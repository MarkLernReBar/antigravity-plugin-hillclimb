#!/usr/bin/env node
import { createRepository, defaultDataDir, openDatabase } from "./repository.js";
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
} from "./repo-ops.js";
import { climbCommand, engineDir, ENGINE_FILES } from "./engine.js";
import { actionSchema } from "./actions.js";
import { lintTree } from "./linter.js";
import { writeMirror } from "./mirror.js";
import { ingestJunitReport, postTestEvidenceBundle } from "./ci-ingest.js";
import { runStudyPreview, runStudyReport } from "./studies.js";
import { HillClimbError } from "./errors.js";

function parseArgs(argv: string[]) {
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
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[key] = next;
          i++;
        } else {
          options[key] = true;
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
  hillclimb sync [--project <id>] [--dir <repo>]

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

  const dataDir = str(options["data-dir"]) ?? defaultDataDir();
  const db = openDatabase(dataDir);
  const repo = createRepository(db);
  const runtime = createRuntime(repo, { automatic: false });

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
        const registerDir = str(options.register);
        if (registerDir) {
          const registered = repo.registerProject({
            id: str(options.id),
            name: str(options.name),
            directory: registerDir,
          });
          console.log(JSON.stringify(registered, null, 2));
          return 0;
        }
        console.log(JSON.stringify(repo.listProjects(), null, 2));
        return 0;
      }
      case "tree": {
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const view = repo.view(project, str(options.track) ?? "main");
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
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const action = actionSchema.parse(JSON.parse(rawAction));
        if (action.op === "approve_change" || action.op === "reject_change" || action.op === "promote_track") {
          throw new HillClimbError("Review this decision in the Hill Climb UI inbox (human confirmation required).", {
            code: "human_decision_required",
          });
        }
        repo.act(project, action);
        const view = repo.view(project);
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
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const findings = lintTree(repo.read(project));
        console.log(JSON.stringify(findings, null, 2));
        return findings.passed ? 0 : 1;
      }
      case "sync": {
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const info = repo.getProject(project);
        const dir = str(options.dir) ?? info?.directory;
        if (!dir) {
          throw new HillClimbError(`Project ${project} has no local directory; pass --dir <repo>.`, {
            code: "missing_directory",
          });
        }
        const res = await writeMirror(dir, repo.view(project));
        console.log(JSON.stringify(res, null, 2));
        return 0;
      }
      case "ingest-junit": {
        const report = str(options.report);
        if (!report) throw new HillClimbError("Pass --report <file>.", { code: "missing_report" });
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const res = ingestJunitReport(repo, {
          project,
          report,
          directory: str(options.dir) ?? repo.getProject(project)?.directory ?? process.cwd(),
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
        const project = repo.resolveProjectId(str(options.project), str(options.dir));
        const res = postTestEvidenceBundle(repo, {
          project,
          bundle,
          directory: str(options.dir) ?? repo.getProject(project)?.directory ?? process.cwd(),
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
    db.close();
  }
}

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
