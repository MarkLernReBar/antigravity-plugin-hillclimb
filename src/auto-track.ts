import type { DatabaseSync } from "node:sqlite";
import type { LiveData } from "./view-props.js";
import type { Repository } from "./repository.js";
import { redactSecrets, scanProjectClimbs, type ScannedClimb, type ScannedProjectClimbs } from "./repo-ops.js";

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
): string {
  const base =
    climbName
      .toUpperCase()
      .replace(/[^A-Z0-9_-]+/g, "-")
      .replace(/^[^A-Z0-9]+/, "")
      .replace(/-+$/g, "")
      .slice(0, 88) || "CLIMB";
  if (!goalKeys.has(base)) return base;
  return `CLIMB-${base}`.slice(0, 95);
}

function buildOutcomeContract(climb: ScannedClimb) {
  const rawGoal = climb.goal?.trim() ?? "";
  const title =
    rawGoal.length >= 4 && rawGoal.length <= 96
      ? rawGoal
      : humanizeClimbName(climb.name);

  const workerNote =
    climb.origin === "antigravity"
      ? `Antigravity worker ${climb.workerLabel}`
      : climb.origin === "archived"
        ? `archived worktree ${climb.workerLabel}`
        : `local checkout`;

  const story =
    rawGoal.length > 0
      ? `${rawGoal} (tracked from .hill-climb/${climb.name} in ${workerNote}).`
      : climb.status === "prepared"
        ? `Preparing benchmark inputs (${climb.preparedFiles} staged file${climb.preparedFiles === 1 ? "" : "s"}) before running climb.py in ${workerNote}.`
        : `Tracked from .hill-climb/${climb.name} in ${workerNote}.`;

  const checkCmd = redactSecrets(climb.check.join(" ; ").trim());
  const targetLabel = climb.targetText ?? (climb.target !== null ? fmtNum(climb.target) : "the climb target");
  const dirLabel = climb.direction === "min" ? "lower is better" : "higher is better";

  const criterion =
    climb.status === "active"
      ? {
          id: "C1",
          given: `Baseline score ${fmtNum(climb.baseline)} measured in .hill-climb/${climb.name}`,
          when: checkCmd ? `Running scoring check (${checkCmd})` : `Running climb.py verifier for ${climb.name}`,
          then: `Score reaches ${targetLabel} (${dirLabel}) with all regression guards passing`,
        }
      : {
          id: "C1",
          given: `Climb ${climb.name} staged in ${workerNote}`,
          when: `Initialized and iterated with climb.py`,
          then: `Score reaches the climb target with all regression guards passing`,
        };

  return {
    title,
    story,
    criteria: [criterion],
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
  return null;
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
      label: r.idea ?? r.why ?? (r.result ? `Step ${stepNum} (${r.result})` : `Step ${stepNum}`),
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
      PRIMARY KEY (project_id, climb_name)
    );
  `);

  const getSettingStmt = db.prepare("SELECT auto_track_climbs FROM hc_settings WHERE project_id = ?");
  const setSettingStmt = db.prepare(
    `INSERT INTO hc_settings(project_id, auto_track_climbs, updated) VALUES(?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET auto_track_climbs = excluded.auto_track_climbs, updated = excluded.updated`,
  );
  const getLinkByNameStmt = db.prepare(
    "SELECT * FROM hc_climb_links WHERE project_id = ? AND climb_name = ?",
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
     ON CONFLICT(project_id, climb_name) DO UPDATE SET
       climb_id = excluded.climb_id,
       outcome_key = excluded.outcome_key,
       directory = excluded.directory,
       origin = excluded.origin,
       last_synced_steps = excluded.last_synced_steps,
       last_synced_verdict = excluded.last_synced_verdict,
       updated = excluded.updated`,
  );

  function isAutoTrackEnabled(projectId: string): boolean {
    const row = getSettingStmt.get(projectId) as { auto_track_climbs: number } | undefined;
    // Enabled by default unless explicitly disabled for this project.
    return row ? row.auto_track_climbs !== 0 : true;
  }

  function setAutoTrackEnabled(projectId: string, enabled: boolean): void {
    setSettingStmt.run(projectId, enabled ? 1 : 0, new Date().toISOString());
  }

  function syncProgress(projectId: string, climb: ScannedClimb, link: LinkRow): void {
    const tree = repo.read(projectId);
    const outcome = tree.outcomes.find((o) => o.key === link.outcome_key);
    if (!outcome) return;

    const now = new Date().toISOString();
    const workerId = climb.conversationId ?? climb.workerLabel ?? climb.worktreeName;
    const existingClaim = tree.claims.find((c) => c.key === outcome.key);
    const claimActive = existingClaim ? Date.parse(existingClaim.expires) > Date.now() : false;

    if (climb.isLive) {
      if (!claimActive && workerId) {
        try {
          repo.act(projectId, { op: "claim_outcome", key: outcome.key, threadId: workerId, hours: 4 });
        } catch {
          // Non-fatal if another thread holds the claim
        }
      }
    } else if (existingClaim && existingClaim.threadId === workerId) {
      try {
        repo.act(projectId, { op: "release_outcome", key: outcome.key, threadId: workerId });
      } catch {
        // Non-fatal
      }
    }

    if (climb.status !== "active") {
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
      return;
    }

    const changed = climb.steps !== link.last_synced_steps || climb.verdict !== link.last_synced_verdict;
    if (!changed) return;

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

    if (climbMeetsTargetWithGain(climb) && !alreadyConfirmed) {
      const targetText = climb.targetText ?? fmtNum(climb.target);
      repo.act(projectId, {
        op: "add_evidence",
        key: outcome.key,
        version: outcome.version,
        kind: "confirms",
        criterionIds,
        track: "main",
        source,
        text: `climb.py reached target ${targetText}: ${fmtNum(climb.baseline)} → ${fmtNum(climb.best)} across ${climb.kept}/${climb.steps} kept edit${climb.steps === 1 ? "" : "s"}.`,
      });
    } else if (climb.steps > Math.max(0, link.last_synced_steps) || (link.last_synced_steps < 0 && climb.baseline !== null)) {
      const targetPart = climb.target !== null ? ` (target ${climb.targetText ?? fmtNum(climb.target)})` : "";
      const text =
        climb.steps === 0
          ? `climb.py baseline measured: ${fmtNum(climb.baseline)}${targetPart}.`
          : `climb.py update (${climb.verdict}): ${fmtNum(climb.baseline)} → ${fmtNum(climb.best)}${targetPart} after ${climb.steps} step${climb.steps === 1 ? "" : "s"} (${climb.kept} kept).`;
      repo.act(projectId, {
        op: "add_evidence",
        key: outcome.key,
        version: outcome.version,
        kind: "note",
        criterionIds,
        track: "main",
        source,
        text,
      });
    }

    upsertLinkStmt.run(
      projectId,
      climb.name,
      climb.id,
      outcome.key,
      climb.directory,
      climb.origin,
      link.auto_created,
      climb.steps,
      climb.verdict,
      link.created,
      now,
    );
  }

  function trackClimb(
    projectId: string,
    climb: ScannedClimb,
    opts?: { autoCreated?: boolean },
  ): string {
    const autoCreated = opts?.autoCreated ?? false;
    const now = new Date().toISOString();
    const tree = repo.read(projectId);
    const existingLink = getLinkByNameStmt.get(projectId, climb.name) as LinkRow | undefined;

    if (existingLink && tree.outcomes.some((o) => o.key === existingLink.outcome_key)) {
      syncProgress(projectId, climb, existingLink);
      return existingLink.outcome_key;
    }

    const goalKeys = new Set(tree.goals.map((g) => g.key));
    const outcomeKey = deriveOutcomeKey(climb.name, goalKeys);
    const existingOutcome = tree.outcomes.find((o) => o.key === outcomeKey);

    if (!existingOutcome) {
      if (!goalKeys.has(DEFAULT_GOAL_KEY)) {
        repo.act(projectId, {
          op: "create_goal",
          key: DEFAULT_GOAL_KEY,
          parentGoalKey: null,
          title: "Tracked climbs",
          brief: "Outcomes automatically tracked from .hill-climb runs in this repository and its Antigravity worktrees.",
          rank: 50,
        });
      }
      repo.act(projectId, {
        op: "create_outcome",
        key: outcomeKey,
        goalKey: DEFAULT_GOAL_KEY,
        contract: buildOutcomeContract(climb),
      });
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

    syncProgress(projectId, climb, link);
    return outcomeKey;
  }

  function syncScannedClimbs(projectId: string, scanned: ScannedProjectClimbs): EnrichedProjectClimbs {
    const autoTrackClimbs = isAutoTrackEnabled(projectId);
    const existingLinks = new Map<string, LinkRow>();
    for (const row of listLinksStmt.all(projectId) as unknown as LinkRow[]) {
      existingLinks.set(row.climb_name, row);
    }

    const tree = repo.read(projectId);
    const outcomeKeys = new Set(tree.outcomes.map((o) => o.key));
    const linkedByName = new Map<string, string>();

    for (const climb of scanned.climbs) {
      const existing = existingLinks.get(climb.name);
      const alreadyTracked = existing !== undefined && outcomeKeys.has(existing.outcome_key);

      if (alreadyTracked) {
        try {
          syncProgress(projectId, climb, existing);
          linkedByName.set(climb.name, existing.outcome_key);
        } catch {
          linkedByName.set(climb.name, existing.outcome_key);
        }
      } else if (autoTrackClimbs && climb.origin !== "archived") {
        // Automatically track current Antigravity & local checkout climbs into Outcomes.
        // External/archived worktree runs remain opt-in via "Track as Outcome".
        try {
          const key = trackClimb(projectId, climb, { autoCreated: true });
          linkedByName.set(climb.name, key);
          outcomeKeys.add(key);
        } catch {
          // Never fail UI rendering if a climb directory has unexpected state
        }
      }
    }

    return {
      ...scanned,
      autoTrackClimbs,
      climbs: scanned.climbs.map((climb) => ({
        ...climb,
        outcomeKey: linkedByName.get(climb.name) ?? null,
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

  return {
    isAutoTrackEnabled,
    setAutoTrackEnabled,
    trackClimb,
    syncScannedClimbs,
    liveForOutcome,
  };
}

export type AutoTracker = ReturnType<typeof createAutoTracker>;
