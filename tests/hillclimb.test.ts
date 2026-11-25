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
import { createRuntime } from "../src/runtime.js";
import { createAutoTracker } from "../src/auto-track.js";
import { getClimbCard, getClimbList, getClimbStatus, getClimbVerdict, installEngine, scanProjectClimbs } from "../src/repo-ops.js";
import { actionSchema } from "../src/actions.js";
import { lintTree } from "../src/linter.js";
import { writeMirror } from "../src/mirror.js";
import { ingestJunitReport } from "../src/ci-ingest.js";
import { runStudyPreview } from "../src/studies.js";

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

      tracker.syncScannedClimbs("auto-proj", scanProjectClimbs(repoDir));
      view = repo.view("auto-proj");
      assert.equal(view.ranked.find((r) => r.key === "LATENCY-DROP")?.signal, "verified");
      assert.equal(view.ranked.find((r) => r.key === "LATENCY-DROP")?.claim, null);

      const live = tracker.liveForOutcome("auto-proj", "LATENCY-DROP", repoDir);
      assert.equal(live?.engine, "repo");
      assert.equal(live?.baseline, 2);
      assert.equal(live?.best, 0);
      assert.equal(live?.target, 0);
      assert.equal(live?.rows.length, 1);

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
      // Simulate `climb.py raise` changing numeric target without updating target_text
      writeFileSync(
        join(repoDir, ".hill-climb", "latency-drop", "card.json"),
        JSON.stringify({ ...origCard, target: -1, target_text: "0" }),
        "utf8",
      );
      const rescanned = scanProjectClimbs(repoDir);
      assert.equal(rescanned.climbs.length, 1, "renamed fixture folder with stale card.json must not appear as a second climb");
      assert.equal(rescanned.climbs[0]?.name, "latency-drop");
      assert.equal(rescanned.climbs[0]?.target, -1);
      assert.equal(rescanned.climbs[0]?.targetText, null, "stale target_text must not override raised numeric target");

      db.close();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
