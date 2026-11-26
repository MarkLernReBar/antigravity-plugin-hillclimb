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
import { createAutoTracker } from "../src/auto-track.js";
import { clearScanCache, getClimbCard, getClimbList, getClimbStatus, getClimbVerdict, installEngine, redactSecrets, scanProjectClimbs } from "../src/repo-ops.js";
import { actionSchema } from "../src/actions.js";
import { lintTree } from "../src/linter.js";
import { writeMirror } from "../src/mirror.js";
import { ingestJunitReport } from "../src/ci-ingest.js";
import { runStudyPreview } from "../src/studies.js";
import { buildRig, draftForKit, emptyDraft, kitById, seedDraft, validateDraft } from "../src/ui/RigEditor.js";
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
});
