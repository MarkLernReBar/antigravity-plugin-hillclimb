#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository, defaultDataDir, openDatabase, type Repository } from "./repository.js";
import { createRuntime } from "./runtime.js";
import {
  ENGINE_COMMANDS,
  formatSetupText,
  getClimbCard,
  getClimbList,
  getClimbLog,
  getClimbNotes,
  getClimbStatus,
  getClimbVerdict,
  installEngine,
  resolveRepoDirectory,
  scanProjectClimbs,
} from "./repo-ops.js";
import { climbCommand, engineDir, ENGINE_FILES } from "./engine.js";
import { actionSchema } from "./actions.js";
import { lintTree } from "./linter.js";
import { writeMirror } from "./mirror.js";
import { ingestJunitReport, postTestEvidenceBundle } from "./ci-ingest.js";
import { runStudyPreview, runStudyReport } from "./studies.js";
import { computeInsights } from "./insights.js";
import { exportShareableReport, generateArtifactFromTemplate, type ArtifactTemplateId } from "./artifacts.js";
import { blueprintActions, listBlueprints, parseMarkdownImport } from "./templates.js";
import { createAutomationEngine, ingestAlert } from "./hooks.js";
import { startLoopbackServer } from "./http-server.js";
import { HillClimbError } from "./errors.js";

const BOOLEAN_FLAGS = new Set(["json", "apply", "help", "watch", "propose"]);

export function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        options[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          options[key] = true;
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--") && next !== "-h") {
            options[key] = next;
            i++;
          } else {
            options[key] = true;
          }
        }
      }
    } else if (token === "-h") {
      options.help = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, options };
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bool(value: string | boolean | undefined): boolean {
  return value === true || value === "true" || value === "1";
}

function printHelp(): void {
  console.log(`hillclimb — Antigravity Hill Climb CLI

Repo engine commands (reads disk without running checks):
  hillclimb setup [--dir <repo>] [--json]
  hillclimb status [--name <climb>] [--dir <repo>] [--last N] [--json]
  hillclimb card [--name <climb>] [--dir <repo>] [--json]
  hillclimb list [--dir <repo>] [--json]
  hillclimb log [--name <climb>] [--dir <repo>] [--limit N] [--json]
  hillclimb notes [--name <climb>] [--dir <repo>]
  hillclimb verdict [--name <climb>] [--dir <repo>]
  hillclimb engine [--dir <repo>] [--json]

Contract tree commands:
  hillclimb projects [--register <dir>] [--name <label>] [--id <id>]
  hillclimb tree [--project <id>] [--track <name>] [--outcome <key>] [--json]
  hillclimb act '<json>' [--project <id>]
  hillclimb lint [--project <id>]
  hillclimb sync [--project <id>] [--dir <repo>] [--watch]
  hillclimb search <query> [--project <id>] [--limit N] [--json]
  hillclimb insights [--project <id>] [--days 30] [--track main] [--json]
  hillclimb export [--project <id>] [--format html|markdown] [--release <name>] [--out <file>]
  hillclimb import [--blueprint <id> | --file <md>] [--project <id>] [--propose] [--apply]
  hillclimb ingest-alert --key <K> --message <msg> --source <src> [--severity error|warning|info] [--project <id>]
  hillclimb serve [--port 4318] [--token <secret>] [--data-dir <dir>]

CI evidence & equal-budget studies:
  hillclimb ingest-junit --report <file> [--project <id>] [--dir <repo>] [--format auto|junit|json|text] [--source <url>] [--track <name>] [--prefixes HC] [--contract-frozen-at <iso>] [--apply]
  hillclimb post-test-evidence --bundle <file> [--project <id>] [--dir <repo>] [--track <name>] [--apply]
  hillclimb study-preview [spec] [--dir <folder>] [--candidates N] [--verifier-repeat N] [--trial-allowance N] [--repeats N] [--budget 15m] [--json]
  hillclimb study-report [--dir <folder>] [--artifact <file>] [--study <name>] [--run <id>] [--problem <id>] [--control <arm>] [--noise-floor N] [--json]
`);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }

  const { positionals, options } = parseArgs(rest);
  if (bool(options.help)) {
    printHelp();
    return 0;
  }

  const dbState: { repo: Repository | null } = { repo: null };
  const ensureRepo = (): Repository => {
    if (!dbState.repo) {
      const dataDir = str(options["data-dir"]) ?? defaultDataDir();
      const db = openDatabase(dataDir);
      try {
        const created = createRepository(db);
        createRuntime(created, { automatic: false });
        dbState.repo = created;
      } catch (error) {
        try {
          db.close();
        } catch {
          // ignore close error
        }
        throw error;
      }
    }
    return dbState.repo;
  };

  try {
    switch (command) {
      case "setup": {
        const dir = resolveRepoDirectory(str(options.dir));
        const result = installEngine(dir);
        console.log(bool(options.json) ? JSON.stringify({ ...result, directory: dir }, null, 2) : formatSetupText(result, dir));
        return 0;
      }
      case "status": {
        const dir = resolveRepoDirectory(str(options.dir));
        const res = getClimbStatus(dir, str(options.name), num(options.last) ?? 15);
        console.log(
          bool(options.json)
            ? JSON.stringify({ directory: dir, engine: res.engine, ...res.summary }, null, 2)
            : res.text,
        );
        return 0;
      }
      case "card": {
        const dir = resolveRepoDirectory(str(options.dir));
        const res = getClimbCard(dir, str(options.name));
        console.log(bool(options.json) ? JSON.stringify(res.data, null, 2) : res.text);
        return 0;
      }
      case "list": {
        const dir = resolveRepoDirectory(str(options.dir));
        const res = getClimbList(dir);
        console.log(bool(options.json) ? JSON.stringify({ directory: dir, climbs: res.climbs }, null, 2) : res.text);
        return 0;
      }
      case "log": {
        const dir = resolveRepoDirectory(str(options.dir));
        const res = getClimbLog(dir, str(options.name), num(options.limit) ?? 40);
        console.log(bool(options.json) ? JSON.stringify(res.rows, null, 2) : res.text);
        return 0;
      }
      case "notes": {
        const dir = resolveRepoDirectory(str(options.dir));
        console.log(getClimbNotes(dir, str(options.name)));
        return 0;
      }
      case "verdict": {
        const dir = resolveRepoDirectory(str(options.dir));
        console.log(getClimbVerdict(dir, str(options.name)));
        return 0;
      }
      case "engine": {
        const dir = resolveRepoDirectory(str(options.dir));
        const directory = engineDir(dir);
        if (bool(options.json)) {
          console.log(
            JSON.stringify({ directory, command: climbCommand(dir), files: ENGINE_FILES, commands: ENGINE_COMMANDS }, null, 2),
          );
        } else {
          console.log(
            [`Engine: ${directory}`, `Run it: ${climbCommand(dir)} <command>`, "", "Commands:", ...ENGINE_COMMANDS.map((c) => `  ${c}`)].join(
              "\n",
            ),
          );
        }
        return 0;
      }
      case "projects": {
        const activeRepo = ensureRepo();
        const registerDir = str(options.register);
        if (registerDir) {
          const registered = activeRepo.registerProject({
            id: str(options.id),
            name: str(options.name),
            directory: registerDir,
          });
          console.log(JSON.stringify(registered, null, 2));
          return 0;
        }
        console.log(JSON.stringify(activeRepo.listProjects(), null, 2));
        return 0;
      }
      case "tree": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const view = activeRepo.view(project, str(options.track) ?? "main");
        const outcomeKey = str(options.outcome);
        if (!outcomeKey) {
          console.log(JSON.stringify(view, null, 2));
          return 0;
        }
        const outcome = view.outcomes.find((o) => o.key === outcomeKey);
        if (!outcome) throw new HillClimbError(`Unknown outcome ${outcomeKey}`, { code: "unknown_outcome" });
        console.log(
          JSON.stringify(
            {
              outcome,
              rank: view.ranked.find((r) => r.key === outcome.key),
              plans: view.plans.filter((p) => p.key === outcome.key),
              evidence: view.evidence.filter((e) => e.key === outcome.key),
              inbox: view.inbox,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "act": {
        const rawAction = positionals[0];
        if (!rawAction) throw new HillClimbError("Pass a JSON action object as the positional argument.", { code: "missing_action" });
        const action = actionSchema.parse(JSON.parse(rawAction));
        if (
          action.op === "approve_change" ||
          action.op === "reject_change" ||
          action.op === "promote_track" ||
          action.op === "accept_flow_change" ||
          action.op === "reject_flow_change"
        ) {
          throw new HillClimbError("Review this decision in the Hill Climb UI inbox (human confirmation required).", {
            code: "human_decision_required",
          });
        }
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        activeRepo.act(project, action, { actor: "cli", via: "cli" });
        const view = activeRepo.view(project);
        console.log(
          JSON.stringify(
            {
              ok: true,
              project,
              inbox: view.inbox,
              ...(action.op === "create_goal" || action.op === "create_outcome"
                ? { lint: lintTree(view).findings.filter((f) => f.itemKey === action.key) }
                : {}),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "lint": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const findings = lintTree(activeRepo.read(project));
        console.log(JSON.stringify(findings, null, 2));
        return findings.passed ? 0 : 1;
      }
      case "sync": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const info = activeRepo.getProject(project);
        const dir = str(options.dir) ?? info?.directory;
        if (!dir) {
          throw new HillClimbError(`Project ${project} has no local directory; pass --dir <repo>.`, {
            code: "missing_directory",
          });
        }
        const runSync = async () =>
          writeMirror(dir, activeRepo.view(project), {
            artifacts: activeRepo.listArtifacts(project),
            scannedClimbs: scanProjectClimbs(dir, { rowLimit: 10, includeNotes: true }),
          });
        const res = await runSync();
        console.log(JSON.stringify(res, null, 2));
        if (bool(options.watch)) {
          const intervalSec = Math.max(5, num(options.interval) ?? 30);
          console.error(`Watching ${project} -> ${res.root} every ${intervalSec}s (Ctrl-C to stop)...`);
          await new Promise<void>((resolveWatch) => {
            const timer = setInterval(() => void runSync().catch(() => undefined), intervalSec * 1000);
            const stop = () => {
              clearInterval(timer);
              resolveWatch();
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
        }
        return 0;
      }
      case "search": {
        const query = positionals.join(" ").trim() || str(options.query) || "";
        if (!query) throw new HillClimbError("Pass a search query: hillclimb search <query>", { code: "missing_query" });
        const activeRepo = ensureRepo();
        const pid = str(options.project) || str(options.dir) ? activeRepo.resolveProjectId(str(options.project), str(options.dir)) : null;
        const hits = activeRepo.search(pid, query, { limit: num(options.limit) ?? 25 });
        if (bool(options.json)) {
          console.log(JSON.stringify({ query, project: pid, hits }, null, 2));
        } else if (hits.length === 0) {
          console.log(`No matches for "${query}".`);
        } else {
          for (const h of hits) {
            console.log(`[${h.entityType}] ${h.entityId} (${h.project}) — ${h.title}\n  ${h.snippet}`);
          }
        }
        return 0;
      }
      case "insights": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const dir = str(options.dir) ?? activeRepo.getProject(project)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 50, includeNotes: false }) : null;
        const ins = computeInsights(activeRepo, project, {
          days: num(options.days) ?? 30,
          track: str(options.track) ?? "main",
          scannedClimbs: scanned,
        });
        console.log(JSON.stringify(ins, null, 2));
        return 0;
      }
      case "export": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const dir = str(options.dir) ?? activeRepo.getProject(project)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 25, includeNotes: false }) : null;
        const format = str(options.format) === "markdown" ? "markdown" : "html";
        const out = exportShareableReport(activeRepo, project, {
          format,
          track: str(options.track) ?? "main",
          releaseName: str(options.release),
          scope: str(options.scope),
          goalKey: str(options.goal),
          scannedClimbs: scanned,
        });
        const outPath = str(options.out);
        if (outPath) {
          writeFileSync(resolve(outPath), out.content, "utf8");
          console.log(JSON.stringify({ written: resolve(outPath), format: out.format, outcomes: out.outcomesIncluded }, null, 2));
        } else {
          process.stdout.write(out.content);
        }
        return 0;
      }
      case "import": {
        const bpId = str(options.blueprint);
        const filePath = str(options.file);
        if (!bpId && !filePath) {
          console.log(JSON.stringify({ blueprints: listBlueprints() }, null, 2));
          return 0;
        }
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const existingTree = activeRepo.read(project);
        const existingKeys = new Set([
          ...existingTree.goals.map((g) => g.key),
          ...existingTree.outcomes.map((o) => o.key),
        ]);
        const asProposals = bool(options.propose);
        const built = bpId
          ? blueprintActions(bpId, { asProposals, keyPrefix: str(options.prefix), existingKeys })
          : parseMarkdownImport(readFileSync(resolve(filePath!), "utf8"), {
              goalKey: str(options.goal),
              prefix: str(options.prefix),
              asProposals,
              existingKeys,
            });
        if (bool(options.apply) && built.actions.length > 0) {
          activeRepo.actBatch(project, built.actions, { actor: "cli", via: "cli" });
        }
        console.log(
          JSON.stringify(
            {
              project,
              applied: bool(options.apply) ? built.actions.length : 0,
              actionCount: built.actions.length,
              lint: { passed: built.lint.passed, errors: built.lint.errorCount, warnings: built.lint.warningCount },
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "artifact": {
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const template = (str(options.template) ?? "weekly-update") as ArtifactTemplateId;
        const dir = str(options.dir) ?? activeRepo.getProject(project)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 25, includeNotes: false }) : null;
        const gen = generateArtifactFromTemplate(activeRepo, project, {
          template,
          title: str(options.title),
          folder: str(options.folder),
          releaseName: str(options.release),
          scannedClimbs: scanned,
          actor: "cli",
          save: bool(options.apply),
        });
        console.log(bool(options.json) ? JSON.stringify(gen, null, 2) : gen.body);
        return 0;
      }
      case "ingest-alert": {
        const key = str(options.key);
        const msg = str(options.message);
        const src = str(options.source) ?? "monitoring";
        if (!key || !msg) throw new HillClimbError("Pass --key <outcome> and --message <text>.", { code: "missing_alert_args" });
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const sev = (str(options.severity) ?? "error") as "critical" | "error" | "warning" | "info";
        const res = ingestAlert(activeRepo, {
          project,
          key,
          message: msg,
          source: src,
          severity: sev,
          track: str(options.track) ?? "main",
          actor: "cli-alert",
        });
        console.log(JSON.stringify(res, null, 2));
        return 0;
      }
      case "serve": {
        const activeRepo = ensureRepo();
        const automation = createAutomationEngine(activeRepo);
        const srv = await startLoopbackServer(activeRepo, {
          port: num(options.port) ?? 4318,
          token: str(options.token),
        });
        console.log(
          JSON.stringify(
            {
              url: srv.url,
              bind: "127.0.0.1",
              port: srv.port,
              token: srv.token,
              endpoints: [
                "GET /api/v1/health",
                "GET /api/v1/projects",
                "GET /api/v1/projects/:id/tree",
                "GET /api/v1/projects/:id/next",
                "GET /api/v1/projects/:id/search?q=...",
                "GET /api/v1/projects/:id/insights",
                "GET /api/v1/projects/:id/artifacts",
                "GET /api/v1/projects/:id/export?format=html|markdown",
                "POST /api/v1/projects/:id/act",
                "POST /api/v1/projects/:id/alerts",
                "POST /api/v1/projects/:id/artifacts",
              ],
            },
            null,
            2,
          ),
        );
        await new Promise<void>((done) => {
          const stop = () => {
            automation.stop();
            void srv.close().finally(done);
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }
      case "ingest-junit": {
        const report = str(options.report);
        if (!report) throw new HillClimbError("Pass --report <file>.", { code: "missing_report" });
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const res = ingestJunitReport(activeRepo, {
          project,
          report,
          directory: str(options.dir) ?? activeRepo.getProject(project)?.directory ?? process.cwd(),
          format: (str(options.format) ?? "auto") as "auto" | "junit" | "json" | "text",
          source: str(options.source),
          track: str(options.track),
          prefixes: str(options.prefixes),
          contractFrozenAt: str(options["contract-frozen-at"]),
          limit: num(options.limit),
          apply: bool(options.apply),
        });
        console.log(JSON.stringify(res.payload, null, 2));
        return res.exitCode;
      }
      case "post-test-evidence": {
        const bundle = str(options.bundle);
        if (!bundle) throw new HillClimbError("Pass --bundle <file>.", { code: "missing_bundle" });
        const activeRepo = ensureRepo();
        const project = activeRepo.resolveProjectId(str(options.project), str(options.dir));
        const res = postTestEvidenceBundle(activeRepo, {
          project,
          bundle,
          directory: str(options.dir) ?? activeRepo.getProject(project)?.directory ?? process.cwd(),
          track: str(options.track),
          limit: num(options.limit),
          apply: bool(options.apply),
        });
        console.log(JSON.stringify(res.payload, null, 2));
        return res.exitCode;
      }
      case "study-preview": {
        const res = await runStudyPreview({
          spec: positionals[0],
          dir: str(options.dir),
          candidates: num(options.candidates),
          verifierRepeat: num(options["verifier-repeat"]),
          trialAllowance: num(options["trial-allowance"]),
          repeats: num(options.repeats),
          budget: str(options.budget),
        });
        console.log(bool(options.json) ? res.jsonText : res.text);
        return 0;
      }
      case "study-report": {
        const res = await runStudyReport({
          dir: str(options.dir),
          artifact: str(options.artifact),
          study: str(options.study),
          run: str(options.run),
          problem: str(options.problem),
          control: str(options.control),
          noiseFloor: str(options["noise-floor"]),
        });
        console.log(bool(options.json) ? res.jsonText : res.text);
        return 0;
      }
      default:
        throw new HillClimbError(`Unknown command: ${command}`, {
          code: "unknown_command",
          hint: "Run `hillclimb --help` to see all available commands.",
        });
    }
  } finally {
    dbState.repo?.close();
  }
}

function isMainEntrypoint(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
  }
}

if (isMainEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error instanceof HillClimbError ? error.hint : undefined;
      console.error(hint ? `${message}\n${hint}` : message);
      process.exitCode = 1;
    });
}
