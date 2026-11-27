import type { DatabaseSync } from "node:sqlite";
import type { LiveData } from "./view-props.js";
import type { Outcome, Tree } from "./model.js";
import type { Repository } from "./repository.js";
import { lintOutcome } from "./linter.js";
import { redactSecrets, scanProjectClimbs, type ScannedClimb, type ScannedProjectClimbs } from "./repo-ops.js";
import { applyCore, outcomeSignal } from "./tree.js";

export interface TrackedScannedClimb extends ScannedClimb {
  outcomeKey: string | null;
}

export interface EnrichedProjectClimbs extends Omit<ScannedProjectClimbs, "climbs"> {
  autoTrackClimbs: boolean;
  climbs: TrackedScannedClimb[];
}

interface LinkRow {
  project_id: string;
  climb_name: string;
  climb_id: string;
  outcome_key: string;
  directory: string;
  origin: string;
  auto_created: number;
  last_synced_steps: number;
  last_synced_verdict: string | null;
  created: string;
  updated: string;
}

const DEFAULT_GOAL_KEY = "CLIMBS";

function fmtNum(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5)));
}

export function humanizeClimbName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function deriveOutcomeKey(
  climbName: string,
  goalKeys: ReadonlySet<string>,
  takenOutcomeKeys?: ReadonlySet<string>,
  disambiguator?: string,
): string {
  const rawBase =
    climbName
      .toUpperCase()
      .replace(/[^A-Z0-9_-]+/g, "-")
      .replace(/^[^A-Z0-9]+/, "")
      .replace(/-+$/g, "")
      .slice(0, 88) || "CLIMB";
  const candidate = goalKeys.has(rawBase) ? `CLIMB-${rawBase}`.slice(0, 95) : rawBase;
  const isTaken = (key: string) => goalKeys.has(key) || (takenOutcomeKeys?.has(key) ?? false);
  if (!isTaken(candidate)) return candidate;
  if (disambiguator) {
    const suffix = disambiguator
      .toUpperCase()
      .replace(/[^A-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16);
    if (suffix) {
      const withSuffix = `${candidate.slice(0, 95 - suffix.length - 1)}-${suffix}`;
      if (!isTaken(withSuffix)) return withSuffix;
    }
  }
  for (let n = 2; n < 1000; n += 1) {
    const numbered = `${candidate.slice(0, 95 - String(n).length - 1)}-${n}`;
    if (!isTaken(numbered)) return numbered;
  }
  return `${candidate.slice(0, 86)}-${Date.now().toString(36).toUpperCase()}`.slice(0, 95);
}

const AUTO_TASK_VERB_PREFIX =
  /^(?:bug\s*:|issue\s*:|task\s*:|chore\s*:|todo\s*:|(?:add|build|fix|measure|decide|document|migrate|cut\s+over|install|set\s+up|investigate|implement|refactor|create|update|write|remove|delete|wire|rename|bump|upgrade|launch|replace|rewrite|adopt|deprecate)\b)\s*/i;

const AUTO_STRIP_TOKENS =
  /\S*\b[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|py|rs|go|sql|mjs|cjs|rb|java|kt)(?::\d+)?\b|\b[a-z]+_[a-z]+_\w+\s*=\s*(?:true|false|1|0)\b|\b#[0-9a-fA-F]{6}\b|\b\d+(?:\.\d+)?\s*(?:px|ms|rem)\b|\b(?:PR\s*#\d+|issue\s*#\d+|commit\s+[0-9a-f]{7,40}|20\d{2}-\d{2}-\d{2})\b/gi;

function sanitizeAutoPhrase(raw: string): string {
  return redactSecrets(raw)
    .replace(AUTO_STRIP_TOKENS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;,\s]+$/, "");
}

function safeClimbLabel(name: string): string {
  const humanized = sanitizeAutoPhrase(humanizeClimbName(name)) || "tracked metric";
  if (AUTO_TASK_VERB_PREFIX.test(humanized)) {
    return `Tracked climb ${humanized.charAt(0).toLowerCase()}${humanized.slice(1)}`;
  }
  return humanized;
}

export function buildOutcomeContract(climb: ScannedClimb) {
  const targetLabel = climb.targetText ?? (climb.target !== null ? fmtNum(climb.target) : "the climb target");
  const dirLabel = climb.direction === "min" ? "lower is better" : "higher is better";
  const label = safeClimbLabel(climb.name);
  const labelLower = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const cleanedGoal = sanitizeAutoPhrase(climb.goal ?? "");

  const criterion =
    climb.status === "active"
      ? {
          id: "C1",
          given: `A measured baseline of ${fmtNum(climb.baseline)} for ${label}`,
          when: "The locked scoring check and guard suite run",
          then: `The measured score reaches ${targetLabel} (${dirLabel}) with all guards passing`,
        }
      : {
          id: "C1",
          given: `A staged climb check for ${label}`,
          when: "The locked scoring check is initialized and run",
          then: "The measured score reaches the climb target with all guards passing",
        };

  const fallbackTitle = `${label} meets target score`;
  const fallbackStory =
    climb.status === "active"
      ? `As a maintainer, I want ${labelLower} to reach target ${targetLabel} (${dirLabel}), so that measured quality stays verified.`
      : `As a maintainer, I want ${labelLower} to pass its locked scoring check once initialized, so that measured quality stays verified.`;

  const goalCandidateTitle =
    cleanedGoal.length >= 4 && cleanedGoal.length <= 96 && !AUTO_TASK_VERB_PREFIX.test(cleanedGoal)
      ? cleanedGoal
      : fallbackTitle;

  const goalSnippet = cleanedGoal.length >= 4 && cleanedGoal.length <= 160 ? cleanedGoal : "";
  const goalCandidateStory = goalSnippet
    ? `As a maintainer, I want ${goalSnippet.charAt(0).toLowerCase()}${goalSnippet.slice(1)}, so that measured quality stays verified.`
    : fallbackStory;

  const candidate = {
    title: goalCandidateTitle,
    story: goalCandidateStory,
    criteria: [criterion],
    dependsOn: [] as string[],
    rank: 100,
    recheckDays: null as number | null,
  };

  if (
    lintOutcome({
      key: "AUTO-CHECK",
      goalKey: DEFAULT_GOAL_KEY,
      ...candidate,
    }).length === 0
  ) {
    return candidate;
  }

  const fallback = {
    title: fallbackTitle,
    story: fallbackStory,
    criteria: [criterion],
    dependsOn: [] as string[],
    rank: 100,
    recheckDays: null as number | null,
  };

  if (
    lintOutcome({
      key: "AUTO-CHECK",
      goalKey: DEFAULT_GOAL_KEY,
      ...fallback,
    }).length === 0
  ) {
    return fallback;
  }

  const neutralCriterion =
    climb.status === "active"
      ? {
          id: "C1",
          given: `A measured baseline of ${fmtNum(climb.baseline)} for this tracked climb`,
          when: "The locked scoring check and guard suite run",
          then: `The measured score reaches ${targetLabel} (${dirLabel}) with all guards passing`,
        }
      : {
          id: "C1",
          given: "A staged climb check in this repository",
          when: "The locked scoring check is initialized and run",
          then: "The measured score reaches the climb target with all guards passing",
        };

  return {
    title: "Tracked climb metric meets target score",
    story:
      climb.status === "active"
        ? `As a maintainer, I want this tracked climb metric to reach target ${targetLabel} (${dirLabel}), so that measured quality stays verified.`
        : "As a maintainer, I want this tracked climb metric to pass its locked scoring check once initialized, so that measured quality stays verified.",
    criteria: [neutralCriterion],
    dependsOn: [] as string[],
    rank: 100,
    recheckDays: null as number | null,
  };
}

function climbMeetsTargetWithGain(climb: ScannedClimb): boolean {
  if (climb.status !== "active" || climb.verdict !== "bar-reached") return false;
  if (climb.best === null) return false;
  const targetMet =
    climb.target === null
      ? true
      : climb.direction === "min"
        ? climb.best <= climb.target
        : climb.best >= climb.target;
  if (!targetMet) return false;
  const improved =
    climb.baseline !== null &&
    (climb.direction === "min" ? climb.best < climb.baseline : climb.best > climb.baseline);
  return climb.kept > 0 || improved;
}

function lastKeptCommit(climb: ScannedClimb): string | null {
  for (let i = climb.rows.length - 1; i >= 0; i -= 1) {
    const r = climb.rows[i];
    if (r && r.kind === "step" && r.result === "kept" && r.commit) {
      return r.commit;
    }
  }
  return climb.bestCommit ?? null;
}

const AUTO_CLAIM_HOURS = 0.25;
const AUTO_CLAIM_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function autoClaimWorkerId(climb: ScannedClimb): string | null {
  if (climb.isMainCheckout || climb.workerLabel === "main checkout") {
    return climb.conversationId;
  }
  const candidate = climb.conversationId ?? climb.workerLabel ?? climb.worktreeName;
  if (!candidate || candidate === "main checkout") return null;
  return candidate;
}

function canUpgradePreparedContract(
  link: LinkRow,
  climb: ScannedClimb,
  outcome: Outcome,
  tree: Tree,
): boolean {
  return (
    link.auto_created === 1 &&
    climb.status === "active" &&
    outcome.version === 1 &&
    !tree.changes.some((c) => c.key === outcome.key) &&
    outcome.criteria.length === 1 &&
    outcome.criteria[0]?.id === "C1" &&
    (outcome.criteria[0]?.when === "Initialized and iterated with climb.py" ||
      outcome.criteria[0]?.when === "The locked scoring check is initialized and run")
  );
}

function shouldRecordAutoNote(
  tree: Tree,
  outcome: Outcome,
  climb: ScannedClimb,
  link: LinkRow,
): boolean {
  // Always record baseline measurement once
  if (link.last_synced_steps < 0 && climb.baseline !== null) return true;
  // Always record meaningful verdict transitions (e.g. plateau / stuck / bar-reached)
  if (link.last_synced_verdict !== null && climb.verdict !== link.last_synced_verdict) return true;
  if (climb.steps <= Math.max(0, link.last_synced_steps)) return false;
  // Only record step updates when a new best commit/score landed (skip repetitive flat/undone step spam)
  const sourcePrefix = `climb.py:${climb.name}`;
  const commit = lastKeptCommit(climb);
  const nextSource = commit ? `${sourcePrefix}@${commit}` : sourcePrefix;
  const lastAutoNote = [...tree.evidence]
    .reverse()
    .find(
      (e) =>
        e.key === outcome.key &&
        e.track === "main" &&
        e.kind === "note" &&
        e.source.startsWith(sourcePrefix),
    );
  if (!lastAutoNote) return true;
  if (commit && lastAutoNote.source !== nextSource) return true;
  // Also record if best score text changed even when commit wasn't recorded in fixture rows
  const bestToken = `→ ${fmtNum(climb.best)}`;
  if (climb.kept > 0 && !lastAutoNote.text.includes(bestToken)) return true;
  return false;
}

export function climbToLiveData(climb: ScannedClimb): LiveData {
  const rows: LiveData["rows"] = [];
  let incumbentId: string | null = null;
  let stepIdx = 0;

  const baselineRow = climb.rows.find((r) => r.kind === "baseline");
  if (climb.baseline !== null) {
    rows.push({
      id: "baseline",
      parent: null,
      score: climb.baseline,
      label: "baseline",
      at: baselineRow?.time ?? climb.updatedAt ?? new Date().toISOString(),
    });
    incumbentId = "baseline";
  }

  for (const r of climb.rows) {
    if (r.kind !== "step") continue;
    stepIdx += 1;
    const stepNum = r.step ?? stepIdx;
    const id = `step-${stepNum}`;
    rows.push({
      id,
      parent: incumbentId,
      score: r.score,
      label: redactSecrets(r.idea ?? r.why ?? (r.result ? `Step ${stepNum} (${r.result})` : `Step ${stepNum}`)),
      at: r.time ?? climb.updatedAt ?? new Date().toISOString(),
    });
    if (r.result === "kept") {
      incumbentId = id;
    }
  }

  // Extract latest measured numeric holdout score (never expose raw shell command as holdout readout)
  const holdoutScores = climb.rows.filter(
    (r) => r.kind === "holdout" && typeof r.score === "number" && Number.isFinite(r.score),
  );
  const latestHoldout = holdoutScores.length > 0 ? holdoutScores[holdoutScores.length - 1]!.score! : null;

  const nextAction =
    climb.status === "prepared"
      ? `Staging benchmark inputs (${climb.preparedFiles} file${climb.preparedFiles === 1 ? "" : "s"}); awaiting climb.py init.`
      : climb.verdict === "bar-reached"
        ? "Target bar reached."
        : climb.verdict === "plateau"
          ? `No gain in the last ${climb.sinceGain} tries — needs a new approach.`
          : climb.verdict === "stuck"
            ? "Stopped after repeated unsuccessful attempts."
            : "Iterating on candidate edits via climb.py.";

  return {
    engine: "repo",
    baseline: climb.baseline,
    best: climb.best,
    target: climb.target,
    rows,
    holdout: latestHoldout === null ? null : fmtNum(latestHoldout),
    worker: {
      phase: climb.status === "prepared" ? "preparing" : climb.verdict,
      liveness: climb.isLive ? "active" : "idle",
      nextAction,
      retries: 0,
      heartbeatAt: climb.updatedAt,
    },
  };
}

export function createAutoTracker(repo: Repository) {
  const db: DatabaseSync = repo.db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS hc_settings (
      project_id TEXT PRIMARY KEY,
      auto_track_climbs INTEGER NOT NULL DEFAULT 1,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hc_climb_links (
      project_id TEXT NOT NULL,
      climb_name TEXT NOT NULL,
      climb_id TEXT NOT NULL,
      outcome_key TEXT NOT NULL,
      directory TEXT NOT NULL,
      origin TEXT NOT NULL,
      auto_created INTEGER NOT NULL DEFAULT 1,
      last_synced_steps INTEGER NOT NULL DEFAULT -1,
      last_synced_verdict TEXT,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      PRIMARY KEY (project_id, climb_id)
    );
  `);

  // Safe migration from legacy PRIMARY KEY (project_id, climb_name) -> PRIMARY KEY (project_id, climb_id)
  const needsPkMigrationCheck = (): boolean => {
    const linkCols = db.prepare("PRAGMA table_info(hc_climb_links)").all() as Array<{ name: string; pk: number }>;
    const climbIdCol = linkCols.find((c) => c.name === "climb_id");
    const climbNameCol = linkCols.find((c) => c.name === "climb_name");
    return linkCols.length > 0 && ((climbIdCol?.pk ?? 0) === 0 || (climbNameCol?.pk ?? 0) > 0);
  };
  if (needsPkMigrationCheck()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (needsPkMigrationCheck()) {
        db.exec(`
          DROP TABLE IF EXISTS hc_climb_links_v2;
          CREATE TABLE hc_climb_links_v2 (
            project_id TEXT NOT NULL,
            climb_name TEXT NOT NULL,
            climb_id TEXT NOT NULL,
            outcome_key TEXT NOT NULL,
            directory TEXT NOT NULL,
            origin TEXT NOT NULL,
            auto_created INTEGER NOT NULL DEFAULT 1,
            last_synced_steps INTEGER NOT NULL DEFAULT -1,
            last_synced_verdict TEXT,
            created TEXT NOT NULL,
            updated TEXT NOT NULL,
            PRIMARY KEY (project_id, climb_id)
          );
          INSERT OR REPLACE INTO hc_climb_links_v2(
            project_id, climb_name, climb_id, outcome_key, directory, origin,
            auto_created, last_synced_steps, last_synced_verdict, created, updated
          )
          SELECT
            project_id,
            climb_name,
            CASE WHEN climb_id IS NULL OR climb_id = '' THEN directory || '::' || climb_name ELSE climb_id END,
            outcome_key,
            directory,
            origin,
            auto_created,
            last_synced_steps,
            last_synced_verdict,
            created,
            updated
          FROM hc_climb_links
          ORDER BY updated ASC;
          DROP TABLE hc_climb_links;
          ALTER TABLE hc_climb_links_v2 RENAME TO hc_climb_links;
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      throw error;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS hc_climb_links_project_outcome ON hc_climb_links(project_id, outcome_key);
    CREATE INDEX IF NOT EXISTS hc_climb_links_project_name ON hc_climb_links(project_id, climb_name);
  `);

  const getSettingStmt = db.prepare("SELECT auto_track_climbs FROM hc_settings WHERE project_id = ?");
  const setSettingStmt = db.prepare(
    `INSERT INTO hc_settings(project_id, auto_track_climbs, updated) VALUES(?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET auto_track_climbs = excluded.auto_track_climbs, updated = excluded.updated`,
  );
  const getLinkByIdStmt = db.prepare(
    "SELECT * FROM hc_climb_links WHERE project_id = ? AND climb_id = ?",
  );
  const getLinkByOutcomeStmt = db.prepare(
    "SELECT * FROM hc_climb_links WHERE project_id = ? AND outcome_key = ?",
  );
  const listLinksStmt = db.prepare("SELECT * FROM hc_climb_links WHERE project_id = ?");
  const upsertLinkStmt = db.prepare(
    `INSERT INTO hc_climb_links(
       project_id, climb_name, climb_id, outcome_key, directory, origin,
       auto_created, last_synced_steps, last_synced_verdict, created, updated
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, climb_id) DO UPDATE SET
       climb_name = excluded.climb_name,
       outcome_key = excluded.outcome_key,
       directory = excluded.directory,
       origin = excluded.origin,
       last_synced_steps = excluded.last_synced_steps,
       last_synced_verdict = excluded.last_synced_verdict,
       updated = excluded.updated`,
  );

  let activeRunCheckStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
  function hasActiveRunForOutcome(projectId: string, outcomeKey: string): boolean {
    if (!activeRunCheckStmt) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hc_runs' LIMIT 1")
        .get();
      if (!exists) return false;
      activeRunCheckStmt = db.prepare(
        "SELECT 1 FROM hc_runs WHERE project_id = ? AND key = ? AND state IN ('dispatching', 'live') LIMIT 1",
      );
    }
    return activeRunCheckStmt.get(projectId, outcomeKey) !== undefined;
  }

  function isAutoTrackEnabled(projectId: string): boolean {
    const row = getSettingStmt.get(projectId) as { auto_track_climbs: number } | undefined;
    // Enabled by default unless explicitly disabled for this project.
    return row ? row.auto_track_climbs !== 0 : true;
  }

  function setAutoTrackEnabled(projectId: string, enabled: boolean): void {
    setSettingStmt.run(projectId, enabled ? 1 : 0, new Date().toISOString());
  }

  function assessProgressWrite(
    tree: Tree,
    projectId: string,
    climb: ScannedClimb,
    link: LinkRow,
    nowMs: number,
  ): { treeWrite: boolean; linkWrite: boolean } {
    const outcome = tree.outcomes.find((o) => o.key === link.outcome_key);
    if (!outcome) return { treeWrite: false, linkWrite: false };

    const isStaleStep =
      climb.status === "active" &&
      link.last_synced_steps >= 0 &&
      climb.steps < link.last_synced_steps;

    let treeWrite = false;
    let linkWrite =
      !isStaleStep &&
      (link.climb_name !== climb.name ||
        link.directory !== climb.directory ||
        link.origin !== climb.origin);

    const existingClaim = tree.claims.find((c) => c.key === outcome.key);
    if (existingClaim?.threadId === "main checkout") {
      treeWrite = true;
    } else if (!isStaleStep) {
      const workerId = autoClaimWorkerId(climb);
      const canAutoClaim = !climb.isMainCheckout && climb.isLive && workerId !== null && workerId !== "main checkout";
      const expiresMs = existingClaim ? Date.parse(existingClaim.expires) : 0;
      const claimActive = existingClaim ? expiresMs > nowMs : false;
      if (canAutoClaim) {
        const needsClaim =
          !claimActive ||
          (existingClaim?.threadId === workerId && expiresMs - nowMs < AUTO_CLAIM_REFRESH_MARGIN_MS);
        if (needsClaim && !hasActiveRunForOutcome(projectId, outcome.key)) {
          treeWrite = true;
        }
      } else if (existingClaim && workerId !== null && existingClaim.threadId === workerId && !hasActiveRunForOutcome(projectId, outcome.key)) {
        treeWrite = true;
      }
    }

    if (!isStaleStep && canUpgradePreparedContract(link, climb, outcome, tree)) {
      treeWrite = true;
    }

    if (climb.status !== "active") {
      if (link.last_synced_verdict !== climb.verdict) {
        linkWrite = true;
      }
      return { treeWrite, linkWrite };
    }

    const sourcePrefix = `climb.py:${climb.name}`;
    const alreadyConfirmed = tree.evidence.some(
      (e) =>
        e.key === outcome.key &&
        e.version === outcome.version &&
        e.track === "main" &&
        e.kind === "confirms" &&
        e.source.startsWith(sourcePrefix),
    );
    const needsConfirms = climbMeetsTargetWithGain(climb) && !alreadyConfirmed;
    if (needsConfirms) {
      treeWrite = true;
    }

    if (isStaleStep) {
      return { treeWrite, linkWrite };
    }

    const changed = climb.steps !== link.last_synced_steps || climb.verdict !== link.last_synced_verdict;
    if (!changed) return { treeWrite, linkWrite };

    linkWrite = true;
    if (shouldRecordAutoNote(tree, outcome, climb, link)) {
      treeWrite = true;
    }
    return { treeWrite, linkWrite };
  }

  function applySyncProgressInTx(
    tree: Tree,
    projectId: string,
    climb: ScannedClimb,
    link: LinkRow,
    now: string,
    nowMs: number,
    warnings: string[],
  ): void {
    const outcome = tree.outcomes.find((o) => o.key === link.outcome_key);
    if (!outcome) return;

    const isStaleStep =
      climb.status === "active" &&
      link.last_synced_steps >= 0 &&
      climb.steps < link.last_synced_steps;

    if (!isStaleStep && canUpgradePreparedContract(link, climb, outcome, tree)) {
      const upgraded = buildOutcomeContract(climb);
      outcome.title = upgraded.title;
      outcome.story = upgraded.story;
      outcome.criteria = upgraded.criteria;
      outcome.updated = now;
      tree.activity.push({
        at: now,
        key: outcome.key,
        text: `refresh_outcome ${outcome.key} v1 "${outcome.title}"`,
        signal: outcomeSignal(tree, outcome.key, "main", now),
        track: "main",
      });
    }

    const existingClaim = tree.claims.find((c) => c.key === outcome.key);
    if (existingClaim && existingClaim.threadId === "main checkout") {
      applyCore(tree, { op: "release_outcome", key: outcome.key, threadId: "main checkout" }, now);
    }

    if (!isStaleStep) {
      const workerId = autoClaimWorkerId(climb);
      const canAutoClaim = !climb.isMainCheckout && climb.isLive && workerId !== null && workerId !== "main checkout";
      const currentClaim = tree.claims.find((c) => c.key === outcome.key);
      const expiresMs = currentClaim ? Date.parse(currentClaim.expires) : 0;
      const claimActive = currentClaim ? expiresMs > nowMs : false;

      if (canAutoClaim) {
        const needsClaim =
          !claimActive ||
          (currentClaim?.threadId === workerId && expiresMs - nowMs < AUTO_CLAIM_REFRESH_MARGIN_MS);
        if (needsClaim && !hasActiveRunForOutcome(projectId, outcome.key)) {
          try {
            applyCore(
              tree,
              { op: "claim_outcome", key: outcome.key, threadId: workerId, hours: AUTO_CLAIM_HOURS },
              now,
            );
          } catch (error) {
            warnings.push(
              `Auto-claim skipped for ${outcome.key}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else if (
        currentClaim &&
        workerId !== null &&
        currentClaim.threadId === workerId &&
        !hasActiveRunForOutcome(projectId, outcome.key)
      ) {
        try {
          applyCore(tree, { op: "release_outcome", key: outcome.key, threadId: workerId }, now);
        } catch (error) {
          warnings.push(
            `Release claim failed for ${outcome.key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const metaChanged =
      link.climb_name !== climb.name ||
      link.directory !== climb.directory ||
      link.origin !== climb.origin;

    if (climb.status !== "active") {
      if (link.last_synced_verdict !== climb.verdict || metaChanged) {
        upsertLinkStmt.run(
          projectId,
          climb.name,
          climb.id,
          outcome.key,
          climb.directory,
          climb.origin,
          link.auto_created,
          link.last_synced_steps,
          climb.verdict,
          link.created,
          now,
        );
      }
      return;
    }

    const cid = outcome.criteria[0]?.id;
    const criterionIds = cid ? [cid] : [];
    const commit = lastKeptCommit(climb);
    const sourcePrefix = `climb.py:${climb.name}`;
    const source = commit ? `${sourcePrefix}@${commit}` : sourcePrefix;
    const alreadyConfirmed = tree.evidence.some(
      (e) =>
        e.key === outcome.key &&
        e.version === outcome.version &&
        e.track === "main" &&
        e.kind === "confirms" &&
        e.source.startsWith(sourcePrefix),
    );
    const needsConfirms = climbMeetsTargetWithGain(climb) && !alreadyConfirmed;

    if (isStaleStep) {
      if (needsConfirms) {
        const targetText = climb.targetText ?? fmtNum(climb.target);
        applyCore(
          tree,
          {
            op: "add_evidence",
            key: outcome.key,
            version: outcome.version,
            kind: "confirms",
            criterionIds,
            track: "main",
            source,
            text: `climb.py reached target ${targetText}: ${fmtNum(climb.baseline)} → ${fmtNum(climb.best)} across ${climb.kept}/${climb.steps} kept edit${climb.steps === 1 ? "" : "s"}.`,
          },
          now,
        );
      }
      return;
    }

    const changed = climb.steps !== link.last_synced_steps || climb.verdict !== link.last_synced_verdict;
    if (!changed && !needsConfirms) {
      if (metaChanged) {
        upsertLinkStmt.run(
          projectId,
          climb.name,
          climb.id,
          outcome.key,
          climb.directory,
          climb.origin,
          link.auto_created,
          link.last_synced_steps,
          link.last_synced_verdict,
          link.created,
          now,
        );
      }
      return;
    }

    if (needsConfirms) {
      const targetText = climb.targetText ?? fmtNum(climb.target);
      applyCore(
        tree,
        {
          op: "add_evidence",
          key: outcome.key,
          version: outcome.version,
          kind: "confirms",
          criterionIds,
          track: "main",
          source,
          text: `climb.py reached target ${targetText}: ${fmtNum(climb.baseline)} → ${fmtNum(climb.best)} across ${climb.kept}/${climb.steps} kept edit${climb.steps === 1 ? "" : "s"}.`,
        },
        now,
      );
    } else if (shouldRecordAutoNote(tree, outcome, climb, link)) {
      const targetPart = climb.target !== null ? ` (target ${climb.targetText ?? fmtNum(climb.target)})` : "";
      const text =
        climb.steps === 0
          ? `climb.py baseline measured: ${fmtNum(climb.baseline)}${targetPart}.`
          : `climb.py update (${climb.verdict}): ${fmtNum(climb.baseline)} → ${fmtNum(climb.best)}${targetPart} after ${climb.steps} step${climb.steps === 1 ? "" : "s"} (${climb.kept} kept).`;
      applyCore(
        tree,
        {
          op: "add_evidence",
          key: outcome.key,
          version: outcome.version,
          kind: "note",
          criterionIds,
          track: "main",
          source,
          text,
        },
        now,
      );
    }

    if (changed || metaChanged) {
      const nextSteps = Math.max(link.last_synced_steps, climb.steps);
      upsertLinkStmt.run(
        projectId,
        climb.name,
        climb.id,
        outcome.key,
        climb.directory,
        climb.origin,
        link.auto_created,
        nextSteps,
        climb.verdict,
        link.created,
        now,
      );
    }
  }

  function applyTrackClimbInTx(
    tree: Tree,
    projectId: string,
    climb: ScannedClimb,
    autoCreated: boolean,
    linkedOutcomeToClimbId: Map<string, string>,
    now: string,
    nowMs: number,
    warnings: string[],
  ): string {
    const existingLink = getLinkByIdStmt.get(projectId, climb.id) as LinkRow | undefined;
    if (existingLink && tree.outcomes.some((o) => o.key === existingLink.outcome_key)) {
      applySyncProgressInTx(tree, projectId, climb, existingLink, now, nowMs, warnings);
      return existingLink.outcome_key;
    }

    const goalKeys = new Set(tree.goals.map((g) => g.key));
    const takenOutcomeKeys = new Set<string>();
    for (const [oKey, cId] of linkedOutcomeToClimbId) {
      if (cId !== climb.id) takenOutcomeKeys.add(oKey);
    }
    const outcomeKey = deriveOutcomeKey(climb.name, goalKeys, takenOutcomeKeys, climb.workerLabel);
    const existingOutcome = tree.outcomes.find((o) => o.key === outcomeKey);

    if (!existingOutcome) {
      if (!goalKeys.has(DEFAULT_GOAL_KEY)) {
        applyCore(
          tree,
          {
            op: "create_goal",
            key: DEFAULT_GOAL_KEY,
            parentGoalKey: null,
            title: "Tracked climbs",
            brief: "Outcomes automatically tracked from .hill-climb runs in this repository and its Antigravity worktrees.",
            rank: 50,
          },
          now,
        );
      }
      applyCore(
        tree,
        {
          op: "create_outcome",
          key: outcomeKey,
          goalKey: DEFAULT_GOAL_KEY,
          contract: buildOutcomeContract(climb),
        },
        now,
      );
    }

    const link: LinkRow = {
      project_id: projectId,
      climb_name: climb.name,
      climb_id: climb.id,
      outcome_key: outcomeKey,
      directory: climb.directory,
      origin: climb.origin,
      auto_created: existingOutcome ? 0 : autoCreated ? 1 : 0,
      last_synced_steps: -1,
      last_synced_verdict: null,
      created: now,
      updated: now,
    };

    upsertLinkStmt.run(
      link.project_id,
      link.climb_name,
      link.climb_id,
      link.outcome_key,
      link.directory,
      link.origin,
      link.auto_created,
      link.last_synced_steps,
      link.last_synced_verdict,
      link.created,
      link.updated,
    );
    linkedOutcomeToClimbId.set(outcomeKey, climb.id);

    applySyncProgressInTx(tree, projectId, climb, link, now, nowMs, warnings);
    return outcomeKey;
  }

  function trackClimb(
    projectId: string,
    climb: ScannedClimb,
    opts?: { autoCreated?: boolean },
  ): string {
    const autoCreated = opts?.autoCreated ?? false;
    const warnings: string[] = [];
    return repo.modify(projectId, (tree) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const linkedOutcomeToClimbId = new Map<string, string>();
      for (const row of listLinksStmt.all(projectId) as unknown as LinkRow[]) {
        linkedOutcomeToClimbId.set(row.outcome_key, row.climb_id);
      }
      return applyTrackClimbInTx(tree, projectId, climb, autoCreated, linkedOutcomeToClimbId, now, nowMs, warnings);
    });
  }

  function syncScannedClimbs(projectId: string, scanned: ScannedProjectClimbs): EnrichedProjectClimbs {
    const autoTrackClimbs = isAutoTrackEnabled(projectId);
    const warnings = [...(scanned.warnings ?? [])];
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const preLinks = new Map<string, LinkRow>();
    for (const row of listLinksStmt.all(projectId) as unknown as LinkRow[]) {
      preLinks.set(row.climb_id, row);
    }
    const preTree = repo.read(projectId);
    const preOutcomeKeys = new Set(preTree.outcomes.map((o) => o.key));
    const preLinkedById = new Map<string, string>();

    const hasPhantomMainClaim = preTree.claims.some((c) => c.threadId === "main checkout");
    let needsTreeWrite = hasPhantomMainClaim;
    const linkOnlyUpdates: Array<{ climb: ScannedClimb; link: LinkRow }> = [];

    for (const climb of scanned.climbs) {
      const existing = preLinks.get(climb.id);
      const alreadyTracked = existing !== undefined && preOutcomeKeys.has(existing.outcome_key);
      if (alreadyTracked) {
        preLinkedById.set(climb.id, existing.outcome_key);
        const assessed = assessProgressWrite(preTree, projectId, climb, existing, nowMs);
        if (assessed.treeWrite) needsTreeWrite = true;
        if (assessed.linkWrite) linkOnlyUpdates.push({ climb, link: existing });
      } else if (autoTrackClimbs && climb.origin !== "archived") {
        needsTreeWrite = true;
      }
    }

    // Fast path: 0 writes when nothing changed.
    if (!needsTreeWrite && linkOnlyUpdates.length === 0) {
      return {
        ...scanned,
        warnings,
        autoTrackClimbs,
        climbs: scanned.climbs.map((climb) => ({
          ...climb,
          outcomeKey: preLinkedById.get(climb.id) ?? null,
        })),
      };
    }

    // Link-only metadata updates (no tree mutation needed).
    if (!needsTreeWrite) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { climb, link } of linkOnlyUpdates) {
          const current = (getLinkByIdStmt.get(projectId, climb.id) as LinkRow | undefined) ?? link;
          if (
            climb.status === "active" &&
            current.last_synced_steps >= 0 &&
            climb.steps < current.last_synced_steps
          ) {
            continue;
          }
          const nextSteps =
            climb.status === "active"
              ? Math.max(current.last_synced_steps, climb.steps)
              : current.last_synced_steps;
          upsertLinkStmt.run(
            projectId,
            climb.name,
            climb.id,
            current.outcome_key,
            climb.directory,
            climb.origin,
            current.auto_created,
            nextSteps,
            climb.verdict,
            current.created,
            now,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
        warnings.push(
          `Failed to update climb link metadata: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        ...scanned,
        warnings,
        autoTrackClimbs,
        climbs: scanned.climbs.map((climb) => ({
          ...climb,
          outcomeKey: preLinkedById.get(climb.id) ?? null,
        })),
      };
    }

    // Single atomic repo.modify() transaction with in-tx idempotency checks.
    const linkedById = repo.modify(projectId, (tree) => {
      const txLinks = new Map<string, LinkRow>();
      const txLinkedOutcomeToClimbId = new Map<string, string>();
      for (const row of listLinksStmt.all(projectId) as unknown as LinkRow[]) {
        txLinks.set(row.climb_id, row);
        txLinkedOutcomeToClimbId.set(row.outcome_key, row.climb_id);
      }
      const outcomeKeys = new Set(tree.outcomes.map((o) => o.key));
      const resultMap = new Map<string, string>();

      for (const claim of [...tree.claims]) {
        if (claim.threadId === "main checkout") {
          try {
            applyCore(tree, { op: "release_outcome", key: claim.key, threadId: "main checkout" }, now);
          } catch (error) {
            warnings.push(
              `Failed to release phantom claim on ${claim.key}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      for (const climb of scanned.climbs) {
        const existing = txLinks.get(climb.id);
        const alreadyTracked = existing !== undefined && outcomeKeys.has(existing.outcome_key);

        if (alreadyTracked) {
          try {
            applySyncProgressInTx(tree, projectId, climb, existing, now, nowMs, warnings);
            resultMap.set(climb.id, existing.outcome_key);
          } catch (error) {
            resultMap.set(climb.id, existing.outcome_key);
            warnings.push(
              `Failed to sync climb ${climb.name} (${climb.id}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else if (autoTrackClimbs && climb.origin !== "archived") {
          // Automatically track current Antigravity & local checkout climbs into Outcomes.
          // External/archived worktree runs remain opt-in via "Track as Outcome".
          try {
            const key = applyTrackClimbInTx(
              tree,
              projectId,
              climb,
              true,
              txLinkedOutcomeToClimbId,
              now,
              nowMs,
              warnings,
            );
            resultMap.set(climb.id, key);
            outcomeKeys.add(key);
          } catch (error) {
            warnings.push(
              `Failed to auto-track climb ${climb.name} (${climb.id}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      return resultMap;
    });

    return {
      ...scanned,
      warnings,
      autoTrackClimbs,
      climbs: scanned.climbs.map((climb) => ({
        ...climb,
        outcomeKey: linkedById.get(climb.id) ?? null,
      })),
    };
  }

  function liveForOutcome(
    projectId: string,
    outcomeKey: string,
    projectDirectory: string | null,
  ): LiveData | null {
    const link = getLinkByOutcomeStmt.get(projectId, outcomeKey) as LinkRow | undefined;
    if (!link) return null;
    const scanned = scanProjectClimbs(projectDirectory ?? link.directory);
    const match =
      scanned.climbs.find((c) => c.id === link.climb_id) ??
      scanned.climbs.find((c) => c.name === link.climb_name);
    if (!match) return null;
    return climbToLiveData(match);
  }

  function linkedClimbForOutcome(
    projectId: string,
    outcomeKey: string,
  ): { climbName: string; directory: string } | null {
    const link = getLinkByOutcomeStmt.get(projectId, outcomeKey) as LinkRow | undefined;
    if (!link) return null;
    return { climbName: link.climb_name, directory: link.directory };
  }

  return {
    isAutoTrackEnabled,
    setAutoTrackEnabled,
    trackClimb,
    syncScannedClimbs,
    liveForOutcome,
    linkedClimbForOutcome,
  };
}

export type AutoTracker = ReturnType<typeof createAutoTracker>;
