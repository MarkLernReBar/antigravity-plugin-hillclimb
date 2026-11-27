import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  redactSecrets,
  summarize,
  verdictLine,
  type ClimbCard,
  type ClimbFiles,
  type ClimbSummary,
  type LogRow,
} from "./state.js";

export { redactSecrets } from "./state.js";

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

const IGNORED_STATE_DIRS = new Set(["engine", "bridge", "node_modules", "venv", "tmp", "cache"]);
const CACHE_ONLY_EXTS = /\.(?:pyc|pyo|pyd|class|o|so|dylib|swp|swo)$/i;

function isIgnoredStateDir(name: string): boolean {
  if (!name || name.startsWith(".") || name.startsWith("__")) return true;
  return IGNORED_STATE_DIRS.has(name.toLowerCase());
}

function hasRealClimbContent(dir: string): boolean {
  try {
    const stack = [dir];
    let checked = 0;
    while (stack.length > 0 && checked < 64) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") continue;
        checked += 1;
        if (entry.isDirectory()) {
          stack.push(join(current, entry.name));
        } else if (entry.isFile() && !CACHE_ONLY_EXTS.test(entry.name)) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function discoverClimbs(repoPath: string): { climbs: string[]; prepared: string[] } {
  const base = stateDir(repoPath);
  if (!existsSync(base)) return { climbs: [], prepared: [] };
  const entries = readdirSync(base, { withFileTypes: true });
  const climbs: string[] = [];
  const prepared: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredStateDir(entry.name)) continue;
    const card = readCardFile(repoPath, entry.name);
    if (entry.name === "kits" && card.text === null) continue;
    if (card.text !== null) {
      climbs.push(entry.name);
    } else if (hasRealClimbContent(join(base, entry.name))) {
      prepared.push(entry.name);
    }
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
    const branch = readWorktreeBranch(repoPath);
    if (branch) {
      if (branch.startsWith("climb/")) {
        const fromBranch = branch.slice("climb/".length);
        if (names.includes(fromBranch)) {
          const file = readCardFile(repoPath, fromBranch);
          if (file.text !== null) return { card: parseCard(file.text), name: fromBranch };
        }
      }
      const matching: Array<{ card: ClimbCard; name: string }> = [];
      for (const candidate of names) {
        const file = readCardFile(repoPath, candidate);
        if (file.text === null) continue;
        try {
          const card = parseCard(file.text);
          if (card.branch === branch) matching.push({ card, name: candidate });
        } catch {
          // ignore malformed card while probing branch match
        }
      }
      if (matching.length === 1) {
        return matching[0]!;
      }
    }
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

  clearScanCache(repoPath);
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

export function checkEngineDrift(repoPath: string): {
  status: "current" | "missing" | "diverged";
  hint: string | null;
} {
  const installed = readLocalFile(engineFile(repoPath, "climb.py"));
  if (installed.text === null) {
    return {
      status: "missing",
      hint: "Engine not installed in this repo; run hillclimb_setup.",
    };
  }
  try {
    const bundled = readEngineSource("climb.py").replace(/\r\n/g, "\n");
    const local = installed.text.replace(/\r\n/g, "\n");
    if (local === bundled) return { status: "current", hint: null };
    return {
      status: "diverged",
      hint: "Note: .hill-climb/engine/climb.py differs from the bundled Hill Climb plugin engine (may be older or locally patched). Run hillclimb_setup if you want to upgrade it.",
    };
  } catch {
    return { status: "current", hint: null };
  }
}

export function getClimbStatus(repoPath: string, name?: string, last = 15) {
  const state = readState(repoPath, name);
  const summary = summarize(state, last);
  const text = formatSummary(summary);
  const drift = checkEngineDrift(repoPath);
  const next =
    summary.verdict === "bar-reached"
      ? `\n\nNext: run the holdout, then the final review — ${climbCommand(repoPath)} holdout --why final`
      : `\n\nNext step in your shell: ${climbCommand(repoPath)} try "<idea>"`;
  const driftNote = drift.status === "diverged" && drift.hint ? `\n${drift.hint}` : "";
  return {
    summary,
    text,
    textWithNext: `${text}${next}${driftNote}`,
    directory: repoPath,
    engine: engineDir(repoPath),
    engineDrift: drift.status,
  };
}

export function getClimbCard(repoPath: string, name?: string) {
  const { card } = readClimb(repoPath, name);
  return {
    text: formatRig(card),
    data: {
      directory: repoPath,
      name: card.name,
      goal: redactSecrets(card.goal),
      branch: card.branch ?? null,
      base: card.base ?? null,
      check: (Array.isArray(card.check) ? card.check : card.check === undefined ? [] : [card.check]).map(redactSecrets),
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
      guards: (card.guards ?? []).map(redactSecrets),
      holdout: card.holdout ? redactSecrets(card.holdout) : null,
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
  const slice = rows.slice(-limit).map((row) => ({
    ...row,
    ...(typeof row.idea === "string" ? { idea: redactSecrets(row.idea) } : {}),
    ...(typeof row.why === "string" ? { why: redactSecrets(row.why) } : {}),
  }));
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
  return redactSecrets(notes.text);
}

export function getClimbVerdict(repoPath: string, name?: string): string {
  const state = readState(repoPath, name);
  const summary = summarize(state, 0);
  const line = verdictLine(summary);
  return line === "" ? "CLIMBING" : line;
}

export interface ScannedClimbRow {
  kind: string;
  step: number | null;
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
  bestCommit: string | null;
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
  warnings: string[];
}

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function statSignature(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function collectSampleFiles(dir: string, limit = 200): { count: number; samples: string[]; maxMtimeMs: number } {
  let count = 0;
  let maxMtimeMs = statMtimeMs(dir);
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
      const fullPath = join(cur.full, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__pycache__") stack.push({ full: fullPath, rel });
      } else if (e.isFile()) {
        count += 1;
        if (samples.length < 8) samples.push(rel);
        const mtime = statMtimeMs(fullPath);
        if (mtime > maxMtimeMs) maxMtimeMs = mtime;
      }
    }
  }
  return { count, samples, maxMtimeMs };
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

export function readWorktreeBranch(dir: string): string | null {
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

function linkedWorktreesOf(repoPath: string, warnings: string[]): string[] {
  const seen = new Set<string>();
  const normalizedMain = resolve(repoPath);
  const expectedGitDir = join(normalizedMain, ".git").replaceAll("\\", "/");
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
    } catch (error) {
      if (!isEnoent(error)) {
        warnings.push(`Failed to scan git worktrees in ${gitWorktreesDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
          const absWt = resolve(wtPath);
          if (absWt === normalizedMain || seen.has(absWt)) continue;
          const dotGit = join(wtPath, ".git");
          try {
            const pointer = readFileSync(dotGit, "utf8").replaceAll("\\", "/");
            if (pointer.includes(expectedGitDir)) {
              add(wtPath);
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code !== "ENOENT" && code !== "EISDIR") {
              warnings.push(`Failed to read worktree pointer ${dotGit}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    } catch (error) {
      if (!isEnoent(error)) {
        warnings.push(`Failed to scan Antigravity worktrees in ${agyWorktreesRoot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return [...seen];
}

function conversationIdFromPath(dir: string): string | null {
  const norm = dir.replaceAll("\\", "/");
  const m = /\/\.gemini\/antigravity\/worktrees\/([0-9a-f-]{36})\//i.exec(norm);
  return m?.[1] ?? null;
}

const SCAN_CACHE_TTL_MS = 4_000;
const LIVE_RECENCY_MS = 15 * 60 * 1000;
const CLIMB_STAT_MEMO_MAX = 500;
const scanCache = new Map<string, { at: number; value: ScannedProjectClimbs }>();
const climbStatMemo = new Map<
  string,
  {
    cardMtimeMs: number;
    cardSize: number;
    logMtimeMs: number;
    logSize: number;
    card: ClimbCard;
    rows: LogRow[];
    summary: ClimbSummary;
    checks: string[];
  }
>();

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function mainCheckoutOf(dir: string): string | null {
  try {
    const dotGit = join(dir, ".git");
    if (!existsSync(dotGit)) return null;
    const st = statSync(dotGit);
    if (st.isDirectory()) return resolve(dir);
    if (!st.isFile()) return null;
    const pointer = readFileSync(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!m?.[1]) return null;
    const gitDir = resolve(dir, m[1].trim());
    const commonDirPath = join(gitDir, "commondir");
    if (existsSync(commonDirPath)) {
      const relCommon = readFileSync(commonDirPath, "utf8").trim();
      if (relCommon) {
        const commonGitDir = resolve(gitDir, relCommon);
        return dirname(commonGitDir);
      }
    }
    const norm = gitDir.replaceAll("\\", "/");
    const idx = norm.lastIndexOf("/.git/worktrees/");
    if (idx > 0) return resolve(norm.slice(0, idx));
    return null;
  } catch {
    return null;
  }
}

export function clearScanCache(repoPath?: string): void {
  if (!repoPath) {
    scanCache.clear();
    climbStatMemo.clear();
    return;
  }
  const abs = resolve(repoPath);
  const mainCheckout = mainCheckoutOf(abs);
  if (!mainCheckout) {
    // Ambiguous or non-git path: clear all scan/stat caches to avoid stale entries.
    scanCache.clear();
    climbStatMemo.clear();
    return;
  }
  const targets = new Set<string>([abs, resolve(mainCheckout)]);
  for (const p of [abs, resolve(mainCheckout)]) {
    const real = safeRealpath(p);
    if (real) targets.add(real);
  }
  for (const key of scanCache.keys()) {
    const sepIdx = key.indexOf("|");
    const keyRoot = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
    if (targets.has(keyRoot)) {
      scanCache.delete(key);
      continue;
    }
    const realKeyRoot = safeRealpath(keyRoot);
    if (realKeyRoot && targets.has(realKeyRoot)) {
      scanCache.delete(key);
    }
  }
  // Clear per-climb stat memo entries under both the given worktree and its main checkout.
  const isUnderTargets = (candidate: string): boolean => {
    for (const target of targets) {
      if (candidate === target || candidate.startsWith(`${target}${sep}`)) return true;
    }
    return false;
  };
  for (const climbDir of climbStatMemo.keys()) {
    if (isUnderTargets(climbDir)) {
      climbStatMemo.delete(climbDir);
      continue;
    }
    const realClimbDir = safeRealpath(climbDir);
    if (realClimbDir && isUnderTargets(realClimbDir)) {
      climbStatMemo.delete(climbDir);
    }
  }
}

export interface ScanProjectClimbsOptions {
  force?: boolean;
  bypassCache?: boolean;
  rowLimit?: number;
  includeNotes?: boolean;
}

/**
 * Scan the project's main checkout AND all linked git worktrees (including Antigravity swarm worktrees)
 * for active and prepared `.hill-climb/` runs. Uses a short TTL cache unless `force`/`bypassCache` is true.
 */
export function scanProjectClimbs(repoPath: string | null, opts?: ScanProjectClimbsOptions): ScannedProjectClimbs {
  if (!repoPath || !existsSync(repoPath)) {
    return {
      projectDirectory: repoPath,
      engineInstalled: false,
      worktreesScanned: 0,
      currentCount: 0,
      archivedCount: 0,
      climbs: [],
      warnings: [],
    };
  }
  const normalizedMain = resolve(repoPath);
  const bypassCache = Boolean(opts?.bypassCache || opts?.force);
  const rowLimit = opts?.rowLimit === undefined ? 50 : Math.max(0, Math.floor(opts.rowLimit));
  const includeNotes = opts?.includeNotes ?? true;
  const cacheKey = `${normalizedMain}|${rowLimit}|${includeNotes ? 1 : 0}`;
  const nowMs = Date.now();

  if (!bypassCache) {
    const cached = scanCache.get(cacheKey);
    if (cached && nowMs - cached.at < SCAN_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const warnings: string[] = [];
  const engineInstalled = existsSync(engineFile(normalizedMain, "climb.py"));
  const worktrees = linkedWorktreesOf(normalizedMain, warnings);
  const roots = [normalizedMain, ...worktrees];
  const climbs: ScannedClimb[] = [];

  for (const root of roots) {
    const isMain = root === normalizedMain;
    const baseStateDir = stateDir(root);
    if (!existsSync(baseStateDir)) continue;
    const found = discoverClimbs(root);
    if (found.climbs.length === 0 && found.prepared.length === 0) continue;

    const branch = readWorktreeBranch(root);
    const worktreeName = basename(root);
    const conversationId = conversationIdFromPath(root);
    const { origin, workerLabel } = classifyOrigin(root, isMain);

    const parsedEntries: Array<{
      dirName: string;
      climbDir: string;
      card: ClimbCard;
      rows: LogRow[];
      summary: ClimbSummary;
      checks: string[];
      latestMtimeMs: number;
    }> = [];

    for (const dirName of found.climbs) {
      const climbDir = joinPath(baseStateDir, dirName);
      try {
        const cardPath = joinPath(climbDir, "card.json");
        const logPath = joinPath(climbDir, "log.jsonl");
        const lastPath = joinPath(climbDir, "last.txt");
        const cardSig = statSignature(cardPath);
        if (!cardSig) continue;
        const logSig = statSignature(logPath);
        const lastMtimeMs = statMtimeMs(lastPath);
        const logMtimeMs = logSig?.mtimeMs ?? 0;
        const logSize = logSig?.size ?? 0;
        const latestMtimeMs = Math.max(cardSig.mtimeMs, logMtimeMs, lastMtimeMs);

        const memo = !bypassCache ? climbStatMemo.get(climbDir) : undefined;
        if (
          memo &&
          memo.cardMtimeMs === cardSig.mtimeMs &&
          memo.cardSize === cardSig.size &&
          memo.logMtimeMs === logMtimeMs &&
          memo.logSize === logSize
        ) {
          parsedEntries.push({
            dirName,
            climbDir,
            card: memo.card,
            rows: memo.rows,
            summary: memo.summary,
            checks: memo.checks,
            latestMtimeMs,
          });
          continue;
        }

        const cardText = readFileSync(cardPath, "utf8");
        const card = parseCard(cardText);
        const logText = logSig ? readFileSync(logPath, "utf8") : "";
        const rows = logText === "" ? [] : parseLog(logText);
        const pendingTree = existsSync(joinPath(climbDir, "pending-tree"));
        const summary = summarize({ card, rows, notes: null, pendingTree }, 0, nowMs);
        const checks = Array.isArray(card.check) ? card.check : card.check === undefined ? [] : [card.check];

        if (climbStatMemo.size >= CLIMB_STAT_MEMO_MAX) {
          climbStatMemo.clear();
        }
        climbStatMemo.set(climbDir, {
          cardMtimeMs: cardSig.mtimeMs,
          cardSize: cardSig.size,
          logMtimeMs,
          logSize,
          card,
          rows,
          summary,
          checks,
        });
        parsedEntries.push({ dirName, climbDir, card, rows, summary, checks, latestMtimeMs });
      } catch (error) {
        warnings.push(
          `Failed to read climb ${dirName} in ${root}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    // Identify canonical climbs (folder name === card.name) and any sibling fixture folders
    // referenced in their check/guard/holdout/lock commands (e.g., `.hill-climb/unit-count-bench/`).
    const canonicalNames = new Set(
      parsedEntries.filter((e) => !e.card.name || e.card.name === e.dirName).map((e) => e.dirName),
    );
    const referencedSiblingDirs = new Set<string>();
    const refRegex = /\.hill-climb\/([^/\s"'`]+)/g;
    for (const entry of parsedEntries) {
      if (!canonicalNames.has(entry.dirName)) continue;
      const card = entry.card;
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

    for (const { dirName: name, climbDir, card, rows: allRows, summary, checks, latestMtimeMs } of parsedEntries) {
      const cardName = card.name?.trim() || name;
      // Skip orphaned/moved fixture directories that still contain a stale card.json from an earlier init
      // (folder name != card.name when the real climb exists alongside it, is referenced as fixtures, or has no log).
      if (
        cardName !== name &&
        (canonicalNames.has(cardName) || referencedSiblingDirs.has(name) || allRows.length === 0)
      ) {
        continue;
      }
      const rows: ScannedClimbRow[] =
        rowLimit === 0
          ? []
          : allRows.slice(-rowLimit).map((r) => ({
              kind: r.kind,
              step: typeof r.step === "number" && Number.isFinite(r.step) ? r.step : null,
              result: r.result ?? null,
              score: typeof r.score === "number" ? r.score : null,
              idea: typeof r.idea === "string" ? redactSecrets(r.idea) : null,
              why: typeof r.why === "string" ? redactSecrets(r.why) : null,
              time: r.time ?? null,
              commit: null,
            }));
      const rawTargetText = card.target_text ?? null;
      const targetTextMatches =
        rawTargetText !== null &&
        (summary.target === null ||
          (Number.isFinite(Number(rawTargetText)) && Math.abs(Number(rawTargetText) - summary.target) < 1e-9));
      const isLive =
        (summary.verdict === "climbing" || summary.verdict === "plateau") &&
        latestMtimeMs > 0 &&
        nowMs - latestMtimeMs <= LIVE_RECENCY_MS;
      const rawNotes = includeNotes ? readLocalFile(joinPath(climbDir, "notes.md")).text : null;
      const notes = rawNotes === null ? null : redactSecrets(rawNotes);
      const updatedAt =
        allRows[allRows.length - 1]?.time ??
        (latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : latestMtimeIso(climbDir));
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
        goal: typeof card.goal === "string" ? redactSecrets(card.goal) : null,
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
        check: checks.map(redactSecrets),
        guards: (card.guards ?? []).map(redactSecrets),
        holdout: card.holdout ? redactSecrets(card.holdout) : null,
        locked: card.lock ?? [],
        scoreMode: card.score_mode ?? "failure-count",
        rows,
        notes,
        bestCommit: card.best.commit?.trim() || null,
        preparedFiles: 0,
        preparedSampleFiles: [],
        updatedAt,
      });
    }

    for (const name of found.prepared) {
      if (name === "bridge" || referencedSiblingDirs.has(name)) continue;
      const dir = joinPath(baseStateDir, name);
      const { count, samples, maxMtimeMs } = collectSampleFiles(dir);
      const isLive = maxMtimeMs > 0 && nowMs - maxMtimeMs <= LIVE_RECENCY_MS;
      climbs.push({
        id: `${root}::${name}`,
        name,
        status: "prepared",
        origin,
        isLive,
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
        bestCommit: null,
        preparedFiles: count,
        preparedSampleFiles: samples,
        updatedAt: maxMtimeMs > 0 ? new Date(maxMtimeMs).toISOString() : latestMtimeIso(dir),
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

  const result: ScannedProjectClimbs = {
    projectDirectory: normalizedMain,
    engineInstalled,
    worktreesScanned: worktrees.length,
    currentCount,
    archivedCount,
    climbs,
    warnings,
  };
  scanCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}
