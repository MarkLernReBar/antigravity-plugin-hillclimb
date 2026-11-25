// The tree's domain operations: apply a core action, then compute what the tree
// says right now.
//
// `applyCore` is the only writer. It mutates the tree it is given and appends one
// activity row per change; it never edits or deletes history (evidence, activity
// and rejected/approved changes all stay). `snapshot` is the only reader that
// decides anything: an outcome's signal is computed from evidence, its contract
// version and the clock, never stored.
//
// Signals (mirroring hillclimb.me/docs/evidence.md):
//   verified   every criterion has "confirms" evidence against the current version
//   broken     a "denies" for the current version arrived after the newest confirm
//   stale      a criterion was confirmed only against an older version
//   unverified nothing proves it against the current version
//   recheck    verified, but its newest confirm for the current version is older
//              than the outcome's recheck interval (it still counts as verified)
//
// Ordering: an outcome's effective rank is its goal ancestry plus its own rank,
// lifted to the best rank of anything that depends on it, through chains. A
// dependency that is not proven holds its dependents out of `next`.

import type {
  Activity,
  Claim,
  Contract,
  Criterion,
  Evidence,
  Goal,
  Outcome,
  Ranked,
  Signal,
  Snapshot,
  Tree,
} from "./model.js";
import { emptyTree } from "./model.js";
import type { CoreAction } from "./actions.js";

export const LIVE_TRACK = "main";
export const MAX_DEPENDENCIES = 20;
const DAY_MS = 86_400_000;

/** A refusal that names the invariant it protects. Every refusal is this type. */
export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeError";
  }
}

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

function fail(message: string): never {
  throw new TreeError(message);
}

function timeMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`${field} is not a timestamp: ${value}`);
  return ms;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

function text(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") fail(`${field} must not be empty`);
  return trimmed;
}

function rank(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 0) fail(`rank must be a non-negative integer, got ${String(value)}`);
  return value;
}

function outcomeKey(value: string | undefined, field = "key"): string {
  const key = text(value, field);
  if (!KEY.test(key)) fail(`${field} is not a valid key: ${key}`);
  return key;
}

function byKey<T extends { key: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.key, row]));
}

function findOutcome(tree: Tree, key: string): Outcome {
  const outcome = byKey(tree.outcomes).get(key);
  if (outcome === undefined) fail(`unknown outcome ${key}`);
  return outcome;
}

function assertKeyFree(tree: Tree, key: string): void {
  if (tree.goals.some((goal) => goal.key === key)) fail(`key ${key} is already a goal`);
  if (tree.outcomes.some((outcome) => outcome.key === key)) fail(`key ${key} is already an outcome`);
}

function normalizeCriterion(raw: Criterion, index: number): Criterion {
  const id = outcomeKey(raw?.id, `criteria[${index}].id`);
  return {
    id,
    given: text(raw?.given, `criterion ${id} given`),
    when: text(raw?.when, `criterion ${id} when`),
    then: text(raw?.then, `criterion ${id} then`),
  };
}

/** Every contract entering the tree passes through here. */
function normalizeContract(tree: Tree, raw: Contract, selfKey: string | null): Contract {
  const title = text(raw?.title, "contract title");
  const story = text(raw?.story, "contract story");
  const criteria = (raw?.criteria ?? []).map(normalizeCriterion);
  if (criteria.length === 0) fail("a contract needs at least one criterion");
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (seen.has(criterion.id)) fail(`duplicate criterion id ${criterion.id}`);
    seen.add(criterion.id);
  }
  const dependsOn = [...(raw?.dependsOn ?? [])];
  if (dependsOn.length > MAX_DEPENDENCIES) {
    fail(`at most ${MAX_DEPENDENCIES} dependencies are allowed, got ${dependsOn.length}`);
  }
  const dependencySeen = new Set<string>();
  for (const dependency of dependsOn) {
    if (!KEY.test(dependency)) fail(`dependency is not a valid key: ${dependency}`);
    if (dependencySeen.has(dependency)) fail(`duplicate dependency ${dependency}`);
    dependencySeen.add(dependency);
    if (selfKey !== null && dependency === selfKey) fail(`outcome ${selfKey} cannot depend on itself`);
    if (!tree.outcomes.some((outcome) => outcome.key === dependency)) {
      fail(`dependency ${dependency} is not an outcome in this tree`);
    }
  }
  if (selfKey !== null) {
    const cycle = cycleThrough(tree, selfKey, dependsOn);
    if (cycle !== null) fail(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  const recheckDays = raw?.recheckDays ?? null;
  if (recheckDays !== null && (!Number.isFinite(recheckDays) || recheckDays <= 0)) {
    fail(`recheckDays must be null or positive, got ${String(recheckDays)}`);
  }
  return { title, story, criteria, dependsOn, rank: rank(raw?.rank), recheckDays };
}

/** The loop a new dependency edge would close, named from `selfKey` round to itself. */
function cycleThrough(tree: Tree, selfKey: string, dependencies: string[]): string[] | null {
  const outcomes = byKey(tree.outcomes);
  for (const dependency of dependencies) {
    if (dependency === selfKey) return [selfKey, selfKey];
    const trail = pathBetween(outcomes, dependency, selfKey);
    if (trail !== null) return [selfKey, ...trail];
  }
  return null;
}

function pathBetween(outcomes: Map<string, Outcome>, from: string, target: string): string[] | null {
  const walk = (key: string, trail: string[], seen: Set<string>): string[] | null => {
    const outcome = outcomes.get(key);
    if (outcome === undefined) return null;
    for (const next of outcome.dependsOn) {
      if (next === target) return [...trail, key, target];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...trail, key], seen);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(from, [], new Set([from]));
}

// ---------------------------------------------------------------------------
// Evidence-derived state (pure)
// ---------------------------------------------------------------------------

type CriterionState = Exclude<Signal, "recheck">;

export interface CriterionSignal {
  id: string;
  signal: CriterionState;
  /** Newest "confirms" id behind a verified or stale state. */
  evidence: string | null;
  /** Newest "denies" id for the current version, when one arrived. */
  deny: string | null;
}

interface Decision {
  evidence: Evidence;
  at: number;
  order: number;
}

function decisions(
  outcome: Outcome,
  evidence: Evidence[],
  criterionId: string,
  nowMs: number,
): Decision[] {
  const rows: Decision[] = [];
  evidence.forEach((item, order) => {
    if (item.kind === "note") return; // context, not a decision
    if (item.version > outcome.version) return;
    const covers =
      item.criterionIds.length === 0 ||
      (criterionId !== "" && item.criterionIds.includes(criterionId));
    if (!covers) return;
    const at = Date.parse(item.created);
    if (!Number.isFinite(at) || at > nowMs) return; // replay: nothing from the future
    rows.push({ evidence: item, at, order });
  });
  rows.sort((left, right) => left.at - right.at || left.order - right.order);
  return rows;
}

function criterionState(
  outcome: Outcome,
  evidence: Evidence[],
  criterionId: string,
  nowMs: number,
): CriterionSignal {
  const rows = decisions(outcome, evidence, criterionId, nowMs);
  const current = rows.filter((row) => row.evidence.version === outcome.version);
  const kinds = current.map((row) => row.evidence.kind);
  const lastConfirm = kinds.lastIndexOf("confirms");
  if (lastConfirm >= 0) {
    const confirm = current[lastConfirm] as Decision;
    const deniedAfter = current
      .slice(lastConfirm + 1)
      .some((row) => row.evidence.kind === "denies");
    const newestDeny = deniedAfter
      ? ([...current].reverse().find((row) => row.evidence.kind === "denies") as Decision)
      : null;
    return {
      id: criterionId,
      signal: deniedAfter ? "broken" : "verified",
      evidence: confirm.evidence.id,
      deny: newestDeny?.evidence.id ?? null,
    };
  }
  const newestDeny = [...current].reverse().find((row) => row.evidence.kind === "denies") ?? null;
  const older = rows.filter(
    (row) => row.evidence.version < outcome.version && row.evidence.kind === "confirms",
  );
  const olderConfirm = older[older.length - 1] ?? null;
  return {
    id: criterionId,
    signal: olderConfirm !== null ? "stale" : "unverified",
    evidence: olderConfirm?.evidence.id ?? null,
    deny: newestDeny?.evidence.id ?? null,
  };
}

/** Per-criterion signals for one outcome, on one track, as of `now`. */
export function criterionSignals(
  tree: Tree,
  key: string,
  track: string = LIVE_TRACK,
  now: string = new Date().toISOString(),
): CriterionSignal[] {
  const outcome = byKey(tree.outcomes).get(key);
  if (outcome === undefined) return [];
  const nowMs = timeMs(now, "now");
  const evidence = tree.evidence.filter((item) => item.key === key && item.track === track);
  // A contract with no criteria (only possible from a hand-built tree) reads
  // from outcome-level evidence: the pieces that name no criterion.
  const ids = outcome.criteria.length === 0 ? [""] : outcome.criteria.map((criterion) => criterion.id);
  return ids.map((id) => criterionState(outcome, evidence, id, nowMs));
}

/** When this outcome's recheck falls due, or null when it has no interval. */
export function recheckDueAt(
  tree: Tree,
  key: string,
  track: string = LIVE_TRACK,
  now: string = new Date().toISOString(),
): string | null {
  const outcome = byKey(tree.outcomes).get(key);
  if (outcome === undefined || outcome.recheckDays === null) return null;
  const nowMs = timeMs(now, "now");
  const newest = tree.evidence
    .filter(
      (item) =>
        item.key === key &&
        item.track === track &&
        item.kind === "confirms" &&
        item.version === outcome.version &&
        Date.parse(item.created) <= nowMs,
    )
    .reduce<number | null>((latest, item) => {
      const at = Date.parse(item.created);
      return latest === null || at > latest ? at : latest;
    }, null);
  if (newest === null) return null;
  return iso(newest + outcome.recheckDays * DAY_MS);
}

/** The computed signal for one outcome. */
export function outcomeSignal(
  tree: Tree,
  key: string,
  track: string = LIVE_TRACK,
  now: string = new Date().toISOString(),
): Signal {
  const states = criterionSignals(tree, key, track, now);
  if (states.length === 0) return "unverified";
  if (states.some((state) => state.signal === "broken")) return "broken";
  if (states.every((state) => state.signal === "verified")) {
    const due = recheckDueAt(tree, key, track, now);
    if (due !== null && timeMs(now, "now") > timeMs(due, "recheck due")) return "recheck";
    return "verified";
  }
  const settled = states.every((state) => state.signal === "verified" || state.signal === "stale");
  if (settled && states.some((state) => state.signal === "stale")) return "stale";
  return "unverified";
}

// ---------------------------------------------------------------------------
// Rank: goal ancestry, then the outcome, lifted by dependents
// ---------------------------------------------------------------------------

export function goalAncestors(tree: Tree, goalKey: string | null): Goal[] {
  const goals = byKey(tree.goals);
  const chain: Goal[] = [];
  const seen = new Set<string>();
  let cursor = goalKey;
  while (cursor !== null) {
    if (seen.has(cursor)) break; // never loop on a corrupt tree
    seen.add(cursor);
    const goal = goals.get(cursor);
    if (goal === undefined) break;
    chain.unshift(goal);
    cursor = goal.parentGoalKey;
  }
  return chain;
}

function comparePaths(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    if (a !== b) return a - b;
  }
  return left.length - right.length;
}

function encodePath(path: number[], base: number): number {
  return path.reduce((total, value, index) => total + value / base ** (index + 1), 0);
}

/** A rank path rendered the way a person reads it: "1.2.3". */
export function formatRankPath(path: number[]): string {
  return path.length === 0 ? "" : path.join(".");
}

function rankBase(tree: Tree): number {
  let highest = 1;
  for (const goal of tree.goals) highest = Math.max(highest, goal.rank);
  for (const outcome of tree.outcomes) highest = Math.max(highest, outcome.rank);
  return Math.max(2, highest + 1);
}

/** Effective rank paths for every outcome, after dependency promotion. */
export function effectiveRankPaths(tree: Tree): Map<string, number[]> {
  const outcomes = byKey(tree.outcomes);
  const dependents = new Map<string, string[]>();
  for (const outcome of tree.outcomes) {
    for (const dependency of outcome.dependsOn) {
      if (!outcomes.has(dependency)) continue;
      const list = dependents.get(dependency) ?? [];
      list.push(outcome.key);
      dependents.set(dependency, list);
    }
  }
  const own = new Map<string, number[]>();
  for (const outcome of tree.outcomes) {
    const chain = goalAncestors(tree, outcome.goalKey).map((goal) => goal.rank);
    own.set(outcome.key, [...chain, outcome.rank]);
  }
  const resolved = new Map<string, number[]>();
  const visiting = new Set<string>();
  const resolve = (key: string): number[] => {
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;
    const self = own.get(key) ?? [100];
    if (visiting.has(key)) return self; // a cycle cannot promote anything
    visiting.add(key);
    let best = self;
    for (const dependent of dependents.get(key) ?? []) {
      const candidate = resolve(dependent);
      if (comparePaths(candidate, best) < 0) best = candidate;
    }
    visiting.delete(key);
    resolved.set(key, best);
    return best;
  };
  for (const outcome of tree.outcomes) resolve(outcome.key);
  return resolved;
}

/** The effective rank path for one outcome, or [] when it is not in the tree. */
export function effectiveRankPath(tree: Tree, key: string): number[] {
  return effectiveRankPaths(tree).get(key) ?? [];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function liveClaim(tree: Tree, key: string, nowMs: number): Claim | null {
  const claim = tree.claims
    .filter((row) => row.key === key && Date.parse(row.expires) > nowMs)
    .at(-1);
  return claim ?? null;
}

function proven(signal: Signal): boolean {
  return signal === "verified" || signal === "recheck";
}

/** What the tree says at `now`: signals, promoted ranks, next work, inbox. */
export function snapshot(
  tree: Tree,
  track: string = LIVE_TRACK,
  now: string = new Date().toISOString(),
): Snapshot {
  const nowMs = timeMs(now, "now");
  const paths = effectiveRankPaths(tree);
  const base = rankBase(tree);
  const signals = new Map<string, Signal>();
  for (const outcome of tree.outcomes) {
    signals.set(outcome.key, outcomeSignal(tree, outcome.key, track, now));
  }
  const outcomes = byKey(tree.outcomes);
  const ranked: Ranked[] = tree.outcomes.map((outcome) => {
    const path = paths.get(outcome.key) ?? [outcome.rank];
    const blockedBy = outcome.dependsOn.filter((key) => {
      const signal = signals.get(key);
      return signal === undefined || !proven(signal);
    });
    return {
      key: outcome.key,
      signal: signals.get(outcome.key) ?? "unverified",
      effectiveRank: encodePath(path, base),
      ancestors: goalAncestors(tree, outcome.goalKey),
      blockedBy,
      claim: liveClaim(tree, outcome.key, nowMs),
    };
  });
  ranked.sort((left, right) => {
    const order = comparePaths(
      paths.get(left.key) ?? [],
      paths.get(right.key) ?? [],
    );
    if (order !== 0) return order;
    const leftOutcome = outcomes.get(left.key);
    const rightOutcome = outcomes.get(right.key);
    const leftCreated = Date.parse(leftOutcome?.created ?? "");
    const rightCreated = Date.parse(rightOutcome?.created ?? "");
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return left.key.localeCompare(right.key);
  });
  // Next work: unproven or due, unblocked, unclaimed. `recheck` is still work.
  const next = ranked
    .filter((row) => row.signal !== "verified" && row.blockedBy.length === 0 && row.claim === null)
    .map((row) => row.key);
  const inbox =
    tree.changes.filter((change) => change.state === "pending").length +
    tree.comments.filter((comment) => comment.answer === null).length;
  return {
    goals: [...tree.goals],
    outcomes: [...tree.outcomes],
    evidence: [...tree.evidence],
    claims: [...tree.claims],
    changes: [...tree.changes],
    plans: [...tree.plans],
    comments: [...tree.comments],
    tracks: [...tree.tracks],
    releases: [...tree.releases],
    flows: [...tree.flows],
    activity: [...tree.activity],
    ranked,
    next,
    inbox,
  };
}

/**
 * The tree as it read at `at`. Evidence recorded later, claims that had already
 * lapsed and activity that had not happened yet are left out. Contract versions
 * and approvals are not versioned history, so an approval made later still
 * shows on the earlier reading; use the activity log for exact ordering.
 */
export function replay(tree: Tree, at: string, track: string = LIVE_TRACK): Snapshot {
  const atMs = timeMs(at, "at");
  const earlier: Tree = {
    ...tree,
    evidence: tree.evidence.filter((item) => Date.parse(item.created) <= atMs),
    activity: tree.activity.filter((row) => Date.parse(row.at) <= atMs),
    claims: tree.claims.filter((claim) => Date.parse(claim.expires) > atMs),
  };
  return snapshot(earlier, track, at);
}

// ---------------------------------------------------------------------------
// applyCore
// ---------------------------------------------------------------------------

function nextId(tree: Tree, prefix: string, used: (id: string) => boolean): string {
  let counter = 1;
  while (used(`${prefix}${counter}`)) counter += 1;
  return `${prefix}${counter}`;
}

function record(tree: Tree, at: string, key: string, line: string, signal: Signal | null, track: string = LIVE_TRACK): void {
  const row: Activity = { at, key, text: line, signal, track };
  tree.activity.push(row);
}

/**
 * Apply one core action in place. Every invariant is enforced before anything
 * is written, so a refusal leaves `tree` exactly as it was.
 */
export function applyCore(tree: Tree, action: CoreAction, now: string): void {
  const nowMs = timeMs(now, "now");
  switch (action.op) {
    case "create_goal": {
      const key = outcomeKey(action.key);
      assertKeyFree(tree, key);
      const parentGoalKey = action.parentGoalKey;
      if (parentGoalKey !== null) {
        const parents = byKey(tree.goals);
        const seen = new Set<string>();
        let cursor: string | null = parentGoalKey;
        while (cursor !== null) {
          if (cursor === key) fail(`goal cycle: ${key} would be its own ancestor`);
          if (seen.has(cursor)) fail(`goal hierarchy already loops at ${cursor}`);
          seen.add(cursor);
          const parent = parents.get(cursor);
          if (parent === undefined) fail(`unknown parent goal ${cursor}`);
          cursor = parent.parentGoalKey;
        }
      }
      const goal: Goal = {
        key,
        parentGoalKey,
        title: text(action.title, "goal title"),
        brief: text(action.brief, "goal brief"),
        rank: rank(action.rank),
        created: now,
      };
      tree.goals.push(goal);
      record(tree, now, key, `create_goal ${key} "${goal.title}"`, null);
      return;
    }

    case "create_outcome": {
      const key = outcomeKey(action.key);
      assertKeyFree(tree, key);
      const goalKey = outcomeKey(action.goalKey, "goalKey");
      if (!tree.goals.some((goal) => goal.key === goalKey)) fail(`unknown goal ${goalKey}`);
      const contract = normalizeContract(tree, action.contract, key);
      const outcome: Outcome = {
        key,
        goalKey,
        ...contract,
        version: 1,
        created: now,
        updated: now,
      };
      tree.outcomes.push(outcome);
      record(tree, now, key, `create_outcome ${key} v1 "${outcome.title}"`, outcomeSignal(tree, key, LIVE_TRACK, now));
      return;
    }

    case "propose_change": {
      const key = outcomeKey(action.key);
      const outcome = findOutcome(tree, key);
      const baseVersion = action.version;
      if (!Number.isInteger(baseVersion) || baseVersion <= 0) {
        fail(`version must be a positive integer, got ${String(baseVersion)}`);
      }
      if (baseVersion !== outcome.version) {
        fail(`stale proposal: ${key} is at version ${outcome.version}, not ${baseVersion}`);
      }
      const proposed = normalizeContract(tree, action.contract, key);
      const id = nextId(tree, "chg_", (candidate) => tree.changes.some((change) => change.id === candidate));
      const change = { id, key, baseVersion, proposed, state: "pending" as const, created: now };
      tree.changes.push(change);
      record(tree, now, key, `propose_change ${id} on ${key} v${baseVersion}`, null);
      return;
    }

    case "approve_change": {
      const id = text(action.id, "change id");
      const change = tree.changes.find((row) => row.id === id);
      if (change === undefined) fail(`unknown change ${id}`);
      if (change.state !== "pending") fail(`change ${id} is ${change.state}, not pending`);
      const outcome = findOutcome(tree, change.key);
      // Optimistic gate: the proposer edited the version it read. If anything
      // landed since, this proposal would silently overwrite it.
      if (change.baseVersion !== outcome.version) {
        fail(
          `stale change ${id}: based on ${change.key} v${change.baseVersion}, now v${outcome.version}; propose it again`,
        );
      }
      const contract = normalizeContract(tree, change.proposed, change.key);
      const version = outcome.version + 1;
      Object.assign(outcome, contract, { version, updated: now });
      change.state = "approved";
      record(tree, now, outcome.key, `approve_change ${id} on ${outcome.key} v${version}`, outcomeSignal(tree, outcome.key, LIVE_TRACK, now));
      return;
    }

    case "reject_change": {
      const id = text(action.id, "change id");
      const change = tree.changes.find((row) => row.id === id);
      if (change === undefined) fail(`unknown change ${id}`);
      if (change.state !== "pending") fail(`change ${id} is ${change.state}, not pending`);
      change.state = "rejected";
      record(tree, now, change.key, `reject_change ${id} on ${change.key}`, null);
      return;
    }

    case "claim_outcome": {
      const key = outcomeKey(action.key);
      findOutcome(tree, key);
      const threadId = text(action.threadId, "threadId");
      const hours = action.hours ?? 4;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
        fail(`claim hours must be between 0 and 168, got ${String(hours)}`);
      }
      const held = liveClaim(tree, key, nowMs);
      if (held !== null && held.threadId !== threadId) {
        fail(`outcome ${key} is claimed by ${held.threadId} until ${held.expires}`);
      }
      const blockedBy = tree.outcomes
        .find((outcome) => outcome.key === key)!
        .dependsOn.filter((dependency) => !proven(outcomeSignal(tree, dependency, LIVE_TRACK, now)));
      if (blockedBy.length > 0) fail(`outcome ${key} is blocked by ${blockedBy.join(", ")}`);
      const claim: Claim = { key, threadId, expires: iso(nowMs + hours * 3_600_000) };
      tree.claims = tree.claims.filter((row) => row.key !== key).concat(claim);
      record(tree, now, key, `claim_outcome ${key} by ${threadId} until ${claim.expires}`, null);
      return;
    }

    case "release_outcome": {
      const key = outcomeKey(action.key);
      const threadId = text(action.threadId, "threadId");
      const claim = tree.claims.find((row) => row.key === key);
      if (claim === undefined) fail(`outcome ${key} has no claim to release`);
      if (claim.threadId !== threadId) fail(`outcome ${key} is claimed by ${claim.threadId}, not ${threadId}`);
      tree.claims = tree.claims.filter((row) => row.key !== key);
      record(tree, now, key, `release_outcome ${key} by ${threadId}`, null);
      return;
    }

    case "add_evidence": {
      const key = outcomeKey(action.key);
      const outcome = findOutcome(tree, key);
      const version = action.version;
      if (!Number.isInteger(version) || version <= 0) {
        fail(`version must be a positive integer, got ${String(version)}`);
      }
      if (version > outcome.version) {
        fail(`evidence for ${key} v${version} is from the future; the outcome is v${outcome.version}`);
      }
      const track = text(action.track ?? LIVE_TRACK, "track");
      if (!tree.tracks.some((row) => row.name === track)) fail(`unknown track ${track}`);
      const criterionIds = [...(action.criterionIds ?? [])];
      for (const criterionId of criterionIds) {
        if (!outcome.criteria.some((criterion) => criterion.id === criterionId)) {
          fail(`criterion ${criterionId} is not in ${key} v${outcome.version}`);
        }
      }
      if (new Set(criterionIds).size !== criterionIds.length) fail("duplicate criterion ids in evidence");
      const id = action.receiptId ?? nextId(tree, "ev_", (candidate) => tree.evidence.some((row) => row.id === candidate));
      const prior = tree.evidence.find(row => row.id === id);
      if (prior) {
        if (prior.key === key && prior.version === version && prior.track === track && prior.kind === action.kind &&
            prior.source === action.source && prior.text === action.text &&
            JSON.stringify([...prior.criterionIds].sort()) === JSON.stringify([...criterionIds].sort())) return;
        fail("Receipt already exists with different evidence: " + id);
      }
      const evidence: Evidence = {
        id,
        key,
        version,
        criterionIds,
        kind: action.kind,
        track,
        text: text(action.text, "evidence text"),
        source: text(action.source, "evidence source"),
        created: now,
      };
      tree.evidence.push(evidence);
      record(tree, now, key, `add_evidence ${id} ${action.kind} on ${key} v${version}`, outcomeSignal(tree, key, track, now), track);
      return;
    }

    default: {
      const unreachable: never = action;
      fail(`unsupported core action ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A fresh tree with the live track already in place. */
export function newTree(): Tree {
  return emptyTree();
}