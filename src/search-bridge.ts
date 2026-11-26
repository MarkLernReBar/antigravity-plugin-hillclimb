// The runtime bridge between an outcome and a climb engine.
//
// Two inner loops, one surface:
//
//   repo    .hill-climb/engine/climb.py   (Bil0000/Hill-Climb, vendored)
//   search  hillclimb CLI                 (hillclimb.sh / rebase-energy, MIT)
//
// This module never runs a command, never scores, never commits. It produces a
// recipe — shell text plus the files the shell assumes — and reads the engine's
// own records back. The engine is the single writer of a run's state; anything
// invented here would be a score nobody measured.
//
// Proof is deliberately hard. A receipt (the evidence record that an outcome
// holds) needs five independent things to line up: a marker written before the
// worker started, the binding digest still matching the requested outcome, the
// live run's own identity, the engine's own holdout record, and a receipt line
// from an explicit verifier command whose exit code is zero. Missing any one of
// them returns `receipt: null` and the reason in plain words — a stale climb
// must never record a confirm against a newer contract version.
//
// Formats are read from the real engines, not from a description of them:
//   * repo:   <repo>/.hill-climb/<name>/{card.json,log.jsonl}, written by the
//             vendored climb.py (see src/state.ts for the same fields).
//   * search: <dir>/runs/<run-id>/{run.yaml,searches/<id>/{search.yaml,
//             status.json,journal.jsonl}}, written by hillclimb 0.8.x. Journal
//             records are `candidate_created` / `candidate_result` lines whose
//             body is a Candidate; a trial carries `holdout_score`, a replicate
//             carries `val_score`, and a candidate's score is its best trial's
//             median replicate.

import { bundledKitFiles, ENGINE_FILES, readEngineSource } from "./engine.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinPath } from "./engine.js";
import { number as formatNumber, parseCard, parseLog, redactSecrets, type ClimbCard, type LogRow } from "./state.js";
import type { Goal, Outcome, Tree } from "./model.js";
import type { LiveData } from "./view-props.js";

export type Engine = "repo" | "search";

export interface Workspace {
  hostId?: string;
  /** Absolute path of the checkout the worker edits. */
  directory: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  | "missing_check"
  | "missing_guard"
  | "missing_holdout"
  | "missing_lock"
  | "missing_verifier"
  | "missing_baseline"
  | "missing_target"
  | "engine_mismatch"
  | "bad_problem_id"
  | "bad_run_id"
  | "bad_direction"
  | "bad_metric"
  | "bad_criterion"
  | "bad_climber"
  | "bad_score_mode"
  | "bad_runs"
  | "bad_min_gain"
  | "bad_preflight"
  | "missing_rig";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Rigs: what the engine needs to be able to score at all
// ---------------------------------------------------------------------------

export interface RepoRig {
  engine: "repo";
  /** The command that scores the work. Required: the bridge never invents one. */
  check: string[];
  direction: "min" | "max";
  /** The bar. A receipt needs one; without it nothing can be called done. */
  target: number;
  /** Commands that must keep passing. The criteria of the outcome, as checks. */
  guard: string[];
  /** The check on cases the climber never sees. */
  holdout: string;
  /** Files the climber may not edit: the check and its fixtures. */
  lock: string[];
  /**
   * A trusted worker-shell command that must succeed before `climb.py init`.
   * Guided kits use it to prove the check catches a known-bad candidate; a
   * nonzero exit stops the activation before any climb exists. Omitted keeps
   * an old rig's digest and activation byte-identical.
   */
  preflight?: string;
  /**
   * Which criteria this run's receipt covers. Omitted binds every criterion on
   * the outcome, which is the long-standing behaviour and keeps an old rig's
   * digest and recipe text unchanged.
   */
  criterionIds?: string[];
  /**
   * What the check's output means. Omitted is the legacy failure-count reading
   * (a successful run with no match is zero); `numeric` requires the number.
   * Only an explicit value is emitted, so an old activation stays byte-identical.
   */
  scoreMode?: "numeric" | "failure-count";
  /** Alternate baseline and candidate measurements (climb.py --paired). */
  paired?: boolean;
  /** Stop exactly at --max-steps/--max-hours instead of while steps still gain. */
  hard?: boolean;
  /** Climb name; defaults to a slug of the run id. */
  name?: string;
  score?: string[];
  runs?: number;
  minGain?: string;
  maxSteps?: number;
  maxHours?: number;
  after?: "stop" | "raise";
}

export interface SearchRig {
  engine: "search";
  problemId: string;
  metric: string;
  higherIsBetter: boolean;
  /** The bar the holdout has to reach. */
  target: number;
  /** verifier.sh body: the scoring process (`docs.hillclimb.sh/problems`). */
  verifier: string;
  /** baseline.py body: the starting solution, scored as c000. */
  baseline: string;
  /** Which criteria this run's receipt covers; omitted binds every criterion. */
  criterionIds?: string[];
  holdout?: boolean;
  budget?: string;
  agent?: string;
  model?: string;
  parallelSearches?: number;
  /**
   * Which catalog climber the search runs, and its optional extras. Omitted is
   * the legacy run: `climbers/greedy` fetched if absent, no `--climber`, no
   * `--set`, so an existing rig keeps its digest and its activation text.
   */
  climber?: SearchClimber;
  /** CLI prefix; default "hillclimb". "uv run hillclimb" is equally valid. */
  runner?: string;
}

/** The catalog climbers `hillclimb climber get` copies out (docs/climbers.md). */
export const CLIMBER_NAMES = ["greedy", "openevolve", "gepa"] as const;
export type ClimberName = (typeof CLIMBER_NAMES)[number];

/** The engine's own tuners: `random` is built in, `optuna` is its extra. */
export const CLIMBER_TUNERS = ["random", "optuna"] as const;
export type ClimberTuner = (typeof CLIMBER_TUNERS)[number];

/**
 * A climber as a run names it: the catalog entry, and the block fields this
 * plugin changes. Everything else stays the catalog's own defaults — the
 * engine records the resolved block in `search.yaml` and snapshots it under
 * `searches/<id>/climber/`, which is what the bridge reads back (never a
 * value it invented here).
 */
export interface SearchClimber {
  name: ClimberName;
  /** The block's `tuner:`. `optuna` needs `pip install hillclimb[optuna]`. */
  tuner?: ClimberTuner;
  /**
   * MAP-Elites `selector_params.feature_dimensions` (openevolve only). Set it
   * so the search records the axes of its grid; unset is the selector's own
   * default, which the record then does not carry.
   */
  featureDimensions?: string[];
  /**
   * Extra verifier trials per candidate (`climber.params.tune_budget`). The
   * catalog policies ship different defaults (openevolve 0, greedy 8), so an
   * explicit value is emitted as a `--set` override and snapshotted with the
   * climber. `0` is meaningful: it pins tuning off. GEPA owns its loop and has
   * no tunable operator policy, so it is refused.
   */
  tuneBudget?: number;
}

export type Rig = RepoRig | SearchRig;

const PROBLEM_ID = /^[a-z0-9][a-z0-9._-]*$/;
const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FEATURE_DIMENSION = /^[a-z0-9][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Binding: the anchor that ties one run to one contract version
// ---------------------------------------------------------------------------

export interface Binding {
  id: string;
  engine: Engine;
  outcomeKey: string;
  version: number;
  criterionIds: string[];
  goalKey: string;
  digest: string;
}

/**
 * What the proof is *about*. A changed bar, re-locked check, different guard or
 * a new outcome version all move this digest, which is what makes an old run
 * unable to confirm a new contract. Wording-only edits do not: the outer loop
 * already treats a version bump as the meaning change, and the digest follows
 * that rule rather than second-guessing it.
 */
export function digestFor(outcome: Outcome, engine: Engine, criterionIds: string[], rig: Rig): string {
  const body = {
    engine,
    outcomeKey: outcome.key,
    version: outcome.version,
    criterionIds,
    rig:
      rig.engine === "repo"
        ? {
            check: rig.check,
            score: rig.score ?? [],
            direction: rig.direction,
            target: rig.target,
            guard: rig.guard,
            holdout: rig.holdout,
            lock: rig.lock,
            runs: rig.runs ?? 1,
            minGain: rig.minGain ?? "0",
            after: rig.after ?? "stop",
            // Only a declared value is meaning; omitted keys keep the old hash.
            preflight: rig.preflight,
            scoreMode: rig.scoreMode,
            paired: rig.paired,
            hard: rig.hard,
          }
        : {
            problemId: rig.problemId,
            metric: rig.metric,
            higherIsBetter: rig.higherIsBetter,
            target: rig.target,
            verifier: rig.verifier,
            holdout: rig.holdout ?? true,
            tuneBudget: rig.climber?.tuneBudget,
          },
  };
  return createHash("sha256").update(canonical(body)).digest("hex");
}

/** JSON with sorted keys, so two equal bindings always hash the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function criterionIdsFor(outcome: Outcome, requested?: string[]): string[] {
  const known = outcome.criteria.map((criterion) => criterion.id);
  if (requested === undefined) return known;
  const unique = [...new Set(requested)];
  const unknown = unique.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new BridgeError(
      "bad_criterion",
      `criteria ${unknown.join(", ")} are not in ${outcome.key} v${outcome.version} (has ${known.join(", ") || "none"})`,
    );
  }
  return unique;
}

export function bindingFor(outcome: Outcome, rig: Rig, requested?: string[], runId?: string): Binding {
  const criterionIds = criterionIdsFor(outcome, requested);
  const digest = digestFor(outcome, rig.engine, criterionIds, rig);
  const id = runId ?? `hc-${slug(outcome.key).slice(0, 24)}-v${outcome.version}-${digest.slice(0, 8)}`;
  return { id, engine: rig.engine, outcomeKey: outcome.key, version: outcome.version, criterionIds, goalKey: outcome.goalKey, digest };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** The engines' own naming rule: lowercase, digits, single dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A climb name climb.py accepts (`[a-z0-9][a-z0-9-]{0,40}`) that stays unique
 * for long ids: the digest goes at the end so truncation can never merge two
 * runs into one climb.
 */
export function climbNameFor(runId: string): string {
  const full = slug(runId);
  if (full.length <= 41) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 8);
  const head = full.slice(0, 41 - suffix.length - 1).replace(/-+$/, "");
  return `${head}-${suffix}`;
}

/** Python's `shlex.quote`, so a value survives any shell it is pasted into. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** yaml-safe scalar for a value we generate; the engines read these with PyYAML. */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/:@+-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) return value;
  return JSON.stringify(value);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function at(time: string | undefined | null): string {
  if (typeof time !== "string" || time === "") return "";
  return time;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parse a JSON file that may be absent or half-written; null, never a throw. */
function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    return object(JSON.parse(text));
  } catch {
    return null;
  }
}

function jsonl(text: string | null): Record<string, unknown>[] {
  if (text === null) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = object(JSON.parse(line));
      if (parsed !== null) rows.push(parsed);
    } catch {
      // A last line cut off by a crash is not a reason to lose the trail.
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

export interface RecipeFile {
  /** Relative to the checkout root, which is where activation runs. */
  path: string;
  content: string;
  executable?: boolean;
}

export interface RecipeInput {
  workspace: Workspace;
  outcome: Outcome;
  /** Root -> parent. The briefs the worker must inherit. */
  ancestors: Goal[];
  engine: Engine;
  rig: Rig;
  runId?: string;
  track?: string;
}

export interface Recipe {
  engine: Engine;
  runId: string;
  binding: Binding;
  /** One shell script, run from the checkout root. Never includes the proof step. */
  activation: string;
  /** The exact verifier command that appends the receipt; run it at the bar. */
  proof: string;
  runDir: string;
  receiptPath: string;
  markerPath: string;
  verifier: string;
  /** The registered verifier as a process: what the receipt line must match token for token. */
  verifierArgv: string[];
  files: RecipeFile[];
  prompt: string;
}

/**
 * The marker, the receipt and the receipt writer live under `.hill-climb/`,
 * which the repo engine already keeps out of git (`info/exclude`). That matters
 * for more than tidiness: `climb.py init` refuses a dirty tree, so bridge files
 * anywhere else would block the very init the recipe asks for.
 */
export const BRIDGE_DIR = ".hill-climb/bridge";
export const RECEIPT_SCRIPT = `${BRIDGE_DIR}/receipt.py`;

export function markerPathFor(runId: string): string {
  return `${BRIDGE_DIR}/${runId}.json`;
}

export function receiptPathFor(runId: string): string {
  return `${BRIDGE_DIR}/${runId}.receipts.jsonl`;
}

export function recipe(input: RecipeInput): Recipe {
  const { outcome, ancestors, engine, workspace } = input;
  const rig = input.rig;
  if (rig.engine !== engine) {
    throw new BridgeError("engine_mismatch", `engine is ${engine} but the rig is a ${rig.engine} rig`);
  }
  if (input.runId !== undefined && !RUN_ID.test(input.runId)) {
    throw new BridgeError("bad_run_id", `run id ${JSON.stringify(input.runId)} must match ${RUN_ID}`);
  }
  validate(outcome, rig);
  // The rig's own criterion list is the scope: omitted keeps every criterion,
  // so an old rig's binding digest and proof command are unchanged.
  const binding = bindingFor(outcome, rig, rig.criterionIds, input.runId);
  const track = input.track ?? "main";
  const marker = {
    schema: "hcb/1",
    runId: binding.id,
    binding,
    track,
    rig,
    verifier: "",
    verifierArgv: [] as string[],
    at: new Date().toISOString(),
  };
  const built =
    rig.engine === "repo"
      ? repoRecipe({ workspace, outcome, ancestors, rig, binding, track })
      : searchRecipe({ workspace, outcome, ancestors, rig, binding, track });
  const markerPath = markerPathFor(binding.id);
  const receiptPath = receiptPathFor(binding.id);
  const files: RecipeFile[] = [
    {
      path: markerPath,
      content: `${JSON.stringify({ ...marker, verifier: built.verifier, verifierArgv: built.verifierArgv, runDir: built.runDir }, null, 2)}\n`,
    },
    { path: RECEIPT_SCRIPT, content: receiptScript(), executable: true },
    ...built.files,
  ];
  return {
    engine,
    runId: binding.id,
    binding,
    activation: built.activation,
    proof: built.proof,
    runDir: built.runDir,
    receiptPath,
    markerPath,
    verifier: built.verifier,
    verifierArgv: built.verifierArgv,
    files,
    prompt: brief({ workspace, outcome, ancestors, rig, binding, track, activation: built.activation, proof: built.proof, markerPath, receiptPath }),
  };
}

// --- where a rig comes from ------------------------------------------------

const RIG_FENCE = "```hc-rig";

/**
 * The rig a dispatch runs with, written by hand where plans are written.
 *
 * A check command is an engineering decision, not a field of the contract, so
 * the bridge never guesses one: the newest plan on the outcome has to carry it
 * in a fenced `hc-rig` block. `rigBlock` writes the same block, so the plan, the
 * dispatch form and this parser cannot drift apart.
 */
export function rigFrom(tree: Tree, outcome: Outcome): Rig {
  const plans = tree.plans.filter((plan) => plan.key === outcome.key).sort((a, b) => b.version - a.version);
  for (const plan of plans) {
    const rig = parseRigBlock(plan.body);
    if (rig === null) continue;
    validate(outcome, rig);
    return rig;
  }
  throw new BridgeError(
    "missing_rig",
    plans.length === 0
      ? `no plan for ${outcome.key}: write one carrying a ${RIG_FENCE} block with the check, guard, holdout, lock and bar`
      : `no plan for ${outcome.key} carries a ${RIG_FENCE} block (checked ${plans.length} version${plans.length === 1 ? "" : "s"})`,
  );
}

/** The block `rigFrom` reads, in the one form it accepts. */
export function rigBlock(rig: Rig): string {
  const lines: string[] = [RIG_FENCE];
  lines.push(`engine: ${rig.engine}`);
  if (rig.engine === "repo") {
    if (rig.name !== undefined) lines.push(`name: ${rig.name}`);
    for (const command of rig.check) lines.push(`check: ${command}`);
    for (const pattern of rig.score ?? []) lines.push(`score: ${pattern}`);
    lines.push(`direction: ${rig.direction}`);
    lines.push(`target: ${rig.target}`);
    for (const command of rig.guard) lines.push(`guard: ${command}`);
    lines.push(`holdout: ${rig.holdout}`);
    for (const path of rig.lock) lines.push(`lock: ${path}`);
    if (rig.runs !== undefined) lines.push(`runs: ${rig.runs}`);
    if (rig.minGain !== undefined) lines.push(`minGain: ${rig.minGain}`);
    if (rig.maxSteps !== undefined) lines.push(`maxSteps: ${rig.maxSteps}`);
    if (rig.maxHours !== undefined) lines.push(`maxHours: ${rig.maxHours}`);
    if (rig.after !== undefined) lines.push(`after: ${rig.after}`);
    if (rig.preflight !== undefined) {
      lines.push(`preflight: |`);
      for (const line of rig.preflight.replace(/\n$/, "").split("\n")) lines.push(`  ${line}`);
    }
    if (rig.criterionIds !== undefined) lines.push(`criterionIds: ${rig.criterionIds.join(", ")}`);
    if (rig.scoreMode !== undefined) lines.push(`scoreMode: ${rig.scoreMode}`);
    if (rig.paired !== undefined) lines.push(`paired: ${rig.paired}`);
    if (rig.hard !== undefined) lines.push(`hard: ${rig.hard}`);
  } else {
    lines.push(`problemId: ${rig.problemId}`);
    lines.push(`metric: ${rig.metric}`);
    lines.push(`higherIsBetter: ${rig.higherIsBetter}`);
    lines.push(`target: ${rig.target}`);
    lines.push(`verifier: |`);
    for (const line of rig.verifier.replace(/\n$/, "").split("\n")) lines.push(`  ${line}`);
    lines.push(`baseline: |`);
    for (const line of rig.baseline.replace(/\n$/, "").split("\n")) lines.push(`  ${line}`);
    lines.push(`holdout: ${rig.holdout ?? true}`);
    if (rig.budget !== undefined) lines.push(`budget: ${rig.budget}`);
    if (rig.agent !== undefined) lines.push(`agent: ${rig.agent}`);
    if (rig.model !== undefined) lines.push(`model: ${rig.model}`);
    if (rig.parallelSearches !== undefined) lines.push(`parallelSearches: ${rig.parallelSearches}`);
    if (rig.runner !== undefined) lines.push(`runner: ${rig.runner}`);
    if (rig.climber !== undefined) {
      lines.push(`climber: ${rig.climber.name}`);
      if (rig.climber.tuner !== undefined) lines.push(`climber.tuner: ${rig.climber.tuner}`);
      if (rig.climber.featureDimensions !== undefined) lines.push(`climber.features: ${rig.climber.featureDimensions.join(", ")}`);
      if (rig.climber.tuneBudget !== undefined) lines.push(`climber.tuneBudget: ${rig.climber.tuneBudget}`);
    }
    if (rig.criterionIds !== undefined) lines.push(`criterionIds: ${rig.criterionIds.join(", ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/** Parse the fenced block, or null when the body has none. */
export function parseRigBlock(body: string): Rig | null {
  const start = body.indexOf(RIG_FENCE);
  if (start < 0) return null;
  const rest = body.slice(start + RIG_FENCE.length);
  const end = rest.indexOf("```");
  if (end < 0) return null;
  const block = rest.slice(0, end);
  const fields: Record<string, string[]> = {};
  let blockKey: string | null = null;
  let blockLines: string[] = [];
  const flush = () => {
    if (blockKey !== null) fields[blockKey] = [blockLines.join("\n")];
    blockKey = null;
    blockLines = [];
  };
  for (const line of block.split("\n")) {
    if (/^\s+/.test(line)) {
      if (blockKey !== null) blockLines.push(line.replace(/^ {2}/, ""));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    flush();
    const key = match[1] as string;
    const value = (match[2] ?? "").trim();
    if (value === "|") {
      blockKey = key;
      continue;
    }
    if (value === "") continue;
    (fields[key] ??= []).push(value);
  }
  flush();

  const one = (key: string): string | undefined => fields[key]?.[0];
  const all = (key: string): string[] => fields[key] ?? [];
  const num = (key: string): number | undefined => {
    const value = one(key);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const value = one(key);
    if (value === undefined) return undefined;
    return /^(true|yes|on)$/i.test(value) ? true : /^(false|no|off)$/i.test(value) ? false : undefined;
  };
  /** A comma list, or repeated lines, as the block's own reader flattens them. */
  const ids = (key: string): string[] | undefined => {
    const values = all(key)
      .flatMap((line) => line.split(","))
      .map((id) => id.trim())
      .filter((id) => id !== "");
    return values.length > 0 ? values : undefined;
  };
  const engine = one("engine");
  if (engine === "repo") {
    return withoutEmpty<RepoRig>({
      engine: "repo",
      check: all("check"),
      direction: one("direction") === "max" ? "max" : one("direction") === "min" ? "min" : (undefined as unknown as "min"),
      target: num("target") ?? Number.NaN,
      guard: all("guard"),
      holdout: one("holdout") ?? "",
      lock: all("lock"),
      score: all("score").length > 0 ? all("score") : undefined,
      runs: num("runs"),
      minGain: one("minGain"),
      maxSteps: num("maxSteps"),
      maxHours: num("maxHours"),
      after: one("after") === "raise" ? "raise" : one("after") === "stop" ? "stop" : undefined,
      preflight: one("preflight"),
      criterionIds: ids("criterionIds"),
      scoreMode: one("scoreMode") as RepoRig["scoreMode"],
      paired: bool("paired"),
      hard: bool("hard"),
      name: one("name"),
    });
  }
  if (engine === "search") {
    return withoutEmpty<SearchRig>({
      engine: "search",
      problemId: one("problemId") ?? "",
      metric: one("metric") ?? "",
      higherIsBetter: bool("higherIsBetter") ?? true,
      target: num("target") ?? Number.NaN,
      verifier: one("verifier") ?? "",
      baseline: one("baseline") ?? "",
      criterionIds: ids("criterionIds"),
      holdout: bool("holdout"),
      budget: one("budget"),
      agent: one("agent"),
      model: one("model"),
      parallelSearches: num("parallelSearches"),
      runner: one("runner"),
      climber: climberOf(one("climber"), one("climber.tuner"), one("climber.features"), num("climber.tuneBudget")),
    });
  }
  return null;
}

/** The rig as a block's own reader builds it, so `parseRigBlock(rigBlock(rig))` is `rig`. */
function withoutEmpty<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * The `climber:` lines of a block, as the rig's own type. Validation is
 * `validate`'s job, not the reader's: a block that names a climber nothing
 * knows has to fail loudly when it is used, not parse into nothing here.
 */
function climberOf(name: string | undefined, tuner: string | undefined, features: string | undefined, tuneBudget: number | undefined): SearchClimber | undefined {
  if (name === undefined) return undefined;
  const dimensions = (features ?? "")
    .split(",")
    .map((dimension) => dimension.trim())
    .filter((dimension) => dimension !== "");
  return withoutEmpty<SearchClimber>({
    name: name as ClimberName,
    tuner: tuner as ClimberTuner | undefined,
    featureDimensions: dimensions.length > 0 ? dimensions : undefined,
    tuneBudget,
  });
}

function validate(outcome: Outcome, rig: Rig): void {
  if (outcome.criteria.length === 0) {
    throw new BridgeError("bad_criterion", `${outcome.key} has no criteria, so there is nothing to score`);
  }
  validateCriterionIds(outcome, rig.criterionIds);
  if (!Number.isFinite(rig.target)) throw new BridgeError("missing_target", "a climb needs a bar (rig.target); nothing can be called done without one");
  if (rig.engine === "repo") {
    if (rig.check.length === 0 || rig.check.some((command) => command.trim() === "")) {
      throw new BridgeError("missing_check", "rig.check must name the command that scores the work");
    }
    if (rig.direction !== "min" && rig.direction !== "max") throw new BridgeError("bad_direction", "rig.direction must be min or max");
    if (rig.guard.length === 0 || rig.guard.some((command) => command.trim() === "")) {
      throw new BridgeError("missing_guard", "rig.guard must name at least one command that has to keep passing");
    }
    if (rig.holdout.trim() === "") throw new BridgeError("missing_holdout", "rig.holdout must be the check on cases the climber never sees");
    if (rig.lock.length === 0 || rig.lock.some((path) => path.trim() === "")) {
      throw new BridgeError("missing_lock", "rig.lock must name the files the climber may not edit (the check itself)");
    }
    if (rig.scoreMode !== undefined && rig.scoreMode !== "numeric" && rig.scoreMode !== "failure-count") {
      throw new BridgeError("bad_score_mode", `rig.scoreMode ${JSON.stringify(rig.scoreMode)} must be numeric or failure-count`);
    }
    if (rig.runs !== undefined && (!Number.isSafeInteger(rig.runs) || rig.runs < 1 || rig.runs > 1000)) {
      throw new BridgeError("bad_runs", `rig.runs must be a positive integer at most 1000, got ${JSON.stringify(rig.runs)}`);
    }
    if (rig.minGain !== undefined && !validMinGain(rig.minGain)) {
      throw new BridgeError("bad_min_gain", `rig.minGain must be a number or a percent like "2%", got ${JSON.stringify(rig.minGain)}`);
    }
    if (rig.preflight !== undefined && rig.preflight.trim() === "") {
      throw new BridgeError("bad_preflight", "rig.preflight must name a command that verifies the check, or be omitted");
    }
  } else {
    if (!PROBLEM_ID.test(rig.problemId)) {
      throw new BridgeError("bad_problem_id", `problem id ${JSON.stringify(rig.problemId)} must be lowercase letters, digits, '.', '_' or '-'`);
    }
    if (rig.metric.trim() === "") throw new BridgeError("bad_metric", "rig.metric must name the number the verifier reports");
    if (rig.verifier.trim() === "") throw new BridgeError("missing_verifier", "rig.verifier must be the scoring process (verifier.sh)");
    if (rig.baseline.trim() === "") throw new BridgeError("missing_baseline", "rig.baseline must be the starting solution (baseline.py)");
    if ((rig.holdout ?? true) === false) {
      throw new BridgeError("missing_holdout", "a search without a holdout cannot prove an outcome: set rig.holdout (the problem must declare holdout: true)");
    }
    if (rig.climber !== undefined) {
      if (!(CLIMBER_NAMES as readonly string[]).includes(rig.climber.name)) {
        throw new BridgeError("bad_climber", `rig.climber.name ${JSON.stringify(rig.climber.name)} is not a catalog climber (${CLIMBER_NAMES.join(", ")})`);
      }
      if (rig.climber.tuner !== undefined && !(CLIMBER_TUNERS as readonly string[]).includes(rig.climber.tuner)) {
        throw new BridgeError("bad_climber", `rig.climber.tuner ${JSON.stringify(rig.climber.tuner)} is not a hillclimb tuner (${CLIMBER_TUNERS.join(", ")})`);
      }
      const dimensions = rig.climber.featureDimensions;
      if (dimensions !== undefined) {
        if (rig.climber.name !== "openevolve") {
          throw new BridgeError("bad_climber", `rig.climber.featureDimensions is a MAP-Elites setting, and the ${rig.climber.name} climber has no grid`);
        }
        if (dimensions.length === 0 || dimensions.length > 3 || dimensions.some((dimension) => !FEATURE_DIMENSION.test(dimension))) {
          throw new BridgeError("bad_climber", `rig.climber.featureDimensions must be 1-3 lowercase names (e.g. complexity, score), got ${JSON.stringify(dimensions)}`);
        }
      }
      const tuneBudget = rig.climber.tuneBudget;
      if (tuneBudget !== undefined) {
        if (!Number.isSafeInteger(tuneBudget) || tuneBudget < 0 || tuneBudget > 1000) {
          throw new BridgeError("bad_climber", `rig.climber.tuneBudget must be a nonnegative integer at most 1000, got ${JSON.stringify(tuneBudget)}`);
        }
        if (rig.climber.name === "gepa") {
          throw new BridgeError("bad_climber", "rig.climber.tuneBudget is incompatible with gepa: it owns its loop and has no tunable operator policy");
        }
      }
    }
  }
}

/**
 * The rig's own criterion scope: nonempty, unique, and a subset of the outcome.
 * `criterionIdsFor` already refuses unknown ids; duplicates are refused here
 * rather than silently collapsed, because a duplicate in a declared scope is a
 * mistake about what the proof covers.
 */
function validateCriterionIds(outcome: Outcome, criterionIds: string[] | undefined): void {
  if (criterionIds === undefined) return;
  if (criterionIds.length === 0) throw new BridgeError("bad_criterion", "rig.criterionIds must name at least one criterion, or be omitted to bind every criterion");
  const seen = new Set<string>();
  for (const id of criterionIds) {
    if (seen.has(id)) throw new BridgeError("bad_criterion", `rig.criterionIds names ${JSON.stringify(id)} more than once`);
    seen.add(id);
  }
  criterionIdsFor(outcome, criterionIds);
}

/** The repo engine's `threshold()` accepts a number or a percent; nothing else. */
function validMinGain(value: string): boolean {
  const text = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(text)) return false;
  const amount = Number(text.replace(/%$/, ""));
  return Number.isFinite(amount) && amount >= 0;
}

interface Built {
  activation: string;
  proof: string;
  /** The registered verifier, as a human reads it. */
  verifier: string;
  /** The registered verifier, as the process is started: what receipt.py records. */
  verifierArgv: string[];
  runDir: string;
  files: RecipeFile[];
}

function repoRecipe(args: {
  workspace: Workspace;
  outcome: Outcome;
  ancestors: Goal[];
  rig: RepoRig;
  binding: Binding;
  track: string;
}): Built {
  const { outcome, rig, binding, ancestors } = args;
  const name = rig.name !== undefined ? slug(rig.name) : climbNameFor(binding.id);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new BridgeError("bad_run_id", `climb name ${JSON.stringify(name)} must be lowercase letters, digits and dashes, at most 41 characters`);
  }
  const climb = ".hill-climb/engine/climb.py";
  const goal = goalLine(outcome, ancestors);
  const lock = [...new Set(rig.lock)];
  const init = [
    "python3",
    shellQuote(climb),
    "init",
    shellQuote(name),
    "--goal",
    shellQuote(goal),
    ...rig.check.flatMap((command) => ["--check", shellQuote(command)]),
    ...(rig.score ?? []).flatMap((pattern) => ["--score", shellQuote(pattern)]),
    // Only an explicit mode is emitted: an old rig keeps its exact command
    // line (and therefore its stored activation) byte for byte.
    ...(rig.scoreMode !== undefined ? ["--score-mode", rig.scoreMode] : []),
    "--direction",
    rig.direction,
    "--target",
    shellQuote(String(rig.target)),
    ...rig.guard.flatMap((command) => ["--guard", shellQuote(command)]),
    "--holdout",
    shellQuote(rig.holdout),
    ...lock.flatMap((path) => ["--lock", shellQuote(path)]),
    ...(rig.runs !== undefined ? ["--runs", String(rig.runs)] : []),
    ...(rig.minGain !== undefined ? ["--min-gain", shellQuote(rig.minGain)] : []),
    ...(rig.maxSteps !== undefined ? ["--max-steps", String(rig.maxSteps)] : []),
    ...(rig.maxHours !== undefined ? ["--max-hours", String(rig.maxHours)] : []),
    "--after",
    rig.after ?? "stop",
    ...(rig.paired === true ? ["--paired"] : []),
    ...(rig.hard === true ? ["--hard"] : []),
  ].join(" ");

  const runDir = `.hill-climb/${name}`;
  const verifier = `python3 ${shellQuote(climb)} holdout --why ${shellQuote(`outcome ${outcome.key} v${outcome.version}`)}`;
  const activation = [
    "set -eu",
    `# climb.py init for ${binding.id} (${binding.digest.slice(0, 12)})`,
    `test -f ${shellQuote(climb)} || { echo 'hillclimb engine missing: run "hillclimb setup" in this checkout' >&2; exit 1; }`,
    // A guided kit's known-bad control runs before init, under `set -eu`: a
    // failure here means the check cannot tell bad work from good, so no climb
    // is created and no budget is spent.
    ...(rig.preflight !== undefined ? rig.preflight.replace(/\n$/, "").split("\n") : []),
    `if [ -f ${shellQuote(`${runDir}/card.json`)} ]; then`,
    `  echo 'climb ${name} already exists: resuming it, not re-initialising'`,
    "else",
    `  ${init}`,
    "fi",
  ].join("\n");
  const argv = ["python3", climb, "holdout", "--why", `outcome ${outcome.key} v${outcome.version}`];
  const proof = receiptCommand({
    engine: "repo",
    runId: binding.id,
    binding,
    track: args.track,
    command: verifier,
    argv,
    scorePattern: "Holdout (-?[0-9.eE+-]+)",
  });
  const files: RecipeFile[] = ENGINE_FILES.map(name => ({
    path: `.hill-climb/engine/${name}`, content: readEngineSource(name), executable: true,
  }));
  const commands = [rig.preflight, ...rig.check, ...rig.guard, rig.holdout];
  if (commands.some(command => command?.includes(".hill-climb/kits/"))) {
    files.push(...bundledKitFiles().map(kit => ({
      path: `.hill-climb/kits/${kit.path}`, content: kit.content, executable: kit.path.endsWith(".py"),
    })));
  }
  return { activation, proof, verifier, verifierArgv: argv, runDir, files };
}

/** Where `climber get` writes a catalog climber, and the file a run names. */
export function climberDirFor(rig: SearchRig): string {
  return `climbers/${rig.climber?.name ?? "greedy"}`;
}

/** The climber a run names: the folder's `policy.py`, which *is* the climber. */
export function climberRefFor(rig: SearchRig): string {
  return `${climberDirFor(rig)}/policy.py`;
}

/**
 * `hillclimb run`'s climber arguments, in the engine's own spelling
 * (`docs/climbers.md`): `--climber` names the fetched folder, `--set` edits
 * the block, `--seed-from` is GEPA's required incumbent, and GEPA is serial.
 *
 * Empty when the rig names no climber: the legacy run keeps its exact
 * command line, so an existing dispatch's text does not change under it.
 */
export function climberArgs(rig: SearchRig): string[] {
  const climber = rig.climber;
  if (climber === undefined) return [];
  const args = ["--climber", climberRefFor(rig)];
  if (climber.tuner !== undefined) args.push("--set", `climber.tuner=${climber.tuner}`);
  if (climber.tuneBudget !== undefined) {
    // An explicit value overrides the catalog policy's own default (openevolve
    // ships 0, greedy ships 8) and is snapshotted with the climber.
    args.push("--set", `climber.params.tune_budget=${climber.tuneBudget}`);
  }
  if (climber.featureDimensions !== undefined) {
    args.push("--set", `climber.selector_params.feature_dimensions=[${climber.featureDimensions.join(",")}]`);
  }
  if (climber.name === "gepa") {
    // its seed has to pass the verifier, and the problem's own baseline is the
    // only solution the bridge can name here (`baseline.py` is scored as c000)
    args.push("--seed-from", `problems/${rig.problemId}/baseline.py`);
    args.push("--set", "concurrency.parallel_agents=1");
  }
  return args;
}

function searchRecipe(args: {
  workspace: Workspace;
  outcome: Outcome;
  ancestors: Goal[];
  rig: SearchRig;
  binding: Binding;
  track: string;
}): Built {
  const { outcome, rig, binding, ancestors } = args;
  const runner = rig.runner ?? "hillclimb";
  const problemDir = `problems/${rig.problemId}`;
  const climber = rig.climber;
  const climberDir = climberDirFor(rig);
  /** Staged under the bridge dir: `hillclimb init` must run before `problems/` exists. */
  const stageDir = `${BRIDGE_DIR}/stage/${rig.problemId}`;
  const budget = rig.budget ?? "2h";
  const holdout = rig.holdout ?? true;

  const problemYaml = [
    `problem_id: ${yamlScalar(rig.problemId)}`,
    `metric: ${yamlScalar(rig.metric)}`,
    `higher_is_better: ${rig.higherIsBetter}`,
    "description: description.md",
    "contract: contract.md",
    "verifier: verifier.sh",
    "baseline: baseline.py",
    `holdout: ${holdout}`,
    "allow_internet_during_solution: false",
    `chart_baselines:`,
    `  ${yamlScalar(`outcome bar (${outcome.key} v${outcome.version})`)}: ${rig.target}`,
    "",
  ].join("\n");

  const description = [
    `# ${outcome.title}`,
    "",
    outcome.story,
    "",
    "## What is measured",
    "",
    `The verifier reports **${rig.metric}** (${rig.higherIsBetter ? "higher" : "lower"} is better) and writes it to \`$HILLCLIMB_RESULT\`.`,
    `The bar is **${rig.target}**.`,
    holdout ? "There is a hidden split: `$HILLCLIMB_SPLIT` is `holdout` and the verifier is called with `--holdout` on cases you never see." : "",
    "",
    "## Briefs you inherit",
    "",
    ...ancestorBriefs(ancestors),
    "",
    "## Done looks like",
    "",
    ...(rig.criterionIds !== undefined
      ? [`This run's receipt binds only **${binding.criterionIds.join(", ")}**; the other criteria stay open unless a separate run proves them.`, ""]
      : []),
    ...outcome.criteria.map((criterion) => `- **${criterion.id}** — given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`),
    "",
  ].join("\n");

  const contract = [
    "# Contract",
    "",
    `Outcome \`${outcome.key}\` v${outcome.version}. Do not edit anything under \`${problemDir}/\` except \`solution.py\`; the verifier is the score.`,
    ...(rig.criterionIds !== undefined ? ["", `This run's receipt binds only: ${binding.criterionIds.join(", ")}.`] : []),
    "",
    ...outcome.criteria.map((criterion) => `## ${criterion.id}\n\nGiven ${criterion.given}\nWhen ${criterion.when}\nThen ${criterion.then}`),
    "",
  ].join("\n");

  const verifier = rig.verifier.endsWith("\n") ? rig.verifier : `${rig.verifier}\n`;
  const baseline = rig.baseline.endsWith("\n") ? rig.baseline : `${rig.baseline}\n`;

  const locate = `for d in runs/*/; do [ -f "$d/run.yaml" ] || continue; if grep -qx "name: ${binding.id}" "$d/run.yaml"; then RUN_DIR="\${d%/}"; fi; done`;
  // a search ref is a run DIRECTORY name (`<ts>-<slug>`), never a path
  const statusCommand = `${runner} status "$(basename "$RUN_DIR")"`;
  const findRun = ["RUN_DIR=", locate].join("\n");

  const activation = [
    "set -eu",
    `# hillclimb.sh scaffold + run for ${binding.id} (${binding.digest.slice(0, 12)})`,
    `PROBLEM=${shellQuote(problemDir)}`,
    `RUN_ID=${shellQuote(binding.id)}`,
    // `hillclimb init` refuses a folder that already holds a problems/ of its
    // own, so the problem is staged beside the marker and copied in afterwards.
    `if [ ! -f hillclimb.yaml ]; then ${runner} init; fi`,
    // the legacy run fetches greedy under its old guard, byte for byte
    climber === undefined ? `if [ ! -d climbers/greedy ]; then ${runner} climber get greedy; fi` : `if [ ! -f ${shellQuote(`${climberDir}/policy.py`)} ]; then ${runner} climber get ${shellQuote(climber.name)}; fi`,
    // a fetched climber that imports a library this Python lacks fails here,
    // with the engine's own install line, before any budget is spent
    ...(climber === undefined ? [] : [`${runner} climber check --climber ${shellQuote(`${climberDir}/policy.py`)}`]),
    `mkdir -p "$PROBLEM" && cp -R ${shellQuote(stageDir)}/. "$PROBLEM"/`,
    `chmod +x "$PROBLEM/verifier.sh"`,
    `${runner} verify ${shellQuote(rig.problemId)} --repeat 3`,
    findRun,
    'if [ -n "$RUN_DIR" ]; then',
    `  echo "run $RUN_ID already exists in $RUN_DIR: resuming it, not starting a second one"`,
    `  ${runner} resume "$(basename "$RUN_DIR")"`,
    "else",
    `  ${runner} run ${shellQuote(rig.problemId)} --name "$RUN_ID" --budget ${shellQuote(budget)}${rig.agent !== undefined ? ` --agent ${shellQuote(rig.agent)}` : ""}${rig.model !== undefined ? ` --model ${shellQuote(rig.model)}` : ""}${rig.parallelSearches !== undefined && rig.parallelSearches > 1 ? ` --parallel-searches ${rig.parallelSearches}` : ""}${climberArgs(rig).map((arg) => ` ${shellQuote(arg)}`).join("")}`,
    "fi",
  ].join("\n");

  const runDir = "runs";
  const argv = ["sh", "-c", `RUN_DIR=""; ${locate}; test -n "$RUN_DIR" || { echo 'no run named ${binding.id}' >&2; exit 1; }; exec ${runner} status "$(basename "$RUN_DIR")"`];
  const proof = receiptCommand({
    engine: "search",
    runId: binding.id,
    binding,
    track: args.track,
    command: statusCommand,
    argv,
    scorePattern: null,
  });

  return {
    activation,
    proof,
    verifier: statusCommand,
    verifierArgv: argv,
    runDir,
    files: [
      { path: `${stageDir}/problem.yaml`, content: problemYaml },
      { path: `${stageDir}/description.md`, content: description.replace(/\n{3,}/g, "\n\n") },
      { path: `${stageDir}/contract.md`, content: contract },
      { path: `${stageDir}/verifier.sh`, content: verifier, executable: true },
      { path: `${stageDir}/baseline.py`, content: baseline },
    ],
  };
}

/**
 * The one command whose exit code and output become the receipt line. It runs
 * the verifier, not a summary of it, so the number in the evidence is the
 * engine's own and the exit code is real.
 */
function receiptCommand(args: {
  engine: Engine;
  runId: string;
  binding: Binding;
  track: string;
  command: string;
  argv: string[];
  scorePattern: string | null;
}): string {
  // The argv is the identity of the attempt; #receipt-identity requires the
  // receipt line's own argv to equal it exactly.
  const criteria = args.binding.criterionIds.join(",");
  const parts = [
    "python3",
    shellQuote(RECEIPT_SCRIPT),
    "--receipt",
    shellQuote(receiptPathFor(args.runId)),
    "--run-id",
    shellQuote(args.runId),
    "--binding",
    shellQuote(args.binding.digest),
    "--outcome",
    shellQuote(args.binding.outcomeKey),
    "--version",
    String(args.binding.version),
    "--criteria",
    shellQuote(criteria),
    "--engine",
    args.engine,
    "--track",
    shellQuote(args.track),
    "--command",
    shellQuote(args.command),
    ...(args.scorePattern !== null ? ["--score-pattern", shellQuote(args.scorePattern)] : []),
    "--",
    ...args.argv.map(shellQuote),
  ];
  return parts.join(" ");
}

function goalLine(outcome: Outcome, ancestors: Goal[]): string {
  const then = outcome.criteria.map((criterion) => criterion.then).join("; ");
  const root = ancestors[0];
  const prefix = root !== undefined && root.brief !== "" ? `${root.title}: ` : "";
  return `${prefix}${outcome.title} — ${then}`.replace(/\s+/g, " ").slice(0, 300);
}

function ancestorBriefs(ancestors: Goal[]): string[] {
  if (ancestors.length === 0) return ["No goal above this outcome: the outcome's own story is the whole brief."];
  return ancestors.flatMap((goal) => [`- **${goal.title}** — ${goal.brief}`]);
}

function brief(args: {
  workspace: Workspace;
  outcome: Outcome;
  ancestors: Goal[];
  rig: Rig;
  binding: Binding;
  track: string;
  activation: string;
  proof: string;
  markerPath: string;
  receiptPath: string;
}): string {
  const { outcome, rig, binding, ancestors, workspace, activation, proof, markerPath, receiptPath } = args;
  const scoped = rig.criterionIds !== undefined;
  const boundIds = new Set(binding.criterionIds);
  const boundCriteria = outcome.criteria.filter((criterion) => boundIds.has(criterion.id));
  const declared =
    scoped ||
    (rig.engine === "repo"
      ? rig.scoreMode !== undefined || rig.paired !== undefined || rig.hard !== undefined || rig.preflight !== undefined
      : rig.climber?.tuneBudget !== undefined);
  const engineLine =
    rig.engine === "repo"
      ? `Engine: repo — climb.py, one committed step per kept idea. Bar ${rig.target} (${rig.direction}).`
      : `Engine: search — hillclimb.sh, headless agents write \`problems/${rig.problemId}/solution.py\`. Bar ${rig.target} on \`${rig.metric}\` (${rig.higherIsBetter ? "max" : "min"}).`;
  const climberLine =
    rig.engine === "search" && rig.climber !== undefined
      ? [
          `Climber: \`${rig.climber.name}\` from \`climbers/${rig.climber.name}/\`${rig.climber.tuner === undefined ? "" : `, tuner \`${rig.climber.tuner}\``}${rig.climber.featureDimensions === undefined ? "" : `, feature grid over \`${rig.climber.featureDimensions.join(", ")}\``}${rig.climber.tuneBudget === undefined ? "" : `, ${rig.climber.tuneBudget} extra tune trial${rig.climber.tuneBudget === 1 ? "" : "s"} per candidate`}. The engine snapshots it under the search, so resume runs the climber it started with, not whatever the file says later.`,
        ]
      : [];
  return [
    `# Climb: ${outcome.title}`,
    "",
    `Outcome \`${outcome.key}\` v${outcome.version} in ${workspace.directory}.`,
    `Binding \`${binding.id}\` (${binding.digest.slice(0, 12)}), criteria ${binding.criterionIds.join(", ")}.`,
    ...(scoped ? [`This run binds only ${binding.criterionIds.join(", ")}; the receipt confirms those criteria, not the rest of the contract.`] : []),
    engineLine,
    ...climberLine,
    ...(rig.engine === "repo"
      ? [
          "",
          "The engine measures `--check` with your `--score` pattern and the holdout command without it: the holdout's last line must be the bare number.",
          ...(rig.scoreMode === "numeric"
            ? ["The score mode is `numeric`: every check must print a finite number. A successful run with no matching measurement fails; it is not zero."]
            : rig.scoreMode === "failure-count"
              ? ["The score mode is `failure-count`: a successful run with no matching failure summary reads as zero failures."]
              : []),
          ...(rig.paired === true ? ["Measurements are paired: the engine alternates the candidate and the baseline, so a score of zero is not usable."] : []),
          ...(rig.hard === true ? ["The step and hour limits are hard: the climb stops exactly there instead of continuing while it still gains."] : []),
          ...(rig.preflight !== undefined ? ["The activation first runs the rig's preflight control, before the climb is created: if it fails, the check cannot separate bad work from good and nothing starts."] : []),
          `The check files (${rig.lock.join(", ")}) are locked: editing them makes the engine refuse the step rather than re-score it.`,
          "One idea per step. `try` keeps a real improvement and undoes the rest; a step that breaks a guard is undone too.",
        ]
      : []),
    "",
    "## The contract",
    "",
    outcome.story,
    "",
    ...boundCriteria.map((criterion) => `- **${criterion.id}** — given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`),
    "",
    "## Briefs you inherit",
    "",
    ...ancestorBriefs(ancestors),
    "",
    "## Start it (from the checkout root)",
    "",
    "```sh",
    activation,
    "```",
    "",
    "## Prove it, at the bar",
    "",
    `Run exactly this once the engine reports the bar is reached. It runs the verifier and appends one receipt line to \`${receiptPath}\`; nothing else may write there.`,
    "",
    "```sh",
    proof,
    "```",
    "",
    `The binding marker \`${markerPath}\` was written before you started. Do not edit it: it is how the bridge knows this run belongs to ${outcome.key} v${outcome.version}.`,
    "",
    "## Report",
    "",
    ...(declared
      ? [
          "Record whether the baseline already met the bar or the climb improved on it: the receipt distinguishes attainment from a measured gain using the engine's own baseline and best values. Reaching the bar from a baseline that was already there is not an improvement.",
          "",
        ]
      : []),
    "Finish with the engine's own words — the score line, the steps taken, the holdout, and any guard that failed — plus whether you ran the proof command and its exit code. Do not claim a bar you did not reach.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading a run back
// ---------------------------------------------------------------------------

export interface PortEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

/**
 * File access on the checkout's machine. Local filesystem IO is the default
 * implementation (see `port`); tests use `localPort`.
 */
export interface FilePort {
  read(path: string): Promise<string | null>;
  list(path: string): Promise<PortEntry[]>;
}

export interface ReadInput {
  workspace: Workspace;
  outcome: Outcome;
  ancestors?: Goal[];
  engine: Engine;
  runId?: string;
  /**
   * The exact content of the marker the dispatch persisted (`recipe.files` entry
   * whose path is `recipe.markerPath`). The server's copy is the authority: a
   * marker computed from the mutable checkout alone proves nothing, because
   * whoever holds the checkout can rewrite it. When given, the on-disk marker
   * must match it before any of its paths, verifier or digest are used.
   */
  expectedMarker?: string;
  /**
   * The `proof` text the dispatch persisted. Optional, and only used as a
   * cross-check: the expected argv is derived by re-running the same recipe
   * builder over the trusted rig and run id, and when the dispatch still has
   * the proof text this asserts that derivation reproduces it exactly. That is
   * what lets a run dispatched before argv was recorded reconcile without
   * editing a receipt or re-running an agent.
   */
  expectedProof?: string;
}

export interface Receipt {
  id: string;
  text: string;
  source: string;
  verdict: "confirms" | "denies" | "note";
  version: number;
  criterionIds: string[];
  track: string;
}

export interface BridgeRead {
  live: LiveData;
  receipt: Receipt | null;
  runId: string | null;
  /** Why there is no receipt, in words. null when one came back. */
  reason: string | null;
}

export function emptyLive(): LiveData {
  return { engine: null, baseline: null, best: null, target: null, rows: [], holdout: null };
}

const ROW_LIMIT = 500;

interface Marker {
  runId: string;
  binding: Binding;
  track: string;
  rig: Rig;
  verifier: string;
  /** The registered argv, exactly as receipt.py records it. */
  verifierArgv: string[];
  /** The state directory the recipe told the worker about, e.g. `.hill-climb/<name>`. */
  runDir: string;
  at: string;
}

function parseMarker(text: string | null): Marker | null {
  const raw = parseJson(text);
  if (raw === null || raw.schema !== "hcb/1") return null;
  const binding = object(raw.binding);
  const rig = object(raw.rig);
  if (binding === null || rig === null) return null;
  const engine = binding.engine;
  if (engine !== "repo" && engine !== "search") return null;
  if (rig.engine !== engine) return null;
  const version = finite(binding.version);
  if (version === null || typeof binding.outcomeKey !== "string" || typeof binding.digest !== "string") return null;
  if (typeof raw.runId !== "string" || typeof raw.verifier !== "string") return null;
  return {
    runId: raw.runId,
    track: typeof raw.track === "string" ? raw.track : "main",
    verifier: raw.verifier,
    verifierArgv: Array.isArray(raw.verifierArgv) ? raw.verifierArgv.filter((item): item is string => typeof item === "string") : [],
    runDir: typeof raw.runDir === "string" ? raw.runDir : "",
    at: typeof raw.at === "string" ? raw.at : "",
    binding: {
      id: binding.id as string,
      engine,
      outcomeKey: binding.outcomeKey,
      version,
      criterionIds: strings(binding.criterionIds),
      goalKey: typeof binding.goalKey === "string" ? binding.goalKey : "",
      digest: binding.digest,
    },
    rig: rig as unknown as Rig,
  };
}

interface ReceiptLine {
  runId: string;
  binding: string;
  exitCode: number;
  command: string;
  /** The process that actually ran. `command` is only a label; this is the identity. */
  argv: string[];
  output: string;
  at: string;
  score: number | null;
}

function parseReceiptLines(text: string | null): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  for (const row of jsonl(text)) {
    const exitCode = finite(row.exitCode);
    if (typeof row.runId !== "string" || typeof row.binding !== "string" || exitCode === null) continue;
    lines.push({
      runId: row.runId,
      binding: row.binding,
      exitCode,
      command: typeof row.command === "string" ? row.command : "",
      argv: Array.isArray(row.argv) ? row.argv.filter((item): item is string => typeof item === "string") : [],
      output: typeof row.output === "string" ? row.output : "",
      at: typeof row.at === "string" ? row.at : "",
      score: finite(row.score),
    });
  }
  return lines;
}

export async function read(input: ReadInput): Promise<BridgeRead> {
  return readWith(localPort(input.workspace.directory), input);
}

export async function readWith(files: FilePort, input: ReadInput): Promise<BridgeRead> {
  const root = input.workspace.directory;
  // 1. The dispatch's own marker, when the caller has it. Parsed before any
  //    file is read, because its runId decides which file even matters.
  const trusted = input.expectedMarker === undefined ? trustedMarker() : trustedMarker(input.expectedMarker);
  if (trusted.reason !== null) return { live: emptyLive(), receipt: null, runId: null, reason: trusted.reason };
  const wanted = input.runId ?? trusted.marker?.runId;
  const marker = await findMarker(files, root, { ...input, runId: wanted });
  if (marker === null) {
    return {
      live: emptyLive(),
      receipt: null,
      runId: wanted ?? null,
      reason: `no dispatch marker for ${input.outcome.key} v${input.outcome.version} (${input.engine})${wanted === undefined ? "" : ` at ${markerPathFor(wanted)}`}`,
    };
  }
  // 2. The marker must be the run that was asked for, and — when the dispatch's
  //    copy is known — the very same marker, field for field.
  if (wanted !== undefined && marker.runId !== wanted) {
    return { live: emptyLive(), receipt: null, runId: marker.runId, reason: `the marker at ${markerPathFor(wanted)} is for run ${marker.runId}, not ${wanted}` };
  }
  let expectedArgv = marker.verifierArgv;
  if (trusted.marker !== null) {
    // A run dispatched before the argv was recorded still has a trusted rig and
    // run id, so its argv is not unknown: it is derivable, and only a derivation
    // that reproduces the dispatch's own proof text is accepted as identity.
    const legacy = trusted.marker.verifierArgv.length === 0;
    const derived = legacy ? derivedArgv(trusted.marker, input) : null;
    if (derived !== null && derived.reason !== null) {
      return { live: emptyLive(), receipt: null, runId: marker.runId, reason: derived.reason };
    }
    const difference = markerDifference(trusted.marker, marker, legacy);
    if (difference !== null) {
      return { live: emptyLive(), receipt: null, runId: marker.runId, reason: `the marker on disk is not the one the dispatch wrote: ${difference}` };
    }
    expectedArgv = legacy ? (derived as { argv: string[] }).argv : trusted.marker.verifierArgv;
    if (input.expectedProof !== undefined && derived !== null) {
      const proof = normaliseProof((derived as { proof: string }).proof);
      if (proof !== normaliseProof(input.expectedProof)) {
        return {
          live: emptyLive(),
          receipt: null,
          runId: marker.runId,
          reason: "the dispatch's proof text does not match the rig and run id its marker records",
        };
      }
    }
  } else if (expectedArgv.length === 0) {
    return {
      live: emptyLive(),
      receipt: null,
      runId: marker.runId,
      reason: "the marker predates the registered argv and the dispatch's own marker was not handed over, so a receipt line cannot be matched to it",
    };
  }
  const stale = staleness(marker, input);
  if (stale !== null) return { live: emptyLive(), receipt: null, runId: marker.runId, reason: stale };

  const state = marker.rig.engine === "repo" ? await readRepo(files, root, marker) : await readSearch(files, root, marker);
  if (state.live.engine === null) {
    return { live: state.live, receipt: null, runId: marker.runId, reason: state.reason };
  }
  if (state.holdout === null) {
    return { live: state.live, receipt: null, runId: marker.runId, reason: state.reason ?? "the engine has recorded no holdout score yet" };
  }
  const target = marker.rig.target;
  const direction = marker.rig.engine === "repo" ? marker.rig.direction : marker.rig.higherIsBetter ? "max" : "min";
  const judged: Array<[string, number | null]> =
    marker.rig.engine === "repo"
      ? [["visible best", state.live.best], ["holdout", state.holdout]]
      : [["holdout", state.holdout]];
  for (const [label, value] of judged) {
    if (reaches(value, target, marker.rig)) continue;
    return {
      live: state.live,
      receipt: null,
      runId: marker.runId,
      reason: `${label} ${formatNumber(value ?? Number.NaN)} has not reached the bar ${formatNumber(target)} (${direction})`,
    };
  }

  const lines = parseReceiptLines(await files.read(joinPath(root, receiptPathFor(marker.runId))));
  const ours = lines.filter((row) => row.runId === marker.runId && row.binding === marker.binding.digest);
  // Only the registered process can prove this binding, and only its LATEST
  // attempt counts: an older success must not outlive a newer failure, because
  // the newest run is the one that says what the code does now.
  const exact = ours.filter((row) => row.command === marker.verifier && sameArgv(row.argv, expectedArgv));
  const line = exact[exact.length - 1];
  if (line === undefined) {
    const why =
      ours.length === 0
        ? "the proof command has not run: no receipt line for this binding"
        : ours.some((row) => row.command !== marker.verifier)
          ? `the receipt came from a different command than the registered verifier (${marker.verifier})`
          : "the receipt came from a different argv than the registered one, so it is a different attempt";
    return { live: state.live, receipt: null, runId: marker.runId, reason: why };
  }
  if (line.exitCode !== 0) {
    return {
      live: state.live,
      receipt: null,
      runId: marker.runId,
      reason: `the latest registered attempt exited ${line.exitCode}, so any earlier success is superseded`,
    };
  }
  if (line.score !== null && !agrees(line.score, state.holdout)) {
    return {
      live: state.live,
      receipt: null,
      runId: marker.runId,
      reason: `the proof command reported ${formatNumber(line.score)} but the engine recorded ${formatNumber(state.holdout)}`,
    };
  }
  return {
    live: state.live,
    receipt: {
      id: `${marker.runId}@v${marker.binding.version}`,
      text: receiptText(marker, state, line),
      source: receiptSource(marker, state, line),
      verdict: "confirms",
      version: marker.binding.version,
      criterionIds: marker.binding.criterionIds,
      track: marker.track,
    },
    runId: marker.runId,
    reason: null,
  };
}

async function findMarker(files: FilePort, root: string, input: ReadInput): Promise<Marker | null> {
  if (input.runId !== undefined) {
    // A marker at the requested path, whatever run it names: `readWith` compares
    // that name, so a stray file is reported as a mismatch instead of "missing".
    return parseMarker(await files.read(joinPath(root, markerPathFor(input.runId))));
  }
  const dir = joinPath(root, BRIDGE_DIR);
  const entries = (await files.list(dir)).filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"));
  const matches: Marker[] = [];
  for (const entry of entries) {
    const marker = parseMarker(await files.read(entry.path));
    if (marker === null) continue;
    if (marker.binding.engine !== input.engine) continue;
    if (marker.binding.outcomeKey !== input.outcome.key) continue;
    matches.push(marker);
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return matches[0] ?? null;
}

/**
 * The marker is written before the worker exists, so it cannot know the run's
 * outcome. What it can do is keep the binding honest: recompute the digest from
 * the marker's own rig and the *requested* contract. A bumped version, an
 * edited criterion list, a re-barred climb or a re-locked check all fail here,
 * and none of them may inherit an older run's proof.
 */
function staleness(marker: Marker, input: ReadInput): string | null {
  const outcome = input.outcome;
  if (marker.binding.engine !== input.engine) {
    return `the dispatched run is a ${marker.binding.engine} climb, not ${input.engine}`;
  }
  if (marker.binding.version !== outcome.version) {
    return `the run was dispatched against v${marker.binding.version}; ${outcome.key} is now v${outcome.version}`;
  }
  let current: string[];
  try {
    current = criterionIdsFor(outcome, marker.binding.criterionIds);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const expected = digestFor(outcome, marker.binding.engine, current, marker.rig);
  if (expected !== marker.binding.digest) {
    return "the rig or the contract changed since dispatch, so this run cannot confirm the current version";
  }
  // The rig's declared scope and the binding must be the same list: a marker
  // that names one criterion but hashes another is a different claim.
  const declared = marker.rig.criterionIds;
  if (declared !== undefined) {
    if (!sameIds(declared, marker.binding.criterionIds)) {
      return "the marker's rig and binding name different criteria";
    }
  } else if (!sameIds(outcome.criteria.map((criterion) => criterion.id), marker.binding.criterionIds)) {
    return "the marker's rig declares no criterion scope but its binding names a subset";
  }
  return null;
}

/** Exact list identity: the binding's order is part of its digest. */
function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

interface LiveState {
  live: LiveData;
  /** The holdout number the engine recorded for the current best. */
  holdout: number | null;
  /** The run identity the receipt will cite. */
  identity: string;
  reason: string | null;
}

function reaches(best: number | null, target: number, rig: Rig): boolean {
  if (best === null || !Number.isFinite(target)) return false;
  const higher = rig.engine === "repo" ? rig.direction === "max" : rig.higherIsBetter;
  return higher ? best >= target : best <= target;
}

/**
 * The registered argv of a run whose marker predates it, rebuilt from the
 * trusted rig and run id with the same recipe builder that produced the
 * dispatch. Deterministic by construction: same rig, same run id, same argv.
 */
function derivedArgv(trusted: Marker, input: ReadInput): { argv: string[]; proof: string; reason: null } | { argv: string[]; proof: string; reason: string } {
  try {
    const built = recipe({ workspace: input.workspace, outcome: input.outcome, ancestors: [], engine: input.engine, rig: trusted.rig, runId: trusted.runId, track: trusted.track });
    if (built.binding.digest !== trusted.binding.digest) {
      return { argv: [], proof: "", reason: "the rig and run id in the marker no longer rebuild the same binding" };
    }
    return { argv: built.verifierArgv, proof: built.proof, reason: null };
  } catch (error) {
    return { argv: [], proof: "", reason: `the marker's rig cannot be rebuilt into a recipe: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normaliseProof(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Same process, token for token: the receipt line's argv against the registered one. */
function sameArgv(actual: string[], registered: string[]): boolean {
  return actual.length === registered.length && actual.every((token, index) => token === registered[index]);
}

function short(digest: string): string {
  return digest.slice(0, 12);
}

/** The dispatch's marker, parsed, or the reason it cannot be used as authority. */
function trustedMarker(text?: string): { marker: Marker | null; reason: string | null } {
  if (text === undefined) return { marker: null, reason: null };
  const marker = parseMarker(text);
  if (marker === null) return { marker: null, reason: "the marker handed over by the dispatch is not a readable hcb/1 marker" };
  return { marker, reason: null };
}

/**
 * The first field where the disk disagrees with the dispatch, or null.
 *
 * Exact JSON text would break on a round-trip through any JSON store, so the
 * comparison is normalised (sorted keys, ordered arrays) but covers every field
 * the reader is about to trust: identity, binding, rig, verifier, argv, runDir.
 */
function markerDifference(trusted: Marker, onDisk: Marker, ignoreArgv = false): string | null {
  if (trusted.runId !== onDisk.runId) return `run id is ${onDisk.runId}, the dispatch wrote ${trusted.runId}`;
  if (trusted.binding.digest !== onDisk.binding.digest) {
    return `binding is ${short(onDisk.binding.digest)}, the dispatch wrote ${short(trusted.binding.digest)}`;
  }
  if (canonical(trusted.binding) !== canonical(onDisk.binding)) return "the binding fields differ from the dispatch's";
  if (trusted.verifier !== onDisk.verifier) return `verifier is ${JSON.stringify(onDisk.verifier)}, the dispatch wrote ${JSON.stringify(trusted.verifier)}`;
  if (!ignoreArgv && canonical(trusted.verifierArgv) !== canonical(onDisk.verifierArgv)) {
    return "the registered argv differs from the dispatch's";
  }
  if (trusted.runDir !== onDisk.runDir) return `run directory is ${onDisk.runDir}, the dispatch wrote ${trusted.runDir}`;
  if (canonical(trusted.rig) !== canonical(onDisk.rig)) return "the rig differs from the dispatch's";
  if (trusted.track !== onDisk.track) return `track is ${onDisk.track}, the dispatch wrote ${trusted.track}`;
  return null;
}

/** Two printed numbers agree: the engines print 5-6 significant digits. */
function agrees(reported: number, recorded: number): boolean {
  return Math.abs(reported - recorded) <= 1e-4 * Math.max(1, Math.abs(recorded));
}

function visibleComparison(baseline: number, best: number, improved: boolean): string {
  return improved
    ? `improved from baseline ${formatNumber(baseline)} to visible best ${formatNumber(best)}`
    : `visible best ${formatNumber(best)} shows no gain over baseline ${formatNumber(baseline)}`;
}

function receiptText(marker: Marker, state: LiveState, line: ReceiptLine): string {
  const held = state.holdout === null ? "n/a" : formatNumber(state.holdout);
  const best = state.live.best === null ? "n/a" : formatNumber(state.live.best);
  const visible = state.live.baseline === null ? "" : ` (baseline ${formatNumber(state.live.baseline)})`;
  const target = marker.rig.target;
  const baseline = state.live.baseline;
  // Attainment and improvement are different claims. Say which one the engine's
  // own values support, and never turn a baseline that was already at the bar
  // into a gain.
  const outcome =
    baseline === null
      ? "baseline not recorded, so this proves attainment, not a measured gain"
      : reaches(baseline, target, marker.rig)
        ? `baseline ${formatNumber(baseline)} already met the bar ${formatNumber(target)}, so this proves attainment, not a gain`
        : state.live.best === null
          ? "no visible best was recorded to compare with the baseline"
          : (marker.rig.engine === "repo" ? marker.rig.direction === "max" : marker.rig.higherIsBetter)
            ? visibleComparison(baseline, state.live.best, state.live.best > baseline)
            : visibleComparison(baseline, state.live.best, state.live.best < baseline);
  return `holdout ${held} meets the bar ${formatNumber(target)}; visible best ${best}${visible}; ${outcome} in ${state.identity}`;
}

function receiptSource(marker: Marker, state: LiveState, line: ReceiptLine): string {
  const verified = line.at === "" ? "" : ` at ${line.at}`;
  return `${state.identity} · ${redactSecrets(line.command)}${verified} · binding ${marker.binding.digest.slice(0, 12)}`;
}

// --- repo engine ------------------------------------------------------------

async function readRepo(files: FilePort, root: string, marker: Marker): Promise<LiveState> {
  const relative = marker.runDir !== "" ? marker.runDir : `.hill-climb/${climbNameFor(marker.runId)}`;
  const base = joinPath(root, relative);
  const cardText = await files.read(`${base}/card.json`);
  let card: ClimbCard | null = null;
  try {
    card = cardText === null ? null : parseCard(cardText);
  } catch {
    card = null;
  }
  if (card === null) {
    return { live: emptyLive(), holdout: null, identity: "", reason: `no card.json under ${relative}: init never completed` };
  }
  // state.ts reads the same two files the engine writes, so the trail and the
  // holdout rows cannot drift from `hillclimb status`.
  const rows = parseLog((await files.read(`${base}/log.jsonl`)) ?? "");
  const holdouts = rows.filter((row) => row.kind === "holdout" && finite(row.score) !== null) as Array<LogRow & { visible?: number }>;
  const lastHoldout = holdouts.length > 0 ? (holdouts[holdouts.length - 1] as LogRow & { visible?: number }) : null;

  const trail: LiveData["rows"] = [];
  let bestStep = 0;
  for (const row of rows) {
    if (row.kind === "baseline") {
      trail.push({ id: "baseline", parent: null, score: finite(row.score), label: "baseline", at: at(row.time) });
      continue;
    }
    if (row.kind !== "step") continue;
    const step = finite(row.step) ?? 0;
    const id = `step-${step}`;
    trail.push({
      id,
      parent: bestStep === 0 ? "baseline" : `step-${bestStep}`,
      score: finite(row.score),
      label: typeof row.idea === "string" && row.idea !== "" ? redactSecrets(row.idea) : String(row.result ?? "step"),
      at: at(row.time),
    });
    if (row.result === "kept") bestStep = step;
  }
  const kept = trail.filter((row) => row.id.startsWith("step-"));
  const live: LiveData = {
    engine: "repo",
    baseline: card.baseline,
    best: card.best.score,
    target: card.target ?? null,
    rows: trim(trail),
    holdout: lastHoldout === null ? null : formatNumber(finite(lastHoldout.score) ?? 0),
  };
  const identity = `climb ${card.name}${card.best.commit ? `@${card.best.commit.slice(0, 12)}` : ""}${card.branch ? ` (${card.branch})` : ""}, ${kept.length} steps kept`;
  const lastVisible = finite(lastHoldout?.visible);
  // Exact IEEE-754 equality is intentional here: both values come directly from
  // Python json.dumps in card.json/log.jsonl (unlike stdout strings compared via agrees()),
  // so a tolerance like 1e-4 could falsely accept a stale holdout after a small gain.
  const reached = lastHoldout !== null && lastVisible !== null && lastVisible === card.best.score;
  return {
    live,
    holdout: reached ? finite(lastHoldout.score) : null,
    identity,
    reason: reached
      ? null
      : lastHoldout === null
        ? "no holdout has been run; run the proof command at the bar"
        : "the last holdout was measured against an older best; run the proof command again",
  };
}

// --- search engine ----------------------------------------------------------

async function readSearch(files: FilePort, root: string, marker: Marker): Promise<LiveState> {
  const rig = marker.rig as SearchRig;
  const runsRoot = joinPath(root, "runs");
  // A run directory is `<UTC stamp>-<engine slug of the name>`, and that slug is
  // the engine's business, not ours: a real dispatch used an id like
  // `run_mwuuc36w6aac33af`, which no hyphen normalisation reproduces. The
  // metadata is the identity, so read `run.yaml.name` and compare it exactly.
  const direct = (await files.list(runsRoot)).filter((entry) => entry.kind === "directory" && directChild(entry, runsRoot));
  const named: Array<{ path: string; name: string; started: string }> = [];
  for (const entry of direct) {
    const meta = parseYamlScalars(await files.read(`${entry.path}/run.yaml`));
    if (meta.name !== marker.runId) continue;
    named.push({ path: entry.path, name: entry.name, started: meta.started_at ?? "" });
  }
  if (named.length === 0) {
    return {
      live: emptyLive(),
      holdout: null,
      identity: "",
      reason: `runs/ has no run.yaml whose name is ${marker.runId} (checked ${direct.length} direct entr${direct.length === 1 ? "y" : "ies"})`,
    };
  }
  named.sort((a, b) => (a.started === b.started ? (a.name < b.name ? 1 : -1) : a.started < b.started ? 1 : -1));
  const run = named[0] as { path: string; name: string; started: string };
  const runName = run.name;
  const picked = await pickSearch(files, run.path, rig);
  const searchDir = picked.chosen?.path;
  if (!searchDir) {
    return { live: emptyLive(), holdout: null, identity: "", reason: `Run ${marker.runId} has no recorded search for ${rig.problemId} with the configured climber.` };
  }
  const searchYaml = picked.chosen!.meta;

  const featureDimensions = await recordedFeatureDimensions(files, searchDir, searchYaml);
  const status = parseJson(await files.read(`${searchDir}/status.json`));
  const records = journalCandidates(await files.read(`${searchDir}/journal.jsonl`));
  if (status === null && records.length === 0) {
    return {
      live: emptyLive(),
      holdout: null,
      identity: "",
      reason: "the search has written neither status.json nor journal.jsonl yet (with store.backend: sqlite they never appear; read it with `hillclimb status`)",
    };
  }

  const rows: LiveData["rows"] = records.slice(-ROW_LIMIT).map((candidate) => ({
    id: candidate.id,
    parent: candidate.parent,
    score: candidate.val,
    label: candidate.label,
    at: candidate.at,
  }));
  const baseline = records.find((candidate) => candidate.operator === "baseline" || candidate.operator === "seed");
  const bestRef = object(status?.best);
  const bestCandidate = records.find((candidate) => candidate.best) ?? records.filter((candidate) => candidate.val !== null).sort((a, b) => (rig.higherIsBetter ? (b.val ?? 0) - (a.val ?? 0) : (a.val ?? 0) - (b.val ?? 0)))[0];
  const best = finite(bestRef?.val_score) ?? bestCandidate?.val ?? null;

  const selectedRef = object(status?.selected);
  const selectedId = typeof selectedRef?.candidate_id === "string" ? selectedRef.candidate_id : bestCandidate?.id;
  const selected = records.find((candidate) => candidate.id === selectedId);
  const holdout = selected?.holdout ?? finite(selectedRef?.holdout_score) ?? null;
  const live: LiveData = {
    engine: "search",
    baseline: baseline?.val ?? null,
    best,
    target: rig.target,
    rows: trim(rows),
    holdout: holdout === null ? null : formatNumber(holdout),
    // one search's own candidates: a run may hold several (a fleet, a repeat),
    // and none of them is the run's aggregate
    search: {
      id: pathName(searchDir),
      climber: searchYaml.climber ?? null,
      featureDimensions,
      count: picked.count,
    },
    elite: eliteCells(records, rig.higherIsBetter),
  };
  const identity = `search ${runName}/${pathName(searchDir)}${picked.count > 1 ? ` (1 of ${picked.count})` : ""}${selectedId ? ` selected ${selectedId}` : ""}`;
  const notPassing = selected !== undefined && selected.status !== "passing";
  return {
    live,
    holdout: notPassing ? null : holdout,
    identity,
    reason: notPassing
      ? `the selected candidate ${selected.id} is ${selected.status}, not passing, so its holdout does not count`
      : holdout === null
        ? `the selected candidate${selectedId ? ` ${selectedId}` : ""} has no holdout score (the problem declares none, or the search has not reached it)`
        : null,
  };
}

function pathName(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const index = cleaned.lastIndexOf("/");
  return index === -1 ? cleaned : cleaned.slice(index + 1);
}

/** A listing entry that is the parent's own child, not a deeper path some hosts report. */
function directChild(entry: PortEntry, parent: string): boolean {
  return entry.path.replace(/\/+$/, "") === joinPath(parent, entry.name);
}

interface YamlToken {
  indent: number;
  /** A `- value` line. */
  item?: string;
  key?: string;
  value?: string;
  /** A line this reader does not understand (a nested item, a block scalar). */
  opaque?: boolean;
}

/**
 * The same YAML, one level deeper: what `yaml.safe_dump` writes for a climber
 * block — scalars, nested mappings, lists of scalars. Anything else (a
 * `- key:` item, a `|` block, an anchor) is dropped rather than guessed at: a
 * field this reader cannot prove is absent from its result, which is the only
 * safe way to read a record whose absence means "the engine did not say".
 */
export function parseYamlTree(text: string | null): Record<string, unknown> {
  const tokens: YamlToken[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item !== null) {
      const value = scalarText(item[1] ?? "");
      tokens.push(value === "" || /^[A-Za-z0-9_-]+:\s/.test(value) ? { indent, opaque: true } : { indent, item: value });
      continue;
    }
    const pair = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(trimmed);
    if (pair === null) {
      tokens.push({ indent, opaque: true });
      continue;
    }
    const value = scalarText(pair[2] ?? "");
    // a block scalar (`|`, `>`, `|-`) or an alias/merge key is not a scalar the
    // engine recorded: the field is dropped rather than read as its marker
    tokens.push(/^[|>][-+]?$/.test(value) || /^[&*]/.test(value) ? { indent, opaque: true } : { indent, key: pair[1] as string, value });
  }

  let index = 0;
  const readMap = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    while (index < tokens.length) {
      const token = tokens[index] as YamlToken;
      if (token.opaque === true) {
        index += 1;
        continue;
      }
      if (token.key === undefined || token.indent !== indent) break;
      const key = token.key;
      index += 1;
      if (token.value !== "" && token.value !== undefined) {
        map[key] = token.value;
        continue;
      }
      const next = tokens[index];
      if (next === undefined) {
        map[key] = {};
        continue;
      }
      // `yaml.safe_dump` writes a list at its key's own indent, so an item at
      // or below this indent belongs to this key
      if (next.item !== undefined && next.indent >= indent) {
        const list: string[] = [];
        while (index < tokens.length) {
          const row = tokens[index] as YamlToken;
          if (row.item === undefined || row.indent < indent) break;
          list.push(row.item);
          index += 1;
        }
        map[key] = list;
        continue;
      }
      if (next.key !== undefined && next.indent > indent && next.opaque !== true) {
        map[key] = readMap(next.indent);
        continue;
      }
      map[key] = {};
    }
    return map;
  };
  return readMap(0);
}

/** A one-line YAML scalar: no inline comment, quotes off. */
function scalarText(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  return withoutComment.replace(/^["'](.*)["']$/, "$1");
}

interface SearchEntry {
  name: string;
  path: string;
  /** search.yaml's scalars (`problem_key`, `climber`, …). */
  meta: Record<string, string>;
  /** status.json's own `started_at` — the engine's chronology, not readdir's. */
  startedAt: string;
}

interface PickedSearch {
  chosen: SearchEntry | null;
  /** How many searches in this run climb the rig's problem (repeats, fleet). */
  count: number;
}

/**
 * Which search the live view reads, chosen by the engine's own records.
 *
 * A run can hold several searches on one problem: `--parallel-searches N`
 * repeats it, a mixed fleet runs one per climber (`<problem>`, `<problem>-2`,
 * …). The bridge reads exactly one of them and says how many siblings exist,
 * because reporting one search's candidates as the run's aggregate would be a
 * number nobody measured. Chronology is status.json's `started_at`; a search
 * that has not written one yet sorts by its recorded name, never by readdir.
 */
async function pickSearch(files: FilePort, runPath: string, rig: SearchRig): Promise<PickedSearch> {
  const parent = `${runPath}/searches`;
  const listed = (await files.list(parent)).filter((entry) => entry.kind === "directory" && directChild(entry,parent));
  const entries: SearchEntry[] = [];
  for (const entry of listed) {
    const meta = parseYamlScalars(await files.read(`${entry.path}/search.yaml`));
    const status = parseJson(await files.read(`${entry.path}/status.json`));
    const startedAt = typeof status?.started_at === "string" ? status.started_at : "";
    entries.push({ name: entry.name, path: entry.path, meta, startedAt });
  }
  if (entries.length === 0) return { chosen: null, count: 0 };
  const problemOf = (entry: SearchEntry): string => entry.meta.problem_key ?? entry.meta.problem_id ?? "";
  // a search that named no problem key is an older record, not a sibling of
  // another problem: it stays a candidate for this rig
  const forProblem = entries.filter((entry) => problemOf(entry) === rig.problemId);
  const pool = forProblem;
  const climberName = rig.climber?.name;
  const sameClimber = climberName === undefined ? pool : pool.filter((entry) => entry.meta.climber === climberName);
  const order = (a: SearchEntry, b: SearchEntry): number => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === "") return 1;
      if (b.startedAt === "") return -1;
      return a.startedAt < b.startedAt ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  const candidates = sameClimber.slice().sort(order);
  return { chosen: candidates[0] ?? null, count: pool.length };
}

/**
 * The feature dimensions the search itself recorded, most specific first: the
 * climber snapshot it ran (`searches/<id>/climber/climber.yaml`), then
 * `search.yaml`'s `climber_spec`. Null means the block did not name them — the
 * selector's own defaults then decide the grid, and this module does not
 * invent names for its axes.
 */
async function recordedFeatureDimensions(files: FilePort, searchDir: string, searchYaml: Record<string, string>): Promise<string[] | null> {
  const snapshot = parseYamlTree(await files.read(`${searchDir}/climber/climber.yaml`));
  const fromSnapshot = featureDimensionsOf(snapshot);
  if (fromSnapshot !== null) return fromSnapshot;
  const spec = await files.read(`${searchDir}/search.yaml`);
  return featureDimensionsOf(object(parseYamlTree(spec).climber_spec));
}

function featureDimensionsOf(block: Record<string, unknown> | null): string[] | null {
  const params = object(block?.selector_params);
  const dimensions = params?.feature_dimensions;
  if (!Array.isArray(dimensions)) return null;
  const names = dimensions.filter((dimension): dimension is string => typeof dimension === "string" && dimension.trim() !== "").map((dimension) => dimension.trim());
  return names.length > 0 ? names : null;
}

export interface EliteCell {
  island: number;
  /** The grid bin the search expanded from (`climber_meta.cell`), as recorded. */
  bins: number[];
  /** The candidate that occupied the cell: the record's `parent_id`. */
  parent: string | null;
  /** That candidate's score when the attempt was made (`climber_meta.parent_fitness`). */
  score: number | null;
  /** Attempts the journal records from this cell. */
  attempts: number;
}

/**
 * The MAP-Elites cells a search actually recorded.
 *
 * OpenEvolve's archive never reaches disk; what the engine journals is the
 * decision it made — `climber_meta.cell` (the parent's grid bin),
 * `climber_meta.island` and `climber_meta.parent_fitness` — on every candidate
 * built from the archive. So this is the grid of *recorded expansion cells*
 * with the best parent recorded in each, not a reconstruction of the live
 * archive and not a value invented here. A search whose climber recorded no
 * cells yields an empty list, which is what the drawer draws: nothing.
 */
export function eliteCells(records: JournalCandidate[], higherIsBetter: boolean): EliteCell[] {
  const cells = new Map<string, EliteCell>();
  for (const record of records) {
    if (record.island === null || record.bins === null) continue;
    const key = `${record.island}|${record.bins.join(",")}`;
    const seen = cells.get(key);
    if (seen === undefined) {
      cells.set(key, { island: record.island, bins: record.bins, parent: record.parent, score: record.parentFitness, attempts: 1 });
      continue;
    }
    seen.attempts += 1;
    seen.score = betterScore(seen.score, record.parentFitness, higherIsBetter);
    if (seen.score === record.parentFitness && record.parent !== null) seen.parent = record.parent;
  }
  return [...cells.values()].sort((a, b) => a.island - b.island || (a.bins[0] ?? 0) - (b.bins[0] ?? 0) || (a.bins[1] ?? 0) - (b.bins[1] ?? 0));
}

function betterScore(current: number | null, candidate: number | null, higherIsBetter: boolean): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return higherIsBetter ? Math.max(current, candidate) : Math.min(current, candidate);
}


/**
 * A deliberately small YAML reader: the fields this bridge reads are single
 * scalars on one line (`name: cosine`), written by the engine's own dumper.
 * Nested blocks are ignored rather than guessed at.
 */
export function parseYamlScalars(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === null) return out;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith(" ")) continue;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    const value = (match[2] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
    if (value === "" || value === "null" || value === "~") continue;
    out[match[1]] = value;
  }
  return out;
}

export interface JournalCandidate {
  id: string;
  parent: string | null;
  operator: string;
  status: string;
  val: number | null;
  holdout: number | null;
  best: boolean;
  label: string;
  at: string;
  /** `climber_meta.island` — MAP-Elites tags a draft with its island. */
  island: number | null;
  /** `climber_meta.cell` — the grid bin the attempt started from. */
  bins: number[] | null;
  /** `climber_meta.parent_fitness` — the parent's score at selection time. */
  parentFitness: number | null;
}

/**
 * The journal is append-only, two events per candidate; the last line wins.
 * A candidate's score is its best trial's median replicate — the engine's own
 * aggregate (`Candidate.best_trial`), not an average this module invents.
 */
export function journalCandidates(text: string | null): JournalCandidate[] {
  const order: string[] = [];
  const byId = new Map<string, JournalCandidate>();
  for (const row of jsonl(text)) {
    const event = row.event;
    if (event !== "candidate_created" && event !== "candidate_result") continue;
    const id = typeof row.candidate_id === "string" ? row.candidate_id : null;
    if (id === null) continue;
    const trials = Array.isArray(row.trials) ? row.trials.map(object).filter((trial): trial is Record<string, unknown> => trial !== null) : [];
    const scored = trials.filter((trial) => trial.verdict !== "failing" && trial.verdict !== "buggy");
    const flagged = scored.filter((trial) => trial.is_best === true);
    const bestTrial = (flagged.length > 0 ? flagged[flagged.length - 1] : scored[scored.length - 1]) ?? null;
    const scores = bestTrial === null ? [] : (Array.isArray(bestTrial.replicates) ? bestTrial.replicates.map(object).filter((r): r is Record<string, unknown> => r !== null) : []).map((replicate) => finite(replicate.val_score)).filter((value): value is number => value !== null);
    const meta = object(row.climber_meta) ?? {};
    const bins = Array.isArray(meta.cell) ? meta.cell.map((value) => finite(value)).filter((value): value is number => value !== null) : [];
    const candidate: JournalCandidate = {
      id,
      parent: typeof row.parent_id === "string" ? row.parent_id : null,
      operator: typeof row.operator === "string" ? row.operator : "",
      status: typeof row.status === "string" ? (row.status === "ok" ? "passing" : row.status) : "pending",
      val: median(scores),
      holdout: bestTrial === null ? null : finite(bestTrial.holdout_score),
      best: row.is_best === true,
      label: [typeof row.operator === "string" ? row.operator : "", typeof row.summary === "string" ? row.summary : ""].filter((part) => part !== "").join(" "),
      at: at(typeof row.finished_at === "string" ? row.finished_at : typeof row.created_at === "string" ? row.created_at : ""),
      island: finite(meta.island),
      bins: bins.length > 0 ? bins : null,
      parentFitness: finite(meta.parent_fitness),
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, candidate);
  }
  return order.map((id) => byId.get(id) as JournalCandidate);
}

function trim(rows: LiveData["rows"]): LiveData["rows"] {
  return rows.length <= ROW_LIMIT ? rows : rows.slice(rows.length - ROW_LIMIT);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The local filesystem, for a CLI/MCP server running beside the checkout and for tests.
 * `root` is only used to make relative paths resolvable.
 */
export function localPort(root = process.cwd()): FilePort {
  return {
    async read(path: string): Promise<string | null> {
      try {
        return readFileSync(resolve(root, path), "utf8");
      } catch {
        return null;
      }
    },
    async list(path: string): Promise<PortEntry[]> {
      const dir = resolve(root, path);
      try {
        return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          path: join(dir, entry.name),
          name: entry.name,
          kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The receipt writer, shipped as an asset and inlined into every recipe
// ---------------------------------------------------------------------------

function assetCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "assets", "bridge"), join(here, "assets", "bridge"), join(here, "..", "..", "assets", "bridge")];
}

/** The script that runs a verifier and appends one receipt line. */
export function receiptScript(): string {
  for (const root of assetCandidates()) {
    try {
      return readFileSync(join(root, "receipt.py"), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error("the bridge receipt writer is missing (assets/bridge/receipt.py); reinstall the plugin");
}
