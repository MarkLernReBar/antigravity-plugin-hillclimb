import type { Repository } from "./repository.js";
import type { ScannedProjectClimbs } from "./repo-ops.js";
import type { Signal } from "./model.js";

export interface DailyProofBucket {
  date: string;
  verified: number;
  broken: number;
  evidenceCount: number;
  outcomeKeys: string[];
}

export interface ActorBreakdown {
  actor: string;
  via: string;
  confirms: number;
  denies: number;
  notes: number;
  actions: number;
  outcomeKeys: string[];
}

export interface ClimbTelemetry {
  totalClimbs: number;
  activeClimbs: number;
  barReachedCount: number;
  totalSteps: number;
  keptSteps: number;
  discardedSteps: number;
  keepRatePct: number | null;
  guardRegressionsCaught: number;
  holdoutChecksRun: number;
  largestHoldoutGap: { climb: string; devScore: number; holdoutScore: number; gap: number } | null;
}

export interface ProjectInsights {
  projectId: string;
  track: string;
  days: number;
  generatedAt: string;
  totals: {
    goals: number;
    outcomes: number;
    bySignal: Record<Signal, number>;
    blockedManual: number;
    deferred: number;
    blockedByDependency: number;
    readyNext: number;
    inbox: number;
    verifiedRatePct: number;
  };
  streakDays: number;
  byDay: DailyProofBucket[];
  byActor: ActorBreakdown[];
  recentVerifications: Array<{
    at: string;
    key: string;
    title: string;
    evidenceId: string;
    source: string;
    actor: string;
    via: string;
  }>;
  climbs: ClimbTelemetry;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function inferActor(source: string, explicitActor?: string): string {
  if (explicitActor && explicitActor.trim() !== "") return explicitActor.trim();
  if (source.startsWith("climb:") || source.startsWith("receipt:")) return "climb-engine";
  if (source.startsWith("ci://") || source.startsWith("junit:")) return "ci";
  if (source.startsWith("track:")) return "track-cutover";
  if (source.startsWith("alert:")) return "monitoring";
  if (source.startsWith("status:")) return source.split(":")[2] || "agent";
  return "workspace";
}

function inferVia(source: string, explicitVia?: string): string {
  if (explicitVia) return explicitVia;
  if (source.startsWith("climb:")) return "auto-track";
  if (source.startsWith("ci://") || source.startsWith("junit:")) return "ci";
  if (source.startsWith("alert:")) return "hook";
  return "mcp";
}

export function computeInsights(
  repo: Repository,
  projectId: string,
  opts?: { days?: number; track?: string; scannedClimbs?: ScannedProjectClimbs | null },
): ProjectInsights {
  const days = Math.min(Math.max(Math.floor(opts?.days ?? 30), 1), 365);
  const track = opts?.track ?? "main";
  const now = new Date();
  const cutoffMs = now.getTime() - days * 86_400_000;
  const snap = repo.view(projectId, track);
  const outcomeTitle = new Map(snap.outcomes.map((o) => [o.key, o.title]));

  const bySignal: Record<Signal, number> = {
    verified: 0,
    unverified: 0,
    broken: 0,
    stale: 0,
    recheck: 0,
  };
  let blockedManual = 0;
  let deferred = 0;
  let blockedByDependency = 0;
  for (const r of snap.ranked) {
    bySignal[r.signal] = (bySignal[r.signal] ?? 0) + 1;
    if (r.availability === "blocked") blockedManual += 1;
    else if (r.availability === "deferred") deferred += 1;
    if (r.blockedBy.length > 0) blockedByDependency += 1;
  }

  const dayMap = new Map<string, { verified: Set<string>; broken: Set<string>; evidenceCount: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    dayMap.set(d, { verified: new Set(), broken: new Set(), evidenceCount: 0 });
  }

  const actorMap = new Map<
    string,
    { actor: string; via: string; confirms: number; denies: number; notes: number; actions: number; keys: Set<string> }
  >();
  const touchActor = (actor: string, via: string) => {
    const k = `${actor}\u0000${via}`;
    let entry = actorMap.get(k);
    if (!entry) {
      entry = { actor, via, confirms: 0, denies: 0, notes: 0, actions: 0, keys: new Set() };
      actorMap.set(k, entry);
    }
    return entry;
  };

  const recentVerifications: ProjectInsights["recentVerifications"] = [];

  for (const ev of snap.evidence) {
    if (ev.track !== track) continue;
    const ms = Date.parse(ev.created);
    if (!Number.isFinite(ms) || ms < cutoffMs) continue;
    const d = dayKey(ev.created);
    const bucket = dayMap.get(d);
    if (bucket) {
      bucket.evidenceCount += 1;
      if (ev.kind === "confirms") bucket.verified.add(ev.key);
      if (ev.kind === "denies") bucket.broken.add(ev.key);
    }
    const actor = inferActor(ev.source, ev.actor);
    const via = inferVia(ev.source, ev.via);
    const entry = touchActor(actor, via);
    if (ev.kind === "confirms") {
      entry.confirms += 1;
      entry.keys.add(ev.key);
      recentVerifications.push({
        at: ev.created,
        key: ev.key,
        title: outcomeTitle.get(ev.key) ?? ev.key,
        evidenceId: ev.id,
        source: ev.source,
        actor,
        via,
      });
    } else if (ev.kind === "denies") {
      entry.denies += 1;
      entry.keys.add(ev.key);
    } else {
      entry.notes += 1;
    }
  }

  for (const act of snap.activity) {
    const ms = Date.parse(act.at);
    if (!Number.isFinite(ms) || ms < cutoffMs) continue;
    const actor = act.actor ?? "workspace";
    const via = act.via ?? "mcp";
    touchActor(actor, via).actions += 1;
  }

  const byDay: DailyProofBucket[] = [...dayMap.entries()].map(([date, b]) => ({
    date,
    verified: b.verified.size,
    broken: b.broken.size,
    evidenceCount: b.evidenceCount,
    outcomeKeys: [...b.verified],
  }));

  // Compute current streak of consecutive days (ending today or yesterday) with >= 1 verified outcome
  let streakDays = 0;
  for (let i = byDay.length - 1; i >= 0; i--) {
    const bucket = byDay[i]!;
    if (bucket.verified > 0) {
      streakDays += 1;
    } else if (i === byDay.length - 1) {
      continue; // allow today to be in progress
    } else {
      break;
    }
  }

  const byActor: ActorBreakdown[] = [...actorMap.values()]
    .map((e) => ({
      actor: e.actor,
      via: e.via,
      confirms: e.confirms,
      denies: e.denies,
      notes: e.notes,
      actions: e.actions,
      outcomeKeys: [...e.keys],
    }))
    .sort((a, b) => b.confirms - a.confirms || b.actions - a.actions);

  recentVerifications.sort((a, b) => b.at.localeCompare(a.at));

  // Inner-loop climb telemetry
  const climbs = opts?.scannedClimbs?.climbs ?? [];
  let activeClimbs = 0;
  let barReachedCount = 0;
  let totalSteps = 0;
  let keptSteps = 0;
  let guardRegressionsCaught = 0;
  let holdoutChecksRun = 0;
  let largestHoldoutGap: ClimbTelemetry["largestHoldoutGap"] = null;

  for (const c of climbs) {
    if (c.status === "active") activeClimbs += 1;
    if (c.verdict === "bar-reached") barReachedCount += 1;
    totalSteps += c.steps;
    keptSteps += c.kept;
    let lastDevScore = c.baseline;
    for (const row of c.rows) {
      if (row.kind === "step" && row.result === "kept" && typeof row.score === "number") {
        lastDevScore = row.score;
      } else if (row.kind === "step" && row.result && /guard/i.test(row.result)) {
        guardRegressionsCaught += 1;
      } else if (row.kind === "holdout" && typeof row.score === "number") {
        holdoutChecksRun += 1;
        if (typeof lastDevScore === "number") {
          const gap = Number(Math.abs(lastDevScore - row.score).toFixed(4));
          if (!largestHoldoutGap || gap > largestHoldoutGap.gap) {
            largestHoldoutGap = {
              climb: c.name,
              devScore: lastDevScore,
              holdoutScore: row.score,
              gap,
            };
          }
        }
      }
    }
  }

  const discardedSteps = Math.max(0, totalSteps - keptSteps);
  const keepRatePct = totalSteps > 0 ? Number(((keptSteps / totalSteps) * 100).toFixed(1)) : null;
  const verifiedTotal = bySignal.verified + bySignal.recheck;
  const verifiedRatePct =
    snap.outcomes.length > 0 ? Number(((verifiedTotal / snap.outcomes.length) * 100).toFixed(1)) : 0;

  return {
    projectId,
    track,
    days,
    generatedAt: now.toISOString(),
    totals: {
      goals: snap.goals.length,
      outcomes: snap.outcomes.length,
      bySignal,
      blockedManual,
      deferred,
      blockedByDependency,
      readyNext: snap.next.length,
      inbox: snap.inbox,
      verifiedRatePct,
    },
    streakDays,
    byDay,
    byActor,
    recentVerifications: recentVerifications.slice(0, 30),
    climbs: {
      totalClimbs: climbs.length,
      activeClimbs,
      barReachedCount,
      totalSteps,
      keptSteps,
      discardedSteps,
      keepRatePct,
      guardRegressionsCaught,
      holdoutChecksRun,
      largestHoldoutGap,
    },
  };
}
