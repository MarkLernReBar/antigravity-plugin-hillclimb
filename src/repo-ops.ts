import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { HillClimbError } from "./errors.js";
import {
  bundledKitFiles,
  climbCommand,
  engineDir,
  engineFile,
  ENGINE_FILES,
  excludePath,
  hasIgnoreRule,
  joinPath,
  readEngineSource,
  resolvePath,
  stateDir,
  withIgnoreRule,
  type EngineFile,
} from "./engine.js";
import {
  formatRig,
  formatSummary,
  listClimbs,
  number,
  parseCard,
  parseLog,
  summarize,
  verdictLine,
  type ClimbCard,
  type ClimbFiles,
  type LogRow,
} from "./state.js";

export const ENGINE_COMMANDS = [
  'init <name> --goal "..." --check "<command>" --lock <check files>',
  'try "<idea>"  [--fix]',
  "status [name]",
  'relock [name] --why "..."',
  'holdout --why "..."',
  'raise <bar> --why "..."',
  'review "<what you found>"',
  "budget [name] [--hours N] [--steps N] [--off]",
  "drop [name]",
  "list",
  "save [name]",
  "kits [words]",
  "reuse <name or repo/name>",
] as const;

interface MaybeFile {
  text: string | null;
  error: string | null;
}

function readLocalFile(path: string): MaybeFile {
  try {
    return { text: readFileSync(path, "utf8"), error: null };
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function writeLocalFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function resolveRepoDirectory(directory?: string): string {
  const target = directory && directory.trim() !== "" ? resolve(directory.trim()) : process.cwd();
  if (!existsSync(target)) {
    throw new HillClimbError(`Directory does not exist: ${target}`, {
      code: "missing_directory",
      hint: "Pass an existing absolute git repository path.",
    });
  }
  return target;
}

export function discoverClimbs(repoPath: string): { climbs: string[]; prepared: string[] } {
  const base = stateDir(repoPath);
  if (!existsSync(base)) return { climbs: [], prepared: [] };
  const entries = readdirSync(base, { withFileTypes: true });
  const climbs: string[] = [];
  const prepared: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "engine") continue;
    const card = readCardFile(repoPath, entry.name);
    if (entry.name === "kits" && card.text === null) continue;
    (card.text === null ? prepared : climbs).push(entry.name);
  }
  return { climbs: climbs.sort(), prepared: prepared.sort() };
}

export function preparedNote(prepared: string[]): string {
  if (prepared.length === 0) return "";
  const list = prepared.join(", ");
  return `\n\nNot a climb yet: ${list} — check files without a card.json, so init never completed there. Start it with: ${
    prepared.length === 1 ? `init ${list}` : "init <name>"
  }`;
}

export function readCardFile(repoPath: string, name: string): MaybeFile {
  return readLocalFile(joinPath(stateDir(repoPath), name, "card.json"));
}

export function readRows(repoPath: string, name: string): LogRow[] {
  const base = joinPath(stateDir(repoPath), name);
  const log = readLocalFile(joinPath(base, "log.jsonl"));
  return log.text === null ? [] : parseLog(log.text);
}

export function readClimb(repoPath: string, wanted?: string): { card: ClimbCard; name: string } {
  const found = discoverClimbs(repoPath);
  if (wanted !== undefined && wanted !== "") {
    const file = found.climbs.includes(wanted) ? readCardFile(repoPath, wanted) : { text: null, error: null };
    if (file.text === null) {
      const why = found.prepared.includes(wanted)
        ? `${wanted} has check files but no card.json, so init never completed there. Start it with: ${climbCommand(repoPath)} init ${wanted}`
        : undefined;
      throw new HillClimbError(`no climb named ${JSON.stringify(wanted)} in ${stateDir(repoPath)}`, {
        code: "climb_not_found",
        hint:
          why ??
          (found.climbs.length > 0
            ? `Climbs here: ${found.climbs.join(", ")}.`
            : `Start one with: ${climbCommand(repoPath)} init <name> …`),
      });
    }
    return { card: parseCard(file.text), name: wanted };
  }
  const names = found.climbs;
  if (names.length === 0) {
    throw new HillClimbError(`no climb in ${stateDir(repoPath)}`, {
      code: "no_climb",
      hint: `Nothing is initialized here. Start one with: ${climbCommand(repoPath)} init <name> --goal "…" --check "…" --lock <check files>${preparedNote(found.prepared)}`,
    });
  }
  if (names.length > 1) {
    throw new HillClimbError("name the climb: this repository has more than one", {
      code: "ambiguous_climb",
      hint: `Climbs here: ${names.join(", ")}.`,
    });
  }
  const only = names[0] as string;
  const file = readCardFile(repoPath, only);
  if (file.text === null) {
    throw new HillClimbError(`climb directory ${only} has no readable card.json`, {
      code: "climb_corrupt",
      hint: file.error ?? undefined,
    });
  }
  return { card: parseCard(file.text), name: only };
}

export function readState(repoPath: string, wanted?: string): ClimbFiles & { name: string } {
  const { card, name } = readClimb(repoPath, wanted);
  const base = joinPath(stateDir(repoPath), name);
  const notes = readLocalFile(joinPath(base, "notes.md"));
  const pending = readLocalFile(joinPath(base, "pending-tree"));
  return {
    name,
    card,
    rows: readRows(repoPath, name),
    notes: notes.text,
    pendingTree: pending.text !== null,
  };
}

export function installEngine(repoPath: string): {
  engine: string;
  command: string;
  wrote: string[];
  exclude: string | null;
  warning: string | null;
} {
  const wrote: string[] = [];
  const target = engineDir(repoPath);
  let exclude: string | null = null;
  let warning: string | null = null;

  const head = readLocalFile(joinPath(repoPath, ".git", "HEAD"));
  const layout =
    head.text !== null
      ? excludePath(repoPath, { dotGitIsDirectory: true })
      : (() => {
          const pointer = readLocalFile(joinPath(repoPath, ".git"));
          if (pointer.text === null) {
            throw new HillClimbError(`${repoPath} is not a git repository`, {
              code: "not_a_repository",
              hint: "Hill Climb commits every kept step, so the target must be a git checkout.",
            });
          }
          const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer.text);
          const common =
            gitdir === null
              ? { text: null }
              : readLocalFile(joinPath(resolvePath(repoPath, gitdir[1]?.trim() ?? ""), "commondir"));
          return excludePath(repoPath, {
            dotGitIsDirectory: false,
            dotGitText: pointer.text,
            commonDirText: common.text,
          });
        })();

  exclude = layout.excludePath;
  const existing = readLocalFile(layout.excludePath);
  if (!hasIgnoreRule(existing.text)) {
    try {
      writeLocalFile(layout.excludePath, withIgnoreRule(existing.text));
      wrote.push(layout.excludePath);
    } catch (error) {
      warning = `could not write ${layout.excludePath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  for (const name of ENGINE_FILES) {
    writeLocalFile(engineFile(repoPath, name as EngineFile), readEngineSource(name));
    wrote.push(engineFile(repoPath, name as EngineFile));
  }

  for (const kit of bundledKitFiles()) {
    const path = joinPath(repoPath, ".hill-climb", "kits", kit.path);
    writeLocalFile(path, kit.content);
    wrote.push(path);
  }

  return { engine: target, command: climbCommand(repoPath), wrote, exclude, warning };
}

export function formatSetupText(result: ReturnType<typeof installEngine>, repoPath: string): string {
  const lines = [
    `Engine: ${result.engine}`,
    `Benchmark kits: ${joinPath(repoPath, ".hill-climb", "kits")}`,
    `CLIMB="${result.engine}/climb.py"`,
    "",
    "Next (write the check first, then start the climb in your own shell):",
    `  ${result.command} init <name> --goal "…" --check "<command>" --lock <check files>`,
    `  ${result.command} try "<idea>"`,
    `  ${result.command} status`,
    "",
    "Commands:",
    ...ENGINE_COMMANDS.map((command) => `  ${command}`),
    "",
    `Read state without running checks: hillclimb_status (or hillclimb status --dir ${repoPath})`,
  ];
  if (result.warning !== null) lines.push("", `Warning: ${result.warning}`);
  return lines.join("\n");
}

export function getClimbStatus(repoPath: string, name?: string, last = 15) {
  const state = readState(repoPath, name);
  const summary = summarize(state, last);
  const text = formatSummary(summary);
  const next =
    summary.verdict === "bar-reached"
      ? `\n\nNext: run the holdout, then the final review — ${climbCommand(repoPath)} holdout --why final`
      : `\n\nNext step in your shell: ${climbCommand(repoPath)} try "<idea>"`;
  return { summary, text, textWithNext: `${text}${next}`, directory: repoPath, engine: engineDir(repoPath) };
}

export function getClimbCard(repoPath: string, name?: string) {
  const { card } = readClimb(repoPath, name);
  return {
    text: formatRig(card),
    data: {
      directory: repoPath,
      name: card.name,
      goal: card.goal,
      branch: card.branch ?? null,
      base: card.base ?? null,
      check: Array.isArray(card.check) ? card.check : card.check === undefined ? [] : [card.check],
      score: card.score ?? [],
      direction: card.direction,
      target: card.target,
      targetText: card.target_text ?? null,
      after: card.after ?? "stop",
      runs: card.runs ?? 1,
      paired: card.paired ?? false,
      scoreMode: card.score_mode ?? "failure-count",
      minGain: card.min_gain ?? 0,
      timeout: card.timeout ?? null,
      guards: card.guards ?? [],
      holdout: card.holdout ?? null,
      locked: card.lock ?? [],
      fingerprint: card.fingerprint ?? null,
      repos: (card.repos ?? []).map((repo) => repo.path),
      maxSteps: card.max_steps ?? null,
      maxHours: card.max_hours ?? null,
      hard: card.hard ?? false,
    },
  };
}

export function getClimbList(repoPath: string) {
  const { climbs: names, prepared } = discoverClimbs(repoPath);
  const entries: Array<{ card: ClimbCard; rows: LogRow[] }> = [];
  for (const name of names) {
    const card = readCardFile(repoPath, name);
    if (card.text === null) continue;
    entries.push({ card: parseCard(card.text), rows: readRows(repoPath, name) });
  }
  const summaries = listClimbs(entries);
  const text =
    entries.length === 0
      ? `No climbs in ${stateDir(repoPath)}. Start one with: ${climbCommand(repoPath)} init <name> …${preparedNote(prepared)}`
      : `${summaries
          .map((entry) => {
            const verdict = entry.verdict === "climbing" ? "" : `  [${entry.verdict}]`;
            return `${entry.name}: ${number(entry.baseline)} -> ${number(entry.best)} (${entry.direction}), ${entry.steps} steps${verdict}`;
          })
          .join("\n")}${preparedNote(prepared)}`;
  return { directory: repoPath, climbs: summaries, prepared, text };
}

export function getClimbLog(repoPath: string, name?: string, limit = 40) {
  const { name: climbName } = readClimb(repoPath, name);
  const rows = readRows(repoPath, climbName);
  const slice = rows.slice(-limit);
  const text = slice
    .map((row) => {
      const score = typeof row.score === "number" ? number(row.score) : "-";
      const label = row.idea ?? row.why ?? "";
      return `${row.time ?? ""}  ${row.kind.padEnd(9)} ${(row.result ?? "").padEnd(6)} ${score.padStart(10)}  ${label}`;
    })
    .join("\n");
  return { name: climbName, rows: slice, text: text === "" ? "No log rows." : text };
}

export function getClimbNotes(repoPath: string, name?: string): string {
  const { name: climbName } = readClimb(repoPath, name);
  const notes = readLocalFile(joinPath(stateDir(repoPath), climbName, "notes.md"));
  if (notes.text === null) {
    throw new HillClimbError(`climb ${climbName} has no notes.md yet`, {
      code: "no_notes",
      hint: `Write a few lines after every 5 steps: ${joinPath(stateDir(repoPath), climbName, "notes.md")}`,
    });
  }
  return notes.text;
}

export function getClimbVerdict(repoPath: string, name?: string): string {
  const state = readState(repoPath, name);
  const summary = summarize(state, 0);
  const line = verdictLine(summary);
  return line === "" ? "CLIMBING" : line;
}

export interface ScannedClimbRow {
  kind: string;
  result: string | null;
  score: number | null;
  idea: string | null;
  why: string | null;
  time: string | null;
  commit: string | null;
}

export interface ScannedClimb {
  id: string;
  name: string;
  status: "active" | "prepared";
  origin: "antigravity" | "checkout" | "archived";
  isLive: boolean;
  directory: string;
  worktreeName: string;
  workerLabel: string;
  isMainCheckout: boolean;
  conversationId: string | null;
  branch: string | null;
  goal: string | null;
  direction: "min" | "max" | null;
  baseline: number | null;
  best: number | null;
  target: number | null;
  targetText: string | null;
  steps: number;
  kept: number;
  undone: number;
  sinceGain: number;
  verdict: string;
  sparkline: string;
  check: string[];
  guards: string[];
  holdout: string | null;
  locked: string[];
  scoreMode: string | null;
  rows: ScannedClimbRow[];
  notes: string | null;
  preparedFiles: number;
  preparedSampleFiles: string[];
  updatedAt: string | null;
}

export interface ScannedProjectClimbs {
  projectDirectory: string | null;
  engineInstalled: boolean;
  worktreesScanned: number;
  currentCount: number;
  archivedCount: number;
  climbs: ScannedClimb[];
}

function collectSampleFiles(dir: string, limit = 200): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  const stack: Array<{ full: string; rel: string }> = [{ full: dir, rel: "" }];
  while (stack.length > 0 && count < limit) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur.full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (count >= limit) break;
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== "__pycache__") stack.push({ full: join(cur.full, e.name), rel });
      } else if (e.isFile()) {
        count += 1;
        if (samples.length < 8) samples.push(rel);
      }
    }
  }
  return { count, samples };
}

function classifyOrigin(dir: string, isMain: boolean): { origin: "antigravity" | "checkout" | "archived"; workerLabel: string } {
  const norm = dir.replaceAll("\\", "/");
  const base = basename(dir);
  if (isMain) return { origin: "checkout", workerLabel: "main checkout" };
  if (norm.includes("/.gemini/antigravity/worktrees/")) {
    const cleaned = base.replace(/^swarm-/, "").replace(/-[0-9a-f]{6,10}$/i, "");
    return { origin: "antigravity", workerLabel: cleaned || base };
  }
  if (/\/\.[^/]+\/.*(?:worktree|storage|cache|plugins)/i.test(norm)) {
    return { origin: "archived", workerLabel: base };
  }
  return { origin: "checkout", workerLabel: base };
}

function latestMtimeIso(dir: string): string | null {
  try {
    return statSync(dir).mtime.toISOString();
  } catch {
    return null;
  }
}

function readWorktreeBranch(dir: string): string | null {
  try {
    const dotGit = join(dir, ".git");
    let headPath = join(dotGit, "HEAD");
    if (!existsSync(headPath) && existsSync(dotGit)) {
      const pointer = readFileSync(dotGit, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (m?.[1]) headPath = join(resolvePath(dir, m[1].trim()), "HEAD");
    }
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref?.[1] ?? head.slice(0, 10);
  } catch {
    return null;
  }
}

function linkedWorktreesOf(repoPath: string): string[] {
  const seen = new Set<string>();
  const normalizedMain = resolve(repoPath);
  const add = (candidate: string) => {
    const abs = resolve(candidate);
    if (abs === normalizedMain || seen.has(abs)) return;
    if (existsSync(abs)) seen.add(abs);
  };

  // 1. Linked git worktrees recorded in <repo>/.git/worktrees/*/gitdir
  const gitWorktreesDir = join(normalizedMain, ".git", "worktrees");
  if (existsSync(gitWorktreesDir)) {
    try {
      for (const entry of readdirSync(gitWorktreesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const gitdirFile = join(gitWorktreesDir, entry.name, "gitdir");
        if (!existsSync(gitdirFile)) continue;
        const targetGitFile = readFileSync(gitdirFile, "utf8").trim();
        if (!targetGitFile) continue;
        const wtDir = dirname(resolve(gitWorktreesDir, entry.name, targetGitFile));
        add(wtDir);
      }
    } catch {
      // ignore unreadable git worktrees
    }
  }

  // 2. Antigravity worktrees (~/.gemini/antigravity/worktrees/<convId>/<wt>/) pointing back to this repo
  const agyWorktreesRoot = join(homedir(), ".gemini", "antigravity", "worktrees");
  if (existsSync(agyWorktreesRoot)) {
    try {
      for (const conv of readdirSync(agyWorktreesRoot, { withFileTypes: true })) {
        if (!conv.isDirectory()) continue;
        const convDir = join(agyWorktreesRoot, conv.name);
        for (const wt of readdirSync(convDir, { withFileTypes: true })) {
          if (!wt.isDirectory()) continue;
          const wtPath = join(convDir, wt.name);
          const dotGit = join(wtPath, ".git");
          try {
            const pointer = readFileSync(dotGit, "utf8").replaceAll("\\", "/");
            const expectedGitDir = join(normalizedMain, ".git").replaceAll("\\", "/");
            if (pointer.includes(expectedGitDir)) {
              add(wtPath);
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return [...seen];
}

function conversationIdFromPath(dir: string): string | null {
  const norm = dir.replaceAll("\\", "/");
  const m = /\/\.gemini\/antigravity\/worktrees\/([0-9a-f-]{36})\//i.exec(norm);
  return m?.[1] ?? null;
}

/**
 * Scan the project's main checkout AND all linked git worktrees (including Antigravity swarm worktrees)
 * for active and prepared `.hill-climb/` runs.
 */
export function scanProjectClimbs(repoPath: string | null): ScannedProjectClimbs {
  if (!repoPath || !existsSync(repoPath)) {
    return {
      projectDirectory: repoPath,
      engineInstalled: false,
      worktreesScanned: 0,
      currentCount: 0,
      archivedCount: 0,
      climbs: [],
    };
  }
  const normalizedMain = resolve(repoPath);
  const engineInstalled = existsSync(engineFile(normalizedMain, "climb.py"));
  const worktrees = linkedWorktreesOf(normalizedMain);
  const roots = [normalizedMain, ...worktrees];
  const climbs: ScannedClimb[] = [];

  for (const root of roots) {
    const isMain = root === normalizedMain;
    const found = discoverClimbs(root);
    const branch = readWorktreeBranch(root);
    const worktreeName = basename(root);
    const conversationId = conversationIdFromPath(root);
    const { origin, workerLabel } = classifyOrigin(root, isMain);

    const parsedEntries: Array<{
      dirName: string;
      state: ReturnType<typeof readState>;
      summary: ReturnType<typeof summarize>;
      checks: string[];
    }> = [];
    for (const dirName of found.climbs) {
      try {
        const state = readState(root, dirName);
        const summary = summarize(state, 50);
        const card = state.card;
        const checks = Array.isArray(card.check) ? card.check : card.check === undefined ? [] : [card.check];
        parsedEntries.push({ dirName, state, summary, checks });
      } catch {
        continue;
      }
    }

    // Identify canonical climbs (folder name === card.name) and any sibling fixture folders
    // referenced in their check/guard/holdout/lock commands (e.g., `.hill-climb/unit-count-bench/`).
    const canonicalNames = new Set(
      parsedEntries.filter((e) => !e.state.card.name || e.state.card.name === e.dirName).map((e) => e.dirName),
    );
    const referencedSiblingDirs = new Set<string>();
    const refRegex = /\.hill-climb\/([^/\s"'`]+)/g;
    for (const entry of parsedEntries) {
      if (!canonicalNames.has(entry.dirName)) continue;
      const card = entry.state.card;
      const texts = [...entry.checks, ...(card.guards ?? []), ...(card.lock ?? []), ...(card.holdout ? [card.holdout] : [])];
      for (const text of texts) {
        for (const match of text.matchAll(refRegex)) {
          const refDir = match[1];
          if (refDir && refDir !== entry.dirName && refDir !== "engine" && refDir !== "kits" && refDir !== "bridge") {
            referencedSiblingDirs.add(refDir);
          }
        }
      }
    }

    for (const { dirName: name, state, summary, checks } of parsedEntries) {
      const card = state.card;
      const cardName = card.name?.trim() || name;
      // Skip orphaned/moved fixture directories that still contain a stale card.json from an earlier init
      // (folder name != card.name when the real climb exists alongside it, is referenced as fixtures, or has no log).
      if (
        cardName !== name &&
        (canonicalNames.has(cardName) || referencedSiblingDirs.has(name) || state.rows.length === 0)
      ) {
        continue;
      }
      const rows: ScannedClimbRow[] = state.rows.slice(-50).map((r) => ({
        kind: r.kind,
        result: r.result ?? null,
        score: typeof r.score === "number" ? r.score : null,
        idea: r.idea ?? null,
        why: r.why ?? null,
        time: r.time ?? null,
        commit: null,
      }));
      const rawTargetText = card.target_text ?? null;
      const targetTextMatches =
        rawTargetText !== null &&
        (summary.target === null ||
          (Number.isFinite(Number(rawTargetText)) && Math.abs(Number(rawTargetText) - summary.target) < 1e-9));
      const isLive = summary.verdict === "climbing" || summary.verdict === "plateau";
      climbs.push({
        id: `${root}::${name}`,
        name,
        status: "active",
        origin,
        isLive,
        directory: root,
        worktreeName,
        workerLabel,
        isMainCheckout: isMain,
        conversationId,
        branch: card.branch ?? branch,
        goal: card.goal ?? null,
        direction: card.direction,
        baseline: summary.baseline,
        best: summary.best,
        target: summary.target,
        targetText: targetTextMatches ? rawTargetText : null,
        steps: summary.steps,
        kept: summary.kept,
        undone: Math.max(0, summary.steps - summary.kept),
        sinceGain: summary.sinceGain,
        verdict: summary.verdict,
        sparkline: summary.spark,
        check: checks,
        guards: card.guards ?? [],
        holdout: card.holdout ?? null,
        locked: card.lock ?? [],
        scoreMode: card.score_mode ?? "failure-count",
        rows,
        notes: state.notes,
        preparedFiles: 0,
        preparedSampleFiles: [],
        updatedAt: rows[rows.length - 1]?.time ?? latestMtimeIso(joinPath(stateDir(root), name)),
      });
    }

    for (const name of found.prepared) {
      if (name === "bridge" || referencedSiblingDirs.has(name)) continue;
      const dir = joinPath(stateDir(root), name);
      const { count, samples } = collectSampleFiles(dir);
      climbs.push({
        id: `${root}::${name}`,
        name,
        status: "prepared",
        origin,
        isLive: true,
        directory: root,
        worktreeName,
        workerLabel,
        isMainCheckout: isMain,
        conversationId,
        branch,
        goal: null,
        direction: null,
        baseline: null,
        best: null,
        target: null,
        targetText: null,
        steps: 0,
        kept: 0,
        undone: 0,
        sinceGain: 0,
        verdict: "preparing",
        sparkline: "",
        check: [],
        guards: [],
        holdout: null,
        locked: [],
        scoreMode: null,
        rows: [],
        notes: null,
        preparedFiles: count,
        preparedSampleFiles: samples,
        updatedAt: latestMtimeIso(dir),
      });
    }
  }

  const timeMs = (v: string | null): number => {
    if (!v) return 0;
    const ms = Date.parse(v.includes("T") ? v : v.replace(" ", "T"));
    return Number.isFinite(ms) ? ms : 0;
  };
  const originRank = (o: ScannedClimb["origin"]): number => (o === "antigravity" ? 0 : o === "checkout" ? 1 : 2);

  climbs.sort((a, b) => {
    if (originRank(a.origin) !== originRank(b.origin)) return originRank(a.origin) - originRank(b.origin);
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return timeMs(b.updatedAt) - timeMs(a.updatedAt) || a.name.localeCompare(b.name);
  });

  const currentCount = climbs.filter((c) => c.origin !== "archived" || c.isLive).length;
  const archivedCount = climbs.length - currentCount;

  return {
    projectDirectory: normalizedMain,
    engineInstalled,
    worktreesScanned: worktrees.length,
    currentCount,
    archivedCount,
    climbs,
  };
}
