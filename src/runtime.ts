import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Repository } from "./repository.js";
import type { Goal, Outcome, Tree } from "./model.js";
import type { LiveData } from "./view-props.js";
import { number, redactSecrets } from "./state.js";
import { clearScanCache } from "./repo-ops.js";
import { applyCore } from "./tree.js";
import { read as bridgeRead, recipe as bridgeRecipe, type BridgeRead } from "./search-bridge.js";
import { rigSchema, type Rig } from "./rig.js";
import { excludePath, hasIgnoreRule, joinPath, resolvePath, withIgnoreRule } from "./engine.js";

export type Engine = "repo" | "search";

export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export const EMPTY_LIVE: LiveData = {
  engine: null,
  baseline: null,
  best: null,
  target: null,
  rows: [],
  holdout: null,
};

export const RIG_SCORE_MODE = { numeric: "numeric", legacy: "failure-count" } as const;

const CLAIM_HOURS = 4;
const MAX_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 30_000;

const liveSchema = z.object({
  engine: z.enum(["repo", "search"]).nullable(),
  baseline: z.number().nullable(),
  best: z.number().nullable(),
  target: z.number().nullable(),
  rows: z
    .array(
      z.object({
        id: z.string(),
        parent: z.string().nullable(),
        score: z.number().nullable(),
        label: z.string(),
        at: z.string(),
      }),
    )
    .default([]),
  holdout: z.string().nullable(),
  search: z
    .object({
      id: z.string(),
      climber: z.string().nullable(),
      featureDimensions: z.array(z.string()).nullable(),
      count: z.number(),
    })
    .nullable()
    .optional(),
  elite: z
    .array(
      z.object({
        island: z.number(),
        bins: z.array(z.number()),
        parent: z.string().nullable(),
        score: z.number().nullable(),
        attempts: z.number(),
      }),
    )
    .optional(),
});

export const receiptSchema = z.object({
  id: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(4000),
  verdict: z.enum(["confirms", "denies", "note"]).default("confirms"),
  version: z.number().int().positive().optional(),
  criterionIds: z.array(z.string().trim().min(1)).max(50).optional(),
  track: z.string().trim().min(1).max(96).optional(),
  runId: z.string().trim().min(1).max(200).optional(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export interface ReconcileReport {
  scanned: number;
  applied: number;
  refused: number;
  duplicate: number;
  closed: number;
  errors: string[];
}

export type RunState = "dispatching" | "live" | "failed" | "closed" | "superseded";
export type RunPhase =
  | "reserved"
  | "spawning"
  | "awaiting_checkout"
  | "preparing"
  | "running"
  | "settled"
  | "abandoned";
export type RunLiveness = "launching" | "active" | "idle" | "stale" | "gone" | "settled" | "unknown";

export interface RunStatus {
  runId: string;
  projectId: string;
  key: string;
  track: string;
  engine: Engine;
  version: number;
  state: RunState;
  phase: RunPhase;
  liveness: RunLiveness;
  threadId: string | null;
  directory: string | null;
  runDir: string | null;
  receiptPath: string | null;
  attempt: number;
  attemptsRemaining: number;
  retries: number;
  retriesRemaining: number;
  heartbeatAt: string | null;
  heartbeatNote: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  nextAction: string;
  created: string;
  updated: string;
}

export interface ReceiptRecord {
  id: string;
  runId: string;
  projectId: string;
  key: string;
  version: number;
  track: string;
  criterionIds: string[];
  kind: string;
  text: string;
  source: string;
  state: "applied" | "refused";
  refusal: string | null;
  evidenceId: string | null;
  created: string;
}

interface RunRow {
  run_id: string;
  project_id: string;
  key: string;
  track: string;
  engine: Engine;
  version: number;
  criterion_ids: string;
  state: RunState;
  phase: RunPhase | null;
  thread_id: string | null;
  directory: string | null;
  run_dir: string | null;
  receipt_path: string | null;
  recipe: string | null;
  brief: string | null;
  brief_sent: number;
  attempt: number;
  retries: number;
  spawn_started: string | null;
  heartbeat_at: string | null;
  heartbeat_note: string | null;
  lease_expires: string | null;
  recovery: string | null;
  last_error: string | null;
  created: string;
  updated: string;
  closed: string | null;
}

interface ReceiptRow {
  receipt_id: string;
  run_id: string;
  project_id: string;
  key: string;
  version: number;
  track: string;
  criterion_ids: string;
  kind: string;
  text: string;
  source: string;
  state: "applied" | "refused";
  refusal: string | null;
  evidence_id: string | null;
  created: string;
}

type BridgeRecipe = ReturnType<typeof bridgeRecipe>;

export interface DispatchResult {
  runId: string;
  threadId: string | null;
  directory: string;
  brief: string;
  activation: string;
  proof: string;
  receiptPath: string;
  needsClientWorkerLaunch: boolean;
  launchMode: "antigravity_conversation" | "client_message" | "prepared_local";
}

export interface RuntimeDeps {
  now: () => Date;
  claimHours: number;
  maxConcurrentLaunches: number;
  maxActivePerProject: number;
  maxAttempts: number;
  reconcileIntervalMs: number;
  staleAfterMs: number;
  automatic: boolean;
  disableConversationService: boolean;
  allowEphemeralConversationService: boolean;
}

export type RuntimeOptions = Partial<RuntimeDeps>;

export interface DispatchOptions {
  directory?: string;
  deferWorkerLaunch?: boolean;
  disableConversationService?: boolean;
  allowEphemeralConversationService?: boolean;
}

const defaults = (): RuntimeDeps => ({
  now: () => new Date(),
  claimHours: CLAIM_HOURS,
  maxConcurrentLaunches: 4,
  maxActivePerProject: 8,
  maxAttempts: MAX_ATTEMPTS,
  reconcileIntervalMs: RECONCILE_INTERVAL_MS,
  staleAfterMs: Math.max(RECONCILE_INTERVAL_MS * 4, 120_000),
  automatic: false,
  disableConversationService: false,
  allowEphemeralConversationService: false,
});

export interface WorkerBrief {
  projectId: string;
  key: string;
  track: string;
  engine: Engine;
  runId: string;
  version: number;
  outcome: Outcome;
  recipe: BridgeRecipe;
  directory: string;
  rig?: Rig;
  ancestors?: Goal[];
}

function parseRigFromRecipeMarker(recipe: BridgeRecipe): Rig | null {
  const markerFile = recipe.files.find((file) => file.path === recipe.markerPath);
  if (!markerFile) return null;
  try {
    const parsed = JSON.parse(markerFile.content) as { rig?: unknown };
    if (!parsed.rig || typeof parsed.rig !== "object") return null;
    const candidate = parsed.rig as { engine?: unknown };
    if (candidate.engine !== "repo" && candidate.engine !== "search") return null;
    return candidate as Rig;
  } catch {
    return null;
  }
}

function parseAncestorsFromPrompt(rawPrompt: string): Goal[] {
  const header = "## Briefs you inherit";
  const start = rawPrompt.indexOf(header);
  if (start === -1) return [];
  const afterHeader = start + header.length;
  const nextSection = rawPrompt.indexOf("\n## ", afterHeader);
  const block = (nextSection === -1 ? rawPrompt.slice(afterHeader) : rawPrompt.slice(afterHeader, nextSection)).trim();
  const goals: Goal[] = [];
  for (const line of block.split("\n")) {
    const match = /^- \*\*(.+)\*\* — (.*)$/.exec(line);
    if (!match) continue;
    goals.push({
      key: "",
      parentGoalKey: null,
      title: match[1] as string,
      brief: match[2] as string,
      rank: goals.length,
      created: "",
    });
  }
  return goals;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactRigForDisplay(rig: Rig): Rig {
  if (rig.engine === "repo") {
    return {
      ...rig,
      check: rig.check.map(redactSecrets),
      guard: rig.guard.map(redactSecrets),
      holdout: redactSecrets(rig.holdout),
      lock: rig.lock.map(redactSecrets),
      ...(rig.score !== undefined ? { score: rig.score.map(redactSecrets) } : {}),
      ...(rig.preflight !== undefined ? { preflight: redactSecrets(rig.preflight) } : {}),
      ...(rig.minGain !== undefined ? { minGain: redactSecrets(rig.minGain) } : {}),
    };
  }
  return {
    ...rig,
    metric: redactSecrets(rig.metric),
    verifier: redactSecrets(rig.verifier),
    baseline: redactSecrets(rig.baseline),
    ...(rig.budget !== undefined ? { budget: redactSecrets(rig.budget) } : {}),
    ...(rig.agent !== undefined ? { agent: redactSecrets(rig.agent) } : {}),
    ...(rig.model !== undefined ? { model: redactSecrets(rig.model) } : {}),
    ...(rig.runner !== undefined ? { runner: redactSecrets(rig.runner) } : {}),
  };
}

export function workerPrompt(brief: WorkerBrief): string {
  const { outcome, recipe } = brief;
  const rawPrompt = recipe.prompt.trim();
  const missingCriteria = outcome.criteria.filter((criterion) => !rawPrompt.includes(criterion.id));

  let safePrompt = rawPrompt;
  const displayRig = brief.rig ?? parseRigFromRecipeMarker(recipe);
  let rebuilt = false;
  if (displayRig !== null) {
    try {
      const ancestors = brief.ancestors ?? parseAncestorsFromPrompt(rawPrompt);
      const safeOutcome: Outcome = {
        ...outcome,
        title: redactSecrets(outcome.title),
        story: redactSecrets(outcome.story),
        criteria: outcome.criteria.map((criterion) => ({
          ...criterion,
          given: redactSecrets(criterion.given),
          when: redactSecrets(criterion.when),
          then: redactSecrets(criterion.then),
        })),
      };
      const safeAncestors: Goal[] = ancestors.map((goal) => ({
        ...goal,
        title: redactSecrets(goal.title),
        brief: redactSecrets(goal.brief),
      }));
      const safeRig = redactRigForDisplay(displayRig);
      const dirMatch = new RegExp(`^Outcome \\\`${escapeRegExp(outcome.key)}\\\` v${outcome.version} in (.+)\\.$`, "m").exec(rawPrompt);
      const displayWorkspace = { directory: dirMatch?.[1] ?? "." };
      const displayRecipe = bridgeRecipe({
        workspace: displayWorkspace,
        outcome: safeOutcome,
        ancestors: safeAncestors,
        engine: brief.engine,
        rig: safeRig,
        runId: brief.runId,
        track: brief.track,
      });
      safePrompt = displayRecipe.prompt.trim();
      const origDigest12 = recipe.binding.digest.slice(0, 12);
      const dispDigest12 = displayRecipe.binding.digest.slice(0, 12);
      if (origDigest12 && dispDigest12 && origDigest12 !== dispDigest12) {
        safePrompt = safePrompt.replaceAll(dispDigest12, origDigest12);
      }
      if (displayRecipe.proof !== recipe.proof) {
        safePrompt = safePrompt.replaceAll(displayRecipe.proof, redactSecrets(recipe.proof));
      }
      rebuilt = true;
    } catch {
      rebuilt = false;
    }
  }
  if (!rebuilt) {
    for (const criterion of outcome.criteria) {
      const rawLine = `- **${criterion.id}** — given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`;
      if (safePrompt.includes(rawLine)) {
        const safeLine = `- **${redactSecrets(criterion.id)}** — given ${redactSecrets(criterion.given)}, when ${redactSecrets(criterion.when)}, then ${redactSecrets(criterion.then)}`;
        safePrompt = safePrompt.replaceAll(rawLine, safeLine);
      }
    }
    const safeTitle = redactSecrets(outcome.title);
    if (safeTitle !== outcome.title && outcome.title.length > 0) {
      safePrompt = safePrompt.replaceAll(`# Climb: ${outcome.title}`, `# Climb: ${safeTitle}`);
    }
    const safeStory = redactSecrets(outcome.story);
    if (safeStory !== outcome.story && outcome.story.length > 0) {
      safePrompt = safePrompt.replaceAll(outcome.story, safeStory);
    }
  }
  safePrompt = redactSecrets(safePrompt);

  const lines: string[] = [
    `<!-- hillclimb: run ${redactSecrets(recipe.runId)} · ${redactSecrets(brief.key)} v${brief.version} · track ${redactSecrets(brief.track)} · engine ${brief.engine} · project ${redactSecrets(brief.projectId)} -->`,
    "",
    `Workspace directory: \`${redactSecrets(brief.directory)}\``,
    "",
    safePrompt,
    "",
  ];
  if (missingCriteria.length) {
    lines.push("## Criteria this run must prove", "");
    for (const criterion of missingCriteria) {
      lines.push(
        `- \`${redactSecrets(criterion.id)}\` given ${redactSecrets(criterion.given)}, when ${redactSecrets(criterion.when)}, then ${redactSecrets(criterion.then)}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Limits this dispatch set",
    "- Work inside the configured repository checkout. Do not push, do not deploy, and do not move a branch someone else works on.",
    "- Use the configured engine, verifier and budget in this checkout.",
    `- The receipt is the verifier's record. Run \`${redactSecrets(recipe.proof)}\` exactly once at the bar; do not write, edit or hand-set a receipt line. The bridge re-checks the verifier's own record and refuses anything it cannot re-run.`,
    "- Stop at the bar, at a plateau, or after two refusals for the same reason, and say which one it was.",
    "- When finished, call `hillclimb_search_summit` to verify the receipt landed in the ledger.",
  );
  return redactSecrets(lines.join("\n"));
}

export interface ConversationServiceGuardOptions {
  directory?: string | null;
  disableConversationService?: boolean;
  allowEphemeralConversationService?: boolean;
}

export type ConversationServiceBlockReason =
  | "disabled_by_env"
  | "disabled_by_option"
  | "blocked_test_harness"
  | "blocked_ephemeral_directory";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function isTestHarnessArg(arg: string): boolean {
  if (arg === "--test" || arg.startsWith("--test=") || arg.startsWith("--test-")) return true;
  return /(?:^|[\\/=])(?:tsx|vitest|jest|mocha)(?:[\\/.]|$)/i.test(arg);
}

function isTestHarnessEntrypoint(entry: string | undefined): boolean {
  if (!entry) return false;
  if (/(?:^|[\\/])node_modules[\\/](?:tsx|vitest|jest|mocha)(?:[\\/]|$)/i.test(entry)) return true;
  const file = basename(entry);
  if (/^(?:tsx|vitest|jest|mocha)(?:\.[cm]?[jt]s)?$/i.test(file)) return true;
  return /\.(?:test|spec)\.[cm]?[jt]s$/i.test(file);
}

function isTestHarnessEnvironment(): boolean {
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (isTruthyEnv(process.env.VITEST) || process.env.VITEST_WORKER_ID || process.env.JEST_WORKER_ID) return true;
  if (process.execArgv.some(isTestHarnessArg)) return true;
  if (isTestHarnessEntrypoint(process.argv[1])) return true;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--") break;
    if (arg === "--test" || arg.startsWith("--test=")) return true;
  }
  return false;
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return tmpdir();
  }
}

function isEphemeralTempDirectory(directory: string): boolean {
  const resolvedDir = resolve(directory);
  const canonDir = canonicalPath(resolvedDir);
  const rawRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  for (const rawRoot of rawRoots) {
    if (!rawRoot) continue;
    const resRoot = resolve(rawRoot);
    if (resRoot !== parsePath(resRoot).root) {
      if (isSameOrInside(resRoot, resolvedDir) || isSameOrInside(resRoot, canonDir)) return true;
    }
    const canonRoot = canonicalPath(resRoot);
    if (canonRoot !== parsePath(canonRoot).root) {
      if (isSameOrInside(canonRoot, resolvedDir) || isSameOrInside(canonRoot, canonDir)) return true;
    }
  }
  return false;
}

export function conversationServiceGuardReason(
  options?: ConversationServiceGuardOptions,
): ConversationServiceBlockReason | null {
  if (isTruthyEnv(process.env.HILLCLIMB_DISABLE_CONVERSATION_SERVICE)) {
    return "disabled_by_env";
  }
  if (options?.disableConversationService) {
    return "disabled_by_option";
  }
  const allowTestOrEphemeral =
    Boolean(options?.allowEphemeralConversationService) ||
    isTruthyEnv(process.env.HILLCLIMB_ALLOW_TEST_CONVERSATION_SERVICE);
  if (!allowTestOrEphemeral) {
    if (isTestHarnessEnvironment()) return "blocked_test_harness";
    if (options?.directory && isEphemeralTempDirectory(options.directory)) return "blocked_ephemeral_directory";
  }
  return null;
}

async function callConversationService<T>(
  method: string,
  body: Record<string, unknown>,
  guardOptions?: ConversationServiceGuardOptions,
): Promise<T | null> {
  if (conversationServiceGuardReason(guardOptions) !== null) return null;
  const address = process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!address || !token) return null;
  try {
    const response = await fetch(`http://${address}/product.v1.ConversationService/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function ensureGitExclude(repoPath: string, extraRules: string[]): void {
  try {
    const dotGitHead = join(repoPath, ".git", "HEAD");
    let excludeFile: string;
    if (existsSync(dotGitHead)) {
      excludeFile = excludePath(repoPath, { dotGitIsDirectory: true }).excludePath;
    } else {
      const dotGit = join(repoPath, ".git");
      if (!existsSync(dotGit)) return;
      const pointer = readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      const commonPath = match?.[1] ? joinPath(resolvePath(repoPath, match[1].trim()), "commondir") : null;
      const commonText = commonPath && existsSync(commonPath) ? readFileSync(commonPath, "utf8") : null;
      excludeFile = excludePath(repoPath, {
        dotGitIsDirectory: false,
        dotGitText: pointer,
        commonDirText: commonText,
      }).excludePath;
    }
    let text = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    let changed = false;
    if (!hasIgnoreRule(text)) {
      text = withIgnoreRule(text);
      changed = true;
    }
    for (const rule of extraRules) {
      const lines = text.split("\n").map((l) => l.trim());
      if (!lines.includes(rule)) {
        const sep = text === "" || text.endsWith("\n") ? "" : "\n";
        text = `${text}${sep}${rule}\n`;
        changed = true;
      }
    }
    if (changed) {
      mkdirSync(dirname(excludeFile), { recursive: true });
      writeFileSync(excludeFile, text, "utf8");
    }
  } catch {
    // Non-fatal if repo is not a git repo or exclude is read-only
  }
}

export function createRuntime(repo: Repository, overrides: RuntimeOptions = {}) {
  const deps: RuntimeDeps = { ...defaults(), ...overrides };
  const db = repo.db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS hc_runs(
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      track TEXT NOT NULL,
      engine TEXT NOT NULL,
      version INTEGER NOT NULL,
      criterion_ids TEXT NOT NULL,
      state TEXT NOT NULL,
      phase TEXT,
      thread_id TEXT,
      directory TEXT,
      run_dir TEXT,
      receipt_path TEXT,
      recipe TEXT,
      brief TEXT,
      brief_sent INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0,
      spawn_started TEXT,
      heartbeat_at TEXT,
      heartbeat_note TEXT,
      lease_expires TEXT,
      recovery TEXT,
      last_error TEXT,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      closed TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hc_runs_one_live
      ON hc_runs(project_id,key,track) WHERE state IN ('dispatching','live');
    CREATE INDEX IF NOT EXISTS hc_runs_thread ON hc_runs(thread_id);
    CREATE INDEX IF NOT EXISTS hc_runs_project_state ON hc_runs(project_id,state);
    CREATE INDEX IF NOT EXISTS hc_runs_project_key_track ON hc_runs(project_id,key,track);
    CREATE TABLE IF NOT EXISTS hc_receipts(
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      track TEXT NOT NULL,
      criterion_ids TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL,
      refusal TEXT,
      evidence_id TEXT,
      created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hc_receipts_run ON hc_receipts(run_id);
    CREATE TABLE IF NOT EXISTS hc_rigs(
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      engine TEXT NOT NULL,
      body TEXT NOT NULL,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      PRIMARY KEY(project_id,key,version,engine)
    );
    CREATE TABLE IF NOT EXISTS hc_badges(
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      track TEXT NOT NULL,
      score TEXT,
      live TEXT,
      updated TEXT NOT NULL,
      PRIMARY KEY(project_id,key,track)
    );
  `);

  const now = () => deps.now();
  const nowIso = () => now().toISOString();
  const ms = (value: string) => Date.parse(value);

  const activeRunStmt = db.prepare(
    `SELECT * FROM hc_runs WHERE project_id=? AND key=? AND track=? AND state IN ('dispatching','live') ORDER BY created DESC LIMIT 1`,
  );
  const runByIdStmt = db.prepare(`SELECT * FROM hc_runs WHERE run_id=?`);
  const runsByProjectStmt = db.prepare(
    `SELECT * FROM hc_runs WHERE project_id=? AND state IN ('dispatching','live') ORDER BY created`,
  );
  const activeRunsStmt = db.prepare(`SELECT * FROM hc_runs WHERE state IN ('dispatching','live') ORDER BY created`);
  const launchesInFlightStmt = db.prepare(`SELECT COUNT(*) AS n FROM hc_runs WHERE state='dispatching'`);
  const activeForProjectStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM hc_runs WHERE project_id=? AND state IN ('dispatching','live')`,
  );
  const latestRunStmt = db.prepare(
    `SELECT * FROM hc_runs WHERE project_id=? AND key=? AND track=? ORDER BY rowid DESC LIMIT 1`,
  );
  const failedAttemptsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM hc_runs WHERE project_id=? AND key=? AND track=? AND version=? AND state='failed'`,
  );
  const receiptByIdStmt = db.prepare(`SELECT * FROM hc_receipts WHERE receipt_id=?`);
  const badgeByKeyStmt = db.prepare(
    `SELECT score, live FROM hc_badges WHERE project_id=? AND key=? ORDER BY updated DESC LIMIT 1`,
  );
  const rigAtStmt = db.prepare(`SELECT body FROM hc_rigs WHERE project_id=? AND key=? AND version=? AND engine=?`);

  const writeRunStmt = db.prepare(
    `INSERT INTO hc_runs(run_id,project_id,key,track,engine,version,criterion_ids,state,phase,thread_id,directory,run_dir,receipt_path,recipe,brief,brief_sent,attempt,retries,spawn_started,heartbeat_at,heartbeat_note,lease_expires,recovery,last_error,created,updated,closed)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const updateRunStmt = db.prepare(
    `UPDATE hc_runs SET state=?,phase=?,thread_id=?,directory=?,run_dir=?,receipt_path=?,recipe=?,brief=?,brief_sent=?,retries=?,spawn_started=?,heartbeat_at=?,heartbeat_note=?,lease_expires=?,recovery=?,last_error=?,updated=?,closed=? WHERE run_id=?`,
  );
  const writeReceiptStmt = db.prepare(
    `INSERT INTO hc_receipts(receipt_id,run_id,project_id,key,version,track,criterion_ids,kind,text,source,state,refusal,evidence_id,created)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const writeRigStmt = db.prepare(
    `INSERT INTO hc_rigs(project_id,key,version,engine,body,created,updated) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(project_id,key,version,engine) DO UPDATE SET body=excluded.body, updated=excluded.updated`,
  );
  const writeBadgeStmt = db.prepare(
    `INSERT INTO hc_badges(project_id,key,track,score,live,updated) VALUES(?,?,?,?,?,?)
     ON CONFLICT(project_id,key,track) DO UPDATE SET score=excluded.score,live=excluded.live,updated=excluded.updated`,
  );

  function persist(row: RunRow): void {
    updateRunStmt.run(
      row.state,
      row.phase,
      row.thread_id,
      row.directory,
      row.run_dir,
      row.receipt_path,
      row.recipe,
      row.brief,
      row.brief_sent,
      row.retries,
      row.spawn_started,
      row.heartbeat_at,
      row.heartbeat_note,
      row.lease_expires,
      row.recovery,
      row.last_error,
      row.updated,
      row.closed,
      row.run_id,
    );
  }

  function touch(row: RunRow, note: string, phase?: RunPhase): void {
    const stamp = nowIso();
    row.heartbeat_at = stamp;
    row.heartbeat_note = note;
    if (phase) row.phase = phase;
    row.updated = stamp;
    persist(row);
  }

  function phaseOf(row: RunRow): RunPhase {
    if (row.state === "closed" || row.state === "superseded") return "settled";
    if (row.state === "failed") return "abandoned";
    if (row.phase) return row.phase;
    if (row.state === "live") return "running";
    return row.thread_id ? "preparing" : "reserved";
  }

  function silenceMs(row: RunRow): number {
    const since = row.heartbeat_at ?? row.updated;
    return Math.max(0, now().getTime() - ms(since));
  }

  function livenessOf(row: RunRow): RunLiveness {
    if (row.state === "failed") return "gone";
    if (row.state === "closed" || row.state === "superseded") return "settled";
    const silent = silenceMs(row);
    if (row.state === "dispatching") {
      return silent > deps.staleAfterMs ? "stale" : "launching";
    }
    if (silent > deps.staleAfterMs) return "stale";
    return /\bidle\b/i.test(row.heartbeat_note ?? "") ? "idle" : "active";
  }

  function nextActionOf(row: RunRow, liveness: RunLiveness): string {
    if (row.state === "closed") return "none: the run proved its contract";
    if (row.state === "superseded") return "This run was superseded. Check the active run for this contract.";
    if (row.state === "failed") {
      if (row.attempt >= deps.maxAttempts) return "none: the attempt budget is spent; propose a change or raise the budget";
      return `dispatch again (attempt ${row.attempt + 1} of ${deps.maxAttempts})`;
    }
    if (row.state === "dispatching") return "preparing worker checkout and delivering brief";
    if (liveness === "stale") return `no observation since ${row.heartbeat_at ?? row.updated}; reconcile to check progress`;
    if (liveness === "idle") return "the worker is idle; reconcile to collect its receipt";
    return "collecting progress on the next sweep";
  }

  function status(row: RunRow): RunStatus {
    const liveness = livenessOf(row);
    return {
      runId: row.run_id,
      projectId: row.project_id,
      key: row.key,
      track: row.track,
      engine: row.engine,
      version: row.version,
      state: row.state,
      phase: phaseOf(row),
      liveness,
      threadId: row.thread_id,
      directory: row.directory,
      runDir: row.run_dir,
      receiptPath: row.receipt_path,
      attempt: row.attempt,
      attemptsRemaining: Math.max(0, deps.maxAttempts - row.attempt),
      retries: row.retries,
      retriesRemaining: Math.max(0, 3 - row.retries),
      heartbeatAt: row.heartbeat_at,
      heartbeatNote: row.heartbeat_note,
      leaseExpiresAt: row.lease_expires,
      lastError: row.last_error,
      nextAction: nextActionOf(row, liveness),
      created: row.created,
      updated: row.updated,
    };
  }

  function selectedCriteria(value: unknown, outcome: Outcome): string[] | null {
    if (value === null || typeof value !== "object") return null;
    const raw = (value as { criterionIds?: unknown }).criterionIds;
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || !raw.every((id): id is string => typeof id === "string")) {
      throw new RuntimeError("bad_criterion", "criterionIds must be a list of criterion ids");
    }
    const ids = [...new Set(raw)];
    if (!ids.length) throw new RuntimeError("bad_criterion", "a verifier selection must name at least one criterion");
    const known = new Set(outcome.criteria.map((criterion) => criterion.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new RuntimeError(
        "bad_criterion",
        `criteria ${unknown.join(", ")} are not in ${outcome.key} v${outcome.version} (has ${[...known].join(", ") || "none"})`,
      );
    }
    return ids;
  }

  function reservedCriteria(recipe: BridgeRecipe, selection: string[] | null, outcome: Outcome): string[] {
    const known = outcome.criteria.map((criterion) => criterion.id);
    const onlyKnown = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return [...new Set(value.filter((item): item is string => typeof item === "string" && known.includes(item)))];
    };
    const fromBinding = onlyKnown(recipe.binding?.criterionIds);
    if (fromBinding.length) {
      if (selection === null) return fromBinding;
      const narrowed = fromBinding.filter((id) => selection.includes(id));
      if (narrowed.length) return narrowed;
      throw new RuntimeError(
        "bad_criterion",
        `The saved verifier selection (${selection.join(", ")}) has no criterion in common with the binding (${fromBinding.join(", ")}) for ${outcome.key} v${outcome.version}.`,
      );
    }
    return selection ?? known;
  }

  function trustedBinding(row: RunRow): { expectedMarker: string; expectedProof: string } {
    if (!row.recipe) throw new RuntimeError("missing_binding", "The dispatch has no saved verifier binding.");
    const recipe = JSON.parse(row.recipe) as BridgeRecipe;
    const marker = recipe.files.find((file) => file.path === recipe.markerPath);
    if (!marker?.content) throw new RuntimeError("missing_binding", "The saved verifier binding has no marker.");
    return { expectedMarker: marker.content, expectedProof: recipe.proof };
  }

  function materialize(directory: string, recipe: BridgeRecipe): void {
    ensureGitExclude(directory, ["/.hillclimb/bridge/"]);
    for (const file of recipe.files) {
      const fullPath = resolveInside(directory, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf8");
    }
  }

  function claimOf(projectId: string, key: string): { claim: { threadId: string; expires: string } | null; live: boolean } {
    const claim = repo.read(projectId).claims.find((item) => item.key === key) ?? null;
    if (!claim) return { claim: null, live: false };
    return { claim, live: ms(claim.expires) > now().getTime() };
  }

  function takeClaim(projectId: string, key: string, threadId: string): { ok: true; expires: string | null } | { ok: false; reason: string } {
    try {
      repo.modify(projectId, (tree) => {
        applyCore(tree, { op: "claim_outcome", key, threadId, hours: deps.claimHours }, nowIso());
      });
      return { ok: true, expires: claimOf(projectId, key).claim?.expires ?? null };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  function saveRig(projectId: string, key: string, version: number, value: unknown): { version: number; engine: Engine } {
    if (!projectId) throw new RuntimeError("no_project", "Select a project before saving a rig.");
    if (!Number.isInteger(version) || version < 1) {
      throw new RuntimeError("bad_version", `Rig version must be a positive integer, got ${String(version)}.`);
    }
    const outcome = repo.read(projectId).outcomes.find((item) => item.key === key);
    if (!outcome) throw new RuntimeError("unknown_outcome", `No outcome ${key} in this project.`);
    if (version !== outcome.version) {
      throw new RuntimeError(
        "stale_version",
        `${key} is at v${outcome.version}; the rig editor is on v${version}. Reload the contract and save against v${outcome.version}.`,
      );
    }
    selectedCriteria(value, outcome);
    const parsed = rigSchema.safeParse(value);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "rig"}: ${issue.message}`).join("; ");
      throw new RuntimeError("bad_rig", `That is not a rig the bridge can run: ${detail}`);
    }
    const rig: Rig = parsed.data;
    const body = rig.engine === "repo" && rig.scoreMode === undefined ? { ...rig, scoreMode: RIG_SCORE_MODE.numeric } : rig;
    const stamp = nowIso();
    writeRigStmt.run(projectId, key, version, rig.engine, JSON.stringify(body), stamp, stamp);
    return { version, engine: rig.engine };
  }

  function getRigAt(projectId: string, key: string, version: number, engine: Engine): Rig | null {
    const row = rigAtStmt.get(projectId, key, version, engine) as { body: string } | undefined;
    if (!row) return null;
    try {
      const parsed = rigSchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) return null;
      const rig = parsed.data;
      if (rig.engine === "repo" && rig.scoreMode === undefined) return { ...rig, scoreMode: RIG_SCORE_MODE.legacy };
      return rig;
    } catch {
      return null;
    }
  }

  function getRig(projectId: string, key: string, engine: Engine): Rig | null {
    const outcome = repo.read(projectId).outcomes.find((item) => item.key === key);
    if (!outcome) return null;
    return getRigAt(projectId, key, outcome.version, engine);
  }

  function attachWorker(runId: string, threadId: string): RunStatus {
    const row = runByIdStmt.get(runId) as RunRow | undefined;
    if (!row) throw new RuntimeError("unknown_run", `Unknown run ${runId}.`);
    row.thread_id = threadId;
    const claim = takeClaim(row.project_id, row.key, threadId);
    if (!claim.ok) {
      row.state = "failed";
      row.last_error = claim.reason;
      row.closed = nowIso();
      touch(row, `could not lease ${row.key}: ${claim.reason}`, "abandoned");
      throw new RuntimeError("claim_refused", `Could not lease ${row.key}: ${claim.reason}`);
    }
    row.lease_expires = claim.expires;
    row.brief_sent = 1;
    row.state = "live";
    row.last_error = null;
    touch(row, `worker ${threadId} launched and leased ${row.key}`, "running");
    return status(row);
  }

  function retire(runId: string, state: RunState, reason: string): void {
    const row = runByIdStmt.get(runId) as RunRow | undefined;
    if (!row || row.state === "closed" || row.state === "failed" || row.state === "superseded") return;
    if (row.thread_id) {
      try {
        repo.modify(row.project_id, (tree) => {
          const claim = tree.claims.find((item) => item.key === row.key);
          if (claim && claim.threadId === row.thread_id) {
            applyCore(tree, { op: "release_outcome", key: row.key, threadId: claim.threadId }, nowIso());
          }
        });
      } catch {
        // non-fatal
      }
    }
    row.state = state;
    row.last_error = reason;
    row.closed = nowIso();
    row.updated = nowIso();
    persist(row);
  }

  async function dispatch(
    projectId: string,
    key: string,
    engine: Engine,
    track = "main",
    options?: DispatchOptions,
  ): Promise<DispatchResult> {
    if (!projectId) throw new RuntimeError("no_project", "Select a project before dispatching a climb.");
    if (engine !== "repo" && engine !== "search") throw new RuntimeError("no_engine", `Unknown engine ${String(engine)}.`);

    const existing = activeRunStmt.get(projectId, key, track) as RunRow | undefined;
    if (existing) {
      const existingRecipe = existing.recipe ? (JSON.parse(existing.recipe) as BridgeRecipe) : null;
      if (existing.state === "live" && existing.directory && existing.brief && existingRecipe) {
        return {
          runId: existing.run_id,
          threadId: existing.thread_id,
          directory: existing.directory,
          brief: existing.brief,
          activation: existingRecipe.activation,
          proof: existingRecipe.proof,
          receiptPath: existingRecipe.receiptPath,
          needsClientWorkerLaunch: false,
          launchMode: existing.thread_id?.startsWith("local:") ? "prepared_local" : "antigravity_conversation",
        };
      }
      const tree = repo.read(projectId);
      const outcome = tree.outcomes.find((item) => item.key === key);
      if (!outcome) retire(existing.run_id, "closed", "the outcome was removed");
      else if (outcome.version !== existing.version) retire(existing.run_id, "superseded", "contract advanced");
      else if (existing.state === "dispatching" && existing.directory && existing.brief && existingRecipe) {
        return {
          runId: existing.run_id,
          threadId: existing.thread_id,
          directory: existing.directory,
          brief: existing.brief,
          activation: existingRecipe.activation,
          proof: existingRecipe.proof,
          receiptPath: existingRecipe.receiptPath,
          needsClientWorkerLaunch: !existing.brief_sent,
          launchMode: "client_message",
        };
      }
    }

    const tree = repo.read(projectId);
    const outcome = tree.outcomes.find((item) => item.key === key);
    if (!outcome) throw new RuntimeError("unknown_outcome", `No outcome ${key} in this project.`);
    const view = repo.view(projectId, track);
    const ranked = view.ranked.find((row) => row.key === key);
    if (!ranked) throw new RuntimeError("unknown_track", `Outcome ${key} is not ranked on track ${track}.`);
    if (ranked.blockedBy.length) {
      throw new RuntimeError("blocked", `${key} is blocked by unproven ${ranked.blockedBy.join(", ")}.`);
    }
    if (ranked.claim) {
      throw new RuntimeError("claimed", `${key} is already claimed by ${ranked.claim.threadId} until ${ranked.claim.expires}.`);
    }
    if (ranked.signal === "verified") {
      throw new RuntimeError("already_verified", `${key} is verified. Propose a change or add a recheck before climbing it again.`);
    }

    const rig = getRig(projectId, key, engine);
    const selection = rig ? selectedCriteria(rig, outcome) : null;
    if (!rig) {
      throw new RuntimeError(
        "missing_rig",
        `No rig stored for ${key} v${outcome.version} (${engine}). Save the verifier configuration before dispatching.`,
      );
    }

    const projectInfo = repo.getProject(projectId);
    const directory = options?.directory
      ? resolve(options.directory)
      : projectInfo?.directory
        ? resolve(projectInfo.directory)
        : null;
    if (!directory || !existsSync(directory)) {
      throw new RuntimeError(
        "no_checkout",
        `Project ${projectId} has no registered local workspace directory. Register its repository directory first (or pass directory).`,
      );
    }

    const ancestors = ancestorsOf(tree, outcome.goalKey);
    const runId = mintRunId(now());
    let recipe: BridgeRecipe;
    try {
      recipe = bridgeRecipe({ workspace: { directory: "." }, outcome, ancestors, engine, rig, runId, track });
    } catch (error) {
      throw new RuntimeError("bridge_refused", message(error));
    }
    const brief = workerPrompt({ projectId, key, track, engine, runId, version: outcome.version, outcome, recipe, directory, rig, ancestors });

    const attempt = ((failedAttemptsStmt.get(projectId, key, track, outcome.version) as { n: number } | undefined)?.n ?? 0) + 1;
    const launches = (launchesInFlightStmt.get() as { n: number } | undefined)?.n ?? 0;
    if (launches >= deps.maxConcurrentLaunches) {
      throw new RuntimeError("launch_limit", `${launches} launches are already in flight (limit ${deps.maxConcurrentLaunches}).`);
    }
    const active = (activeForProjectStmt.get(projectId) as { n: number } | undefined)?.n ?? 0;
    if (active >= deps.maxActivePerProject) {
      throw new RuntimeError("project_limit", `${projectId} already has ${active} active runs (limit ${deps.maxActivePerProject}).`);
    }
    if (attempt > deps.maxAttempts) {
      throw new RuntimeError(
        "attempt_budget_exhausted",
        `${key} on track ${track} has spent its ${deps.maxAttempts} launches on v${outcome.version}.`,
      );
    }

    const stamp = nowIso();
    const run: RunRow = {
      run_id: runId,
      project_id: projectId,
      key,
      track,
      engine,
      version: outcome.version,
      criterion_ids: JSON.stringify(reservedCriteria(recipe, selection, outcome)),
      state: "dispatching",
      phase: "preparing",
      thread_id: null,
      directory,
      run_dir: recipe.runDir,
      receipt_path: recipe.receiptPath,
      recipe: JSON.stringify(recipe),
      brief,
      brief_sent: 0,
      attempt,
      retries: 0,
      spawn_started: stamp,
      heartbeat_at: stamp,
      heartbeat_note: "materializing verifier rig, marker and receipt script",
      lease_expires: null,
      recovery: null,
      last_error: null,
      created: stamp,
      updated: stamp,
      closed: null,
    };

    try {
      writeRunStmt.run(
        run.run_id,
        run.project_id,
        run.key,
        run.track,
        run.engine,
        run.version,
        run.criterion_ids,
        run.state,
        run.phase,
        run.thread_id,
        run.directory,
        run.run_dir,
        run.receipt_path,
        run.recipe,
        run.brief,
        run.brief_sent,
        run.attempt,
        run.retries,
        run.spawn_started,
        run.heartbeat_at,
        run.heartbeat_note,
        run.lease_expires,
        run.recovery,
        run.last_error,
        run.created,
        run.updated,
        run.closed,
      );
    } catch (error) {
      if (/UNIQUE/i.test(message(error))) {
        throw new RuntimeError("dispatch_in_progress", `Another dispatch for ${key} on track ${track} is already active.`);
      }
      throw error;
    }

    try {
      materialize(directory, recipe);
      clearScanCache(directory);
    } catch (error) {
      retire(runId, "failed", `materialize failed: ${message(error)}`);
      throw new RuntimeError("materialize_failed", `Could not write verifier files into ${directory}: ${message(error)}`);
    }

    if (options?.deferWorkerLaunch) {
      touch(run, "rig and marker materialized; awaiting client worker launch", "preparing");
      return {
        runId,
        threadId: null,
        directory,
        brief,
        activation: recipe.activation,
        proof: recipe.proof,
        receiptPath: recipe.receiptPath,
        needsClientWorkerLaunch: true,
        launchMode: "client_message",
      };
    }

    // Try spawning an Antigravity worker conversation via ConversationService if LS env is present
    // and allowed by runtime/env/test-harness/ephemeral-directory safeguards.
    const created = await callConversationService<{ conversation?: { id?: string } }>(
      "CreateConversation",
      {
        ...(projectInfo?.source === "antigravity" ? { projectId } : {}),
        title: `Climb ${key} · ${engine}`,
        tags: ["hillclimb", `run:${runId}`, `outcome:${key}`],
        prompt: [{ text: brief }],
      },
      {
        directory,
        disableConversationService: Boolean(options?.disableConversationService || deps.disableConversationService),
        allowEphemeralConversationService: Boolean(
          options?.allowEphemeralConversationService || deps.allowEphemeralConversationService,
        ),
      },
    );
    const convId = created?.conversation?.id ?? null;
    if (convId) {
      attachWorker(runId, convId);
      return {
        runId,
        threadId: convId,
        directory,
        brief,
        activation: recipe.activation,
        proof: recipe.proof,
        receiptPath: recipe.receiptPath,
        needsClientWorkerLaunch: false,
        launchMode: "antigravity_conversation",
      };
    }

    // Fallback: prepared local run ready for the calling agent or user shell.
    const localWorkerId = `local:${runId}`;
    attachWorker(runId, localWorkerId);
    return {
      runId,
      threadId: localWorkerId,
      directory,
      brief,
      activation: recipe.activation,
      proof: recipe.proof,
      receiptPath: recipe.receiptPath,
      needsClientWorkerLaunch: false,
      launchMode: "prepared_local",
    };
  }

  function bookReceipt(
    row: RunRow,
    raw: unknown,
  ): { outcome: "applied" | "refused" | "duplicate" | "invalid"; why?: string; evidenceId?: string } {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: "invalid",
        why: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      };
    }
    const receipt = parsed.data;
    const seen = receiptByIdStmt.get(receipt.id) as ReceiptRow | undefined;
    if (seen) return { outcome: "duplicate", evidenceId: seen.evidence_id ?? undefined };

    const refuse = (why: string) => {
      recordReceipt(receipt, row, "refused", why, null);
      return { outcome: "refused" as const, why };
    };

    if (receipt.runId && receipt.runId !== row.run_id) {
      return refuse(`receipt ${receipt.id} belongs to run ${receipt.runId}, not ${row.run_id}`);
    }
    if (receipt.version !== undefined && receipt.version !== row.version) {
      return refuse(`receipt ${receipt.id} is for version ${receipt.version}; the run is for version ${row.version}`);
    }
    if (receipt.track && receipt.track !== row.track) {
      return refuse(`receipt ${receipt.id} is on track ${receipt.track}, not ${row.track}`);
    }

    const tree = repo.read(row.project_id);
    const outcome = tree.outcomes.find((item) => item.key === row.key);
    if (!outcome) return refuse(`outcome ${row.key} no longer exists`);
    if (outcome.version !== row.version) {
      return refuse(`receipt ${receipt.id} is for version ${row.version}; the contract is at version ${outcome.version}`);
    }

    const held = tree.claims.find((claim) => claim.key === row.key);
    if (held && row.thread_id && held.threadId !== row.thread_id) {
      return refuse(
        `the lease for ${row.key} is held by ${held.threadId} until ${held.expires}; this run's worker is ${row.thread_id}`,
      );
    }

    const current = new Set(outcome.criteria.map((criterion) => criterion.id));
    const dispatched = JSON.parse(row.criterion_ids) as string[];
    const dispatchedSet = new Set(dispatched);
    const named = receipt.criterionIds?.length ? [...new Set(receipt.criterionIds)] : dispatched;
    const foreign = named.filter((id) => !dispatchedSet.has(id));
    if (foreign.length) {
      return refuse(`receipt ${receipt.id} names criteria this run was not dispatched for: ${foreign.join(", ")}`);
    }
    const bound = named.filter((id) => current.has(id));
    if (bound.length === 0) {
      return refuse(`receipt ${receipt.id} names no criterion that still exists on ${row.key} v${outcome.version}`);
    }
    if (!tree.tracks.some((item) => item.name === row.track)) {
      return refuse(`track ${row.track} is not defined in this tree`);
    }

    const twin = tree.evidence.find(
      (item) =>
        item.key === row.key &&
        item.version === row.version &&
        item.source === receipt.source &&
        item.text === receipt.text &&
        item.kind === receipt.verdict &&
        sameSet(item.criterionIds, bound),
    );
    if (twin) {
      recordReceipt(receipt, row, "applied", null, twin.id);
      return { outcome: "applied", evidenceId: twin.id };
    }

    let evidenceId: string | undefined;
    try {
      evidenceId = repo.modify(row.project_id, (draft) => {
        applyCore(
          draft,
          {
            op: "add_evidence",
            key: row.key,
            version: row.version,
            receiptId: receipt.id,
            kind: receipt.verdict,
            criterionIds: bound,
            text: receipt.text,
            source: receipt.source,
            track: row.track,
          },
          nowIso(),
        );
        return draft.evidence.find((item) => item.id === receipt.id)?.id;
      });
    } catch (error) {
      return refuse(`the tree refused the evidence: ${message(error)}`);
    }
    recordReceipt(receipt, row, "applied", null, evidenceId ?? null);
    return { outcome: "applied", evidenceId };
  }

  function recordReceipt(
    receipt: Receipt,
    row: RunRow,
    state: "applied" | "refused",
    refusal: string | null,
    evidenceId: string | null,
  ): void {
    writeReceiptStmt.run(
      receipt.id,
      row.run_id,
      row.project_id,
      row.key,
      row.version,
      row.track,
      JSON.stringify(receipt.criterionIds ?? []),
      receipt.verdict,
      receipt.text,
      receipt.source,
      state,
      refusal,
      evidenceId,
      nowIso(),
    );
  }

  function cacheBadge(row: RunRow, liveData: LiveData): void {
    writeBadgeStmt.run(row.project_id, row.key, row.track, badgeOf(liveData), JSON.stringify(liveData), nowIso());
  }

  async function reconcileRun(row: RunRow, report: ReconcileReport): Promise<void> {
    const tree = repo.read(row.project_id);
    const outcome = tree.outcomes.find((item) => item.key === row.key);
    if (!outcome) {
      retire(row.run_id, "closed", "the outcome was removed");
      report.closed += 1;
      return;
    }

    let observed: { rows: number; best: number | null } | null = null;
    if (row.directory && existsSync(row.directory)) {
      try {
        const read: BridgeRead = await bridgeRead({
          workspace: { directory: row.directory },
          outcome,
          ancestors: ancestorsOf(tree, outcome.goalKey),
          ...trustedBinding(row),
          engine: row.engine,
          runId: row.run_id,
        });
        const liveVal = liveSchema.parse(read.live);
        cacheBadge(row, liveVal);
        observed = { rows: liveVal.rows.length, best: liveVal.best };
        if (read.receipt) {
          const result = bookReceipt(row, read.receipt);
          if (result.outcome === "applied") report.applied += 1;
          else if (result.outcome === "refused") report.refused += 1;
          else if (result.outcome === "duplicate") report.duplicate += 1;
          else report.errors.push(`run ${row.run_id}: ${result.why ?? "unreadable receipt"}`);
        }
      } catch (error) {
        report.errors.push(`run ${row.run_id}: live read failed: ${message(error)}`);
      }
    }

    const current = repo.read(row.project_id).outcomes.find((item) => item.key === row.key);
    if (!current || current.version !== row.version) {
      retire(row.run_id, "superseded", "the contract moved on while the run was live");
      report.closed += 1;
      return;
    }

    let convRunState: string | null = null;
    if (row.thread_id && !row.thread_id.startsWith("local:")) {
      const guardDirectory =
        row.directory ||
        (isEphemeralTempDirectory(safeCwd())
          ? safeCwd()
          : (repo.getProject(row.project_id)?.directory ?? safeCwd()));
      const conv = await callConversationService<{ state?: { runState?: string } }>(
        "GetConversation",
        {
          conversationId: row.thread_id,
        },
        {
          directory: guardDirectory,
          disableConversationService: deps.disableConversationService,
          allowEphemeralConversationService: deps.allowEphemeralConversationService,
        },
      );
      convRunState = conv?.state?.runState ?? null;
    }

    const seen =
      convRunState === "RUN_STATE_RUNNING"
        ? "active"
        : convRunState === "RUN_STATE_IDLE"
          ? "idle"
          : row.thread_id?.startsWith("local:")
            ? "local"
            : "unknown";
    const progress =
      observed === null ? "" : ` · ${observed.rows} attempts${observed.best === null ? "" : ` · best ${observed.best}`}`;
    touch(row, `worker ${seen}${progress}`);

    const signal = repo.view(row.project_id, row.track).ranked.find((item) => item.key === row.key)?.signal;
    if ((seen === "idle" || seen === "local") && (signal === "verified" || signal === "recheck")) {
      retire(row.run_id, "closed", "the run proved the current version");
      report.closed += 1;
    }
  }

  async function reconcile(projectId?: string): Promise<ReconcileReport> {
    const report: ReconcileReport = { scanned: 0, applied: 0, refused: 0, duplicate: 0, closed: 0, errors: [] };
    const rows = (projectId ? runsByProjectStmt.all(projectId) : activeRunsStmt.all()) as unknown as RunRow[];
    report.scanned = rows.length;
    for (const row of rows) {
      try {
        await reconcileRun((runByIdStmt.get(row.run_id) as RunRow | undefined) ?? row, report);
      } catch (error) {
        report.errors.push(`run ${row.run_id}: ${message(error)}`);
      }
    }
    return report;
  }

  async function live(projectId: string, key: string, track = "main"): Promise<LiveData> {
    const row = latestRunStmt.get(projectId, key, track) as RunRow | undefined;
    if (!row) return EMPTY_LIVE;
    if ((row.state === "dispatching" || row.state === "live") && row.directory && existsSync(row.directory)) {
      const tree = repo.read(projectId);
      const outcome = tree.outcomes.find((item) => item.key === key);
      if (outcome) {
        try {
          const read: BridgeRead = await bridgeRead({
            workspace: { directory: row.directory },
            outcome,
            ancestors: ancestorsOf(tree, outcome.goalKey),
            ...trustedBinding(row),
            engine: row.engine,
            runId: row.run_id,
          });
          const value = liveSchema.parse(read.live);
          cacheBadge(row, value);
          const s = status(row);
          return {
            ...value,
            worker: {
              phase: s.phase,
              liveness: s.liveness,
              nextAction: s.nextAction,
              retries: s.retries,
              heartbeatAt: s.heartbeatAt,
            },
          };
        } catch {
          // Fall back to cached live reading
        }
      }
    }
    const cached = cachedLive(projectId, key, track) ?? { ...EMPTY_LIVE, engine: row.engine };
    const s = status(row);
    return {
      ...cached,
      worker: {
        phase: s.phase,
        liveness: s.liveness,
        nextAction: s.nextAction,
        retries: s.retries,
        heartbeatAt: s.heartbeatAt,
      },
    };
  }

  function cachedLive(projectId: string, key: string, track: string): LiveData | null {
    const row = db
      .prepare("SELECT live FROM hc_badges WHERE project_id=? AND key=? AND track=?")
      .get(projectId, key, track) as { live: string } | undefined;
    if (!row?.live) return null;
    const parsed = liveSchema.safeParse(JSON.parse(row.live));
    return parsed.success ? parsed.data : null;
  }

  function score(projectId: string, key: string): string | null {
    return (badgeByKeyStmt.get(projectId, key) as { score: string | null } | undefined)?.score ?? null;
  }

  function run(projectId: string, key: string, track = "main"): RunStatus | null {
    const row = latestRunStmt.get(projectId, key, track) as RunRow | undefined;
    return row ? status(row) : null;
  }

  function receipts(runId: string): ReceiptRecord[] {
    const rows = db.prepare(`SELECT * FROM hc_receipts WHERE run_id=? ORDER BY created`).all(runId) as unknown as ReceiptRow[];
    return rows.map((row) => ({
      id: row.receipt_id,
      runId: row.run_id,
      projectId: row.project_id,
      key: row.key,
      version: row.version,
      track: row.track,
      criterionIds: JSON.parse(row.criterion_ids) as string[],
      kind: row.kind,
      text: row.text,
      source: row.source,
      state: row.state,
      refusal: row.refusal,
      evidenceId: row.evidence_id,
      created: row.created,
    }));
  }

  function runs(projectId?: string): RunStatus[] {
    const rows = (
      projectId
        ? db.prepare(`SELECT * FROM hc_runs WHERE project_id=? ORDER BY created DESC LIMIT 200`).all(projectId)
        : db.prepare(`SELECT * FROM hc_runs ORDER BY created DESC LIMIT 200`).all()
    ) as unknown as RunRow[];
    return rows.map(status);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (deps.automatic) {
    timer = setInterval(() => {
      void reconcile().catch(() => undefined);
    }, deps.reconcileIntervalMs);
    timer.unref();
  }

  return {
    dispatch,
    attachWorker,
    retire,
    live,
    score,
    run,
    runs,
    reconcile,
    saveRig,
    getRig,
    getRigAt,
    receipts,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;

function mintRunId(at: Date): string {
  const hex = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
  return `run_${at.getTime().toString(36)}${hex}`;
}

function ancestorsOf(tree: Tree, goalKey: string | null): Goal[] {
  const path: Goal[] = [];
  const seen = new Set<string>();
  let cursor = goalKey;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const goal = tree.goals.find((item) => item.key === cursor);
    if (!goal) break;
    path.unshift(goal);
    cursor = goal.parentGoalKey;
  }
  return path;
}

function badgeOf(live: LiveData): string | null {
  if (live.best === null) return null;
  const best = number(live.best);
  return live.target === null ? best : `${best}/${number(live.target)}`;
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((item) => set.has(item));
}

const MAX_SYMLINK_HOPS = 40;

function isSameOrInside(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel));
}

function isStrictlyInside(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel);
}

function canonicalPath(p: string): string {
  const abs = resolve(p);
  const missing: string[] = [];
  let cur = abs;
  while (true) {
    try {
      const real = realpathSync(cur);
      return missing.length ? join(real, ...missing) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(cur);
      if (parent === cur) {
        return abs;
      }
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

function resolveSegments(
  startDir: string,
  segments: string[],
  state: { hops: number },
  boundary: string | null,
  originalTargetPath: string,
): string {
  let cur = startDir;
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      const parent = dirname(cur);
      if (boundary !== null && !isSameOrInside(boundary, parent)) {
        throw new RuntimeError("path_outside_root", `Refusing symlink path outside workspace root: ${originalTargetPath}`);
      }
      cur = parent;
      continue;
    }
    const next = join(cur, seg);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        cur = next;
        continue;
      }
      if (code === "ELOOP") {
        throw new RuntimeError("path_outside_root", `Refusing symlink loop in path: ${originalTargetPath}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      state.hops += 1;
      if (state.hops > MAX_SYMLINK_HOPS) {
        throw new RuntimeError("path_outside_root", `Refusing symlink loop in path: ${originalTargetPath}`);
      }
      const rawLink = readlinkSync(next);
      if (!rawLink || rawLink.includes("\0")) {
        throw new RuntimeError("path_outside_root", `Refusing invalid symlink target for path: ${originalTargetPath}`);
      }
      const linkSegs = rawLink.split(/[\\/]+/).filter(Boolean);
      if (isAbsolute(rawLink)) {
        const fsRoot = parsePath(rawLink).root || sep;
        const resolvedAbs = resolveSegments(fsRoot, linkSegs, state, null, originalTargetPath);
        const canonAbs = canonicalPath(resolvedAbs);
        if (boundary !== null && (!isSameOrInside(boundary, resolvedAbs) || !isSameOrInside(boundary, canonAbs))) {
          throw new RuntimeError("path_outside_root", `Refusing symlink path outside workspace root: ${originalTargetPath}`);
        }
        cur = canonAbs;
      } else {
        cur = resolveSegments(dirname(next), linkSegs, state, boundary, originalTargetPath);
      }
    } else {
      cur = next;
    }
  }
  return cur;
}

export function resolveInside(root: string, targetPath: string): string {
  if (!targetPath || targetPath.includes("\0")) {
    throw new RuntimeError("path_outside_root", `Refusing invalid path ${JSON.stringify(targetPath)}`);
  }
  const base = resolve(root);
  const resolved = resolve(base, targetPath);
  const rel = relative(base, resolved);
  if (!isStrictlyInside(base, resolved)) {
    throw new RuntimeError("path_outside_root", `Refusing path outside workspace root: ${targetPath}`);
  }
  const baseReal = canonicalPath(base);
  const segments = rel.split(sep).filter(Boolean);
  const finalResolved = resolveSegments(baseReal, segments, { hops: 0 }, baseReal, targetPath);
  if (!isStrictlyInside(baseReal, finalResolved)) {
    throw new RuntimeError("path_outside_root", `Refusing symlink path outside workspace root: ${targetPath}`);
  }
  return resolved;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
