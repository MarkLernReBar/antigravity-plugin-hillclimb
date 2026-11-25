import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  buildEvidence,
  parseReport,
  parseTestTag,
  readContract,
  toActions,
  type AddEvidenceAction,
  type ReportFormat,
  type TestResult,
} from "../assets/ci/hillclimb-evidence.mjs";
import { HillClimbError } from "./errors.js";
import type { Evidence, Snapshot, Tree } from "./model.js";
import type { Repository } from "./repository.js";

export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
export const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.:-]{0,199}$/;
const TAG_PREFIXES_ENV = "HILLCLIMB_KEY_PREFIXES";
const MAX_EVIDENCE_TEXT = 800;

export interface Refusal {
  key?: string;
  test?: string;
  reason: string;
}

export type EvidenceAction = AddEvidenceAction;

export interface ActionPlan {
  actions: EvidenceAction[];
  existing: EvidenceAction[];
  stale: Refusal[];
  invalid: Refusal[];
}

interface EvidenceShape {
  key: string;
  version: number;
  kind: string;
  track: string;
  source: string;
  text: string;
  criterionIds: string[];
}

function asRefusal(entry: { key?: string; test?: string; reason: string }): Refusal {
  return { key: entry.key, test: entry.test, reason: entry.reason };
}

function bound(text: string, max = MAX_EVIDENCE_TEXT) {
  const chars = text.length;
  return chars <= max
    ? { text, chars, truncated: false }
    : { text: text.slice(0, max), chars, truncated: true };
}

function inboxOf(snapshot: Snapshot) {
  return {
    count: snapshot.inbox,
    pendingChanges: snapshot.changes.filter((change) => change.state === "pending").length,
    openQuestions: snapshot.comments.filter((comment) => comment.answer === null).length,
  };
}

function evidenceSignature(row: EvidenceShape): string {
  return [
    row.key,
    row.version,
    row.kind,
    row.track,
    row.source,
    row.text,
    [...row.criterionIds].sort().join(","),
  ].join("|");
}

function judgeAction(
  action: EvidenceAction,
  tree: Tree,
): { ok: true } | { stale: Refusal } | { invalid: Refusal } {
  const outcome = tree.outcomes.find((row) => row.key === action.key);
  if (outcome === undefined) {
    return { invalid: { key: action.key, reason: "names no outcome in this tree" } };
  }
  if (action.version !== outcome.version) {
    const direction = action.version < outcome.version ? "older" : "newer";
    return {
      stale: {
        key: action.key,
        reason:
          direction === "older"
            ? `proves ${action.key} v${action.version}; the contract is now v${outcome.version}. Old proof is never recorded against a newer contract: re-run against the current contract, or drop the @version when the test should track whatever is current.`
            : `names ${action.key} v${action.version} but the tree is at v${outcome.version}: this checkout is stale. Run hillclimb_sync and re-run.`,
      },
    };
  }
  const known = outcome.criteria.map((criterion) => criterion.id);
  const unknown = action.criterionIds.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    return {
      invalid: {
        key: action.key,
        reason: `criterion ${unknown.join(", ")} is not in ${action.key} v${outcome.version} (has ${known.join(", ") || "none"})`,
      },
    };
  }
  if (action.kind !== "note" && action.criterionIds.length === 0) {
    return {
      invalid: {
        key: action.key,
        reason: `a ${action.kind} with an empty criterion scope means "the whole contract" in the tree; a test run proves named criteria, so this must be a note`,
      },
    };
  }
  if (!tree.tracks.some((track) => track.name === action.track)) {
    return { invalid: { key: action.key, reason: `unknown track ${action.track}` } };
  }
  if (action.text.trim() === "") return { invalid: { key: action.key, reason: "evidence text is empty" } };
  if (action.source.trim() === "") return { invalid: { key: action.key, reason: "evidence source is empty" } };
  return { ok: true };
}

export function planActions(tree: Tree, actions: readonly EvidenceAction[]): ActionPlan {
  const plan: ActionPlan = { actions: [], existing: [], stale: [], invalid: [] };
  const byReceipt = new Map<string, string>();
  const seenContent = new Set<string>();
  for (const row of tree.evidence) {
    byReceipt.set(row.id, evidenceSignature(row));
    seenContent.add(evidenceSignature(row));
  }
  for (const action of actions) {
    const judged = judgeAction(action, tree);
    if ("stale" in judged) {
      plan.stale.push({ ...judged.stale, test: action.key });
      continue;
    }
    if ("invalid" in judged) {
      plan.invalid.push({ ...judged.invalid, test: action.key });
      continue;
    }
    const signature = evidenceSignature(action);
    const taken = byReceipt.get(action.receiptId);
    if (taken !== undefined) {
      if (taken === signature) {
        plan.existing.push(action);
        continue;
      }
      plan.invalid.push({
        key: action.key,
        test: action.receiptId,
        reason: `receipt ${action.receiptId} is already recorded with different evidence; a receipt id names one piece of proof, so this is a collision, not a retry`,
      });
      continue;
    }
    if (seenContent.has(signature)) {
      plan.existing.push(action);
      continue;
    }
    byReceipt.set(action.receiptId, signature);
    seenContent.add(signature);
    plan.actions.push(action);
  }
  return plan;
}

export function assertTrackAgreement(
  chosen: string,
  declared: string | null,
  actions: readonly { track: string; key: string; receiptId?: string }[],
): void {
  const problems: string[] = [];
  if (declared !== null && declared !== chosen) {
    problems.push(`the bundle declares track ${declared}`);
  }
  for (const action of actions) {
    if (action.track !== chosen) {
      problems.push(`receipt ${action.receiptId ?? action.key} is on track ${action.track}`);
    }
  }
  if (problems.length === 0) return;
  throw new HillClimbError(
    `track mismatch: selected ${chosen}, but ${problems.join("; ")}. Nothing was written.`,
    {
      code: "track_mismatch",
      hint: `Post this bundle to its own track: --track ${declared ?? actions[0]?.track ?? chosen}.`,
    },
  );
}

export interface CiBundle {
  version: 1;
  source: string;
  track: string;
  created?: string;
  contractVersion?: number | null;
  contractVersions?: number[];
  contractFrozenAt?: string | null;
  evidence: Evidence[];
  skipped?: unknown[];
  invalid?: unknown[];
  stale?: unknown[];
}

export function readBundle(text: string): CiBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new HillClimbError(`the evidence bundle is not JSON: ${(error as Error).message}`, {
      code: "bad_bundle",
    });
  }
  const raw = data as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || raw.version !== 1) {
    throw new HillClimbError("the evidence bundle must be schema version 1", {
      code: "bad_bundle",
      hint: "Produce it with: node assets/ci/hillclimb-evidence.mjs … --out ci-evidence.json",
    });
  }
  if (!Array.isArray(raw.evidence)) {
    throw new HillClimbError("the evidence bundle has no evidence array", { code: "bad_bundle" });
  }
  const source = raw.source;
  if (typeof source !== "string" || source.trim() === "") {
    throw new HillClimbError("the evidence bundle names no source run", { code: "bad_bundle" });
  }
  const bundleTrack = raw.track;
  if (typeof bundleTrack !== "string" || !KEY_PATTERN.test(bundleTrack)) {
    throw new HillClimbError(
      `the evidence bundle names no usable track (got ${JSON.stringify(bundleTrack)})`,
      { code: "bad_bundle" },
    );
  }

  const entries = raw.evidence as unknown[];
  const evidence: Evidence[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    evidence.push(readBundleRecord(entries[index], index));
  }

  return {
    version: 1,
    source,
    track: bundleTrack,
    created: typeof raw.created === "string" ? raw.created : undefined,
    contractVersion:
      typeof raw.contractVersion === "number" || raw.contractVersion === null
        ? (raw.contractVersion as number | null)
        : undefined,
    contractVersions: Array.isArray(raw.contractVersions)
      ? raw.contractVersions.filter((value): value is number => typeof value === "number")
      : undefined,
    contractFrozenAt: typeof raw.contractFrozenAt === "string" ? raw.contractFrozenAt : null,
    evidence,
    skipped: Array.isArray(raw.skipped) ? raw.skipped : [],
    invalid: Array.isArray(raw.invalid) ? raw.invalid : [],
    stale: Array.isArray(raw.stale) ? raw.stale : [],
  };
}

function readBundleRecord(value: unknown, index: number): Evidence {
  const at = `evidence[${index}]`;
  const bad = (field: string, detail: string): never => {
    throw new HillClimbError(`${at}.${field}: ${detail}`, {
      code: "bad_bundle",
      hint: "Regenerate the bundle with the shipped hook; do not hand-edit evidence.",
    });
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad("record", "is not an object");
  const record = value as Record<string, unknown>;

  const id = record.id;
  if (typeof id !== "string" || !RECEIPT_ID_PATTERN.test(id)) {
    bad("id", `must be a receipt id like "ev_ci_1a2b3c4d5e6f7a8b" (got ${JSON.stringify(id)})`);
  }
  const key = record.key;
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    bad("key", `must be an outcome key (got ${JSON.stringify(key)})`);
  }
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    bad("version", `must be a positive integer (got ${JSON.stringify(version)})`);
  }
  const kind = record.kind;
  if (kind !== "confirms" && kind !== "denies" && kind !== "note") {
    bad("kind", `must be confirms, denies or note (got ${JSON.stringify(kind)})`);
  }
  const rawCriteria = record.criterionIds;
  if (
    !Array.isArray(rawCriteria) ||
    (rawCriteria as unknown[]).some((entry) => typeof entry !== "string" || !KEY_PATTERN.test(entry))
  ) {
    bad("criterionIds", `must be an array of criterion ids (got ${JSON.stringify(rawCriteria)})`);
  }
  const criterionIds = rawCriteria as string[];
  if (kind !== "note" && criterionIds.length === 0) {
    bad(
      "criterionIds",
      `a ${kind} must name the criteria it proves; an empty scope means "the whole contract" in the tree, and no test run may claim that`,
    );
  }
  const track = record.track;
  if (typeof track !== "string" || !KEY_PATTERN.test(track)) {
    bad("track", `must be a track name (got ${JSON.stringify(track)})`);
  }
  const text = record.text;
  if (typeof text !== "string" || text.trim() === "") bad("text", "must be the observation, in words");
  const recordSource = record.source;
  if (typeof recordSource !== "string" || recordSource.trim() === "") {
    bad("source", "must name the command and run the observation came from");
  }
  const created = record.created;
  if (typeof created !== "string" || created.trim() === "") {
    bad("created", "must be the time the evidence was produced");
  }
  return {
    id: id as string,
    key: key as string,
    version: version as number,
    criterionIds,
    kind: kind as Evidence["kind"],
    track: track as string,
    text: text as string,
    source: recordSource as string,
    created: created as string,
  };
}

export function frozenBreaches(tree: Tree, frozenAt: string, keys?: readonly string[]): Refusal[] {
  const frozenMs = Date.parse(frozenAt);
  if (Number.isNaN(frozenMs)) {
    throw new HillClimbError(
      `--contract-frozen-at needs a date like 2026-11-24T09:00:00Z, got ${JSON.stringify(frozenAt)}`,
      { code: "bad_freeze_time" },
    );
  }
  if (frozenMs > Date.now()) {
    throw new HillClimbError(
      "--contract-frozen-at is in the future; a contract frozen later than the tests proves nothing",
      { code: "bad_freeze_time" },
    );
  }
  const breaches: Refusal[] = [];
  const scope = keys === undefined ? null : new Set(keys);
  for (const outcome of tree.outcomes) {
    if (scope !== null && !scope.has(outcome.key)) continue;
    const updated = Date.parse(outcome.updated);
    if (Number.isNaN(updated) || updated > frozenMs + 1000) {
      breaches.push({
        key: outcome.key,
        reason: `${outcome.key} was updated at ${outcome.updated}, after the freeze (${frozenAt}); a run that started before that edit cannot prove the contract that is live now`,
      });
    }
  }
  return breaches;
}

function readReportText(file: string, directory?: string): string {
  const full = isAbsolute(file) ? file : resolve(directory ?? process.cwd(), file);
  try {
    return readFileSync(full, "utf8");
  } catch (error) {
    throw new HillClimbError(`cannot read ${full}: ${(error as Error).message}`, {
      code: "report_unreadable",
    });
  }
}

function finishIngest(
  repo: Repository,
  project: string,
  plan: ActionPlan,
  options: {
    apply: boolean;
    label: string;
    source: string;
    track: string;
    limit: number;
    skipped: Refusal[];
    contractFrozenAt: string | null;
  },
) {
  const fatal = plan.stale.length > 0 || plan.invalid.length > 0;
  let applied = 0;
  let atomic: boolean | null = null;
  if (options.apply && !fatal && plan.actions.length > 0) {
    repo.applyEvidenceBatch(project, plan.actions);
    applied = plan.actions.length;
    atomic = true;
  }
  const snapshot = repo.view(project, options.track);
  return {
    exitCode: fatal ? 2 : 0,
    payload: {
      ok: !fatal,
      label: options.label,
      source: options.source,
      track: options.track,
      contractFrozenAt: options.contractFrozenAt,
      dryRun: !options.apply,
      wouldWrite: plan.actions.length,
      applied,
      atomic,
      alreadyRecorded: plan.existing.length,
      records: {
        total: plan.actions.length,
        returned: Math.min(plan.actions.length, options.limit),
        items: plan.actions.slice(0, options.limit).map((action) => ({
          key: action.key,
          version: action.version,
          kind: action.kind,
          criterionIds: action.criterionIds,
          receiptId: action.receiptId,
          text: bound(action.text, MAX_EVIDENCE_TEXT),
        })),
      },
      stale: plan.stale.slice(0, options.limit),
      invalid: plan.invalid.slice(0, options.limit),
      skipped: options.skipped.slice(0, options.limit),
      counts: {
        stale: plan.stale.length,
        invalid: plan.invalid.length,
        skipped: options.skipped.length,
      },
      inbox: inboxOf(snapshot),
      next: fatal
        ? "Nothing was written: fix the tags or the version pin and re-run."
        : options.apply
          ? "Evidence is in the ledger; read hillclimb_next_outcomes for what moved."
          : "Nothing was written. Re-run with apply=true (--apply) to record it.",
    },
  };
}

export function ingestJunitReport(
  repo: Repository,
  options: {
    project: string;
    report: string;
    directory?: string;
    format?: ReportFormat;
    source?: string;
    track?: string;
    prefixes?: string;
    contractFrozenAt?: string;
    limit?: number;
    apply?: boolean;
  },
) {
  const trackName = options.track ?? "main";
  const source = options.source ?? `local:${new Date().toISOString()}`;
  const prefixes = options.prefixes ?? process.env[TAG_PREFIXES_ENV] ?? "HC";
  const frozenAt = options.contractFrozenAt ?? null;
  const limit = options.limit ?? 20;
  const tree = repo.read(options.project);

  const text = readReportText(options.report, options.directory);
  let results: TestResult[];
  try {
    results = parseReport(text, (options.format ?? "auto") as ReportFormat, { prefixes });
  } catch (error) {
    throw new HillClimbError(`cannot parse ${options.report}: ${(error as Error).message}`, {
      code: "report_unparseable",
      hint: "Pass format junit, json or text to say what the file is.",
    });
  }
  if (results.filter((result) => parseTestTag(result.name, { prefixes }) !== null).length === 0) {
    throw new HillClimbError(`no test in ${options.report} names an outcome key`, {
      code: "no_tagged_tests",
      hint: `Tag a test title with ${prefixes.split(",")[0] ?? "HC"}-<key>, optionally @<version> and #<criterionIds>.`,
    });
  }
  if (frozenAt !== null) {
    const tagged = results
      .map((result) => parseTestTag(result.name, { prefixes }))
      .flatMap((tag) => (tag !== null && !("error" in tag) ? [tag.key] : []));
    const breaches = frozenBreaches(tree, frozenAt, tagged);
    if (breaches.length > 0) {
      return finishIngest(
        repo,
        options.project,
        { actions: [], existing: [], stale: breaches, invalid: [] },
        {
          apply: options.apply === true,
          label: "ingest-junit",
          source,
          track: trackName,
          limit,
          skipped: [],
          contractFrozenAt: frozenAt,
        },
      );
    }
  }

  const built = buildEvidence({
    results,
    contract: readContract(tree),
    source,
    track: trackName,
    prefixes,
    now: new Date().toISOString(),
    contractFrozenAt: frozenAt,
  });
  const allActions = toActions(built.evidence);
  assertTrackAgreement(trackName, null, allActions);
  const judged = planActions(tree, allActions);
  const plan: ActionPlan = {
    actions: judged.actions,
    existing: judged.existing,
    stale: [...built.stale.map(asRefusal), ...judged.stale],
    invalid: [...built.invalid.map(asRefusal), ...judged.invalid],
  };
  return finishIngest(repo, options.project, plan, {
    apply: options.apply === true,
    label: "ingest-junit",
    source,
    track: trackName,
    limit,
    skipped: built.skipped.map(asRefusal),
    contractFrozenAt: frozenAt,
  });
}

export function postTestEvidenceBundle(
  repo: Repository,
  options: {
    project: string;
    bundle: string;
    directory?: string;
    track?: string;
    limit?: number;
    apply?: boolean;
  },
) {
  const limit = options.limit ?? 20;
  const text = readReportText(options.bundle, options.directory);
  const bundle = readBundle(text);
  const trackName = options.track ?? bundle.track;
  const allActions = toActions(bundle.evidence);
  assertTrackAgreement(trackName, bundle.track, allActions);
  const tree = repo.read(options.project);
  const plan = planActions(tree, allActions);
  const skipped: Refusal[] = (Array.isArray(bundle.skipped) ? bundle.skipped : []).map((entry) => ({
    reason: "the CI hook skipped this",
    test: typeof entry === "string" ? entry : JSON.stringify(entry),
  }));
  const bundleStale = Array.isArray(bundle.stale) ? bundle.stale.length : 0;
  const bundleInvalid = Array.isArray(bundle.invalid) ? bundle.invalid.length : 0;
  const bundleRefused = bundleStale > 0 || bundleInvalid > 0;
  const result = finishIngest(repo, options.project, plan, {
    apply: options.apply === true && !bundleRefused,
    label: "post-test-evidence",
    source: bundle.source,
    track: trackName,
    limit,
    skipped,
    contractFrozenAt: typeof bundle.contractFrozenAt === "string" ? bundle.contractFrozenAt : null,
  });
  if (!bundleRefused) return result;
  return {
    exitCode: 2,
    payload: {
      ...result.payload,
      ok: false,
      applied: 0,
      wouldWrite: 0,
      bundleRefusals: { stale: bundleStale, invalid: bundleInvalid },
      next: "The CI hook refused this run: its tags disagree with the contract it built against. Re-run the hook and apply the new bundle.",
    },
  };
}
