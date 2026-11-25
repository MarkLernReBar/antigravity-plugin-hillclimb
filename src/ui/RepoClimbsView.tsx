import { useMemo, useState } from "react";

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
  outcomeKey?: string | null;
}

export interface RepoClimbsPayload {
  projectDirectory: string | null;
  engineInstalled: boolean;
  worktreesScanned: number;
  currentCount: number;
  archivedCount: number;
  autoTrackClimbs?: boolean;
  climbs: ScannedClimb[];
}

function fmtNum(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5)));
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

function statusOf(verdict: string): StatusDisplay {
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
  if (climb.verdict === "plateau") {
    return `No improvement in the last ${climb.sinceGain} tries — needs a fresh angle. Best is ${best} (started at ${base}, target ${target}).`;
  }
  const pct = progressPct(climb);
  const pctText = pct !== null ? ` (${pct}% of the way to target ${target})` : "";
  if (climb.baseline === climb.best) {
    return `Started at ${base}${climb.target !== null ? ` aiming for ${target}` : ""}. Waiting for the first winning edit.`;
  }
  return `Moving ${verb} from ${base} to ${best}${pctText} across ${keptWord}${undoneWord}.`;
}

function ScoreChart({ climb }: { climb: ScannedClimb }) {
  const points = useMemo(() => {
    const out: Array<{ idx: number; score: number; label: string; kept: boolean; isBaseline: boolean }> = [];
    if (climb.baseline !== null) {
      out.push({ idx: 0, score: climb.baseline, label: "Start (baseline)", kept: true, isBaseline: true });
    }
    let step = 0;
    for (const r of climb.rows) {
      if (r.kind === "step" && typeof r.score === "number" && Number.isFinite(r.score)) {
        step += 1;
        out.push({
          idx: step,
          score: r.score,
          label: r.idea ?? `Step ${step}`,
          kept: r.result === "kept",
          isBaseline: false,
        });
      }
    }
    return out;
  }, [climb]);

  if (points.length === 0) return null;

  const w = 520;
  const h = 158;
  const l = 50;
  const r = 18;
  const t = 18;
  const b = 26;
  const innerW = w - l - r;
  const innerH = h - t - b;

  const vals = [
    ...points.map((p) => p.score),
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

  const keptPoints = points.map((p, pos) => ({ ...p, pos })).filter((p) => p.kept);
  const linePath = keptPoints
    .map((p, idx) => `${idx === 0 ? "M" : "L"} ${x(p.pos).toFixed(1)} ${y(p.score).toFixed(1)}`)
    .join(" ");

  const areaPath =
    keptPoints.length >= 2
      ? `${linePath} L ${x(keptPoints[keptPoints.length - 1]!.pos).toFixed(1)} ${(t + innerH).toFixed(1)} L ${x(keptPoints[0]!.pos).toFixed(1)} ${(t + innerH).toFixed(1)} Z`
      : "";

  return (
    <div className="cl-chart-card">
      <div className="cl-chart-head">
        <span className="cl-section-label">
          Score history ({climb.direction === "min" ? "lower is better" : "higher is better"})
        </span>
        <div className="cl-chart-legend">
          <span>
            <i className="cl-dot cl-dot-kept" /> Kept
          </span>
          {climb.undone > 0 ? (
            <span>
              <i className="cl-dot cl-dot-undone" /> Discarded
            </span>
          ) : null}
          {climb.target !== null ? (
            <span>
              <i className="cl-dash cl-dash-target" /> Target ({fmtNum(climb.target)})
            </span>
          ) : null}
        </div>
      </div>
      <svg className="cl-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score trajectory for ${climb.name}`}>
        <rect className="cl-chart-bg" x={l} y={t} width={innerW} height={innerH} rx={6} />
        <line className="cl-chart-grid" x1={l} x2={w - r} y1={t + innerH / 2} y2={t + innerH / 2} />

        {climb.target !== null ? (
          <g className="cl-rule-target">
            <line x1={l} x2={w - r} y1={y(climb.target)} y2={y(climb.target)} />
            <text x={l - 8} y={y(climb.target) + 3} textAnchor="end">
              {fmtNum(climb.target)}
            </text>
          </g>
        ) : null}

        <text className="cl-axis" x={l - 8} y={t + 8} textAnchor="end">
          {fmtNum(rawMax)}
        </text>
        {climb.target !== rawMin ? (
          <text className="cl-axis" x={l - 8} y={t + innerH} textAnchor="end">
            {fmtNum(rawMin)}
          </text>
        ) : null}

        {areaPath ? <path className="cl-chart-area" d={areaPath} /> : null}
        {linePath ? <path className="cl-chart-line" d={linePath} /> : null}

        {points.map((p, i) => {
          const cx = x(i);
          const cy = y(p.score);
          return (
            <g key={i}>
              <circle
                className={p.isBaseline ? "cl-pt cl-pt-base" : p.kept ? "cl-pt cl-pt-kept" : "cl-pt cl-pt-undone"}
                cx={cx}
                cy={cy}
                r={p.kept ? 4.5 : 3.5}
              >
                <title>{`${p.label} — score ${fmtNum(p.score)}${p.isBaseline ? "" : p.kept ? " (kept)" : " (discarded)"}`}</title>
              </circle>
              {points.length <= 8 ? (
                <text className="cl-axis" x={cx} y={h - 6} textAnchor="middle">
                  {p.isBaseline ? "Start" : `#${p.idx}`}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StepTimeline({ climb }: { climb: ScannedClimb }) {
  const entries = useMemo(() => {
    let prevScore = climb.baseline;
    const list: Array<{
      index: number;
      kind: string;
      badge: string;
      tone: "ok" | "muted" | "warn" | "info";
      score: number | null;
      delta: string | null;
      text: string;
      time: string;
    }> = [];
    let stepNum = 0;
    for (const row of climb.rows) {
      if (row.kind === "baseline") {
        prevScore = row.score;
        list.push({
          index: list.length,
          kind: "baseline",
          badge: "Baseline",
          tone: "info",
          score: row.score,
          delta: null,
          text: "Measured starting score before any code changes.",
          time: relativeTime(row.time),
        });
        continue;
      }
      if (row.kind === "step") {
        stepNum += 1;
        const kept = row.result === "kept";
        let delta: string | null = null;
        if (prevScore !== null && row.score !== null) {
          const diff = row.score - prevScore;
          if (diff !== 0) delta = `${diff > 0 ? "+" : ""}${fmtNum(diff)}`;
        }
        if (kept && row.score !== null) prevScore = row.score;
        list.push({
          index: list.length,
          kind: "step",
          badge: kept ? `Step ${stepNum} · Kept` : `Step ${stepNum} · Discarded`,
          tone: kept ? "ok" : "muted",
          score: row.score,
          delta,
          text: row.idea ?? "No description recorded",
          time: relativeTime(row.time),
        });
        continue;
      }
      list.push({
        index: list.length,
        kind: row.kind,
        badge:
          row.kind === "relock"
            ? "Check updated"
            : row.kind === "holdout"
              ? "Holdout check"
              : row.kind === "raise"
                ? "Target raised"
                : row.kind,
        tone: row.kind === "relock" ? "warn" : "info",
        score: row.score,
        delta: null,
        text: row.why ?? row.idea ?? "",
        time: relativeTime(row.time),
      });
    }
    return list.reverse();
  }, [climb]);

  if (entries.length === 0) return null;

  return (
    <div className="cl-section">
      <div className="cl-section-label">What happened ({entries.length} events, newest first)</div>
      <ol className="cl-timeline">
        {entries.slice(0, 25).map((e) => (
          <li key={e.index} className={`cl-event cl-event-${e.tone}`}>
            <div className="cl-event-head">
              <span className={`cl-pill cl-pill-${e.tone}`}>{e.badge}</span>
              <span className="cl-event-score">
                {e.score !== null ? <strong>{fmtNum(e.score)}</strong> : null}
                {e.delta ? <span className="cl-delta"> ({e.delta})</span> : null}
              </span>
              {e.time ? <span className="cl-muted">{e.time}</span> : null}
            </div>
            {e.text ? <p className="cl-event-text">{e.text}</p> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RepoClimbsView({
  payload,
  loading,
  onRefresh,
  onToggleAutoTrack,
  onTrackClimb,
  onOpenOutcome,
}: {
  payload: RepoClimbsPayload | null;
  loading: boolean;
  onRefresh: () => void;
  onToggleAutoTrack?: (enabled: boolean) => Promise<void> | void;
  onTrackClimb?: (climbId: string) => Promise<void> | void;
  onOpenOutcome?: (outcomeKey: string) => void;
}) {
  const [scope, setScope] = useState<"current" | "all">("current");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [togglingAuto, setTogglingAuto] = useState(false);

  if (loading && !payload) {
    return <p className="cl-loading" role="status">Checking repository for active climbs…</p>;
  }

  if (!payload || !payload.projectDirectory) {
    return (
      <section className="cl-root">
        <div className="cl-empty">
          <h3>No repository linked</h3>
          <p>
            Click <strong>+ Project</strong> above to link a local git repository. Any active or completed{" "}
            <code>climb.py</code> runs in the repo or its Antigravity swarm worktrees will appear here automatically.
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

      {visible.length === 0 ? (
        <div className="cl-empty">
          <h3>No climbs running yet</h3>
          <p>
            When an agent runs <code>climb.py</code> in this project or a swarm worktree, its live score trajectory and
            every edit it tries will show up here.
          </p>
        </div>
      ) : (
        <div className="cl-grid">
          <div className="cl-list" role="listbox" aria-label="Climbs">
            {visible.map((climb) => {
              const st = statusOf(climb.verdict);
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
                          · {climb.kept}/{climb.steps} kept
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
                    <span className={`cl-pill cl-pill-${statusOf(chosen.verdict).tone}`}>
                      {statusOf(chosen.verdict).label}
                    </span>
                  </div>
                  <p className="cl-muted cl-small">
                    {chosen.origin === "antigravity"
                      ? `Antigravity swarm worker (${chosen.workerLabel})`
                      : chosen.origin === "archived"
                        ? `Archived worktree (${chosen.workerLabel})`
                        : "Local checkout"}
                    {chosen.branch ? ` · branch ${chosen.branch}` : ""}
                    {chosen.updatedAt ? ` · updated ${relativeTime(chosen.updatedAt)}` : ""}
                  </p>
                </div>
                <div className="cl-detail-actions">
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

              <div className={`cl-summary cl-summary-${statusOf(chosen.verdict).tone}`}>
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
                          <code>.hill-climb/{chosen.name}/{f}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="cl-muted cl-small">Directory created; waiting for benchmark scripts and data.</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="cl-stats">
                    <div className="cl-stat">
                      <span className="cl-stat-label">Started at</span>
                      <strong className="cl-stat-val">{fmtNum(chosen.baseline)}</strong>
                    </div>
                    <div className="cl-stat">
                      <span className="cl-stat-label">Best so far</span>
                      <strong className="cl-stat-val cl-stat-ok">{fmtNum(chosen.best)}</strong>
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
                          <strong className="cl-stat-val">
                            {fmtNum(latest)}
                            {holdouts.length > 1 && first !== latest ? (
                              <span className="cl-muted"> (from {fmtNum(first)})</span>
                            ) : null}
                          </strong>
                        </div>
                      );
                    })()}
                  </div>

                  <ScoreChart climb={chosen} />
                  <StepTimeline climb={chosen} />

                  {chosen.notes ? (
                    <details className="cl-disclosure" open>
                      <summary>Agent notes (notes.md)</summary>
                      <pre className="cl-pre">{chosen.notes}</pre>
                    </details>
                  ) : null}

                  <details className="cl-disclosure">
                    <summary>How it scores &amp; guardrails</summary>
                    <dl className="cl-kv">
                      <dt>Scoring check</dt>
                      <dd><code>{chosen.check.join(" ; ") || "—"}</code></dd>
                      <dt>Direction</dt>
                      <dd>{chosen.direction === "min" ? "Lower is better" : "Higher is better"} ({chosen.scoreMode ?? "failure-count"})</dd>
                      <dt>Regression guards</dt>
                      <dd><code>{chosen.guards.join(" ; ") || "none"}</code></dd>
                      <dt>Holdout check</dt>
                      <dd><code>{chosen.holdout ?? "none"}</code></dd>
                      <dt>Locked files</dt>
                      <dd><code>{chosen.locked.join(", ") || "none"}</code></dd>
                      <dt>Worktree path</dt>
                      <dd><code>{chosen.directory}</code></dd>
                    </dl>
                  </details>
                </>
              )}
            </article>
          ) : null}
        </div>
      )}
    </section>
  );
}
