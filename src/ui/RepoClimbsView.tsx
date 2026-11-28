import { useEffect, useMemo, useState } from "react";

export interface ScannedClimbRow {
  kind: string;
  step?: number | null;
  result: string | null;
  score: number | null;
  idea: string | null;
  why: string | null;
  time: string | null;
  commit: string | null;
  seconds?: number | null;
  diffLines?: number | null;
  files?: string[];
  deltaSummary?: string | null;
  skeptic?: string | null;
  prevScore?: number | null;
  visible?: number | null;
}

export interface ScannedClimbRunning {
  kind: string;
  phase: string;
  step: number | null;
  idea: string | null;
  startedAt: number;
  pid: number;
}

export interface ScannedClimbHealth {
  overfitWarning: string | null;
  lowTransferWarning?: string | null;
  holdoutCheckpointWarning: string | null;
  thrashWarning: string | null;
  stallWarning: string | null;
  notesWarning: string | null;
  probeWarning?: string | null;
  branchWarning: string | null;
}

export interface ScannedClimbBreakdownMetric {
  key: string;
  value: number;
  raw?: string;
  status?: "pass" | "fail" | null;
  target?: string | null;
}

export interface ScannedClimbBreakdown {
  summaryLine: string | null;
  metrics: ScannedClimbBreakdownMetric[];
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
  base?: string | null;
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
  probe?: string | null;
  guards: string[];
  holdout: string | null;
  holdoutEvery?: number | null;
  locked: string[];
  scoreMode: string | null;
  rows: ScannedClimbRow[];
  notes: string | null;
  preparedFiles: number;
  preparedSampleFiles: string[];
  updatedAt: string | null;
  outcomeKey?: string | null;
  running?: ScannedClimbRunning | null;
  avgCheckSeconds?: number | null;
  keptSinceHoldout?: number;
  relockCount?: number;
  behindBase?: number;
  notesStaleSteps?: number;
  holdoutGain?: number | null;
  transferRatio?: number | null;
  health?: ScannedClimbHealth;
  breakdown?: ScannedClimbBreakdown | null;
  hasBestOutput?: boolean;
  hasLastOutput?: boolean;
}

export interface RepoClimbsPayload {
  projectDirectory: string | null;
  engineInstalled: boolean;
  engineDrift?: "current" | "missing" | "diverged";
  worktreesScanned: number;
  currentCount: number;
  archivedCount: number;
  autoTrackClimbs?: boolean;
  climbs: ScannedClimb[];
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5)));
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? "+" : "-"}${fmtNum(Math.abs(v))}`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return "";
  const whole = Math.round(sec);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function relativeTime(raw: string | null): string {
  if (!raw) return "";
  const ts = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (!Number.isFinite(ts)) return raw;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86_400);
  if (days < 14) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface StatusDisplay {
  label: string;
  tone: "ok" | "live" | "prep" | "warn" | "bad";
}

function statusOf(verdict: string, climb?: ScannedClimb): StatusDisplay {
  if (climb?.running) {
    return { label: "Running", tone: "live" };
  }
  if (climb?.health?.overfitWarning && verdict !== "stuck") {
    return { label: "Overfit risk", tone: "bad" };
  }
  if (climb?.health?.thrashWarning && verdict === "climbing") {
    return { label: "Thrashing", tone: "bad" };
  }
  if (climb?.health?.stallWarning && verdict === "climbing") {
    return { label: "Stalled", tone: "warn" };
  }
  switch (verdict) {
    case "bar-reached":
      return { label: "Target reached", tone: "ok" };
    case "climbing":
      return { label: "Climbing", tone: "live" };
    case "preparing":
      return { label: "Setting up", tone: "prep" };
    case "plateau":
      return { label: "Plateau", tone: "warn" };
    case "stuck":
      return { label: "Stuck", tone: "bad" };
    default:
      return { label: verdict, tone: "live" };
  }
}

function progressPct(climb: ScannedClimb): number | null {
  if (climb.baseline === null || climb.best === null || climb.target === null) return null;
  const total = climb.target - climb.baseline;
  if (total === 0) return climb.best === climb.target ? 100 : 0;
  const moved = climb.best - climb.baseline;
  return Math.max(0, Math.min(100, Math.round((moved / total) * 100)));
}

function plainSummary(climb: ScannedClimb): string {
  if (climb.status === "prepared") {
    return "This agent is building the test/benchmark inputs before starting the scored loop. Once it runs `climb.py init`, the baseline score and every edit it tries will stream in here automatically.";
  }
  const verb = climb.direction === "min" ? "down" : "up";
  const base = fmtNum(climb.baseline);
  const best = fmtNum(climb.best);
  const target = climb.targetText ?? fmtNum(climb.target);
  const keptWord = `${climb.kept} kept ${climb.kept === 1 ? "edit" : "edits"}`;
  const undoneWord = climb.undone > 0 ? `, ${climb.undone} discarded` : "";

  if (climb.verdict === "bar-reached") {
    if (climb.baseline === climb.best) {
      return `Baseline already matched target ${target} (${base}).`;
    }
    return `Hit target ${target} — moved ${verb} from ${base} to ${best} in ${keptWord}${undoneWord}.`;
  }
  if (climb.verdict === "stuck") {
    return `Stopped after repeated attempts without further gain. Best score is ${best} (started at ${base}, target ${target}).`;
  }
  if (climb.health?.thrashWarning) {
    return `Last ${climb.sinceGain} tries repeated the same approach without gain — needs a different failure bucket or parallel subagents. Best is ${best} (target ${target}).`;
  }
  if (climb.verdict === "plateau" || climb.health?.stallWarning) {
    return `No improvement in the last ${climb.sinceGain} tries — needs a fresh angle. Best is ${best} (started at ${base}, target ${target}).`;
  }
  const pct = progressPct(climb);
  const pctText = pct !== null ? ` (${pct}% of the way to target ${target})` : "";
  if (climb.baseline === climb.best) {
    return `Started at ${base}${climb.target !== null ? ` aiming for ${target}` : ""}. Waiting for the first winning edit.`;
  }
  return `Moving ${verb} from ${base} to ${best}${pctText} across ${keptWord}${undoneWord}.`;
}

function phaseLabel(running: ScannedClimbRunning): string {
  if (running.kind === "holdout" || running.phase === "holdout") return "Running blind holdout check";
  if (running.kind === "relock") return running.phase === "guards" ? "Relocking · running guards" : "Relocking · re-measuring check";
  if (running.phase === "guards") return `Step ${running.step ?? "?"} · running pre-check guards`;
  if (running.phase === "probe") return `Step ${running.step ?? "?"} · running fast slice probe`;
  return running.step ? `Step ${running.step} · scoring check` : "Running check";
}

function RunningBanner({ running, avgSeconds }: { running: ScannedClimbRunning; avgSeconds?: number | null }) {
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, [running.startedAt]);
  const elapsed = Math.max(0, Math.round(nowSec - running.startedAt));
  return (
    <div className="cl-running" role="status">
      <div className="cl-running-head">
        <span className="cl-pill cl-pill-live">
          <i className="cl-pulse" />
          {phaseLabel(running)}
        </span>
        <span className="cl-running-timer">
          <strong>{fmtDuration(elapsed)}</strong> elapsed
          {avgSeconds && avgSeconds > 5 ? ` · ~${fmtDuration(avgSeconds)} typical` : ""}
        </span>
      </div>
      {running.idea ? <p className="cl-running-idea">{running.idea}</p> : null}
    </div>
  );
}

interface HealthItem {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "info" | "muted";
}

function HealthStrip({ climb }: { climb: ScannedClimb }) {
  const h = climb.health;
  const holdouts = climb.rows.filter((r) => r.kind === "holdout" && typeof r.score === "number" && Number.isFinite(r.score));
  const relocks = climb.relockCount ?? climb.rows.filter((r) => r.kind === "relock").length;

  const momentum: HealthItem =
    climb.verdict === "bar-reached"
      ? { label: "Momentum", value: "Bar reached", tone: "ok" }
      : h?.thrashWarning
        ? { label: "Momentum", value: `Thrashing (${climb.sinceGain} tries)`, tone: "bad" }
        : climb.verdict === "stuck"
          ? { label: "Momentum", value: "Stuck", tone: "bad" }
          : climb.verdict === "plateau"
            ? { label: "Momentum", value: `Plateau (${climb.sinceGain} tries)`, tone: "warn" }
            : h?.stallWarning
              ? { label: "Momentum", value: `Stalled (${climb.sinceGain} tries)`, tone: "warn" }
              : climb.kept > 0
                ? { label: "Momentum", value: `Gaining (${climb.kept}/${climb.steps})`, tone: "ok" }
                : { label: "Momentum", value: climb.steps === 0 ? "Baseline" : `${climb.steps} tried`, tone: "info" };

  let generalization: HealthItem;
  if (!climb.holdout) {
    generalization = { label: "Generalization", value: "Visible-only", tone: "muted" };
  } else if (h?.overfitWarning) {
    generalization = { label: "Generalization", value: "Overfit risk", tone: "bad" };
  } else if (typeof climb.holdoutGain === "number" && climb.holdoutGain > 1e-9) {
    const ratio = typeof climb.transferRatio === "number" ? climb.transferRatio : null;
    const pct = ratio !== null ? ` · ${Math.round(ratio * 100)}%` : "";
    if (ratio !== null && ratio < 0.2) {
      generalization = { label: "Generalization", value: `Low transfer (${fmtSigned(climb.holdoutGain)}${pct})`, tone: "warn" };
    } else if (ratio !== null && ratio < 0.5) {
      generalization = { label: "Generalization", value: `Partial transfer (${fmtSigned(climb.holdoutGain)}${pct})`, tone: "warn" };
    } else {
      generalization = { label: "Generalization", value: `Transfers (${fmtSigned(climb.holdoutGain)}${pct})`, tone: "ok" };
    }
  } else if (h?.holdoutCheckpointWarning) {
    generalization = { label: "Generalization", value: `Checkpoint due (${climb.keptSinceHoldout ?? 0} kept)`, tone: "warn" };
  } else if (holdouts.length === 1) {
    generalization = { label: "Generalization", value: `Baseline ${fmtNum(holdouts[0]!.score)}`, tone: "info" };
  } else {
    generalization = { label: "Generalization", value: "Baseline missing", tone: "warn" };
  }

  const integrity: HealthItem =
    climb.locked.length === 0
      ? { label: "Check lock", value: "Unlocked", tone: "warn" }
      : relocks > 0
        ? { label: "Check lock", value: `Locked · ${relocks} relock${relocks === 1 ? "" : "s"}`, tone: "warn" }
        : { label: "Check lock", value: `Locked (${climb.locked.length})`, tone: "ok" };

  const hygieneIssues: string[] = [];
  if ((climb.behindBase ?? 0) > 0) hygieneIssues.push(`${climb.behindBase} behind ${climb.base ?? "base"}`);
  if (h?.notesWarning) hygieneIssues.push(`Notes ${climb.notesStaleSteps ?? 0} steps stale`);
  if (h?.probeWarning) hygieneIssues.push("No fast probe");
  const hygiene: HealthItem =
    hygieneIssues.length === 0
      ? { label: "Hygiene", value: "Clean", tone: "ok" }
      : { label: "Hygiene", value: hygieneIssues.join(" · "), tone: "warn" };

  const items = [momentum, generalization, integrity, hygiene];

  const alerts: Array<{ tone: "bad" | "warn"; tag: string; text: string }> = [];
  if (h?.overfitWarning) alerts.push({ tone: "bad", tag: "Overfit", text: h.overfitWarning });
  else if (h?.lowTransferWarning) alerts.push({ tone: "warn", tag: "Transfer", text: h.lowTransferWarning });
  else if (
    typeof climb.holdoutGain === "number" &&
    climb.holdoutGain > 1e-9 &&
    typeof climb.transferRatio === "number" &&
    climb.transferRatio < 0.5
  ) {
    const pct = Math.round(climb.transferRatio * 100);
    alerts.push({
      tone: "warn",
      tag: "Transfer",
      text: `Only ${pct}% of visible dev gain transferred to blind holdout${
        relocks > 0 ? ` across ${relocks} relock${relocks === 1 ? "" : "s"}` : ""
      } — review relock and holdout steps before treating the visible score as real gain.`,
    });
  }
  if (h?.thrashWarning) alerts.push({ tone: "bad", tag: "Thrash", text: h.thrashWarning });
  else if (h?.stallWarning) alerts.push({ tone: "warn", tag: "Stall", text: h.stallWarning });
  if (h?.holdoutCheckpointWarning) alerts.push({ tone: "warn", tag: "Holdout", text: h.holdoutCheckpointWarning });
  if (h?.probeWarning) alerts.push({ tone: "warn", tag: "Probe", text: h.probeWarning });
  if (h?.branchWarning) alerts.push({ tone: "warn", tag: "Branch", text: h.branchWarning });
  if (h?.notesWarning) alerts.push({ tone: "warn", tag: "Notes", text: h.notesWarning });

  return (
    <div className="cl-health-wrap">
      <div className="cl-health-grid" aria-label="Climb health and trust signals">
        {items.map((it) => (
          <div key={it.label} className={`cl-health-card cl-health-${it.tone}`}>
            <span className="cl-health-label">{it.label}</span>
            <strong className="cl-health-val">{it.value}</strong>
          </div>
        ))}
      </div>
      {alerts.length > 0 ? (
        <ul className="cl-alerts" aria-label="Active climb warnings">
          {alerts.map((a, idx) => (
            <li key={idx} className={`cl-alert cl-alert-${a.tone}`}>
              <span className={`cl-pill cl-pill-${a.tone}`}>{a.tag}</span>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ScoreChart({ climb }: { climb: ScannedClimb }) {
  const { points, holdoutPoints, relockPos } = useMemo(() => {
    const pts: Array<{
      idx: number;
      score: number;
      label: string;
      kept: boolean;
      isBaseline: boolean;
      why?: string | null;
      deltaSummary?: string | null;
      seconds?: number | null;
    }> = [];
    const hPts: Array<{ pos: number; score: number; why: string; visible?: number | null }> = [];
    const rPos: Array<{ pos: number; why: string; score: number | null; prevScore?: number | null }> = [];

    if (climb.baseline !== null) {
      pts.push({ idx: 0, score: climb.baseline, label: "Start (baseline)", kept: true, isBaseline: true });
    }
    let step = 0;
    for (const r of climb.rows) {
      if (r.kind === "step" && typeof r.score === "number" && Number.isFinite(r.score)) {
        step += 1;
        const stepLabel = r.step ?? step;
        pts.push({
          idx: stepLabel,
          score: r.score,
          label: r.idea ?? `Step ${stepLabel}`,
          kept: r.result === "kept",
          isBaseline: false,
          why: r.why,
          deltaSummary: r.deltaSummary,
          seconds: r.seconds,
        });
      } else if (r.kind === "holdout" && typeof r.score === "number" && Number.isFinite(r.score)) {
        hPts.push({
          pos: Math.max(0, pts.length - 1),
          score: r.score,
          why: r.why ?? "holdout",
          visible: r.visible,
        });
      } else if (r.kind === "relock") {
        rPos.push({
          pos: Math.max(0, pts.length - 1),
          why: r.why ?? "check updated",
          score: r.score,
          prevScore: r.prevScore,
        });
      }
    }
    return { points: pts, holdoutPoints: hPts, relockPos: rPos };
  }, [climb]);

  if (points.length === 0) return null;

  const hasDiscardedPoint = points.some((p) => !p.kept);
  const w = 520;
  const h = 172;
  const l = 54;
  const r = 18;
  const t = 24;
  const b = 26;
  const innerW = w - l - r;
  const innerH = h - t - b;

  const vals = [
    ...points.map((p) => p.score),
    ...holdoutPoints.map((p) => p.score),
    ...(climb.target !== null ? [climb.target] : []),
    ...(climb.baseline !== null ? [climb.baseline] : []),
  ];
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const span = rawMax - rawMin;
  const pad = span === 0 ? Math.max(1, Math.abs(rawMin) * 0.15) : span * 0.14;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const y = (v: number) => t + innerH - ((v - min) / (max - min)) * innerH;
  const x = (i: number) => (points.length <= 1 ? l + innerW / 2 : l + (i / (points.length - 1)) * innerW);

  const targetY = climb.target !== null ? y(climb.target) : null;
  const showMaxAxis = targetY === null || Math.abs(targetY - (t + 8)) >= 14;
  const showMinAxis = rawMin !== rawMax && (targetY === null || Math.abs(targetY - (t + innerH)) >= 14);

  const keptPoints = points.map((p, pos) => ({ ...p, pos })).filter((p) => p.kept);
  const linePath = keptPoints
    .map((p, idx) => `${idx === 0 ? "M" : "L"} ${x(p.pos).toFixed(1)} ${y(p.score).toFixed(1)}`)
    .join(" ");

  const areaPath =
    keptPoints.length >= 2
      ? `${linePath} L ${x(keptPoints[keptPoints.length - 1]!.pos).toFixed(1)} ${(t + innerH).toFixed(1)} L ${x(keptPoints[0]!.pos).toFixed(1)} ${(t + innerH).toFixed(1)} Z`
      : "";

  const holdoutPath =
    holdoutPoints.length >= 2
      ? holdoutPoints.map((p, idx) => `${idx === 0 ? "M" : "L"} ${x(p.pos).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ")
      : "";

  return (
    <div className="cl-chart-card">
      <div className="cl-chart-head">
        <span className="cl-section-label">
          Score trajectory ({climb.direction === "min" ? "lower is better" : "higher is better"})
        </span>
        <div className="cl-chart-legend">
          <span>
            <i className="cl-dot cl-dot-kept" /> Kept
          </span>
          {hasDiscardedPoint ? (
            <span>
              <i className="cl-dot cl-dot-undone" /> Discarded
            </span>
          ) : null}
          {holdoutPoints.length > 0 ? (
            <span>
              <i className="cl-diamond" /> Holdout
            </span>
          ) : null}
          {relockPos.length > 0 ? (
            <span>
              <i className="cl-relock-tick" /> Relock
            </span>
          ) : null}
          {climb.target !== null ? (
            <span>
              <i className="cl-dash cl-dash-target" /> Target ({climb.targetText ?? fmtNum(climb.target)})
            </span>
          ) : null}
        </div>
      </div>
      <svg className="cl-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score trajectory for ${climb.name}`}>
        <rect className="cl-chart-bg" x={l} y={t} width={innerW} height={innerH} rx={6} />
        <line className="cl-chart-grid" x1={l} x2={w - r} y1={t + innerH / 2} y2={t + innerH / 2} />

        {(() => {
          // Group relocks that happened at the same step so lines/labels never collide.
          const groups: Array<{ pos: number; indices: number[]; items: typeof relockPos }> = [];
          for (let i = 0; i < relockPos.length; i += 1) {
            const rk = relockPos[i]!;
            const last = groups[groups.length - 1];
            if (last && last.pos === rk.pos) {
              last.indices.push(i + 1);
              last.items.push(rk);
            } else {
              groups.push({ pos: rk.pos, indices: [i + 1], items: [rk] });
            }
          }
          const compact = groups.length > 1 || relockPos.length > 1;
          let prevLabelX = -Infinity;
          let tier = 0;
          return groups.map((g, gi) => {
            const rx = x(g.pos);
            const label = !compact
              ? "relock"
              : g.indices.length === 1
                ? `R${g.indices[0]}`
                : `R${g.indices[0]}–${g.indices[g.indices.length - 1]}`;
            const labelX = Math.max(l + 12, Math.min(w - r - 12, rx));
            if (labelX - prevLabelX < 20) {
              tier = tier === 0 ? 1 : 0;
            } else {
              tier = 0;
            }
            prevLabelX = labelX;
            const labelY = tier === 0 ? t - 5 : t - 14;
            const tooltip = g.items
              .map(
                (rk, idx) =>
                  `Relock #${g.indices[idx]}: ${rk.why}${rk.score !== null ? ` (re-measured ${fmtNum(rk.score)})` : ""}`,
              )
              .join("\n");
            return (
              <g key={`rk-${gi}`} className="cl-rule-relock">
                <line x1={rx} x2={rx} y1={t} y2={t + innerH} />
                <text x={labelX} y={labelY} textAnchor="middle">
                  {label}
                </text>
                <title>{tooltip}</title>
              </g>
            );
          });
        })()}

        {climb.target !== null && targetY !== null ? (
          <g className="cl-rule-target">
            <line x1={l} x2={w - r} y1={targetY} y2={targetY} />
            <text x={l - 8} y={Math.min(t + innerH, Math.max(t + 8, targetY + 3))} textAnchor="end">
              {climb.targetText ?? fmtNum(climb.target)}
            </text>
          </g>
        ) : null}

        {showMaxAxis ? (
          <text className="cl-axis" x={l - 8} y={t + 8} textAnchor="end">
            {fmtNum(rawMax)}
          </text>
        ) : null}
        {showMinAxis ? (
          <text className="cl-axis" x={l - 8} y={t + innerH} textAnchor="end">
            {fmtNum(rawMin)}
          </text>
        ) : null}

        {areaPath ? <path className="cl-chart-area" d={areaPath} /> : null}
        {linePath ? <path className="cl-chart-line" d={linePath} /> : null}
        {holdoutPath ? <path className="cl-chart-holdout-line" d={holdoutPath} /> : null}

        {(() => {
          const maxTicks = 7;
          const stride = points.length <= maxTicks ? 1 : Math.ceil((points.length - 1) / (maxTicks - 1));
          return points.map((p, i) => {
            const cx = x(i);
            const cy = y(p.score);
            const extra = [
              p.why && !p.kept ? `why: ${p.why}` : "",
              p.deltaSummary ? `diff: ${p.deltaSummary}` : "",
              p.seconds ? fmtDuration(p.seconds) : "",
            ]
              .filter(Boolean)
              .join(" · ");
            const showTick =
              i === 0 ||
              i === points.length - 1 ||
              (i % stride === 0 && points.length - 1 - i >= Math.ceil(stride * 0.55));
            const anchor =
              points.length > maxTicks && i === 0
                ? "start"
                : points.length > maxTicks && i === points.length - 1
                  ? "end"
                  : "middle";
            return (
              <g key={i}>
                <circle
                  className={p.isBaseline ? "cl-pt cl-pt-base" : p.kept ? "cl-pt cl-pt-kept" : "cl-pt cl-pt-undone"}
                  cx={cx}
                  cy={cy}
                  r={p.kept ? 4.5 : 3.5}
                >
                  <title>{`${p.label} — score ${fmtNum(p.score)}${p.isBaseline ? "" : p.kept ? " (kept)" : " (discarded)"}${extra ? `\n${extra}` : ""}`}</title>
                </circle>
                {showTick ? (
                  <text className="cl-axis" x={cx} y={h - 6} textAnchor={anchor}>
                    {p.isBaseline ? "Start" : `#${p.idx}`}
                  </text>
                ) : null}
              </g>
            );
          });
        })()}

        {holdoutPoints.map((hp, i) => {
          const cx = x(hp.pos);
          const cy = y(hp.score);
          const d = 5;
          return (
            <polygon
              key={`ho-${i}`}
              className="cl-pt-holdout"
              points={`${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`}
            >
              <title>{`Holdout (${hp.why}): ${fmtNum(hp.score)}${hp.visible !== null && hp.visible !== undefined ? ` (visible ${fmtNum(hp.visible)})` : ""}`}</title>
            </polygon>
          );
        })}
      </svg>
    </div>
  );
}

function BreakdownCard({
  climb,
  onOpenFile,
}: {
  climb: ScannedClimb;
  onOpenFile?: (filePath: string, baseDir?: string | null) => Promise<void>;
}) {
  const bd = climb.breakdown;
  if (!bd || (!bd.summaryLine && bd.metrics.length === 0)) return null;
  return (
    <div className="cl-breakdown">
      <div className="cl-breakdown-head">
        <span className="cl-section-label">Latest score breakdown (best.txt)</span>
        <div className="cl-breakdown-links">
          {onOpenFile && climb.hasBestOutput ? (
            <button
              type="button"
              className="hc-link hc-file-link"
              onClick={() => void onOpenFile(`.hill-climb/${climb.name}/best.txt`, climb.directory)}
            >
              best.txt ↗
            </button>
          ) : null}
          {onOpenFile && climb.hasLastOutput ? (
            <button
              type="button"
              className="hc-link hc-file-link"
              onClick={() => void onOpenFile(`.hill-climb/${climb.name}/last.txt`, climb.directory)}
            >
              last.txt ↗
            </button>
          ) : null}
        </div>
      </div>
      {bd.summaryLine ? <code className="cl-breakdown-summary">{bd.summaryLine}</code> : null}
      {bd.metrics.length > 0 ? (
        <div className="cl-metric-grid">
          {bd.metrics.map((m) => (
            <div
              key={m.key}
              className={`cl-metric-chip${m.status === "pass" ? " is-pass" : m.status === "fail" ? " is-fail" : ""}`}
              title={m.target ? `${m.key}: ${m.raw ?? fmtNum(m.value)} (${m.target})` : `${m.key}: ${m.raw ?? fmtNum(m.value)}`}
            >
              <span className="cl-metric-key">{m.key}</span>
              <strong className="cl-metric-val">{m.raw ?? fmtNum(m.value)}</strong>
              {m.target ? <span className="cl-metric-sub">{m.target}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepTimeline({ climb }: { climb: ScannedClimb }) {
  const [filter, setFilter] = useState<"all" | "kept" | "milestones">("all");
  const [showAll, setShowAll] = useState(false);

  const entries = useMemo(() => {
    let prevScore = climb.baseline;
    let firstHoldout: number | null = null;
    const list: Array<{
      index: number;
      kind: string;
      kept: boolean;
      milestone: boolean;
      badge: string;
      tone: "ok" | "muted" | "warn" | "bad" | "info";
      score: number | null;
      delta: string | null;
      text: string;
      whyDetail: string | null;
      deltaSummary: string | null;
      duration: string;
      diffMeta: string;
      skeptic: string | null;
      time: string;
    }> = [];
    let stepNum = 0;
    for (const row of climb.rows) {
      if (row.kind === "baseline") {
        prevScore = row.score;
        list.push({
          index: list.length,
          kind: "baseline",
          kept: true,
          milestone: true,
          badge: "Baseline",
          tone: "info",
          score: row.score,
          delta: null,
          text: "Measured starting score before any code changes.",
          whyDetail: null,
          deltaSummary: null,
          duration: fmtDuration(row.seconds),
          diffMeta: "",
          skeptic: null,
          time: relativeTime(row.time),
        });
        continue;
      }
      if (row.kind === "step") {
        stepNum += 1;
        const displayStep = row.step ?? stepNum;
        const kept = row.result === "kept";
        const broke = row.result === "broke";
        let delta: string | null = null;
        if (prevScore !== null && row.score !== null) {
          const diff = row.score - prevScore;
          if (Math.abs(diff) > 1e-9) delta = fmtSigned(diff);
        }
        if (kept && row.score !== null) prevScore = row.score;
        const fileCount = row.files?.length ?? 0;
        const diffMeta =
          row.diffLines && row.diffLines > 0
            ? `${row.diffLines} line${row.diffLines === 1 ? "" : "s"}${fileCount > 0 ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}`
            : fileCount > 0
              ? `${fileCount} file${fileCount === 1 ? "" : "s"}`
              : "";
        list.push({
          index: list.length,
          kind: "step",
          kept,
          milestone: kept,
          badge: kept ? `Step ${displayStep} · Kept` : broke ? `Step ${displayStep} · Broke` : `Step ${displayStep} · Discarded`,
          tone: kept ? "ok" : broke ? "bad" : "muted",
          score: row.score,
          delta,
          text: row.idea ?? "No description recorded",
          whyDetail: kept ? null : row.why ?? null,
          deltaSummary: kept ? null : row.deltaSummary ?? null,
          duration: fmtDuration(row.seconds),
          diffMeta,
          skeptic: null,
          time: relativeTime(row.time),
        });
        continue;
      }
      if (row.kind === "holdout") {
        let delta: string | null = null;
        if (firstHoldout === null && row.score !== null) {
          firstHoldout = row.score;
        } else if (firstHoldout !== null && row.score !== null) {
          const diff = row.score - firstHoldout;
          if (Math.abs(diff) > 1e-9) delta = `${fmtSigned(diff)} vs start`;
        }
        const visNote = row.visible !== null && row.visible !== undefined ? `visible ${fmtNum(row.visible)}` : null;
        list.push({
          index: list.length,
          kind: "holdout",
          kept: false,
          milestone: true,
          badge: "Blind holdout",
          tone: "info",
          score: row.score,
          delta,
          text: row.why ?? "Holdout check",
          whyDetail: visNote,
          deltaSummary: null,
          duration: "",
          diffMeta: "",
          skeptic: null,
          time: relativeTime(row.time),
        });
        continue;
      }
      if (row.kind === "relock") {
        let delta: string | null = null;
        if (row.prevScore !== null && row.prevScore !== undefined && row.score !== null) {
          const diff = row.score - row.prevScore;
          if (Math.abs(diff) > 1e-9) delta = `${fmtSigned(diff)} from ${fmtNum(row.prevScore)}`;
        }
        if (row.score !== null) prevScore = row.score;
        const filesNote =
          row.files && row.files.length > 0
            ? `${row.files.join(", ")}${row.diffLines ? ` (${row.diffLines} lines)` : ""}`
            : null;
        list.push({
          index: list.length,
          kind: "relock",
          kept: false,
          milestone: true,
          badge: "Check relocked",
          tone: "warn",
          score: row.score,
          delta,
          text: row.why ?? "Locked check updated",
          whyDetail: filesNote,
          deltaSummary: null,
          duration: "",
          diffMeta: "",
          skeptic: null,
          time: relativeTime(row.time),
        });
        continue;
      }
      list.push({
        index: list.length,
        kind: row.kind,
        kept: false,
        milestone: true,
        badge:
          row.kind === "review"
            ? "Blocker review"
            : row.kind === "raise"
              ? "Target raised"
              : row.kind === "budget"
                ? "Budget updated"
                : row.kind,
        tone: row.kind === "review" ? "warn" : "info",
        score: row.score,
        delta: null,
        text: row.why ?? row.idea ?? "",
        whyDetail: null,
        deltaSummary: null,
        duration: "",
        diffMeta: "",
        skeptic: row.skeptic ?? null,
        time: relativeTime(row.time),
      });
    }
    return list.reverse();
  }, [climb]);

  const filtered = useMemo(() => {
    if (filter === "kept") return entries.filter((e) => e.kept);
    if (filter === "milestones") return entries.filter((e) => e.milestone);
    return entries;
  }, [entries, filter]);

  if (entries.length === 0) return null;
  const visibleEntries = showAll ? filtered : filtered.slice(0, 25);
  const truncated = filtered.length > 25 && !showAll;

  return (
    <div className="cl-section">
      <div className="cl-timeline-head">
        <span className="cl-section-label">
          What happened ({truncated ? `latest 25 of ${filtered.length}` : `${filtered.length} events`}, newest first)
        </span>
        <div className="cl-timeline-controls">
          <div className="cl-seg cl-seg-sm" role="tablist" aria-label="Filter timeline">
            {(
              [
                ["all", "All"],
                ["kept", "Kept"],
                ["milestones", "Milestones"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={filter === id ? "is-active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {filtered.length > 25 ? (
            <button type="button" className="hill-action-btn" onClick={() => setShowAll((prev) => !prev)}>
              {showAll ? "Latest 25" : `All ${filtered.length}`}
            </button>
          ) : null}
        </div>
      </div>
      <ol className="cl-timeline">
        {visibleEntries.map((e) => {
          const isCancelOut = Boolean(e.deltaSummary?.startsWith("cancel-out:"));
          const isZeroChange = e.deltaSummary === "zero-case-change";
          return (
            <li key={e.index} className={`cl-event cl-event-${e.tone}`}>
              <div className="cl-event-head">
                <span className={`cl-pill cl-pill-${e.tone}`}>{e.badge}</span>
                {e.skeptic ? <span className="cl-pill cl-pill-ok">Skeptic-audited</span> : null}
                <span className="cl-event-score">
                  {e.score !== null ? <strong>{fmtNum(e.score)}</strong> : null}
                  {e.delta ? <span className="cl-delta"> ({e.delta})</span> : null}
                </span>
                {e.duration ? <span className="cl-meta-chip">{e.duration}</span> : null}
                {e.diffMeta ? <span className="cl-meta-chip">{e.diffMeta}</span> : null}
                {e.time ? <span className="cl-muted cl-event-time">{e.time}</span> : null}
              </div>
              {e.text ? <p className="cl-event-text">{e.text}</p> : null}
              {e.whyDetail || e.deltaSummary ? (
                <div className="cl-event-diag">
                  {e.whyDetail ? (
                    <span className="cl-diag-item">
                      <strong>{e.kind === "relock" ? "Files:" : e.kind === "holdout" ? "Context:" : "Why:"}</strong>{" "}
                      {e.whyDetail}
                    </span>
                  ) : null}
                  {e.deltaSummary ? (
                    <span className={`cl-diag-item${isCancelOut || isZeroChange ? " is-warn" : ""}`}>
                      <strong>{isCancelOut ? "Cancel-out:" : isZeroChange ? "No trigger:" : "Case diff:"}</strong>{" "}
                      {isCancelOut
                        ? e.deltaSummary.replace(/^cancel-out:\s*/i, "")
                        : isZeroChange
                          ? "output metrics identical to best (edit likely did not fire on missed cases)"
                          : e.deltaSummary}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {e.skeptic ? (
                <details className="cl-skeptic-details">
                  <summary>Skeptic audit evidence</summary>
                  <p>{e.skeptic}</p>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function buildClimbContextMarkdown(climb: ScannedClimb): string {
  const lines = [
    `Hill Climb Run: ${climb.name}`,
    `Status: ${statusOf(climb.verdict, climb).label} (${climb.verdict}) | Directory: ${climb.directory}${climb.branch ? ` | Branch: ${climb.branch}` : ""}`,
    `Score: baseline ${fmtNum(climb.baseline)} → best ${fmtNum(climb.best)}${climb.target !== null ? ` (target ${climb.targetText ?? fmtNum(climb.target)})` : ""} | ${climb.kept}/${climb.steps} edits kept`,
  ];
  if (climb.running) {
    lines.push(`Currently running: ${phaseLabel(climb.running)}${climb.running.idea ? ` — ${climb.running.idea}` : ""}`);
  }
  if (climb.goal) lines.push(`Goal: ${climb.goal}`);
  if (typeof climb.holdoutGain === "number") {
    const pct = typeof climb.transferRatio === "number" ? ` (transfer ratio ${Math.round(climb.transferRatio * 100)}%)` : "";
    lines.push(`Holdout delta: ${fmtSigned(climb.holdoutGain)}${pct}`);
  }
  const h = climb.health;
  const warnings = [
    h?.overfitWarning,
    h?.lowTransferWarning,
    h?.thrashWarning,
    h?.stallWarning,
    h?.holdoutCheckpointWarning,
    h?.probeWarning,
    h?.branchWarning,
    h?.notesWarning,
  ].filter(Boolean);
  if (warnings.length > 0) {
    lines.push("", "Active warnings:", ...warnings.map((w) => `- ${w}`));
  }
  if (climb.breakdown?.summaryLine) {
    lines.push("", `Latest breakdown: ${climb.breakdown.summaryLine}`);
  }
  if (climb.check.length > 0) lines.push(`Check: ${climb.check.join(" ; ")}`);
  if (climb.probe) lines.push(`Fast probe: ${climb.probe}`);
  if (climb.guards.length > 0) lines.push(`Guards: ${climb.guards.join(" ; ")}`);
  if (climb.locked.length > 0) lines.push(`Locked files: ${climb.locked.join(", ")}`);
  const recentSteps = climb.rows.filter((r) => r.kind === "step").slice(-6);
  if (recentSteps.length > 0) {
    lines.push(
      "",
      "Recent steps:",
      ...recentSteps.map((s) => {
        const why = s.result !== "kept" && s.why ? ` [${s.why}]` : "";
        const diff = s.deltaSummary ? ` (${s.deltaSummary})` : "";
        return `- [${s.result ?? "?"}] score=${fmtNum(s.score)}: ${s.idea ?? ""}${why}${diff}`;
      }),
    );
  }
  return lines.join("\n");
}

export function RepoClimbsView({
  payload,
  loading,
  onRefresh,
  onUpgradeEngine,
  onToggleAutoTrack,
  onTrackClimb,
  onOpenOutcome,
  attachedContextId,
  onAttachContext,
  onOpenFile,
}: {
  payload: RepoClimbsPayload | null;
  loading: boolean;
  onRefresh: () => void;
  onUpgradeEngine?: () => Promise<void> | void;
  onToggleAutoTrack?: (enabled: boolean) => Promise<void> | void;
  onTrackClimb?: (climbId: string) => Promise<void> | void;
  onOpenOutcome?: (outcomeKey: string) => void;
  attachedContextId?: string | null;
  onAttachContext?: (id: string, label: string, markdown: string) => Promise<void>;
  onOpenFile?: (filePath: string, baseDir?: string | null) => Promise<void>;
}) {
  const [scope, setScope] = useState<"current" | "all">("current");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [upgradingEngine, setUpgradingEngine] = useState(false);

  if (loading && !payload) {
    return <p className="cl-loading" role="status">Checking repository for active climbs…</p>;
  }

  if (!payload || !payload.projectDirectory) {
    return (
      <section className="cl-root">
        <div className="cl-empty">
          <h3>No repository linked</h3>
          <p>
            Choose <strong>+ Link repository…</strong> from the project menu above to connect a local git repository.
            Active and completed climbs will appear here automatically.
          </p>
        </div>
      </section>
    );
  }

  const currentClimbs = payload.climbs.filter((c) => c.origin !== "archived" || c.isLive);
  const archivedClimbs = payload.climbs.filter((c) => c.origin === "archived" && !c.isLive);
  const effectiveScope = scope === "current" && currentClimbs.length === 0 && archivedClimbs.length > 0 ? "all" : scope;
  const visible = effectiveScope === "current" ? currentClimbs : payload.climbs;
  const chosen = visible.find((c) => c.id === selectedId) ?? visible[0] ?? null;

  return (
    <section className="cl-root">
      <div className="cl-topbar">
        <div className="cl-seg" role="tablist" aria-label="Climb filter">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === "current"}
            className={effectiveScope === "current" ? "is-active" : ""}
            onClick={() => setScope("current")}
          >
            Current ({currentClimbs.length})
          </button>
          {archivedClimbs.length > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveScope === "all"}
              className={effectiveScope === "all" ? "is-active" : ""}
              onClick={() => setScope("all")}
            >
              All history ({payload.climbs.length})
            </button>
          ) : null}
        </div>
        <div className="cl-topbar-right">
          {onToggleAutoTrack ? (
            <button
              type="button"
              className={`cl-auto-toggle${payload.autoTrackClimbs !== false ? " is-on" : ""}`}
              disabled={togglingAuto}
              title="Automatically track current climbs as Outcomes in the Outcomes tab"
              onClick={async () => {
                setTogglingAuto(true);
                try {
                  await onToggleAutoTrack(payload.autoTrackClimbs === false);
                } finally {
                  setTogglingAuto(false);
                }
              }}
            >
              <i className="cl-auto-dot" />
              Auto-track Outcomes: {payload.autoTrackClimbs !== false ? "On" : "Off"}
            </button>
          ) : null}
          <span className="cl-muted">Updates every 10s</span>
          <button type="button" className="hill-action-btn" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {payload.engineDrift === "diverged" || (payload.engineDrift === "missing" && payload.climbs.length > 0) ? (
        <div className="cl-engine-banner">
          <span>
            {payload.engineDrift === "diverged"
              ? "Local .hill-climb/engine/climb.py differs from the bundled Hill Climb plugin engine (upgrade to get live running heartbeats, plateau/thrash diagnostics, holdout checkpoints, and audit checks)."
              : "Hill Climb engine is not installed in this repository yet."}
          </span>
          {onUpgradeEngine ? (
            <button
              type="button"
              className="hc-btn hc-btn-primary"
              disabled={upgradingEngine}
              onClick={async () => {
                setUpgradingEngine(true);
                try {
                  await onUpgradeEngine();
                } finally {
                  setUpgradingEngine(false);
                }
              }}
            >
              {upgradingEngine ? "Upgrading…" : "Upgrade engine"}
            </button>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="cl-empty">
          <h3>No climbs running yet</h3>
          <p>
            When an agent runs <code>climb.py</code> in this project or a swarm worktree, its live score trajectory and
            every edit it tries will show up here.
          </p>
        </div>
      ) : (
        <>
          {visible.length > 1 ? (
            <label className="cl-compact-picker">
              <span className="cl-muted cl-small">Climb</span>
              <select
                value={chosen?.id ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-label="Select climb"
              >
                {visible.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {statusOf(c.verdict, c).label}
                    {c.status === "active" ? ` (${fmtNum(c.baseline)} → ${fmtNum(c.best)})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="cl-grid">
            <div className="cl-list" role="listbox" aria-label="Climbs">
              {visible.map((climb) => {
                const st = statusOf(climb.verdict, climb);
                const pct = progressPct(climb);
                const isSelected = chosen?.id === climb.id;
                return (
                  <button
                    key={climb.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`cl-item${isSelected ? " is-selected" : ""}`}
                    onClick={() => setSelectedId(climb.id)}
                  >
                    <div className="cl-item-top">
                      <span className="cl-item-name">{climb.name}</span>
                      <span className={`cl-pill cl-pill-${st.tone}`}>
                        {st.tone === "prep" || st.tone === "live" ? <i className="cl-pulse" /> : null}
                        {st.label}
                      </span>
                    </div>

                    <div className="cl-item-meta">
                      <span>
                        {climb.origin === "antigravity"
                          ? `Swarm · ${climb.workerLabel}`
                          : climb.origin === "archived"
                            ? `${climb.workerLabel} (archived)`
                            : climb.workerLabel}
                      </span>
                      {climb.updatedAt ? <span>{relativeTime(climb.updatedAt)}</span> : null}
                    </div>

                    {climb.status === "active" ? (
                      <>
                        <div className="cl-item-score">
                          <span className="cl-score-nums">
                            <strong>{fmtNum(climb.baseline)}</strong>
                            <span className="cl-arrow">→</span>
                            <strong>{fmtNum(climb.best)}</strong>
                          </span>
                          {climb.target !== null ? (
                            <span className="cl-muted">target {climb.targetText ?? fmtNum(climb.target)}</span>
                          ) : null}
                          <span className="cl-muted">
                            {climb.kept}/{climb.steps} kept
                          </span>
                        </div>
                        {pct !== null ? (
                          <div className="cl-bar" aria-hidden="true">
                            <span className={`cl-bar-fill cl-bar-${st.tone}`} style={{ width: `${pct}%` }} />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="cl-muted cl-small">
                        Staging benchmark ({climb.preparedFiles} {climb.preparedFiles === 1 ? "file" : "files"}) —
                        waiting for baseline
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {chosen ? (
              <article className="cl-detail">
                <header className="cl-detail-head">
                  <div>
                    <div className="cl-detail-title-row">
                      <h2>{chosen.name}</h2>
                      <span className={`cl-pill cl-pill-${statusOf(chosen.verdict, chosen).tone}`}>
                        {chosen.running ? <i className="cl-pulse" /> : null}
                        {statusOf(chosen.verdict, chosen).label}
                      </span>
                    </div>
                    <p className="cl-muted cl-small">
                      {chosen.origin === "antigravity"
                        ? `Antigravity swarm worker (${chosen.workerLabel})`
                        : chosen.origin === "archived"
                          ? `Archived worktree (${chosen.workerLabel})`
                          : "Local checkout"}
                      {chosen.branch ? ` · branch ${chosen.branch}` : ""}
                      {chosen.avgCheckSeconds ? ` · ~${fmtDuration(chosen.avgCheckSeconds)}/check` : ""}
                      {chosen.updatedAt ? ` · updated ${relativeTime(chosen.updatedAt)}` : ""}
                    </p>
                  </div>
                  <div className="cl-detail-actions">
                    {onAttachContext ? (
                      <button
                        type="button"
                        className={`hill-action-btn hc-attach-btn${attachedContextId === `climb:${chosen.id}` ? " is-attached" : ""}`}
                        aria-pressed={attachedContextId === `climb:${chosen.id}`}
                        title="Attach this climb's diagnostics, warnings, and steps as context for your next chat message"
                        onClick={() => void onAttachContext(`climb:${chosen.id}`, `climb "${chosen.name}"`, buildClimbContextMarkdown(chosen))}
                      >
                        {attachedContextId === `climb:${chosen.id}` ? "Attached ✓" : "Attach to chat"}
                      </button>
                    ) : null}
                    {chosen.outcomeKey ? (
                      <button
                        type="button"
                        className="cl-outcome-link"
                        onClick={() => onOpenOutcome?.(chosen.outcomeKey!)}
                      >
                        Outcome: {chosen.outcomeKey} ↗
                      </button>
                    ) : onTrackClimb ? (
                      <button
                        type="button"
                        className="hill-action-btn"
                        disabled={trackingId === chosen.id}
                        onClick={async () => {
                          setTrackingId(chosen.id);
                          try {
                            await onTrackClimb(chosen.id);
                          } finally {
                            setTrackingId(null);
                          }
                        }}
                      >
                        {trackingId === chosen.id ? "Tracking…" : "+ Track as Outcome"}
                      </button>
                    ) : null}
                  </div>
                </header>

                {chosen.running ? (
                  <RunningBanner running={chosen.running} avgSeconds={chosen.avgCheckSeconds} />
                ) : null}

                <div className={`cl-summary cl-summary-${statusOf(chosen.verdict, chosen).tone}`}>
                  <p>{plainSummary(chosen)}</p>
                  {chosen.goal ? <p className="cl-goal"><strong>Goal:</strong> {chosen.goal}</p> : null}
                </div>

                {chosen.status === "prepared" ? (
                  <div className="cl-section">
                    <div className="cl-section-label">Staged files so far ({chosen.preparedFiles})</div>
                    {chosen.preparedSampleFiles.length > 0 ? (
                      <ul className="cl-file-list">
                        {chosen.preparedSampleFiles.map((f) => (
                          <li key={f}>
                            {onOpenFile ? (
                              <button
                                type="button"
                                className="hc-link hc-file-link"
                                onClick={() => void onOpenFile(`.hill-climb/${chosen.name}/${f}`, chosen.directory)}
                              >
                                <code>.hill-climb/{chosen.name}/{f}</code> ↗
                              </button>
                            ) : (
                              <code>.hill-climb/{chosen.name}/{f}</code>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="cl-muted cl-small">Directory created; waiting for benchmark scripts and data.</p>
                    )}
                  </div>
                ) : (
                  <>
                    <HealthStrip climb={chosen} />

                    <div className="cl-stats">
                      <div className="cl-stat">
                        <span className="cl-stat-label">Started at</span>
                        <strong className="cl-stat-val">{fmtNum(chosen.baseline)}</strong>
                      </div>
                      <div className="cl-stat">
                        <span className="cl-stat-label">Best so far</span>
                        <strong className="cl-stat-val cl-stat-ok">{fmtNum(chosen.best)}</strong>
                        {chosen.baseline !== null && chosen.best !== null && chosen.best !== chosen.baseline ? (
                          <span className="cl-stat-sub">{fmtSigned(chosen.best - chosen.baseline)}</span>
                        ) : null}
                      </div>
                      <div className="cl-stat">
                        <span className="cl-stat-label">Target</span>
                        <strong className="cl-stat-val">{chosen.targetText ?? fmtNum(chosen.target)}</strong>
                      </div>
                      <div className="cl-stat">
                        <span className="cl-stat-label">Edits kept</span>
                        <strong className="cl-stat-val">
                          {chosen.kept} <span className="cl-muted">/ {chosen.steps}</span>
                        </strong>
                        {chosen.sinceGain > 0 ? (
                          <span className="cl-stat-sub">{chosen.sinceGain} since gain</span>
                        ) : null}
                      </div>
                      {(() => {
                        const holdouts = chosen.rows.filter(
                          (r) => r.kind === "holdout" && typeof r.score === "number" && Number.isFinite(r.score),
                        );
                        if (holdouts.length === 0) return null;
                        const latest = holdouts[holdouts.length - 1]!.score!;
                        const first = holdouts[0]!.score!;
                        return (
                          <div className="cl-stat">
                            <span className="cl-stat-label">Holdout</span>
                            <strong
                              className={`cl-stat-val${
                                chosen.health?.overfitWarning
                                  ? " cl-stat-bad"
                                  : typeof chosen.holdoutGain === "number" && chosen.holdoutGain > 1e-9
                                    ? " cl-stat-ok"
                                    : ""
                              }`}
                            >
                              {fmtNum(latest)}
                            </strong>
                            {holdouts.length > 1 ? (
                              <span className="cl-stat-sub">
                                {fmtSigned(latest - first)} from {fmtNum(first)}
                              </span>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>

                    <ScoreChart climb={chosen} />
                    <BreakdownCard climb={chosen} onOpenFile={onOpenFile} />
                    <StepTimeline key={chosen.id} climb={chosen} />

                    {chosen.notes ? (
                      <details className="cl-disclosure">
                        <summary className="cl-disclosure-row">
                          <span>
                            Agent notes (notes.md)
                            {chosen.health?.notesWarning ? (
                              <span className="cl-pill cl-pill-warn" style={{ marginLeft: 8 }}>
                                Stale ({chosen.notesStaleSteps} steps)
                              </span>
                            ) : null}
                          </span>
                          {onOpenFile ? (
                            <button
                              type="button"
                              className="hc-link hc-file-link"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void onOpenFile(`.hill-climb/${chosen.name}/notes.md`, chosen.directory);
                              }}
                            >
                              Open file ↗
                            </button>
                          ) : null}
                        </summary>
                        <pre className="cl-pre">{chosen.notes}</pre>
                      </details>
                    ) : null}

                    <details className="cl-disclosure">
                      <summary className="cl-disclosure-row">
                        <span>How it scores &amp; guardrails</span>
                        {onOpenFile ? (
                          <button
                            type="button"
                            className="hc-link hc-file-link"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void onOpenFile(`.hill-climb/${chosen.name}/card.json`, chosen.directory);
                            }}
                          >
                            Open card.json ↗
                          </button>
                        ) : null}
                      </summary>
                      <dl className="cl-kv">
                        <dt>Scoring check</dt>
                        <dd><code>{chosen.check.join(" ; ") || "—"}</code></dd>
                        {chosen.probe ? (
                          <>
                            <dt>Fast probe</dt>
                            <dd><code>{chosen.probe}</code></dd>
                          </>
                        ) : null}
                        <dt>Direction</dt>
                        <dd>{chosen.direction === "min" ? "Lower is better" : "Higher is better"} ({chosen.scoreMode ?? "failure-count"})</dd>
                        <dt>Regression guards</dt>
                        <dd><code>{chosen.guards.join(" ; ") || "none"}</code></dd>
                        <dt>Holdout check</dt>
                        <dd>
                          <code>{chosen.holdout ?? "none"}</code>
                          {chosen.holdoutEvery ? (
                            <span className="cl-muted"> (auto every {chosen.holdoutEvery} kept steps)</span>
                          ) : null}
                        </dd>
                        <dt>Locked files</dt>
                        <dd>
                          {chosen.locked.length === 0 ? (
                            <code>none</code>
                          ) : onOpenFile ? (
                            <span className="hc-inline-group">
                              {chosen.locked.map((file) => (
                                <button
                                  key={file}
                                  type="button"
                                  className="hc-chip hc-file-chip"
                                  onClick={() => void onOpenFile(file, chosen.directory)}
                                >
                                  <code>{file}</code> ↗
                                </button>
                              ))}
                            </span>
                          ) : (
                            <code>{chosen.locked.join(", ")}</code>
                          )}
                        </dd>
                        <dt>Worktree path</dt>
                        <dd><code>{chosen.directory}</code></dd>
                      </dl>
                    </details>
                  </>
                )}
              </article>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
