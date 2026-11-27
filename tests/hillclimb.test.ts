import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRepository, openDatabase } from "../src/repository.js";
import { conversationServiceGuardReason, createRuntime } from "../src/runtime.js";
import { buildOutcomeContract, createAutoTracker } from "../src/auto-track.js";
import { clearScanCache, getClimbCard, getClimbList, getClimbStatus, getClimbVerdict, installEngine, redactSecrets, scanProjectClimbs } from "../src/repo-ops.js";
import { actionSchema } from "../src/actions.js";
import { lintTree } from "../src/linter.js";
import { writeMirror } from "../src/mirror.js";
import { ingestJunitReport } from "../src/ci-ingest.js";
import { runStudyPreview } from "../src/studies.js";
import { computeInsights } from "../src/insights.js";
import { exportShareableReport, generateArtifactFromTemplate } from "../src/artifacts.js";
import { blueprintActions, listBlueprints, parseMarkdownImport } from "../src/templates.js";
import { createAutomationEngine, ingestAlert } from "../src/hooks.js";
import { startLoopbackServer } from "../src/http-server.js";
import { buildRig, draftForKit, emptyDraft, kitById, seedDraft, validateDraft } from "../src/ui/RigEditor.js";
import { layoutTree, pendingProposedOutcomesByGoal } from "../src/ui/TreeView.js";
import { readWorkspaceImageDataUri, scanDesignKit } from "../src/design-kit.js";
import type { Outcome } from "../src/model.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "app.py"), "def value():\n    return 2\n", "utf8");
  execFileSync("git", ["add", "app.py"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
}

describe("Hill Climb Antigravity plugin", () => {
  it("installs engine + 5 benchmark kits and matches climb.py status byte-for-byte on score line", () => {
    const repoDir = tempDir("hc-parity-");
    try {
      initGitRepo(repoDir);
      const installed = installEngine(repoDir);
      assert.ok(existsSync(join(repoDir, ".hill-climb", "engine", "climb.py")));
      assert.ok(existsSync(join(repoDir, ".hill-climb", "engine", "judge.py")));
      assert.ok(existsSync(join(repoDir, ".hill-climb", "kits", "preflight.py")));
      assert.ok(existsSync(join(repoDir, ".hill-climb", "kits", "correctness", "kit.json")));
      assert.ok(existsSync(join(repoDir, ".hill-climb", "kits", "tuning", "kit.json")));
      assert.ok(installed.exclude && readFileSync(installed.exclude, "utf8").includes("/.hill-climb/"));

      writeFileSync(
        join(repoDir, "check.py"),
        "import app\nprint(app.value())\n",
        "utf8",
      );
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      execFileSync(
        "python3",
        [
          climbPy,
          "init",
          "demo",
          "--goal",
          "reduce value to zero",
          "--check",
          "python3 -B check.py",
          "--direction",
          "min",
          "--target",
          "0",
          "--lock",
          "check.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      writeFileSync(join(repoDir, "app.py"), "def value():\n    return 1\n", "utf8");
      execFileSync("python3", [climbPy, "try", "halve the value"], { cwd: repoDir, encoding: "utf8" });

      const pyStatus = execFileSync("python3", [climbPy, "status", "demo"], { cwd: repoDir, encoding: "utf8" });
      const tsStatus = getClimbStatus(repoDir, "demo");
      const pyScoreLine = pyStatus.split("\n").find((l) => l.startsWith("Score:"));
      const tsScoreLine = tsStatus.text.split("\n").find((l) => l.startsWith("Score:"));
      assert.equal(tsScoreLine, pyScoreLine);
      assert.equal(tsStatus.summary.baseline, 2);
      assert.equal(tsStatus.summary.best, 1);
      assert.equal(tsStatus.summary.kept, 1);
      assert.equal(getClimbVerdict(repoDir, "demo"), "CLIMBING");
      assert.equal(getClimbCard(repoDir, "demo").data.name, "demo");
      assert.equal(getClimbList(repoDir).climbs.length, 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("manages contract trees, 22-rule linting, mirror sync, CI evidence ingestion, and study preview", async () => {
    const workDir = tempDir("hc-core-");
    const dataDir = tempDir("hc-data-");
    try {
      const db = openDatabase(dataDir);
      const repo = createRepository(db);
      const proj = repo.registerProject({ id: "demo-proj", name: "Demo", directory: workDir });
      assert.equal(proj.id, "demo-proj");

      repo.act("demo-proj", {
        op: "create_goal",
        key: "G-1",
        parentGoalKey: null,
        title: "Invoices always reconcile cleanly",
        brief: "Every invoice total matches the sum of its line items to the cent.",
        rank: 10,
      });
      repo.act("demo-proj", {
        op: "create_outcome",
        key: "HC-1",
        goalKey: "G-1",
        contract: {
          title: "Invoice totals round deterministically",
          story: "Billing clerks see invoice totals that match line-item sums without penny drift.",
          criteria: [
            {
              id: "ac1",
              given: "an invoice with fractional tax line items",
              when: "the invoice total is computed",
              then: "the total equals the rounded sum of line items",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: null,
        },
      });

      const lint = lintTree(repo.read("demo-proj"));
      assert.equal(typeof lint.passed, "boolean");

      const mirror = await writeMirror(workDir, repo.view("demo-proj"));
      assert.ok(mirror.files >= 4);
      assert.ok(existsSync(join(workDir, ".hillclimb", "INDEX.md")));
      assert.ok(existsSync(join(workDir, ".hillclimb", "tree.json")));

      // CI JUnit ingestion dry-run + atomic apply + idempotent retry
      const junitPath = join(workDir, "junit.xml");
      writeFileSync(
        junitPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="billing" tests="1" failures="0">
  <testcase classname="billing" name="HC-1@1#ac1 rounds invoice totals" time="0.01"/>
</testsuite>`,
        "utf8",
      );
      const dry = ingestJunitReport(repo, {
        project: "demo-proj",
        report: junitPath,
        directory: workDir,
        source: "ci://run/1",
        apply: false,
      });
      assert.equal(dry.exitCode, 0);
      assert.equal(dry.payload.wouldWrite, 1);
      assert.equal(dry.payload.applied, 0);

      const applied = ingestJunitReport(repo, {
        project: "demo-proj",
        report: junitPath,
        directory: workDir,
        source: "ci://run/1",
        apply: true,
      });
      assert.equal(applied.exitCode, 0);
      assert.equal(applied.payload.applied, 1);
      assert.equal(repo.view("demo-proj").ranked.find((r) => r.key === "HC-1")?.signal, "verified");

      // Idempotent second run writes 0 new records
      const repeat = ingestJunitReport(repo, {
        project: "demo-proj",
        report: junitPath,
        directory: workDir,
        source: "ci://run/1",
        apply: true,
      });
      assert.equal(repeat.payload.applied, 0);
      assert.equal(repeat.payload.alreadyRecorded, 1);

      // Equal-budget study preview
      writeFileSync(
        join(workDir, "self-study.yaml"),
        `name: self-study
budget: 10m
repeats: 2
problems:
  - knapsack
experiments:
  greedy:
    climber: greedy
  openevolve:
    climber: openevolve
`,
        "utf8",
      );
      const preview = await runStudyPreview({ dir: workDir, spec: "self-study.yaml" });
      assert.equal(preview.preview.schema, "hillclimb.study.preview.v1");
      assert.equal(preview.preview.jobs.length, 4);

      db.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("saves verifier rig, dispatches local run with marker/receipt.py, and exposes full MCP + MCP App protocol over stdio", async () => {
    const repoDir = tempDir("hc-mcp-repo-");
    const dataDir = tempDir("hc-mcp-data-");
    try {
      initGitRepo(repoDir);
      const transport = new StdioClientTransport({
        command: "node",
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs"), "--data-dir", dataDir],
        env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: "", ANTIGRAVITY_CSRF_TOKEN: "" },
      });
      const client = new Client({ name: "hillclimb-test-client", version: "1.0.0" });
      await client.connect(transport);

      try {
        // 1. Verify MCP tools & MCP App metadata
        const tools = await client.listTools();
        const openTool = tools.tools.find((t) => t.name === "hillclimb_open");
        assert.ok(openTool, "hillclimb_open tool must be registered");
        const meta = openTool._meta as Record<string, unknown>;
        assert.equal((meta.ui as { resourceUri?: string })?.resourceUri, "ui://hillclimb/app.html");
        const entrypoints = (meta["com.google.antigravity/ui"] as { entrypoints?: Array<{ type: string }> })?.entrypoints;
        assert.deepEqual(
          entrypoints?.map((e) => e.type),
          ["aux_pane", "global"],
        );

        const appTreeTool = tools.tools.find((t) => t.name === "app_tree");
        assert.ok(appTreeTool, "app_tree app-only tool must be registered");
        assert.deepEqual(((appTreeTool._meta as Record<string, unknown>)?.ui as { visibility?: string[] })?.visibility, ["app"]);

        // 2. Verify MCP App UI HTML resource
        const res = await client.readResource({ uri: "ui://hillclimb/app.html" });
        assert.equal(res.contents.length, 1);
        const content = res.contents[0] as { mimeType?: string; text?: string };
        assert.equal(content.mimeType, "text/html;profile=mcp-app");
        assert.ok((content.text?.length ?? 0) > 50_000, "bundled React app HTML should be non-trivial");
        assert.ok((content.text?.length ?? 0) < 10 * 1024 * 1024, "HTML must be under 10 MiB limit");

        // 3. Call hillclimb_open with empty args (as entrypoint launch does)
        const opened = await client.callTool({ name: "hillclimb_open", arguments: {} });
        assert.ok(!opened.isError);
        assert.ok(opened.structuredContent);

        // 4. Register project, create goal/outcome, test human gate on approve_change
        await client.callTool({
          name: "hillclimb_projects",
          arguments: { registerDirectory: repoDir, id: "mcp-repo", name: "MCP Repo" },
        });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "mcp-repo",
            action: JSON.stringify({
              op: "create_goal",
              key: "G-MCP",
              parentGoalKey: null,
              title: "Queries stay fast under load",
              brief: "P95 latency stays below 50ms.",
              rank: 1,
            }),
          },
        });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "mcp-repo",
            action: JSON.stringify({
              op: "create_outcome",
              key: "HC-10",
              goalKey: "G-MCP",
              contract: {
                title: "Search responds under 50ms",
                story: "Users get instant search results.",
                criteria: [
                  {
                    id: "ac1",
                    given: "an indexed catalog",
                    when: "a user queries by prefix",
                    then: "results return in under 50ms",
                  },
                ],
                dependsOn: [],
                rank: 1,
                recheckDays: null,
              },
            }),
          },
        });
        const proposed = await client.callTool({
          name: "hillclimb_propose_change",
          arguments: {
            projectId: "mcp-repo",
            key: "HC-10",
            contract: {
              title: "Search responds under 40ms",
              story: "Users get instant search results.",
              criteria: [
                {
                  id: "ac1",
                  given: "an indexed catalog",
                  when: "a user queries by prefix",
                  then: "results return in under 40ms",
                },
              ],
            },
          },
        });
        const changeId = (proposed.structuredContent as { proposed: string }).proposed;
        assert.ok(changeId);

        // Model hillclimb_act MUST refuse approve_change
        const refused = await client.callTool({
          name: "hillclimb_act",
          arguments: { projectId: "mcp-repo", action: JSON.stringify({ op: "approve_change", id: changeId }) },
        });
        assert.equal(refused.isError, true);

        // App-only app_act without confirmed=true MUST refuse approve_change
        const refusedUnconfirmed = await client.callTool({
          name: "app_act",
          arguments: { projectId: "mcp-repo", action: { op: "approve_change", id: changeId } },
        });
        assert.equal(refusedUnconfirmed.isError, true);

        // App-only app_act with confirmed=true MUST succeed
        const approved = await client.callTool({
          name: "app_act",
          arguments: { projectId: "mcp-repo", action: { op: "approve_change", id: changeId }, confirmed: true },
        });
        assert.ok(!approved.isError);

        // 5. Save a repo rig and dispatch a local run
        const rigSave = await client.callTool({
          name: "hillclimb_rig",
          arguments: {
            projectId: "mcp-repo",
            key: "HC-10",
            engine: "repo",
            rig: {
              engine: "repo",
              check: ["python3 bench.py"],
              direction: "min",
              target: 40,
              guard: ["pytest -q"],
              holdout: "python3 holdout.py",
              lock: ["bench.py", "holdout.py"],
              criterionIds: ["ac1"],
            },
          },
        });
        assert.ok(!rigSave.isError);

        const started = await client.callTool({
          name: "hillclimb_search_start",
          arguments: { projectId: "mcp-repo", key: "HC-10", engine: "repo" },
        });
        assert.ok(!started.isError);
        const runInfo = started.structuredContent as { runId: string; directory: string };
        assert.ok(runInfo.runId.startsWith("run_"));
        assert.ok(existsSync(join(repoDir, ".hill-climb", "engine", "climb.py")));
        assert.ok(existsSync(join(repoDir, ".hill-climb", "bridge", `${runInfo.runId}.json`)));
        assert.ok(existsSync(join(repoDir, ".hill-climb", "bridge", "receipt.py")));

        // 6. Verify CLI wrapper works cleanly
        const cli = spawnSync(join(PLUGIN_ROOT, "bin", "hillclimb"), ["tree", "--project", "mcp-repo", "--data-dir", dataDir], {
          encoding: "utf8",
        });
        assert.equal(cli.status, 0);
        const parsedTree = JSON.parse(cli.stdout) as { outcomes: Array<{ key: string; version: number }> };
        assert.equal(parsedTree.outcomes[0]?.version, 2);

        // 7. Verify create_goal accepts omitted or empty-string parentGoalKey and app_repo_climbs works
        for (const variant of [
          { op: "create_goal", key: "G-OMIT", title: "Omitted parent", brief: "Root goal", rank: 2 },
          { op: "create_goal", key: "G-EMPTY", parentGoalKey: "", title: "Empty parent", brief: "Root goal", rank: 3 },
        ]) {
          const parsed = actionSchema.parse(variant);
          assert.equal("parentGoalKey" in parsed && parsed.parentGoalKey, null);
          const actRes = await client.callTool({
            name: "hillclimb_act",
            arguments: { projectId: "mcp-repo", action: JSON.stringify(variant) },
          });
          assert.ok(!actRes.isError, `Expected create_goal variant ${variant.key} to succeed`);
        }

        // 8. Verify scanProjectClimbs detects active & prepared climbs across linked git worktrees
        const wtDir = tempDir("hc-wt-");
        try {
          execFileSync("git", ["worktree", "add", "-q", "-b", "wt-climb-branch", wtDir], { cwd: repoDir });
          installEngine(wtDir);
          execFileSync("mkdir", ["-p", join(wtDir, ".hill-climb", "unit-count-recall", "raw")]);
          writeFileSync(join(wtDir, ".hill-climb", "unit-count-recall", "raw", "sample.txt"), "data", "utf8");
          const scanned = scanProjectClimbs(repoDir);
          assert.ok(scanned.worktreesScanned >= 1);
          const prep = scanned.climbs.find((c) => c.name === "unit-count-recall");
          assert.ok(prep, "prepared climb in linked worktree must be discovered");
          assert.equal(prep.status, "prepared");
          assert.equal(prep.isMainCheckout, false);
          assert.equal(prep.preparedFiles, 1);

          // 9. Verify auto-tracking is ON by default via app_tree and app_live
          const treeRes = await client.callTool({ name: "app_tree", arguments: { projectId: "mcp-repo" } });
          assert.ok(!treeRes.isError);
          const treePayload = treeRes.structuredContent as {
            tree: { outcomes: Array<{ key: string }>; ranked: Array<{ key: string; signal: string; claim: unknown }> };
            repoClimbs: { autoTrackClimbs: boolean; climbs: Array<{ name: string; outcomeKey: string | null }> };
          };
          assert.equal(treePayload.repoClimbs.autoTrackClimbs, true);
          const trackedClimb = treePayload.repoClimbs.climbs.find((c) => c.name === "unit-count-recall");
          assert.equal(trackedClimb?.outcomeKey, "UNIT-COUNT-RECALL");
          const trackedRank = treePayload.tree.ranked.find((r) => r.key === "UNIT-COUNT-RECALL");
          assert.ok(trackedRank, "prepared climb must auto-populate Outcomes tab");
          assert.equal(trackedRank.signal, "unverified");
          assert.ok(trackedRank.claim, "live climb must hold an active claim");

          const liveRes = await client.callTool({
            name: "app_live",
            arguments: { projectId: "mcp-repo", key: "UNIT-COUNT-RECALL" },
          });
          assert.ok(!liveRes.isError);
          const livePayload = liveRes.structuredContent as { engine: string | null; worker?: { phase: string } };
          assert.equal(livePayload.engine, "repo");
          assert.equal(livePayload.worker?.phase, "preparing");
        } finally {
          rmSync(wtDir, { recursive: true, force: true });
        }
      } finally {
        await client.close();
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("auto-tracks active climb.py runs into Outcomes, records verifier evidence on target reach, and respects toggle + archived opt-in", () => {
    const repoDir = tempDir("hc-auto-repo-");
    const dataDir = tempDir("hc-auto-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      writeFileSync(join(repoDir, "check.py"), "import app\nprint(app.value())\n", "utf8");
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      execFileSync(
        "python3",
        [
          climbPy,
          "init",
          "latency-drop",
          "--goal",
          "Drop value to zero",
          "--check",
          "python3 -B check.py",
          "--direction",
          "min",
          "--target",
          "0",
          "--lock",
          "check.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      const db = openDatabase(dataDir);
      const repo = createRepository(db);
      repo.registerProject({ id: "auto-proj", name: "Auto", directory: repoDir });
      const tracker = createAutoTracker(repo);

      assert.equal(tracker.isAutoTrackEnabled("auto-proj"), true);

      // Baseline measured -> auto-tracked as unverified with note evidence (never fake-verified)
      const first = tracker.syncScannedClimbs("auto-proj", scanProjectClimbs(repoDir));
      assert.equal(first.climbs[0]?.outcomeKey, "LATENCY-DROP");
      let view = repo.view("auto-proj");
      assert.equal(view.ranked.find((r) => r.key === "LATENCY-DROP")?.signal, "unverified");
      assert.equal(view.evidence.filter((e) => e.key === "LATENCY-DROP").length, 1);

      // Idempotent second sync writes zero duplicate evidence
      tracker.syncScannedClimbs("auto-proj", scanProjectClimbs(repoDir));
      assert.equal(repo.view("auto-proj").evidence.filter((e) => e.key === "LATENCY-DROP").length, 1);

      // Climb hits target 0 -> verifier confirms evidence is recorded and signal becomes verified
      writeFileSync(join(repoDir, "app.py"), "def value():\n    return 0\n", "utf8");
      execFileSync("python3", [climbPy, "try", "reach zero"], { cwd: repoDir, encoding: "utf8" });

      tracker.syncScannedClimbs("auto-proj", scanProjectClimbs(repoDir, { force: true }));
      view = repo.view("auto-proj");
      assert.equal(view.ranked.find((r) => r.key === "LATENCY-DROP")?.signal, "verified");
      assert.equal(view.ranked.find((r) => r.key === "LATENCY-DROP")?.claim, null);

      const live = tracker.liveForOutcome("auto-proj", "LATENCY-DROP", repoDir);
      assert.equal(live?.engine, "repo");
      assert.equal(live?.baseline, 2);
      assert.equal(live?.best, 0);
      assert.equal(live?.target, 0);
      // Includes baseline root row + chained step-1 row
      assert.equal(live?.rows.length, 2);
      assert.equal(live?.rows[0]?.id, "baseline");
      assert.equal(live?.rows[1]?.parent, "baseline");
      // Holdout must be numeric score or null, never a raw shell command
      assert.equal(live?.holdout, null);

      // Disabling auto-track prevents new climbs from being auto-added while preserving existing outcomes
      tracker.setAutoTrackEnabled("auto-proj", false);
      const synthetic = {
        ...scanProjectClimbs(repoDir),
        climbs: [
          ...scanProjectClimbs(repoDir).climbs,
          {
            ...scanProjectClimbs(repoDir).climbs[0]!,
            id: "synthetic:archived-run",
            name: "old-archived-run",
            origin: "archived" as const,
            isLive: false,
          },
          {
            ...scanProjectClimbs(repoDir).climbs[0]!,
            id: "synthetic:new-run",
            name: "new-run-when-off",
            origin: "checkout" as const,
          },
        ],
      };
      const syncedOff = tracker.syncScannedClimbs("auto-proj", synthetic);
      assert.equal(syncedOff.autoTrackClimbs, false);
      assert.equal(syncedOff.climbs.find((c) => c.name === "old-archived-run")?.outcomeKey, null);
      assert.equal(syncedOff.climbs.find((c) => c.name === "new-run-when-off")?.outcomeKey, null);
      assert.equal(syncedOff.climbs.find((c) => c.name === "latency-drop")?.outcomeKey, "LATENCY-DROP");

      // Manual opt-in still tracks any archived/untracked climb on demand
      const manualKey = tracker.trackClimb(
        "auto-proj",
        synthetic.climbs.find((c) => c.name === "old-archived-run")!,
      );
      assert.equal(manualKey, "OLD-ARCHIVED-RUN");
      assert.ok(repo.view("auto-proj").outcomes.some((o) => o.key === "OLD-ARCHIVED-RUN"));

      // Moved/orphaned fixture folder with stale card.json (name != folder) & raised target mismatch
      execFileSync("mkdir", ["-p", join(repoDir, ".hill-climb", "latency-bench")]);
      const origCard = JSON.parse(readFileSync(join(repoDir, ".hill-climb", "latency-drop", "card.json"), "utf8")) as Record<string, unknown>;
      // Simulate stale leftover card.json in renamed fixture directory (no log.jsonl)
      writeFileSync(
        join(repoDir, ".hill-climb", "latency-bench", "card.json"),
        JSON.stringify({ ...origCard, best: { score: 2, commit: "abc", step: 0 } }),
        "utf8",
      );
      // Ignore __pycache__, dot-dirs, and bytecode-only directories inside .hill-climb/
      execFileSync("mkdir", ["-p", join(repoDir, ".hill-climb", "__pycache__"), join(repoDir, ".hill-climb", ".pytest_cache"), join(repoDir, ".hill-climb", "empty-dir")]);
      writeFileSync(join(repoDir, ".hill-climb", "__pycache__", "check.cpython-312.pyc"), "bytecode", "utf8");
      writeFileSync(join(repoDir, ".hill-climb", ".pytest_cache", "README.md"), "cache", "utf8");

      // Simulate `climb.py raise` changing numeric target without updating target_text
      writeFileSync(
        join(repoDir, ".hill-climb", "latency-drop", "card.json"),
        JSON.stringify({ ...origCard, target: -1, target_text: "0", check: ["SEARCH_AUTH_TOKEN=super-secret python3 -B check.py"] }),
        "utf8",
      );
      clearScanCache(repoDir);
      const rescanned = scanProjectClimbs(repoDir, { force: true });
      assert.equal(rescanned.climbs.length, 1, "renamed fixture folder and cache dirs must not appear as climbs");
      assert.equal(rescanned.climbs[0]?.name, "latency-drop");
      assert.equal(rescanned.climbs[0]?.target, -1);
      assert.equal(rescanned.climbs[0]?.targetText, null, "stale target_text must not override raised numeric target");
      assert.equal(rescanned.climbs[0]?.check[0], "SEARCH_AUTH_TOKEN=<redacted> python3 -B check.py");
      assert.equal(redactSecrets("API_KEY=abc123 Bearer tok_1234567890"), "API_KEY=<redacted> Bearer <redacted>");

      db.close();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("M1 regressions: no phantom main-checkout claims, legacy DB migration/sanitization, bestCommit, CLI boolean flags, and ConversationService safeguard", () => {
    const repoDir = tempDir("hc-m1-repo-");
    const dataDir = tempDir("hc-m1-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      writeFileSync(join(repoDir, "check.py"), "import app\nprint(app.value())\n", "utf8");
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      execFileSync(
        "python3",
        [
          climbPy,
          "init",
          "main-climb",
          "--goal",
          "Drop value to zero",
          "--check",
          "SEARCH_AUTH_TOKEN=topsecret123 python3 -B check.py",
          "--direction",
          "min",
          "--target",
          "0",
          "--lock",
          "check.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      // 1. Card redacts inline secrets
      const card = getClimbCard(repoDir, "main-climb");
      assert.ok(!card.text.includes("topsecret123"), "card text must redact secrets");
      assert.ok(!JSON.stringify(card.data).includes("topsecret123"), "card data must redact secrets");

      // 2. Legacy v0 DB migration backfills hc_tree_meta and redacts stored secrets without bumping outcome.version
      const db = openDatabase(dataDir);
      db.exec("CREATE TABLE IF NOT EXISTS hc_trees(project TEXT PRIMARY KEY, body TEXT NOT NULL)");
      db.exec("PRAGMA user_version = 0;");
      const legacyTree = {
        charter: "",
        goals: [{ key: "G-1", parentGoalKey: null, title: "Goal", brief: "Brief", rank: 1, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }],
        outcomes: [{
          key: "LEGACY-1",
          goalKey: "G-1",
          version: 1,
          title: "Legacy outcome",
          story: "Uses SEARCH_AUTH_TOKEN=legacy-secret-xyz",
          criteria: [{ id: "c1", given: "g", when: "API_KEY=leak999 run", then: "passes" }],
          dependsOn: [],
          rank: 1,
          recheckDays: null,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        }],
        changes: [],
        evidence: [],
        claims: [],
        plans: [],
        comments: [{ id: "q1", key: "LEGACY-1", parentId: null, text: "Open question?", options: ["A", "B"], answer: null, created: "2026-01-01T00:00:00Z" }],
        tracks: [{ name: "main", description: "", created: "2026-01-01T00:00:00Z" }],
        releases: [],
        flows: [],
        activity: [],
      };
      db.prepare("INSERT INTO hc_trees(project, body) VALUES(?, ?)").run("legacy-proj", JSON.stringify(legacyTree));

      const repo = createRepository(db);
      const migrated = repo.read("legacy-proj");
      assert.equal(migrated.outcomes[0]?.version, 1, "migration must preserve outcome.version");
      assert.ok(!migrated.outcomes[0]!.story.includes("legacy-secret-xyz"));
      assert.ok(!migrated.outcomes[0]!.criteria[0]!.when.includes("leak999"));
      assert.equal(repo.inboxCountTotal(), 1, "O(1) inboxCountTotal must reflect backfilled open question");
      assert.ok(repo.projectSummaries().some((s) => s.project === "legacy-proj" && s.outcomeCount === 1));

      // 3. Auto-tracking a main-checkout climb NEVER phantom-claims it to 'main checkout'
      repo.registerProject({ id: "main-proj", name: "Main Proj", directory: repoDir });
      const tracker = createAutoTracker(repo);
      const scanned = scanProjectClimbs(repoDir, { force: true });
      assert.ok(scanned.climbs[0]?.bestCommit, "bestCommit must be populated from card.best.commit");
      tracker.syncScannedClimbs("main-proj", scanned);
      const view = repo.view("main-proj");
      const ranked = view.ranked.find((r) => r.key === "MAIN-CLIMB");
      assert.equal(ranked?.claim, null, "main checkout climb must NOT create phantom 4h auto-claim");
      assert.ok(view.next.includes("MAIN-CLIMB"), "unclaimed main checkout outcome must remain in next queue");
      assert.ok(
        view.evidence.some((e) => e.key === "MAIN-CLIMB" && e.source.includes(`@${scanned.climbs[0]!.bestCommit!.slice(0, 7)}`)),
        "auto-tracked evidence source must include @<commit>",
      );

      // 4. O(n) redaction performance sanity check on 100k chars
      const big = `API_KEY=${"x".repeat(50_000)} ${"a".repeat(50_000)}`;
      const t0 = performance.now();
      const redactedBig = redactSecrets(big);
      const dt = performance.now() - t0;
      assert.ok(redactedBig.includes("API_KEY=<redacted>"));
      assert.ok(dt < 100, `Expected O(n) redaction <100ms, got ${dt.toFixed(2)}ms`);

      // 5. CLI boolean flags (--json) do not swallow positional JSON args
      repo.close();
      const cliRes = spawnSync(
        "node",
        [
          join(PLUGIN_ROOT, "dist", "cli.mjs"),
          "act",
          "--project",
          "main-proj",
          "--data-dir",
          dataDir,
          "--json",
          JSON.stringify({ op: "create_goal", key: "G-CLI", title: "CLI Goal", brief: "Test boolean flag", rank: 5 }),
        ],
        { encoding: "utf8" },
      );
      assert.equal(cliRes.status, 0, `CLI act with --json failed: ${cliRes.stderr}`);
      assert.equal(JSON.parse(cliRes.stdout).ok, true);

      // 6. ConversationService safeguard blocks env, option, test harnesses, and tempdirs
      const prevDisable = process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE;
      try {
        process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE = "1";
        assert.equal(
          conversationServiceGuardReason({ directory: "/opt/real-project", disableConversationService: false }),
          "disabled_by_env",
        );
        delete process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE;
        assert.equal(
          conversationServiceGuardReason({ directory: "/opt/real-project", disableConversationService: true }),
          "disabled_by_option",
        );
        assert.equal(
          conversationServiceGuardReason({ directory: repoDir, disableConversationService: false }),
          "blocked_test_harness",
        );
      } finally {
        if (prevDisable === undefined) delete process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE;
        else process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE = prevDisable;
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("M2 regressions: slim tools/list, compact hillclimb_list, bounded hillclimb_tree, batch hillclimb_act, app_act track preservation, and RigEditor kit round-trip", async () => {
    const repoDir = tempDir("hc-m2-repo-");
    const dataDir = tempDir("hc-m2-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      writeFileSync(join(repoDir, "check.py"), "import app\nprint(app.value())\n", "utf8");
      execFileSync(
        "python3",
        [
          join(repoDir, ".hill-climb", "engine", "climb.py"),
          "init",
          "perf-climb",
          "--goal",
          "Reduce score",
          "--check",
          "python3 -B check.py",
          "--direction",
          "min",
          "--target",
          "0",
          "--lock",
          "check.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      writeFileSync(join(repoDir, ".hill-climb", "perf-climb", "notes.md"), "N".repeat(8000), "utf8");

      const transport = new StdioClientTransport({
        command: "node",
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs"), "--data-dir", dataDir],
        env: {
          ...process.env,
          ANTIGRAVITY_LS_ADDRESS: "",
          ANTIGRAVITY_CSRF_TOKEN: "",
          HILLCLIMB_DISABLE_CONVERSATION_SERVICE: "1",
        },
      });
      const client = new Client({ name: "hillclimb-m2-test", version: "1.0.0" });
      await client.connect(transport);

      try {
        // 1. tools/list schema size significantly reduced from v0.3.1 baseline (39,566 B)
        const tools = await client.listTools();
        const toolsBytes = Buffer.byteLength(JSON.stringify(tools.tools), "utf8");
        assert.ok(toolsBytes < 30_000, `Expected slimmed tools/list < 30KB, got ${toolsBytes} bytes`);

        // 2. Compact hillclimb_list omits rows/notes by default, includeRows restores them
        const compactList = await client.callTool({ name: "hillclimb_list", arguments: { directory: repoDir } });
        assert.ok(!compactList.isError);
        const compactPayload = compactList.structuredContent as { climbs: Array<Record<string, unknown>> };
        assert.equal(compactPayload.climbs.length, 1);
        assert.equal("rows" in compactPayload.climbs[0]!, false);
        assert.equal("notes" in compactPayload.climbs[0]!, false);

        const fullList = await client.callTool({
          name: "hillclimb_list",
          arguments: { directory: repoDir, includeRows: true, includeNotes: true },
        });
        const fullPayload = fullList.structuredContent as { climbs: Array<{ rows?: unknown[]; notes?: string }> };
        assert.ok((fullPayload.climbs[0]?.rows?.length ?? 0) >= 1);
        assert.ok((fullPayload.climbs[0]?.notes?.length ?? 0) > 1000);

        // 3. Atomic batch hillclimb_act + decision rejection
        await client.callTool({
          name: "hillclimb_projects",
          arguments: { registerDirectory: repoDir, id: "m2-proj", name: "M2" },
        });
        const batchRes = await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "m2-proj",
            actions: [
              { op: "create_goal", key: "G-M2", parentGoalKey: null, title: "Fast API", brief: "Keep latency low", rank: 1 },
              {
                op: "create_outcome",
                key: "HC-BASE",
                goalKey: "G-M2",
                contract: {
                  title: "Base outcome",
                  story: "Story base",
                  criteria: [{ id: "c1", given: "g", when: "w", then: "t" }],
                  dependsOn: [],
                  rank: 1,
                  recheckDays: null,
                },
              },
              {
                op: "create_outcome",
                key: "HC-DEP",
                goalKey: "G-M2",
                contract: {
                  title: "Dependent outcome",
                  story: "Story dep",
                  criteria: [{ id: "c1", given: "g", when: "w", then: "t" }],
                  dependsOn: ["HC-BASE"],
                  rank: 2,
                  recheckDays: null,
                },
              },
              { op: "create_track", name: "staging", description: "Staging track" },
            ],
          },
        });
        assert.ok(!batchRes.isError);
        assert.equal((batchRes.structuredContent as { applied: number }).applied, 4);

        // 4. hillclimb_next_outcomes supports includeContract + includeBlocked
        const nextRes = await client.callTool({
          name: "hillclimb_next_outcomes",
          arguments: { projectId: "m2-proj", includeContract: true, includeBlocked: true },
        });
        assert.ok(!nextRes.isError);
        const nextData = nextRes.structuredContent as {
          queue: { items: Array<{ key: string; criteria?: unknown[] }> };
          blocked?: { items: Array<{ key: string; blockedBy: string[] }> };
        };
        const baseItem = nextData.queue.items.find((i) => i.key === "HC-BASE");
        assert.ok(baseItem?.criteria && baseItem.criteria.length === 1, "includeContract must inline criteria");
        assert.ok(
          nextData.blocked?.items.some((b) => b.key === "HC-DEP" && b.blockedBy.includes("HC-BASE")),
          "includeBlocked must surface blocked outcomes",
        );

        // 5. hillclimb_tree pagination + app_tree concise text summary + app_act preserves non-main track & returns inboxCount
        const treePage = await client.callTool({
          name: "hillclimb_tree",
          arguments: { projectId: "m2-proj", limit: 1, offset: 0 },
        });
        const treePageData = treePage.structuredContent as { ranked: unknown[]; pagination: { hasMore: boolean; total: number } };
        assert.equal(treePageData.ranked.length, 1);
        assert.equal(treePageData.pagination.hasMore, true);

        const appTree = await client.callTool({ name: "app_tree", arguments: { projectId: "m2-proj", track: "staging" } });
        const appTreeText = (appTree.content as Array<{ text?: string }>)[0]?.text ?? "";
        assert.ok(appTreeText.length < 500, `app_tree text must be concise summary, got ${appTreeText.length} chars`);

        const appActRes = await client.callTool({
          name: "app_act",
          arguments: {
            projectId: "m2-proj",
            track: "staging",
            action: {
              op: "add_evidence",
              key: "HC-BASE",
              version: 1,
              kind: "confirms",
              criterionIds: ["c1"],
              text: "Verified on staging",
              source: "test://staging",
              track: "staging",
            },
          },
        });
        assert.ok(!appActRes.isError);
        const appActData = appActRes.structuredContent as {
          tree: { ranked: Array<{ key: string; signal: string }> };
          inboxCount: number;
        };
        assert.equal(
          appActData.tree.ranked.find((r) => r.key === "HC-BASE")?.signal,
          "verified",
          "app_act must return snapshot on the requested non-main track",
        );
        assert.equal(typeof appActData.inboxCount, "number");

        // Runtime Zod validation still enforced on slimmed app_act & hillclimb_rig schemas
        const badRig = await client.callTool({
          name: "hillclimb_rig",
          arguments: { projectId: "m2-proj", key: "HC-BASE", engine: "repo", rig: { engine: "repo", check: [] } },
        });
        assert.equal(badRig.isError, true, "hillclimb_rig must still reject invalid rig via rigSchema");
      } finally {
        await client.close();
      }

      // 6. RigEditor single-pass --all-guards, MIN_GAIN (.5 / .5%), and kit round-trip via seedDraft
      const kit = kitById("correctness")!;
      const outcome: Outcome = {
        key: "HC-KIT",
        goalKey: "G-1",
        version: 1,
        title: "Kit outcome",
        story: "Story",
        criteria: [{ id: "c1", given: "g", when: "w", then: "t" }],
        dependsOn: [],
        rank: 1,
        recheckDays: null,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      };
      let draft = draftForKit(emptyDraft("repo"), kit);
      draft = {
        ...draft,
        covers: { c1: true },
        target: "100",
        minGain: ".5%",
        dataDir: "eval-data",
        candidate: "python3 run_val.py",
        holdoutCandidate: "python3 run_holdout.py",
      };
      assert.deepEqual(validateDraft(draft, outcome, kit, null), []);
      const built = buildRig(draft, outcome, null, kit);
      assert.equal(built.errors.length, 0);
      assert.ok(built.rig && built.rig.engine === "repo");
      assert.equal(built.rig.guard.length, 1, "all kit guards selected must emit single-pass --all-guards");
      assert.ok(built.rig.guard[0]!.includes("--all-guards"));

      const seeded = seedDraft(built.rig, "repo");
      assert.equal(seeded.kit, "correctness", "seedDraft must recover kit id from saved rig");
      assert.equal(seeded.dataDir, "eval-data");
      assert.equal(seeded.candidate, "python3 run_val.py");
      assert.equal(seeded.holdoutCandidate, "python3 run_holdout.py");
      assert.equal(Object.values(seeded.guards).every(Boolean), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("M3/M4 regressions: Python --lock ., \\r scores, judge.py braces, zero __pycache__ in all 5 kits, and scrubbed CI helpers", () => {
    const repoDir = tempDir("hc-m3-repo-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      // 1. \r progress bar before bare score + --lock . handling
      writeFileSync(join(repoDir, "check.py"), "import sys, app\nsys.stdout.write('50%\\r' + str(app.value()) + '\\n')\n", "utf8");
      execFileSync(
        "python3",
        [climbPy, "init", "cr-test", "--goal", "Zero", "--check", "python3 check.py", "--direction", "min", "--target", "0", "--lock", "check.py"],
        { cwd: repoDir, encoding: "utf8" },
      );
      assert.equal(getClimbStatus(repoDir, "cr-test").summary.baseline, 2);

      // 2. All 5 benchmark kits pass preflight without generating __pycache__
      for (const kitId of ["correctness", "latency-cost", "retrieval", "agent-outcomes", "tuning"]) {
        const res = spawnSync("python3", [join(PLUGIN_ROOT, "assets", "kits", "preflight.py"), "preflight", "--kit", kitId], {
          encoding: "utf8",
        });
        assert.equal(res.status, 0, `preflight failed for ${kitId}: ${res.stderr}`);
      }
      assert.equal(existsSync(join(PLUGIN_ROOT, "assets", "kits", "__pycache__")), false, "preflight must not emit __pycache__");

      // 3. CI helper scrubbed of non-standard external wrapper CLI references
      const ciScript = readFileSync(join(PLUGIN_ROOT, "assets", "ci", "hillclimb-evidence.mjs"), "utf8");
      assert.doesNotMatch(ciScript, /\bbb\s+hillclimb\b/, "CI script must use standalone hillclimb CLI");
      assert.doesNotMatch(ciScript, /\bBB_PROJECT_ID\b/, "CI script must use HILLCLIMB_PROJECT_ID");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("v0.5.0 Phase 1 & 2: SQLite v2 migration, availability, tags, saved views/scopes, proposals, Flows v2, FTS5 search, insights, artifacts & mirror", async () => {
    const workDir = tempDir("hc-v05-work-");
    const dataDir = tempDir("hc-v05-data-");
    try {
      const db = openDatabase(dataDir);
      const repo = createRepository(db);
      const userVer = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      assert.equal(userVer, 3, "SQLite schema must migrate to user_version = 3");
      repo.registerProject({ id: "v05", name: "V05 App", directory: workDir });

      // 1. Goals (update_goal + cycle rejection), sectionNumber, tags, propose_outcome -> approve_change
      repo.act(
        "v05",
        {
          op: "create_goal",
          key: "G-ROOT",
          parentGoalKey: null,
          title: "Checkout works reliably",
          brief: "Buyers complete purchases without retries failing.",
          rank: 10,
          tags: ["checkout"],
        },
        { actor: "human", via: "ui" },
      );
      repo.act(
        "v05",
        {
          op: "create_goal",
          key: "G-SUB",
          parentGoalKey: "G-ROOT",
          title: "Payments stay idempotent",
          brief: "Duplicate submissions never double charge.",
          rank: 20,
        },
        { actor: "human", via: "ui" },
      );
      repo.act("v05", { op: "update_goal", key: "G-SUB", title: "Payments stay strictly idempotent", rank: 15 });
      assert.throws(
        () => repo.act("v05", { op: "update_goal", key: "G-ROOT", parentGoalKey: "G-SUB" }),
        /cycle/i,
      );

      // Propose new outcome (kind: "create") -> inbox -> approve creates outcome v1
      repo.act(
        "v05",
        {
          op: "propose_outcome",
          key: "PAY-1",
          goalKey: "G-SUB",
          contract: {
            title: "Retried charge executes once",
            story: "Buyers who double-click submit are charged once.",
            criteria: [
              { id: "c1", given: "same idempotency key", when: "POST repeats", then: "returns original charge id" },
            ],
            dependsOn: [],
            rank: 10,
            recheckDays: 14,
            tags: ["billing", "p0"],
          },
        },
        { actor: "agent-a", via: "mcp" },
      );
      let snap = repo.view("v05");
      assert.equal(snap.outcomes.length, 0, "proposed outcome must not exist until approved");
      assert.equal(snap.inbox, 1);
      const createProposalId = snap.changes[0]!.id;
      assert.equal(snap.changes[0]!.kind, "create");
      repo.act("v05", { op: "approve_change", id: createProposalId }, { actor: "human", via: "ui" });
      snap = repo.view("v05");
      assert.equal(snap.outcomes.length, 1);
      assert.equal(snap.ranked[0]?.sectionNumber, "1.1.1");
      assert.deepEqual(snap.outcomes[0]?.tags, ["billing", "p0"]);

      // 2. Availability: blocked & deferred excluded from next and refused by claim_outcome; expired deferred auto-reopens
      repo.act("v05", {
        op: "set_outcome_availability",
        key: "PAY-1",
        availability: "blocked",
        reason: "Waiting on Stripe test keys",
      });
      snap = repo.view("v05");
      assert.deepEqual(snap.next, []);
      assert.throws(() => repo.act("v05", { op: "claim_outcome", key: "PAY-1", threadId: "t1", hours: 2 }), /blocked/i);

      repo.act("v05", {
        op: "set_outcome_availability",
        key: "PAY-1",
        availability: "deferred",
        reason: "Wait for Q4",
        deferredUntil: "2099-01-01T00:00:00Z",
      });
      assert.deepEqual(repo.view("v05").next, []);

      // Expired deferredUntil automatically reopens in next
      repo.act("v05", {
        op: "set_outcome_availability",
        key: "PAY-1",
        availability: "deferred",
        deferredUntil: "2020-01-01T00:00:00Z",
      });
      assert.deepEqual(repo.view("v05").next, ["PAY-1"]);
      repo.act("v05", { op: "set_outcome_availability", key: "PAY-1", availability: "active" });

      // 3. Tags, Saved Views, Focus Scopes, Plan-version comments, Evidence attachments, Revise release
      repo.act("v05", { op: "set_tags", key: "PAY-1", tags: ["billing", "stripe"] });
      const savedView = repo.saveView("v05", { name: "Billing P0", filter: { tags: ["billing"], signals: ["unverified"] } });
      assert.equal(repo.listViews("v05").length, 1);
      assert.equal(savedView.name, "Billing P0");

      repo.act("v05", { op: "create_release", name: "R1", scenario: "baseline", date: "2026-12-01", keys: ["PAY-1"] });
      repo.act("v05", { op: "revise_release", name: "R1", scenario: "baseline", date: "2026-12-15", keys: ["PAY-1"] });
      assert.equal(repo.read("v05").releases[0]?.date, "2026-12-15");

      const scope = repo.saveScope("v05", {
        name: "R1 Focus",
        releaseName: "R1",
        goalKeys: [],
        tags: [],
        active: true,
      });
      const scopeKeys = repo.resolveScopeOutcomeKeys("v05", scope.name);
      assert.ok(scopeKeys?.has("PAY-1"));

      repo.act("v05", { op: "write_plan", key: "PAY-1", body: "Step 1: Add key check" }, { actor: "agent-a", via: "mcp" });
      repo.act("v05", { op: "revise_plan", key: "PAY-1", version: 1, body: "Step 1: Add key check\nStep 2: Add DB unique index" });
      repo.act("v05", { op: "comment", key: "PAY-1", text: "Looks great on v2", options: [], parentId: null, planVersion: 2 });
      assert.equal(repo.read("v05").comments[0]?.planVersion, 2);

      repo.act(
        "v05",
        {
          op: "add_evidence",
          key: "PAY-1",
          version: 1,
          kind: "confirms",
          criterionIds: ["c1"],
          text: "Stripe idempotency suite passed 12/12",
          source: "ci://run/88",
          attachments: [{ label: "trace", path: "artifacts/trace.json", mimeType: "application/json" }],
          track: "main",
        },
        { actor: "ci-bot", via: "ci" },
      );
      assert.equal(repo.view("v05").ranked[0]?.signal, "verified");
      assert.equal(repo.read("v05").evidence[0]?.attachments?.[0]?.label, "trace");
      assert.equal(repo.read("v05").evidence[0]?.actor, "ci-bot");

      // 4. Flows v2: folders, designKit, pins (forAgents/rect/resolve_pin), propose_flow_change -> accept -> version history -> restore -> drift
      repo.act("v05", {
        op: "create_flow",
        name: "Checkout Flow",
        folder: "Payments",
        designKit: "Clean SaaS",
        frames: [
          {
            title: "Submit Order",
            key: "PAY-1",
            criterionId: "c1",
            kind: "html",
            html: "<main><button>Pay $10</button></main>",
            viewport: { width: 1440, height: 900 },
            notes: "Initial checkout screen",
          },
        ],
      });
      repo.act("v05", {
        op: "pin",
        name: "Checkout Flow",
        frame: 0,
        x: 0.5,
        y: 0.5,
        text: "Disable button while submitting",
        kind: "rect",
        geometry: { w: 0.2, h: 0.1 },
        selector: "button.pay",
        forAgents: true,
      });
      repo.act("v05", { op: "resolve_pin", name: "Checkout Flow", frame: 0, pinIndex: 0, resolved: true });
      assert.equal(repo.read("v05").flows[0]?.frames[0]?.pins[0]?.resolved, true);

      repo.act("v05", {
        op: "propose_flow_change",
        kind: "change",
        flowName: "Checkout Flow",
        frameIndex: 0,
        basedOnVersion: 1,
        frame: {
          title: "Submit Order (loading)",
          key: "PAY-1",
          criterionId: "c1",
          kind: "html",
          html: "<main><button disabled>Processing...</button></main>",
        },
        selfGrade: "pass",
        ref: "PR #99",
        note: "Shows disabled spinner during POST",
      });
      // Plain plan review note does NOT open an inbox decision; only the pending flow proposal counts (1)
      assert.equal(repo.view("v05").inbox, 1);

      // Regression: replying to an answered question NEVER reopens Decisions
      repo.act(
        "v05",
        { op: "comment", key: "PAY-1", text: "Which SSO mode?", options: ["Per-user SSO", "Shared"], parentId: null },
        { actor: "agent-a", via: "mcp" },
      );
      const qId = repo.read("v05").comments.at(-1)!.id;
      assert.equal(repo.view("v05").inbox, 2);
      repo.act("v05", { op: "answer", id: qId, answer: "Per-user SSO" }, { actor: "human", via: "ui" });
      assert.equal(repo.view("v05").inbox, 1);
      repo.act(
        "v05",
        { op: "comment", key: "PAY-1", text: "Every team member gets their own SSO", options: [], parentId: qId },
        { actor: "human", via: "ui" },
      );
      assert.equal(repo.view("v05").inbox, 1, "plain reply to an answered question must not reopen inbox");
      const flowPropId = repo.read("v05").flowProposals![0]!.id;
      repo.act("v05", { op: "accept_flow_change", id: flowPropId, reviewNote: "Ship it" }, { actor: "human", via: "ui" });
      let flowFrame = repo.read("v05").flows[0]!.frames[0]!;
      assert.equal(flowFrame.version, 2);
      assert.equal(flowFrame.history?.length, 1);
      assert.equal(flowFrame.title, "Submit Order (loading)");

      repo.act("v05", { op: "restore_frame_version", flowName: "Checkout Flow", frameIndex: 0, version: 1 });
      flowFrame = repo.read("v05").flows[0]!.frames[0]!;
      assert.equal(flowFrame.version, 3);
      assert.equal(flowFrame.title, "Submit Order");

      repo.act("v05", { op: "set_frame_drift", flowName: "Checkout Flow", frameIndex: 0, driftDetected: true, driftNote: "Button color drifted" });
      assert.equal(repo.read("v05").flows[0]!.frames[0]!.driftDetected, true);

      // 5. FTS5 search, Insights, Artifacts (templates + locks + HTML export), and Upgraded Mirror
      const hits = repo.search("v05", "idempotency");
      assert.ok(hits.length >= 2, `expected FTS5 search hits, got ${hits.length}`);

      const insights = computeInsights(repo, "v05", { days: 30, track: "main" });
      assert.equal(insights.totals.bySignal.verified, 1);
      assert.equal(insights.totals.verifiedRatePct, 100);
      assert.ok(insights.byActor.some((a) => a.actor === "ci-bot" && a.via === "ci"));

      const gen = generateArtifactFromTemplate(repo, "v05", { template: "weekly-update", save: true });
      assert.ok(gen.saved);
      assert.ok(gen.body.includes("PAY-1"));
      repo.saveArtifact("v05", { id: gen.saved!.id, title: gen.saved!.title, body: gen.body, locked: true });
      assert.throws(
        () => repo.saveArtifact("v05", { id: gen.saved!.id, title: "Overwrite", body: "Blocked" }),
        /locked/i,
      );

      const exportedHtml = exportShareableReport(repo, "v05", { format: "html" });
      assert.ok(exportedHtml.content.includes("<!doctype html>"));
      assert.ok(exportedHtml.content.includes("PAY-1"));
      const exportedMd = exportShareableReport(repo, "v05", { format: "markdown" });
      assert.ok(exportedMd.content.includes("PAY-1"));

      const mirror = await writeMirror(workDir, repo.view("v05"), { artifacts: repo.listArtifacts("v05") });
      assert.ok(existsSync(join(mirror.root, "flows", "checkout-flow.md")));
      assert.ok(existsSync(join(mirror.root, "reports", `${gen.saved!.id}.md`)));
      repo.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.5.0 Phase 3: blueprints, Markdown import, automation hooks, ingestAlert, loopback REST server & MCP tool contracts", async () => {
    const workDir = tempDir("hc-v05-p3-work-");
    const dataDir = tempDir("hc-v05-p3-data-");
    const markerFile = join(workDir, "hook-fired.txt");
    try {
      const db = openDatabase(dataDir);
      const repo = createRepository(db);
      repo.registerProject({ id: "p3", name: "Phase3", directory: workDir });

      // 1. Blueprints & Markdown importer with 22-rule lint
      assert.ok(listBlueprints().length >= 5);
      const bp = blueprintActions("saas-api");
      assert.ok(bp.actions.length >= 3);
      repo.actBatch("p3", bp.actions, { actor: "human", via: "ui" });
      assert.ok(repo.read("p3").outcomes.some((o) => o.key === "API-IDEMPOTENCY"));

      const md = parseMarkdownImport(
        "# Reliability\n\n## Fast responses\n- As a user, I want pages fast.\n- Given cold cache, when requesting home, then responds under 200ms.\n",
        { asProposals: true },
      );
      assert.ok(md.actions.some((a) => a.op === "propose_outcome"));

      // 2. Automation engine: autoSyncMirror + shell hook fired by ingestAlert -> outcome.broken
      const auto = createAutomationEngine(repo);
      repo.setSetting("p3", "autoSyncMirror", "true");
      repo.saveHook("p3", {
        event: "outcome.broken",
        targetType: "shell",
        target: `printf '%s' "$HILLCLIMB_EVENT" > '${markerFile.replace(/'/g, "'\\''")}'`,
        enabled: true,
      });

      // Confirm outcome first so an incoming production alert flips it verified -> broken
      repo.act("p3", {
        op: "add_evidence",
        key: "API-IDEMPOTENCY",
        version: 1,
        kind: "confirms",
        criterionIds: ["ac1", "ac2"],
        text: "Initial idempotency integration tests passed",
        source: "ci://initial-pass",
        track: "main",
      });
      assert.equal(repo.view("p3").ranked.find((r) => r.key === "API-IDEMPOTENCY")?.signal, "verified");

      const alert = ingestAlert(repo, {
        project: "p3",
        key: "API-IDEMPOTENCY",
        message: "Duplicate charges detected in prod telemetry",
        source: "pagerduty:inc-77",
      });
      assert.equal(alert.signal, "broken");

      // Wait briefly for async debounced mirror & shell hook completion
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (!existsSync(markerFile) || !existsSync(join(workDir, ".hillclimb", "INDEX.md")))) {
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(existsSync(markerFile), true, "outcome.broken shell hook must have fired");
      assert.equal(readFileSync(markerFile, "utf8"), "outcome.broken");
      assert.equal(existsSync(join(workDir, ".hillclimb", "INDEX.md")), true, "autoSyncMirror must sync .hillclimb/");
      auto.stop();

      // 3. Opt-in Loopback REST server (127.0.0.1, Bearer auth, human gate)
      const token = "test-loopback-secret-token-1234";
      const srv = await startLoopbackServer(repo, { port: 0, token });
      try {
        assert.ok(srv.url.startsWith("http://127.0.0.1:"));
        const unauth = await fetch(`${srv.url}/api/v1/projects`);
        assert.equal(unauth.status, 401, "REST API must reject unauthenticated requests");

        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const health = await fetch(`${srv.url}/api/v1/health`, { headers });
        assert.equal(health.status, 200);

        const searchRes = await fetch(`${srv.url}/api/v1/projects/p3/search?q=idempotency`, { headers });
        assert.equal(searchRes.status, 200);
        const searchBody = (await searchRes.json()) as { hits: unknown[] };
        assert.ok(searchBody.hits.length >= 1);

        const forbidden = await fetch(`${srv.url}/api/v1/projects/p3/act`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: { op: "accept_flow_change", id: "fp-1" } }),
        });
        assert.equal(forbidden.status, 403, "REST API must enforce human confirmation gate on flow/contract decisions");
      } finally {
        await srv.close();
      }
      repo.close();

      // 4. End-to-end MCP server checks: 33 tools, new tools callable, requireApprovalForNewOutcomes policy
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs"), "--data-dir", dataDir],
        env: { ...process.env, HILLCLIMB_DISABLE_CONVERSATION_SERVICE: "1" },
      });
      const client = new Client({ name: "v05-test", version: "1.0.0" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((t) => t.name));
        for (const expected of ["hillclimb_search", "hillclimb_insights", "hillclimb_artifact", "hillclimb_import"]) {
          assert.ok(names.has(expected), `missing MCP tool ${expected}`);
        }
        const searchTool = await client.callTool({
          name: "hillclimb_search",
          arguments: { projectId: "p3", query: "idempotency" },
        });
        assert.ok(!searchTool.isError);
        const searchData = searchTool.structuredContent as { count: number };
        assert.ok(searchData.count >= 1);

        const insightsTool = await client.callTool({
          name: "hillclimb_insights",
          arguments: { projectId: "p3", days: 30 },
        });
        assert.ok(!insightsTool.isError);

        const artTool = await client.callTool({
          name: "hillclimb_artifact",
          arguments: { mode: "export", projectId: "p3", format: "html" },
        });
        assert.ok(!artTool.isError);
        assert.ok(String((artTool.structuredContent as { content: string }).content).includes("API-IDEMPOTENCY"));

        const impTool = await client.callTool({
          name: "hillclimb_import",
          arguments: { mode: "blueprints" },
        });
        assert.ok(!impTool.isError);
        assert.ok(((impTool.structuredContent as { blueprints: unknown[] }).blueprints).length >= 5);

        // Enforce human gate on accept_flow_change via MCP
        const refusedFlow = await client.callTool({
          name: "hillclimb_act",
          arguments: { projectId: "p3", action: { op: "accept_flow_change", id: "fp-none" } },
        });
        assert.equal(refusedFlow.isError, true, "hillclimb_act must refuse accept_flow_change");

        // v0.5.2: Inline chat decision cards on hillclimb_propose_change & hillclimb_comment + app_decision_state sync
        const proposeToolMeta = listed.tools.find((t) => t.name === "hillclimb_propose_change")?._meta as
          | { ui?: { resourceUri?: string }; "com.google.antigravity/ui"?: unknown }
          | undefined;
        assert.equal(proposeToolMeta?.ui?.resourceUri, "ui://hillclimb/app.html");
        assert.equal(proposeToolMeta?.["com.google.antigravity/ui"], undefined, "propose_change must render inline, not steal aux_pane");

        const commentToolMeta = listed.tools.find((t) => t.name === "hillclimb_comment")?._meta as
          | { ui?: { resourceUri?: string }; "com.google.antigravity/ui"?: unknown }
          | undefined;
        assert.equal(commentToolMeta?.ui?.resourceUri, "ui://hillclimb/app.html");
        assert.equal(commentToolMeta?.["com.google.antigravity/ui"], undefined, "comment must render inline, not steal aux_pane");

        // Propose brand-new outcome inline via goalKey
        const newProposal = await client.callTool({
          name: "hillclimb_propose_change",
          arguments: {
            projectId: "p3",
            key: "INLINE-NEW",
            goalKey: "G-API",
            contract: {
              title: "Rate limit returns Retry-After header",
              story: "Clients back off cleanly when throttled.",
              criteria: [
                { id: "ac1", given: "a client exceeding quota", when: "receiving 429", then: "Retry-After header is set" },
              ],
            },
          },
        });
        assert.ok(!newProposal.isError);
        const newPropData = newProposal.structuredContent as {
          proposed: string;
          inlineDecision?: { kind: string; change: { id: string; kind?: string; state: string } };
        };
        assert.equal(newPropData.inlineDecision?.kind, "change");
        assert.equal(newPropData.inlineDecision?.change.kind, "create");
        assert.equal(newPropData.inlineDecision?.change.state, "pending");

        // Post inline multiple-choice question
        const qRes = await client.callTool({
          name: "hillclimb_comment",
          arguments: {
            projectId: "p3",
            key: "API-IDEMPOTENCY",
            text: "TTL for stored idempotency keys?",
            options: ["24 hours", "7 days"],
          },
        });
        assert.ok(!qRes.isError);
        const qData = qRes.structuredContent as {
          comment: string;
          inlineDecision?: { kind: string; comment: { id: string; options: string[]; answer: string | null }; outcomeTitle: string };
        };
        assert.equal(qData.inlineDecision?.kind, "question");
        assert.deepEqual(qData.inlineDecision?.comment.options, ["24 hours", "7 days"]);
        assert.equal(qData.inlineDecision?.comment.answer, null);

        // Live sync via app_decision_state before & after app_act
        const beforeState = await client.callTool({
          name: "app_decision_state",
          arguments: { projectId: "p3", kind: "change", id: newPropData.proposed },
        });
        assert.equal((beforeState.structuredContent as { change: { state: string } }).change.state, "pending");

        await client.callTool({
          name: "app_act",
          arguments: { projectId: "p3", action: { op: "approve_change", id: newPropData.proposed }, confirmed: true },
        });
        const afterState = await client.callTool({
          name: "app_decision_state",
          arguments: { projectId: "p3", kind: "change", id: newPropData.proposed },
        });
        assert.equal((afterState.structuredContent as { change: { state: string } }).change.state, "approved");

        await client.callTool({
          name: "app_act",
          arguments: { projectId: "p3", action: { op: "answer", id: qData.comment, answer: "24 hours" }, confirmed: true },
        });
        const afterQ = await client.callTool({
          name: "app_decision_state",
          arguments: { projectId: "p3", kind: "question", id: qData.comment },
        });
        assert.equal((afterQ.structuredContent as { comment: { answer: string } }).comment.answer, "24 hours");
      } finally {
        await client.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.6.0 Design with Agents: UI kit scanner, safe image loading, and inline hillclimb_design loop", async () => {
    const workDir = tempDir("hc-v06-work-");
    const dataDir = tempDir("hc-v06-data-");
    const outsideDir = tempDir("hc-v06-outside-");
    try {
      // Seed realistic frontend project with DESIGN.md, CSS tokens, React components, and a PNG screenshot
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(workDir, "src", "components"), { recursive: true });
      mkdirSync(join(workDir, "screenshots"), { recursive: true });
      writeFileSync(join(workDir, "DESIGN.md"), "# Brand System\nCalm light palette, 10px radius.\n", "utf8");
      writeFileSync(
        join(workDir, "src", "tokens.css"),
        ":root {\n  --brand-primary: #2563eb;\n  --surface-bg: #ffffff;\n  --radius-md: 10px;\n}\n",
        "utf8",
      );
      writeFileSync(
        join(workDir, "src", "components", "PayButton.tsx"),
        `import "./tokens.css";\nexport interface PayButtonProps { label: string; disabled?: boolean; }\nexport function PayButton({ label, disabled }: PayButtonProps) {\n  return <button className="btn-primary" disabled={disabled}>{label}</button>;\n}\n`,
        "utf8",
      );
      // 1x1 transparent PNG
      const tinyPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      writeFileSync(join(workDir, "screenshots", "checkout.png"), tinyPng);
      writeFileSync(join(outsideDir, "secret.png"), tinyPng);

      // 1. Direct scanner & safe workspace image checks
      const kit = scanDesignKit(workDir, { readComponent: "src/components/PayButton.tsx" });
      assert.equal(kit.designDocs[0]?.path, "DESIGN.md");
      assert.equal(kit.tokens["--brand-primary"], "#2563eb");
      assert.ok(kit.tokenStyleBlock.includes("--brand-primary: #2563eb;"));
      assert.ok(kit.components.some((c) => c.name === "PayButton" && c.path === "src/components/PayButton.tsx"));
      assert.ok(kit.componentSnippet?.content.includes("btn-primary"));

      const okUri = readWorkspaceImageDataUri(workDir, "screenshots/checkout.png");
      assert.ok(okUri?.startsWith("data:image/png;base64,"));
      const escaped = readWorkspaceImageDataUri(workDir, `../${outsideDir.split("/").pop()}/secret.png`);
      assert.equal(escaped, null, "must reject path traversal outside workspace");

      // 2. Seed DB project & outcome
      const db = openDatabase(dataDir);
      const repo = createRepository(db);
      repo.registerProject({ id: "design-demo", name: "DesignDemo", directory: workDir });
      repo.act("design-demo", { op: "create_goal", key: "G-UX", title: "Calm checkout", brief: "Fast one-click pay", parentGoalKey: null, rank: 1 });
      repo.act("design-demo", {
        op: "create_outcome",
        key: "UX-PAY",
        goalKey: "G-UX",
        contract: {
          title: "Pay button shows clear loading state",
          story: "Buyers see immediate feedback while payment submits.",
          criteria: [{ id: "c1", given: "buyer clicks Pay", when: "charge is submitting", then: "PayButton disables with spinner" }],
          dependsOn: [],
          rank: 1,
          recheckDays: null,
        },
      });
      repo.close();

      // 3. End-to-end MCP hillclimb_design + app_decision_state + app_read_image
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs"), "--data-dir", dataDir],
        env: { ...process.env, HILLCLIMB_DISABLE_CONVERSATION_SERVICE: "1" },
      });
      const client = new Client({ name: "v06-test", version: "1.0.0" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        const designTool = listed.tools.find((t) => t.name === "hillclimb_design");
        const designMeta = designTool?._meta as
          | { ui?: { resourceUri?: string }; "com.google.antigravity/ui"?: unknown }
          | undefined;
        assert.equal(designMeta?.ui?.resourceUri, "ui://hillclimb/app.html");
        assert.equal(designMeta?.["com.google.antigravity/ui"], undefined, "hillclimb_design must render inline, not steal aux_pane");

        // Regression v0.6.1: frames/frame/contract must expose explicit object properties (not bare z.record) so tool callers serialize nested frames
        const designProps = (designTool?.inputSchema as { properties?: Record<string, { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }> })?.properties;
        assert.ok(designProps?.frame?.properties?.html, "hillclimb_design.frame must declare explicit properties");
        assert.ok(designProps?.frames?.items?.properties?.html, "hillclimb_design.frames[] must declare explicit properties");
        const proposeProps = (listed.tools.find((t) => t.name === "hillclimb_propose_change")?.inputSchema as { properties?: Record<string, { properties?: Record<string, unknown> }> })?.properties;
        assert.ok(proposeProps?.contract?.properties?.criteria, "hillclimb_propose_change.contract must declare explicit properties");

        // mode="kit" (verify text content ALSO carries components, CSS tokens, and readComponent source for the LLM!)
        const kitRes = await client.callTool({
          name: "hillclimb_design",
          arguments: { mode: "kit", projectId: "design-demo", componentQuery: "Pay", readComponent: "src/components/PayButton.tsx" },
        });
        assert.ok(!kitRes.isError);
        const kitText = ((kitRes.content as Array<{ type: string; text?: string }>)?.[0]?.text) ?? "";
        assert.ok(kitText.includes("PayButton"), "kit text response must list discovered components for the agent");
        assert.ok(kitText.includes("--brand-primary: #2563eb"), "kit text response must include CSS tokenStyleBlock");
        assert.ok(kitText.includes("btn-primary"), "kit text response must include readComponent source snippet");
        const kitData = kitRes.structuredContent as {
          inlineDecision?: { kind: string; componentCount: number; tokenCount: number };
        };
        assert.equal(kitData.inlineDecision?.kind, "design_kit");
        assert.equal(kitData.inlineDecision?.componentCount, 1);
        assert.ok((kitData.inlineDecision?.tokenCount ?? 0) >= 3);

        // mode="propose" (new_flow with HTML + local PNG screenshot auto-hydration + componentRefs)
        const propRes = await client.callTool({
          name: "hillclimb_design",
          arguments: {
            mode: "propose",
            projectId: "design-demo",
            flowName: "Checkout Flow",
            componentRefs: ["src/components/PayButton.tsx"],
            note: "Uses PayButton and live CSS tokens",
            frames: [
              {
                title: "Idle pay state",
                key: "UX-PAY",
                criterionId: "c1",
                kind: "html",
                html: "<main><button>Pay $49</button></main>",
              },
              {
                title: "Captured checkout screenshot",
                key: "UX-PAY",
                criterionId: "c1",
                kind: "image",
                imagePath: "screenshots/checkout.png",
              },
            ],
          },
        });
        assert.ok(!propRes.isError);
        const propData = propRes.structuredContent as {
          proposed: string;
          inlineDecision?: {
            kind: string;
            proposal: { id: string; state: string; componentRefs?: string[]; frames?: Array<{ imagePath?: string | null }> };
          };
        };
        assert.equal(propData.inlineDecision?.kind, "flow_proposal");
        assert.equal(propData.inlineDecision?.proposal.state, "pending");
        assert.deepEqual(propData.inlineDecision?.proposal.componentRefs, ["src/components/PayButton.tsx"]);
        assert.ok(
          propData.inlineDecision?.proposal.frames?.[1]?.imagePath?.startsWith("data:image/png;base64,"),
          "workspace screenshot must be auto-hydrated to data URI for isolated iframe",
        );

        // Accept flow via app_act, then verify app_decision_state + mode="inspect" + pin + mode="resolve_pin"
        await client.callTool({
          name: "app_act",
          arguments: { projectId: "design-demo", action: { op: "accept_flow_change", id: propData.proposed }, confirmed: true },
        });
        const syncedProp = await client.callTool({
          name: "app_decision_state",
          arguments: { projectId: "design-demo", kind: "flow_proposal", id: propData.proposed },
        });
        assert.equal((syncedProp.structuredContent as { proposal: { state: string } }).proposal.state, "accepted");

        await client.callTool({
          name: "app_act",
          arguments: {
            projectId: "design-demo",
            action: {
              op: "pin",
              name: "Checkout Flow",
              frame: 0,
              x: 0.4,
              y: 0.6,
              kind: "rect",
              geometry: { w: 0.25, h: 0.12 },
              text: "Increase button padding",
              forAgents: true,
            },
            confirmed: true,
          },
        });

        const inspRes = await client.callTool({
          name: "hillclimb_design",
          arguments: { mode: "inspect", projectId: "design-demo", flowName: "Checkout Flow" },
        });
        assert.ok(!inspRes.isError);
        const inspData = inspRes.structuredContent as { openPinCount: number; inlineDecision?: { kind: string } };
        assert.equal(inspData.openPinCount, 1);
        assert.equal(inspData.inlineDecision?.kind, "flow_inspect");

        const resPin = await client.callTool({
          name: "hillclimb_design",
          arguments: { mode: "resolve_pin", projectId: "design-demo", flowName: "Checkout Flow", frameIndex: 0, pinIndex: 0, resolved: true },
        });
        assert.ok(!resPin.isError);

        const syncedFlow = await client.callTool({
          name: "app_decision_state",
          arguments: { projectId: "design-demo", kind: "flow_inspect", id: "Checkout Flow" },
        });
        assert.equal((syncedFlow.structuredContent as { flow: { frames: Array<{ pins: Array<{ resolved?: boolean }> }> } }).flow.frames[0]?.pins[0]?.resolved, true);

        // app_read_image works for valid workspace file and returns null outside workspace
        const readOk = await client.callTool({
          name: "app_read_image",
          arguments: { projectId: "design-demo", path: "screenshots/checkout.png" },
        });
        assert.ok(String((readOk.structuredContent as { dataUri: string | null }).dataUri).startsWith("data:image/png;base64,"));
        const readBad = await client.callTool({
          name: "app_read_image",
          arguments: { projectId: "design-demo", path: "../escape.png" },
        });
        assert.equal((readBad.structuredContent as { dataUri: string | null }).dataUri, null);

        // UX-PROPOSED-TREE (v0.6.2): pending propose_outcome appears ghosted under its target goal, and clears upon approval
        await client.callTool({
          name: "hillclimb_propose_change",
          arguments: {
            projectId: "design-demo",
            key: "UX-GHOST-1",
            goalKey: "G-UX",
            contract: {
              title: "Ghost proposal row appears inline",
              story: "As a reviewer, I want proposed outcomes visible under their goal, so that context is clear.",
              criteria: [{ id: "c1", given: "pending create", when: "viewing Goals", then: "dashed ghost row renders" }],
            },
          },
        });
        const beforeApprove = await client.callTool({ name: "app_tree", arguments: { projectId: "design-demo" } });
        const snapBefore = (beforeApprove.structuredContent as { tree: import("../src/model.js").Snapshot }).tree;
        const groupedBefore = pendingProposedOutcomesByGoal(snapBefore.changes, new Set(snapBefore.goals.map((g) => g.key)));
        assert.equal(groupedBefore.total, 1);
        assert.equal(groupedBefore.byGoal.get("G-UX")?.[0]?.key, "UX-GHOST-1");
        const layoutBefore = layoutTree(snapBefore.goals, snapBefore.outcomes, snapBefore.changes);
        assert.ok(
          layoutBefore.nodes.some((n) => n.kind === "proposed-outcome" && n.displayKey === "UX-GHOST-1" && n.goalKey === "G-UX"),
          "layoutTree must place pending propose_outcome as a ghosted node under its target goal",
        );

        const ghostChangeId = groupedBefore.byGoal.get("G-UX")![0]!.id;
        await client.callTool({
          name: "app_act",
          arguments: { projectId: "design-demo", action: { op: "approve_change", id: ghostChangeId }, confirmed: true },
        });
        const afterApprove = await client.callTool({ name: "app_tree", arguments: { projectId: "design-demo" } });
        const snapAfter = (afterApprove.structuredContent as { tree: import("../src/model.js").Snapshot }).tree;
        assert.equal(pendingProposedOutcomesByGoal(snapAfter.changes).total, 0);
        const layoutAfter = layoutTree(snapAfter.goals, snapAfter.outcomes, snapAfter.changes);
        assert.ok(!layoutAfter.nodes.some((n) => n.kind === "proposed-outcome"));
        assert.ok(layoutAfter.nodes.some((n) => n.kind === "outcome" && n.key === "UX-GHOST-1"));
      } finally {
        await client.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("v0.6.3 agent ergonomics: clean auto-track lint, multi-climb status resolution, inline last-call hints, and holdout hygiene", async () => {
    const repoDir = tempDir("hc-v063-repo-");
    const dataDir = tempDir("hc-v063-data-");
    try {
      initGitRepo(repoDir);
      const { mkdirSync } = await import("node:fs");

      // 1. Auto-track contracts pass 22-rule lintTree with 0 errors and 0 warnings even for messy goals & raw check commands
      const db = openDatabase(join(dataDir, "lint-auto.db"));
      try {
        const repo = createRepository(db);
        repo.registerProject({ id: "auto-lint", name: "Auto Lint", directory: repoDir });
        const tracker = createAutoTracker(repo);
        const makeClimb = (overrides: Partial<import("../src/repo-ops.js").ScannedClimb>): import("../src/repo-ops.js").ScannedClimb => ({
          id: `${repoDir}::${overrides.name ?? "demo"}`,
          name: "demo",
          status: "active",
          origin: "checkout",
          isLive: false,
          directory: repoDir,
          worktreeName: "main",
          workerLabel: "main checkout",
          isMainCheckout: true,
          conversationId: null,
          branch: "climb/demo",
          goal: "Checkout throughput stays above 120 req/s",
          direction: "max",
          baseline: 0.55,
          best: 0.62,
          target: 0.85,
          targetText: "0.85",
          steps: 3,
          kept: 1,
          undone: 2,
          sinceGain: 1,
          verdict: "climbing",
          sparkline: "▁█",
          check: ["SEARCH_AUTH_TOKEN=secret .venv/bin/python scripts/eval_bench.py --split dev --json-out out.json"],
          guards: ["pytest -q tests/test_core.py"],
          holdout: ".venv/bin/python scripts/eval_bench.py --split holdout",
          locked: ["scripts/eval_bench.py"],
          scoreMode: null,
          rows: [],
          notes: null,
          bestCommit: null,
          preparedFiles: 0,
          preparedSampleFiles: [],
          updatedAt: new Date().toISOString(),
          ...overrides,
        });

        const cleanContract = buildOutcomeContract(makeClimb({ name: "checkout-speed", goal: "Checkout throughput stays above 120 req/s" }));
        assert.equal(cleanContract.title, "Checkout throughput stays above 120 req/s");

        tracker.syncScannedClimbs("auto-lint", {
          projectDirectory: repoDir,
          engineInstalled: true,
          engineDrift: "current",
          worktreesScanned: 1,
          currentCount: 4,
          archivedCount: 0,
          warnings: [],
          climbs: [
            makeClimb({ name: "checkout-speed", goal: "Checkout throughput stays above 120 req/s" }),
            makeClimb({ name: "messy-eval", goal: "Fix slow build in scripts/eval.py --timeout=200ms (2025-01-01)" }),
            makeClimb({ name: "bug-regression", goal: "Bug: no longer crashes with 500 on checkout" }),
            makeClimb({ name: "fix-slow-queries", status: "prepared", goal: null, baseline: null, best: null, target: null, targetText: null, steps: 0, kept: 0, undone: 0, preparedFiles: 2 }),
          ],
        });

        const snap = repo.view("auto-lint", "main");
        const lint = lintTree(snap);
        assert.equal(lint.errorCount, 0, `Expected 0 lint errors on auto-tracked climbs, got: ${JSON.stringify(lint.findings)}`);
        assert.equal(lint.warningCount, 0, `Expected 0 lint warnings on auto-tracked climbs, got: ${JSON.stringify(lint.findings)}`);
        assert.equal(lint.passed, true);
      } finally {
        db.close();
      }

      // 2. Multi-climb hillclimb_status: summarizes on main, auto-resolves checked-out climb/<name> branch
      const writeFakeClimb = (name: string, baseline: number, best: number, target: number) => {
        const dir = join(repoDir, ".hill-climb", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "card.json"),
          JSON.stringify({
            name,
            goal: `${name} metric meets target`,
            branch: `climb/${name}`,
            base: "main",
            check: ["echo 1"],
            direction: "max",
            baseline,
            best: { score: best, step: 1 },
            target,
          }),
          "utf8",
        );
        writeFileSync(
          join(dir, "log.jsonl"),
          `${JSON.stringify({ kind: "baseline", score: baseline, time: "2026-11-27T10:00:00Z" })}\n${JSON.stringify({ kind: "step", step: 1, result: "kept", score: best, idea: "first gain", time: "2026-11-27T10:05:00Z" })}\n`,
          "utf8",
        );
      };
      writeFakeClimb("alpha", 0.4, 0.55, 0.8);
      writeFakeClimb("beta", 0.5, 0.72, 0.9);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs")],
        env: { ...process.env, HILLCLIMB_DATA_DIR: dataDir },
      });
      const client = new Client({ name: "v063-test-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        // On main with 2 climbs: hillclimb_status without name succeeds with compact overview instead of throwing
        const multiRes = await client.callTool({
          name: "hillclimb_status",
          arguments: { directory: repoDir },
        });
        assert.ok(!multiRes.isError, `Expected non-error multi-climb status, got: ${JSON.stringify(multiRes)}`);
        const multiData = multiRes.structuredContent as { multiple?: boolean; branch?: string; climbs?: Array<{ name: string }> };
        assert.equal(multiData.multiple, true);
        assert.equal(multiData.branch, "main");
        assert.deepEqual((multiData.climbs ?? []).map((c) => c.name).sort(), ["alpha", "beta"]);

        // Switch to climb/beta branch: hillclimb_status and hillclimb_card without name auto-resolve beta!
        execFileSync("git", ["checkout", "-q", "-b", "climb/beta"], { cwd: repoDir });
        const branchStatus = await client.callTool({
          name: "hillclimb_status",
          arguments: { directory: repoDir },
        });
        assert.ok(!branchStatus.isError, `Expected branch-resolved status, got: ${JSON.stringify(branchStatus)}`);
        assert.equal((branchStatus.structuredContent as { name?: string; best?: number }).name, "beta");
        assert.equal((branchStatus.structuredContent as { best?: number }).best, 0.72);

        const branchCard = await client.callTool({
          name: "hillclimb_card",
          arguments: { directory: repoDir },
        });
        assert.ok(!branchCard.isError);
        assert.equal((branchCard.structuredContent as { name?: string }).name, "beta");

        // 3. Inline-card tools return explicit "Stop calling tools and yield" next hint
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "ergo-demo",
            action: { op: "create_goal", key: "G-ERGO", parentGoalKey: null, title: "Agents stay reliable", brief: "Keep agent UX frictionless." },
          },
        });
        const propRes = await client.callTool({
          name: "hillclimb_propose_change",
          arguments: {
            projectId: "ergo-demo",
            key: "ERGO-1",
            goalKey: "G-ERGO",
            contract: {
              title: "Inline cards stay visible",
              story: "As a user, I want inline decision cards to stay visible, so that I can approve right in chat.",
              criteria: [{ id: "ac1", given: "a proposal", when: "the agent yields", then: "the inline card remains visible" }],
            },
          },
        });
        assert.match(String((propRes.structuredContent as { next?: string }).next), /Stop calling tools and yield/i);

        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "ergo-demo",
            action: {
              op: "create_outcome",
              key: "ERGO-Q",
              goalKey: "G-ERGO",
              contract: {
                title: "Questions stay visible inline",
                story: "As a user, I want question cards to stay visible, so that I can click an option.",
                criteria: [{ id: "ac1", given: "a question", when: "the agent yields", then: "the option card stays visible" }],
              },
            },
          },
        });
        const qRes = await client.callTool({
          name: "hillclimb_comment",
          arguments: {
            projectId: "ergo-demo",
            key: "ERGO-Q",
            text: "Pick a strategy",
            options: ["Fast", "Thorough"],
          },
        });
        assert.match(String((qRes.structuredContent as { next?: string }).next), /Stop calling tools and yield/i);

        const designRes = await client.callTool({
          name: "hillclimb_design",
          arguments: {
            mode: "propose",
            projectId: "ergo-demo",
            flowName: "Ergo Flow",
            frames: [{ title: "Step 1", key: "ERGO-Q", criterionId: "ac1", html: "<div>Preview</div>" }],
          },
        });
        assert.match(String((designRes.structuredContent as { next?: string }).next), /Stop calling tools and yield/i);
      } finally {
        await client.close();
      }

      // 4. Rules & docs document inline-card last-call rule and blind holdout hygiene
      const rulesMd = readFileSync(join(PLUGIN_ROOT, "rules", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "SKILL.md"), "utf8");
      const checksMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "references", "checks.md"), "utf8");
      assert.match(rulesMd, /FINAL tool step/i);
      assert.match(rulesMd, /holdout/i);
      assert.match(skillMd, /FINAL tool call/i);
      assert.match(skillMd, /only the aggregate score/i);
      assert.match(checksMd, /Holdout hygiene/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.6.4 inner-loop ergonomics: climb.py branch auto-resolution, stdout-first failure headline, graceful holdout init failure, starter notes.md, and engine-drift warning", async () => {
    const repoDir = tempDir("hc-v064-repo-");
    const dataDir = tempDir("hc-v064-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");

      writeFileSync(
        join(repoDir, "check_metric.py"),
        [
          "import sys, app",
          "mode = sys.argv[1] if len(sys.argv) > 1 else 'dev'",
          "if mode == 'holdout':",
          "    print('INFRA_INVALID: valid=3/4 invalid=[case_x]')",
          "    print('0.0000')",
          "    print('2026-11-27 12:01:00 INFO noisy stderr log line', file=sys.stderr)",
          "    sys.exit(2)",
          "val = app.value()",
          "if val < 0:",
          "    print('INFRA_INVALID: valid=4/5 invalid=[case_b]')",
          "    print('0.0000')",
          "    for i in range(8):",
          "        print(f'2026-11-27 12:28:0{i} INFO HTTP Request: GET https://example.test/item/{i}', file=sys.stderr)",
          "    sys.exit(2)",
          "print(val)",
        ].join("\n") + "\n",
        "utf8",
      );
      execFileSync("git", ["add", "check_metric.py"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "add check_metric"], { cwd: repoDir });

      // 1. Initialize first climb on climb/first, then return to main and init second climb with failing holdout
      execFileSync(
        "python3",
        [
          climbPy, "init", "first",
          "--goal", "lower value on first",
          "--check", "python3 -B check_metric.py dev",
          "--direction", "min",
          "--target", "0",
          "--lock", "check_metric.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      execFileSync("git", ["switch", "-q", "main"], { cwd: repoDir });
      const initSecondOut = execFileSync(
        "python3",
        [
          climbPy, "init", "second",
          "--goal", "lower value on second",
          "--check", "python3 -B check_metric.py dev",
          "--holdout", "python3 -B check_metric.py holdout",
          "--direction", "min",
          "--target", "0",
          "--lock", "check_metric.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      // Graceful holdout init failure: exit 0, warns with stdout-first headline, gives recovery command, seeds notes.md
      assert.match(initSecondOut, /Warning: holdout baseline failed \(check exited 2: INFRA_INVALID: valid=3\/4 invalid=\[case_x\]/);
      assert.match(initSecondOut, /climb\.py holdout second --why baseline/);
      assert.ok(existsSync(join(repoDir, ".hill-climb", "second", "notes.md")), "init should seed starter notes.md");

      // 2. Checked out on climb/second in a 2-climb repo: climb.py status and climb.py try auto-resolve WITHOUT --name!
      const pyStatusOut = execFileSync("python3", [climbPy, "status"], { cwd: repoDir, encoding: "utf8" });
      assert.match(pyStatusOut, /^Climb second on climb\/second:/);
      assert.match(pyStatusOut, /Holdout baseline missing — do not inspect holdout files; run: climb\.py holdout second --why baseline/);

      // Trigger a failing step (val = -1) with stdout INFRA_INVALID + noisy stderr logs
      writeFileSync(join(repoDir, "app.py"), "def value():\n    return -1\n", "utf8");
      const tryOut = execFileSync("python3", [climbPy, "try", "trigger infra error"], { cwd: repoDir, encoding: "utf8" });
      assert.match(tryOut, /step 1 broke/);
      assert.match(tryOut, /check exited 2: INFRA_INVALID: valid=4\/5 invalid=\[case_b\]/);

      // Verify log.jsonl and TS getClimbStatus capture the real stdout INFRA_INVALID headline, not noisy stderr
      const statusNow = getClimbStatus(repoDir);
      assert.equal(statusNow.summary.name, "second");
      assert.equal(statusNow.engineDrift, "current");
      assert.match(statusNow.text, /Holdout baseline missing/);
      assert.match(statusNow.text, /INFRA_INVALID: valid=4\/5 invalid=\[case_b\]/);
      assert.doesNotMatch(statusNow.text, /HTTP Request: GET/);

      // 3. Engine drift detection: locally modifying climb.py triggers engineDrift === "diverged"
      const origEngine = readFileSync(climbPy, "utf8");
      writeFileSync(climbPy, `${origEngine}\n# local drift test\n`, "utf8");
      const drifted = getClimbStatus(repoDir);
      assert.equal(drifted.engineDrift, "diverged");
      assert.match(drifted.textWithNext, /differs from the bundled Hill Climb plugin engine/);
      assert.doesNotMatch(drifted.text, /differs from the bundled Hill Climb plugin engine/, "raw status text stays parity-clean");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.7.0 anti-excuse & holdout-transfer guardrails: review plateau/skeptic gates, overfit warnings, holdout-regression confirms block, and early-release notice", async () => {
    const repoDir = tempDir("hc-v070-repo-");
    const dataDir = tempDir("hc-v070-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");

      writeFileSync(join(repoDir, "app.py"), "def dev_score():\n    return 0.50\ndef holdout_score():\n    return 0.60\n", "utf8");
      writeFileSync(
        join(repoDir, "check_transfer.py"),
        "import sys, app\nprint(app.holdout_score() if len(sys.argv) > 1 and sys.argv[1] == 'holdout' else app.dev_score())\n",
        "utf8",
      );
      execFileSync("git", ["add", "app.py", "check_transfer.py"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed dev and holdout scores"], { cwd: repoDir });

      execFileSync(
        "python3",
        [
          climbPy, "init", "email-cov",
          "--goal", "Reach 0.75 verified email coverage",
          "--check", "python3 -B check_transfer.py dev",
          "--holdout", "python3 -B check_transfer.py holdout",
          "--direction", "max",
          "--target", "0.75",
          "--lock", "check_transfer.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      // Step 1 (kept): dev 0.50 -> 0.65, holdout stays flat at 0.60
      writeFileSync(join(repoDir, "app.py"), "def dev_score():\n    return 0.65\ndef holdout_score():\n    return 0.60\n", "utf8");
      execFileSync("python3", [climbPy, "try", "improve dev to 0.65"], { cwd: repoDir, encoding: "utf8" });

      // Step 2 (undone): sinceGain = 1 (nowhere near PLATEAU = 5)
      writeFileSync(join(repoDir, "app.py"), "def dev_score():\n    return 0.64\ndef holdout_score():\n    return 0.60\n", "utf8");
      execFileSync("python3", [climbPy, "try", "small regression"], { cwd: repoDir, encoding: "utf8" });

      // 1. Premature review before PLATEAU is refused!
      const earlyRev = spawnSync("python3", [climbPy, "review", "Physical ceiling reached, requires paid vendor API key"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.notEqual(earlyRev.status, 0);
      assert.match(earlyRev.stderr, /Too early for a blocker review/);

      // 2. Ceiling / vendor excuse with --force but without --skeptic is STILL refused!
      const noSkeptic = spawnSync("python3", [climbPy, "review", "--force", "Physical ceiling reached, requires paid vendor API key"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.notEqual(noSkeptic.status, 0);
      assert.match(noSkeptic.stderr, /without an independent first-principles audit/);

      // 3. Ceiling / vendor excuse with substantive --skeptic succeeds and reminds about human approval below target!
      const withSkeptic = execFileSync(
        "python3",
        [
          climbPy, "review", "--force",
          "Physical ceiling after exhausting local pipeline fixes",
          "--skeptic", "Fresh skeptic subagent audited raw queries, raw uncached API responses, and official docs across 5 missed cases",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      assert.match(withSkeptic, /Review logged after step 2/);
      assert.match(withSkeptic, /Humans own abandoning --target/);

      // 4. Flat holdout (dev +0.15, holdout +0.00) triggers OVERFIT WARNING in climb.py holdout, climb.py status, and TS getClimbStatus
      const flatHoldout = execFileSync("python3", [climbPy, "holdout", "--why", "final"], { cwd: repoDir, encoding: "utf8" });
      assert.match(flatHoldout, /Holdout 0\.6 -> 0\.6 \(\+0\), visible 0\.5 -> 0\.65 \(\+0\.15\)/);
      assert.match(flatHoldout, /OVERFIT WARNING: visible improved 0\.5 -> 0\.65 \(\+0\.15\) while holdout stayed flat \(zero transfer\) 0\.6 -> 0\.6 \(\+0\)/);

      const statusFlat = getClimbStatus(repoDir);
      assert.equal(statusFlat.summary.holdoutGain, 0);
      assert.match(statusFlat.summary.holdoutWarning ?? "", /OVERFIT WARNING/);
      assert.match(statusFlat.text, /OVERFIT WARNING/);

      // 5. MCP integration: hillclimb_add_evidence warns on flat holdout, blocks on regressed holdout, and hillclimb_release warns when below target
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs")],
        env: { ...process.env, HILLCLIMB_DATA_DIR: dataDir },
      });
      const client = new Client({ name: "v070-test-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        await client.callTool({ name: "hillclimb_projects", arguments: { id: "v070", name: "V070", registerDirectory: repoDir } });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "v070",
            action: { op: "create_goal", key: "CLIMBS", parentGoalKey: null, title: "Tracked climbs", brief: "Tracked repo climbs." },
          },
        });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "v070",
            action: {
              op: "create_outcome",
              key: "EMAIL-COV",
              goalKey: "CLIMBS",
              contract: {
                title: "Verified email coverage reaches target",
                story: "As a rep, I want verified corporate emails on admitted accounts, so that outreach reaches buyers.",
                criteria: [
                  { id: "ac1", given: "dev corpus", when: "evaluated", then: "reaches 0.75" },
                  { id: "ac2", given: "unseen holdout corpus", when: "evaluated after climb", then: "holdout generalizes without regressing" },
                ],
              },
            },
          },
        });
        // Trigger auto-track link between email-cov climb and EMAIL-COV outcome
        await client.callTool({ name: "app_tree", arguments: { projectId: "v070", force: true } });

        // Flat holdout -> confirms on ac2 returns overfitWarning
        const flatEv = await client.callTool({
          name: "hillclimb_add_evidence",
          arguments: {
            projectId: "v070",
            key: "EMAIL-COV",
            kind: "confirms",
            criterionIds: ["ac2"],
            text: "Holdout measured 0.60 vs 0.60 baseline",
            source: "climb.py:email-cov",
          },
        });
        assert.ok(!flatEv.isError);
        assert.match(String((flatEv.structuredContent as { overfitWarning?: string }).overfitWarning ?? ""), /OVERFIT WARNING/);

        // Claim and release while still unverified & below target -> belowTargetNotice
        await client.callTool({ name: "hillclimb_claim", arguments: { projectId: "v070", key: "EMAIL-COV" } });
        const rel = await client.callTool({ name: "hillclimb_release", arguments: { projectId: "v070", key: "EMAIL-COV" } });
        assert.ok(!rel.isError);
        assert.match(String((rel.structuredContent as { belowTargetNotice?: string }).belowTargetNotice ?? ""), /Humans own abandoning --target/);

        // Regressed holdout (0.60 -> 0.52 while dev improved 0.50 -> 0.68) -> hard-refuses confirms on holdout criterion!
        writeFileSync(join(repoDir, "app.py"), "def dev_score():\n    return 0.68\ndef holdout_score():\n    return 0.52\n", "utf8");
        execFileSync("python3", [climbPy, "try", "overfit dev while regressing holdout"], { cwd: repoDir, encoding: "utf8" });
        const regHoldout = execFileSync("python3", [climbPy, "holdout", "--why", "recheck"], { cwd: repoDir, encoding: "utf8" });
        assert.match(regHoldout, /OVERFIT WARNING:.*holdout regressed 0\.6 -> 0\.52 \(-0\.08\)/);

        const regEv = await client.callTool({
          name: "hillclimb_add_evidence",
          arguments: {
            projectId: "v070",
            key: "EMAIL-COV",
            kind: "confirms",
            criterionIds: ["ac2"],
            text: "Holdout check completed",
            source: "climb.py:email-cov",
          },
        });
        assert.equal(regEv.isError, true, "Regressed holdout must block confirms on holdout criterion");
        const regErrText = (regEv.content as Array<{ text?: string }>)[0]?.text ?? "";
        assert.match(regErrText, /Cannot record confirms evidence for a holdout criterion/);
      } finally {
        await client.close();
      }

      // 6. Verify rules & docs encode the Skeptic Audit, untrusted notes, and human bar-abandonment rules
      const rulesMd = readFileSync(join(PLUGIN_ROOT, "rules", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "SKILL.md"), "utf8");
      const climbingMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "references", "climbing.md"), "utf8");
      assert.match(rulesMd, /Skeptic gate/i);
      assert.match(rulesMd, /Humans own abandoning a bar/i);
      assert.match(skillMd, /Skeptic Audit/i);
      assert.match(skillMd, /OVERFIT WARNING/i);
      assert.match(climbingMd, /Never declare your own ceiling/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.7.1 live-field upgrades: propose_change lint, contract-vs-check drift, de-noised auto-track, behind-base warning, fast-fail guards, near-miss variance, and UI engine upgrade", async () => {
    const repoDir = tempDir("hc-v071-repo-");
    const dataDir = tempDir("hc-v071-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      const markerPath = join(dataDir, "check-ran-marker");

      writeFileSync(join(repoDir, "app.py"), "def score():\n    return 0.50\ndef guard_ok():\n    return True\n", "utf8");
      writeFileSync(
        join(repoDir, "check_v071.py"),
        `import pathlib, app\npathlib.Path(${JSON.stringify(markerPath)}).write_text("ran")\nprint(app.score())\n`,
        "utf8",
      );
      writeFileSync(join(repoDir, "guard_v071.py"), "import sys, app\nsys.exit(0 if app.guard_ok() else 1)\n", "utf8");
      execFileSync("git", ["add", "app.py", "check_v071.py", "guard_v071.py"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed v071 check and guard"], { cwd: repoDir });

      execFileSync(
        "python3",
        [
          climbPy, "init", "cov-climb",
          "--goal", "Reach 0.80 coverage",
          "--check", "python3 -B check_v071.py",
          "--guard", "python3 -B guard_v071.py",
          "--direction", "max",
          "--target", "0.80",
          "--min-gain", "0.020",
          "--lock", "check_v071.py",
          "--lock", "guard_v071.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      // 1. Fast-fail --guards-first: broken guard undoes BEFORE running check!
      rmSync(markerPath, { force: true });
      writeFileSync(join(repoDir, "app.py"), "def score():\n    return 0.90\ndef guard_ok():\n    return False\n", "utf8");
      const preFail = execFileSync("python3", [climbPy, "try", "--guards-first", "broken guard edit"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(preFail, /pre-check guard failed/);
      assert.ok(!existsSync(markerPath), "slow check must not execute when pre-check guard fails");

      // 2. Near-miss variance signal: 0.505 > 0.50 but +0.005 < min_gain 0.020
      writeFileSync(join(repoDir, "app.py"), "def score():\n    return 0.505\ndef guard_ok():\n    return True\n", "utf8");
      const nearMiss = execFileSync("python3", [climbPy, "try", "tiny improvement"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(nearMiss, /below min_gain \(\+0\.005 < 0\.02/);

      // 3. Advance main by 1 commit so climb/cov-climb is 1 commit behind main -> behindBase warning!
      execFileSync("git", ["switch", "-q", "main"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README.txt"), "main moved ahead\n", "utf8");
      execFileSync("git", ["add", "README.txt"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "advance main"], { cwd: repoDir });
      execFileSync("git", ["switch", "-q", "climb/cov-climb"], { cwd: repoDir });

      const pySt = execFileSync("python3", [climbPy, "status"], { cwd: repoDir, encoding: "utf8" });
      assert.match(pySt, /Branch warning: climb\/cov-climb is 1 commit behind main/);
      const tsSt = getClimbStatus(repoDir);
      assert.equal(tsSt.behindBase, 1);
      assert.match(tsSt.textWithNext, /Branch warning: climb\/cov-climb is 1 commit behind main/);

      // Drift local engine to verify UI + outcome drift detection + one-click upgrade
      const origClimb = readFileSync(climbPy, "utf8");
      writeFileSync(climbPy, `${origClimb}\n# outdated local fork\n`, "utf8");

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs")],
        env: { ...process.env, HILLCLIMB_DATA_DIR: dataDir },
      });
      const client = new Client({ name: "v071-test-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        await client.callTool({ name: "hillclimb_projects", arguments: { id: "v071", name: "V071", registerDirectory: repoDir } });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "v071",
            action: { op: "create_goal", key: "CLIMBS", parentGoalKey: null, title: "Tracked climbs", brief: "Tracked repo climbs." },
          },
        });
        await client.callTool({
          name: "hillclimb_act",
          arguments: {
            projectId: "v071",
            action: {
              op: "create_outcome",
              key: "COV-CLIMB",
              goalKey: "CLIMBS",
              contract: {
                title: "Coverage reaches target",
                story: "As a maintainer, I want coverage to reach 80%, so that regressions are caught.",
                criteria: [{ id: "ac1", given: "dev suite", when: "evaluated", then: "coverage reaches 0.80" }],
              },
            },
          },
        });

        // Initial sync links cov-climb -> COV-CLIMB and writes 1 baseline/update note
        await client.callTool({ name: "app_tree", arguments: { projectId: "v071", force: true } });
        const out1 = (await client.callTool({ name: "hillclimb_outcome", arguments: { projectId: "v071", key: "COV-CLIMB" } })).structuredContent as {
          evidence: { total: number };
          linkedClimb?: { engineDrift?: string; behindBase?: number; contractCheckDrift?: string };
        };
        const evCountBefore = out1.evidence.total;
        assert.equal(out1.linkedClimb?.engineDrift, "diverged");
        assert.equal(out1.linkedClimb?.behindBase, 1);

        // 4. Another flat undone step must NOT add a duplicate note to evidence ledger!
        writeFileSync(join(repoDir, "app.py"), "def score():\n    return 0.49\ndef guard_ok():\n    return True\n", "utf8");
        execFileSync("python3", [climbPy, "try", "flat regression"], { cwd: repoDir, encoding: "utf8" });
        await client.callTool({ name: "app_tree", arguments: { projectId: "v071", force: true } });
        const out2 = (await client.callTool({ name: "hillclimb_outcome", arguments: { projectId: "v071", key: "COV-CLIMB" } })).structuredContent as {
          evidence: { total: number };
        };
        assert.equal(out2.evidence.total, evCountBefore, "undone flat step should not spam redundant note evidence");

        // Kept step MUST add a note!
        writeFileSync(join(repoDir, "app.py"), "def score():\n    return 0.65\ndef guard_ok():\n    return True\n", "utf8");
        execFileSync("python3", [climbPy, "try", "real gain to 0.65"], { cwd: repoDir, encoding: "utf8" });
        await client.callTool({ name: "app_tree", arguments: { projectId: "v071", force: true } });
        const out3 = (await client.callTool({ name: "hillclimb_outcome", arguments: { projectId: "v071", key: "COV-CLIMB" } })).structuredContent as {
          evidence: { total: number };
        };
        assert.equal(out3.evidence.total, evCountBefore + 1, "kept win must record progress note");

        // 5. propose_change runs 22-rule lintOutcome (catches O2 missing ", so that ...")
        const badProp = (await client.callTool({
          name: "hillclimb_propose_change",
          arguments: {
            projectId: "v071",
            key: "COV-CLIMB",
            contract: {
              title: "Coverage reaches target with fallback",
              story: "As a maintainer, I want coverage to reach 80% with fallback.",
              criteria: [{ id: "ac1", given: "dev suite", when: "evaluated", then: "coverage reaches 0.80" }],
            },
          },
        })).structuredContent as { proposed?: string; lint?: { passed: boolean; errorCount: number; findings: Array<{ checkCode: string }> } };
        assert.equal(badProp.lint?.passed, false);
        assert.equal(badProp.lint?.errorCount, 1);
        assert.equal(badProp.lint?.findings[0]?.checkCode, "O2");

        // Approve v2 -> hillclimb_outcome surfaces contractCheckDrift (reminding about relock)!
        await client.callTool({
          name: "app_act",
          arguments: { projectId: "v071", action: { op: "approve_change", id: badProp.proposed! }, confirmed: true },
        });
        const outV2 = (await client.callTool({ name: "hillclimb_outcome", arguments: { projectId: "v071", key: "COV-CLIMB" } })).structuredContent as {
          version: number;
          linkedClimb?: { contractCheckDrift?: string };
        };
        assert.equal(outV2.version, 2);
        assert.match(outV2.linkedClimb?.contractCheckDrift ?? "", /updated to v2.*climb\.py relock/);

        // 6. UI one-click engine upgrade via app_repo_climbs(upgradeEngine: true) restores engineDrift === "current"
        const beforeUp = (await client.callTool({ name: "app_repo_climbs", arguments: { projectId: "v071", force: true } })).structuredContent as {
          engineDrift?: string;
        };
        assert.equal(beforeUp.engineDrift, "diverged");
        const afterUp = (await client.callTool({
          name: "app_repo_climbs",
          arguments: { projectId: "v071", force: true, upgradeEngine: true },
        })).structuredContent as { engineDrift?: string };
        assert.equal(afterUp.engineDrift, "current");
      } finally {
        await client.close();
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.8.0 plateau-breaker engine & MCP diagnostics: --probe fast slice, ZERO-CASE-CHANGE & CANCEL-OUT diffs, bundled-diff warning, THRASH vs STALL, stale notes.md, and compaction-proof card", async () => {
    const repoDir = tempDir("hc-v080-repo-");
    const dataDir = tempDir("hc-v080-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      const markerPath = join(dataDir, "full-check-ran");

      writeFileSync(
        join(repoDir, "solver.py"),
        "CASE_A = 0.50\nCASE_B = 0.80\nPROBE_OK = True\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "probe_slice.py"),
        "import sys, solver\nsys.exit(0 if solver.PROBE_OK else 1)\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "check_cases.py"),
        [
          "import pathlib, solver",
          `pathlib.Path(${JSON.stringify(markerPath)}).write_text("ran")`,
          'print(f"SUMMARY alpha={solver.CASE_A:.3f} beta={solver.CASE_B:.3f}")',
          'print(f"{(solver.CASE_A + solver.CASE_B) / 2:.4f}")',
        ].join("\n") + "\n",
        "utf8",
      );
      execFileSync("git", ["add", "solver.py", "probe_slice.py", "check_cases.py"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed v080 multi-case check and probe"], { cwd: repoDir });

      execFileSync(
        "python3",
        [
          climbPy, "init", "plateau-demo",
          "--goal", "Reach 0.85 multi-case mean",
          "--check", "python3 -B check_cases.py",
          "--probe", "python3 -B probe_slice.py",
          "--direction", "max",
          "--target", "0.85",
          "--min-gain", "0.010",
          "--lock", "check_cases.py",
          "--lock", "probe_slice.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );

      // 1. Structured starter notes.md + Probe recorded in card.json / getClimbCard
      const notesPath = join(repoDir, ".hill-climb", "plateau-demo", "notes.md");
      const starterNotes = readFileSync(notesPath, "utf8");
      assert.match(starterNotes, /Remaining Misses \(Pareto\)/);
      assert.match(starterNotes, /Dead Ends \(Do Not Retry Unchanged\)/);
      const initCard = getClimbCard(repoDir, "plateau-demo");
      assert.equal(initCard.data.probe, "python3 -B probe_slice.py");
      assert.match(initCard.text, /Probe\s+python3 -B probe_slice\.py/);

      // 2. Fast inner-inner --probe fails BEFORE full check runs!
      rmSync(markerPath, { force: true });
      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.90\nCASE_B = 0.90\nPROBE_OK = False\n", "utf8");
      const probeFail = execFileSync("python3", [climbPy, "try", "parser domain proof attempt 1"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(probeFail, /pre-check probe failed/);
      assert.ok(!existsSync(markerPath), "full check must not run when fast --probe fails");

      // 3. ZERO-CASE-CHANGE + BUNDLED DIFF WARNING (>150 changed lines during stall)
      const filler = Array.from({ length: 165 }, (_, i) => `# comment line ${i}`).join("\n");
      writeFileSync(join(repoDir, "solver.py"), `CASE_A = 0.50\nCASE_B = 0.80\nPROBE_OK = True\n${filler}\n`, "utf8");
      const zeroChange = execFileSync("python3", [climbPy, "try", "parser domain proof calibration threshold"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(zeroChange, /ZERO-CASE-CHANGE/);
      assert.match(zeroChange, /BUNDLED DIFF WARNING/);

      // 4. CANCEL-OUT / TRADE-OFF + THRASH DETECTED (3rd consecutive repetitive undone step) + Notes warning!
      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.70\nCASE_B = 0.60\nPROBE_OK = True\n", "utf8");
      const cancelOut = execFileSync("python3", [climbPy, "try", "parser domain proof fallback tuning"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(cancelOut, /CANCEL-OUT \/ TRADE-OFF/);
      assert.match(cancelOut, /alpha 0\.5 -> 0\.7 \(\+0\.2\)/);
      assert.match(cancelOut, /beta 0\.8 -> 0\.6 \(-0\.2\)/);
      assert.match(cancelOut, /THRASH DETECTED/);
      assert.match(cancelOut, /Notes warning: notes\.md has not been updated in 3 step\(s\)/);

      // Verify status, TS summary, card, and MCP outcome all mirror thrashWarning & notesWarning
      const pyStatus = execFileSync("python3", [climbPy, "status"], { cwd: repoDir, encoding: "utf8" });
      assert.match(pyStatus, /THRASH DETECTED/);
      assert.match(pyStatus, /Notes warning/);

      const tsStatus = getClimbStatus(repoDir, "plateau-demo");
      assert.match(tsStatus.summary.thrashWarning ?? "", /THRASH DETECTED/);
      assert.equal(tsStatus.summary.stallWarning, null, "thrash supersedes generic stall");
      assert.equal(tsStatus.summary.notesStaleSteps, 3);
      assert.match(tsStatus.summary.notesWarning ?? "", /Notes warning/);
      assert.match(tsStatus.text, /THRASH DETECTED/);

      const cardAfterStall = getClimbCard(repoDir, "plateau-demo");
      assert.match(cardAfterStall.data.thrashWarning ?? "", /THRASH DETECTED/);
      assert.match(cardAfterStall.data.notesWarning ?? "", /Notes warning/);
      assert.match(cardAfterStall.text, /THRASH DETECTED/);

      // Verify hillclimb_outcome surfaces thrashWarning & notesWarning on linkedClimb
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs")],
        env: { ...process.env, HILLCLIMB_DATA_DIR: dataDir },
      });
      const client = new Client({ name: "v080-test-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        await client.callTool({ name: "hillclimb_projects", arguments: { id: "v080", name: "V080", registerDirectory: repoDir } });
        await client.callTool({ name: "app_tree", arguments: { projectId: "v080", force: true } });
        const out = (await client.callTool({
          name: "hillclimb_outcome",
          arguments: { projectId: "v080", key: "PLATEAU-DEMO" },
        })).structuredContent as { linkedClimb?: { thrashWarning?: string; notesWarning?: string } };
        assert.match(out.linkedClimb?.thrashWarning ?? "", /THRASH DETECTED/);
        assert.match(out.linkedClimb?.notesWarning ?? "", /Notes warning/);
      } finally {
        await client.close();
      }

      // 5. Updating notes.md clears notesWarning; 3 orthogonal undone steps emit STALL (not THRASH)
      writeFileSync(
        notesPath,
        "# plateau-demo notes\n\n## Remaining Misses (Pareto)\n| Bucket | Count |\n| --- | --- |\n| alpha | 1 |\n\n## Dead Ends\n- parser domain proof\n",
        "utf8",
      );
      // Force one kept step so bestStep resets, then try 3 orthogonal undone edits
      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.65\nCASE_B = 0.80\nPROBE_OK = True\n", "utf8");
      const kept = execFileSync("python3", [climbPy, "try", "unlock alpha registry lookup"], { cwd: repoDir, encoding: "utf8" });
      assert.match(kept, /kept/);
      // Refresh notes mtime AFTER kept step
      writeFileSync(
        notesPath,
        "# plateau-demo notes\n\n## Remaining Misses (Pareto)\n- alpha: 0.65, beta: 0.80\n## Dead Ends\n- parser domain proof\n",
        "utf8",
      );

      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.65\nCASE_B = 0.79\nPROBE_OK = True\n", "utf8");
      execFileSync("python3", [climbPy, "try", "vectorize matrix transpose kernel"], { cwd: repoDir, encoding: "utf8" });
      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.64\nCASE_B = 0.80\nPROBE_OK = True\n", "utf8");
      execFileSync("python3", [climbPy, "try", "compress telemetry sqlite wal"], { cwd: repoDir, encoding: "utf8" });
      writeFileSync(join(repoDir, "solver.py"), "CASE_A = 0.65\nCASE_B = 0.78\nPROBE_OK = True\n", "utf8");
      const stallOut = execFileSync("python3", [climbPy, "try", "prefetch graphql schema fragments"], { cwd: repoDir, encoding: "utf8" });
      assert.match(stallOut, /STALL: 3 steps without gain/);
      assert.doesNotMatch(stallOut, /THRASH DETECTED/);

      // 6. Verify plugin rules & skill docs encode v0.8.0 plateau-breaker discipline
      const agentsMd = readFileSync(join(PLUGIN_ROOT, "rules", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "SKILL.md"), "utf8");
      const climbingMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "references", "climbing.md"), "utf8");
      assert.match(agentsMd, /--probe/);
      assert.match(agentsMd, /THRASH DETECTED/);
      assert.match(skillMd, /Parallel Orthogonal Tournament/);
      assert.match(climbingMd, /Breaking through plateaus/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("v0.9.0 generalized win-audit & generalization gates: --holdout-every checkpoints, HOLDOUT CHECKPOINT DUE, relock Anti-Goodhart ledger, check-noise, and climb.py audit case-ID leak scanner", async () => {
    const repoDir = tempDir("hc-v090-repo-");
    const dataDir = tempDir("hc-v090-data-");
    try {
      initGitRepo(repoDir);
      installEngine(repoDir);
      const climbPy = join(repoDir, ".hill-climb", "engine", "climb.py");
      const noiseCounter = join(dataDir, "noise-counter.txt");

      writeFileSync(
        join(repoDir, "engine.py"),
        'DEV_A = 0.50\nDEV_B = 0.50\nHOLDOUT = 0.50\nSPECIAL = []\nPREEXISTING = "catalog_feature"\n',
        "utf8",
      );
      writeFileSync(
        join(repoDir, "check_dev.py"),
        [
          "import pathlib, engine",
          `cp = pathlib.Path(${JSON.stringify(noiseCounter)})`,
          "jitter = 0.0",
          "if cp.exists():",
          "    n = int(cp.read_text().strip() or '0')",
          "    cp.write_text(str(n + 1))",
          "    jitter = [0.0, 0.04, -0.02][n % 3]",
          "a = engine.DEV_A + jitter",
          'print(f"CASES widget_case_a={a:.3f} widget_case_b={engine.DEV_B:.3f} catalog_feature=0.900")',
          'print("  pillar_signal            0.8000  (bar >= 0.55)  [PASS]")',
          'print(f"{(a + engine.DEV_B) / 2:.4f}")',
        ].join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "check_holdout.py"),
        "import engine\nprint(f'{engine.HOLDOUT:.4f}')\n",
        "utf8",
      );
      execFileSync("git", ["add", "engine.py", "check_dev.py", "check_holdout.py"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed v090 dev and holdout checks"], { cwd: repoDir });

      // 1. --holdout-every 2 auto-runs blind holdout checkpoint after 2 kept wins and catches mid-climb OVERFIT!
      execFileSync(
        "python3",
        [
          climbPy, "init", "win-audit",
          "--goal", "Reach 0.90 without overfitting",
          "--check", "python3 -B check_dev.py",
          "--holdout", "python3 -B check_holdout.py",
          "--holdout-every", "2",
          "--direction", "max",
          "--target", "0.90",
          "--min-gain", "0.010",
          "--lock", "check_dev.py",
          "--lock", "check_holdout.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      assert.equal(getClimbCard(repoDir, "win-audit").data.holdoutEvery, 2);

      // Clean deterministic check-noise
      const detNoise = execFileSync("python3", [climbPy, "check-noise", "--runs", "3"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(detNoise, /DETERMINISTIC: 0 spread/);

      // Enable artificial nondeterminism -> check-noise catches spread + jittering sub-metric!
      writeFileSync(noiseCounter, "0", "utf8");
      const noisyOut = execFileSync("python3", [climbPy, "check-noise", "--runs", "3"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(noisyOut, /NOISE WARNING/);
      assert.match(noisyOut, /Jittering sub-metrics: widget_case_a/);
      rmSync(noiseCounter, { force: true });

      // Step 1 (kept, dev=0.55, holdout still 0.50 -> 1 kept since holdout, no checkpoint yet)
      writeFileSync(join(repoDir, "engine.py"), "DEV_A = 0.60\nDEV_B = 0.50\nHOLDOUT = 0.50\nSPECIAL = []\n", "utf8");
      const s1 = execFileSync("python3", [climbPy, "try", "improve dev case a"], { cwd: repoDir, encoding: "utf8" });
      assert.match(s1, /kept/);
      assert.doesNotMatch(s1, /Holdout checkpoint:/);

      // Step 2 (kept, dev=0.60, holdout still 0.50 -> auto-checkpoint fires + OVERFIT WARNING!)
      writeFileSync(join(repoDir, "engine.py"), "DEV_A = 0.70\nDEV_B = 0.50\nHOLDOUT = 0.50\nSPECIAL = []\n", "utf8");
      const s2 = execFileSync("python3", [climbPy, "try", "overfit dev only"], { cwd: repoDir, encoding: "utf8" });
      assert.match(s2, /Holdout checkpoint: 0\.5 -> 0\.5 \(\+0\)/);
      assert.match(s2, /OVERFIT WARNING/);

      // 2. Relock records diff ledger + prints Anti-Goodhart checklist
      const checkContent = readFileSync(join(repoDir, "check_dev.py"), "utf8");
      writeFileSync(join(repoDir, "check_dev.py"), `${checkContent}# enforced qualifier\n`, "utf8");
      const relockOut = execFileSync("python3", [climbPy, "relock", "--why", "enforce v2 qualifier"], {
        cwd: repoDir,
        encoding: "utf8",
      });
      assert.match(relockOut, /Relock Anti-Goodhart Checklist:/);
      assert.match(relockOut, /1 locked file\(s\)/);
      assert.equal(getClimbStatus(repoDir, "win-audit").summary.relockCount, 1);

      // 3. Auto-extracted case-ID leak scan: hardcoding "widget_case_a" in engine.py is caught by `climb.py audit`,
      // while [PASS] summary pillar names ("pillar_signal") and pre-existing codebase terms ("catalog_feature") are NOT false positives!
      writeFileSync(
        join(repoDir, "engine.py"),
        'DEV_A = 0.80\nDEV_B = 0.60\nHOLDOUT = 0.70\nSPECIAL = ["widget_case_a", "pillar_signal", "catalog_feature"]\n',
        "utf8",
      );
      const s3 = execFileSync("python3", [climbPy, "try", "special case widget"], { cwd: repoDir, encoding: "utf8" });
      assert.match(s3, /kept/);

      const auditJson = JSON.parse(
        execFileSync("python3", [climbPy, "audit", "--json"], { cwd: repoDir, encoding: "utf8" }),
      ) as {
        case_id_leaks: Array<{ file: string; identifier: string }>;
        relocks: Array<{ files: string[]; why: string }>;
        findings: string[];
      };
      assert.equal(auditJson.case_id_leaks.length, 1);
      assert.equal(auditJson.case_id_leaks[0]?.file, "engine.py");
      assert.equal(auditJson.case_id_leaks[0]?.identifier, "widget_case_a");
      assert.equal(auditJson.relocks.length, 1);
      assert.deepEqual(auditJson.relocks[0]?.files, ["check_dev.py"]);

      // Verify exact-window transfer_ratio when first holdout ran mid-climb (not at Step 0)
      execFileSync("python3", [climbPy, "holdout", "--why", "mid-check"], { cwd: repoDir, encoding: "utf8" });
      const logPathWin = join(repoDir, ".hill-climb", "win-audit", "log.jsonl");
      const rawLogWin = readFileSync(logPathWin, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      // Remove the initial Step-0 baseline holdout so the remaining window is [visible 0.60->0.70 (+0.10), holdout 0.50->0.70 (+0.20) => ratio 2.0]
      let droppedFirstH = false;
      const midOnly = rawLogWin.filter((r) => {
        if (!droppedFirstH && r.kind === "holdout") {
          droppedFirstH = true;
          return false;
        }
        return true;
      });
      writeFileSync(logPathWin, `${midOnly.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
      const midWindowAudit = JSON.parse(
        execFileSync("python3", [climbPy, "audit", "--json"], { cwd: repoDir, encoding: "utf8" }),
      ) as { transfer_ratio: number | null };
      assert.equal(midWindowAudit.transfer_ratio, 2.0);

      // --strict must fail non-zero when case-ID leak exists!
      let strictFailed = false;
      try {
        execFileSync("python3", [climbPy, "audit", "--strict"], { cwd: repoDir, encoding: "utf8" });
      } catch {
        strictFailed = true;
      }
      assert.ok(strictFailed, "climb.py audit --strict must fail on case-ID leak");

      // 4. Standard climb without --holdout-every emits HOLDOUT CHECKPOINT DUE after 3 kept wins across CLI, TS, and MCP!
      execFileSync("git", ["switch", "-q", "main"], { cwd: repoDir });
      execFileSync(
        "python3",
        [
          climbPy, "init", "manual-cp",
          "--goal", "Reach 0.90",
          "--check", "python3 -B check_dev.py",
          "--holdout", "python3 -B check_holdout.py",
          "--direction", "max",
          "--target", "0.90",
          "--min-gain", "0.010",
          "--lock", "check_dev.py",
          "--lock", "check_holdout.py",
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      for (const [stepIdx, val] of [[1, 0.56], [2, 0.62], [3, 0.68]] as const) {
        writeFileSync(join(repoDir, "engine.py"), `DEV_A = ${val}\nDEV_B = ${val}\nHOLDOUT = ${val}\nSPECIAL = []\n`, "utf8");
        const out = execFileSync("python3", [climbPy, "try", `general improvement ${stepIdx}`], {
          cwd: repoDir,
          encoding: "utf8",
        });
        if (stepIdx === 3) assert.match(out, /HOLDOUT CHECKPOINT DUE: 3 kept step\(s\)/);
      }
      const tsManual = getClimbStatus(repoDir, "manual-cp");
      assert.equal(tsManual.summary.keptSinceHoldout, 3);
      assert.match(tsManual.summary.holdoutCheckpointWarning ?? "", /HOLDOUT CHECKPOINT DUE/);
      assert.match(getClimbCard(repoDir, "manual-cp").text, /HOLDOUT CHECKPOINT DUE/);

      // Clean audit on manual-cp has 0 case-ID leaks!
      const cleanAudit = JSON.parse(
        execFileSync("python3", [climbPy, "audit", "manual-cp", "--json"], { cwd: repoDir, encoding: "utf8" }),
      ) as { case_id_leaks: unknown[]; kept_since_holdout: number };
      assert.equal(cleanAudit.case_id_leaks.length, 0);
      assert.equal(cleanAudit.kept_since_holdout, 3);

      // Verify MCP hillclimb_outcome surfaces holdoutCheckpointWarning
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(PLUGIN_ROOT, "dist", "mcp-server.mjs")],
        env: { ...process.env, HILLCLIMB_DATA_DIR: dataDir },
      });
      const client = new Client({ name: "v090-test-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        await client.callTool({ name: "hillclimb_projects", arguments: { id: "v090", name: "V090", registerDirectory: repoDir } });
        await client.callTool({ name: "app_tree", arguments: { projectId: "v090", force: true } });
        const out = (await client.callTool({
          name: "hillclimb_outcome",
          arguments: { projectId: "v090", key: "MANUAL-CP" },
        })).structuredContent as { linkedClimb?: { holdoutCheckpointWarning?: string; relockCount?: number } };
        assert.match(out.linkedClimb?.holdoutCheckpointWarning ?? "", /HOLDOUT CHECKPOINT DUE/);
      } finally {
        await client.close();
      }

      // 5. Verify generalized rules & docs
      const agentsMd = readFileSync(join(PLUGIN_ROOT, "rules", "AGENTS.md"), "utf8");
      const skillMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "SKILL.md"), "utf8");
      const checksMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "references", "checks.md"), "utf8");
      const climbingMd = readFileSync(join(PLUGIN_ROOT, "skills", "hill-climb", "references", "climbing.md"), "utf8");
      assert.match(agentsMd, /Adversarial Win Audit/);
      assert.match(agentsMd, /check-noise/);
      assert.match(skillMd, /"\$CLIMB" audit/);
      assert.match(checksMd, /Anti-Goodhart/);
      assert.match(climbingMd, /Auditing wins/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
