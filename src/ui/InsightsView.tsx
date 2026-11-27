import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { InsightsDto } from "../view-props.js";

export interface InsightsViewProps {
  projectId: string;
  track: string;
  loadInsights: (days: number) => Promise<InsightsDto>;
  onSelectOutcome: (key: string) => void;
  onOpenClimbs: () => void;
}

const DAY_OPTIONS = [7, 14, 30, 90] as const;

export function InsightsView(props: InsightsViewProps): JSX.Element {
  const { projectId, track, loadInsights, onSelectOutcome, onOpenClimbs } = props;
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<InsightsDto | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void loadInsights(days)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setSelectedDay(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, track, days, loadInsights]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    void loadInsights(days)
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  const maxDayVal = data ? Math.max(1, ...data.byDay.map((d) => d.verified + d.broken)) : 1;
  const activeBucket = data && selectedDay ? data.byDay.find((b) => b.date === selectedDay) ?? null : null;

  return (
    <section className="pf hc-insights" aria-label="Insights">
      <header className="pf-head">
        <div>
          <h2 className="pf-title">Insights</h2>
          <p className="pf-sub">
            Progress, verification rate, and climb performance · track <strong>{track}</strong>
          </p>
        </div>
        <div className="pf-actions">
          <div className="cl-seg" role="group" aria-label="Time range">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={days === d ? "is-active" : ""}
                aria-pressed={days === d}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
          <button type="button" className="pf-btn pf-btn-ghost" disabled={loading} onClick={refresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <p className="pf-error" role="alert">
          {error}
        </p>
      ) : null}

      {!data ? (
        <p className="pf-muted">{loading ? "Computing insights…" : "No insights available yet."}</p>
      ) : (
        <>
          <div className="hc-kpi-grid">
            <div className="hc-kpi-card">
              <span className="hc-kpi-label">Verified rate</span>
              <strong className="hc-kpi-val">{data.totals.verifiedRatePct}%</strong>
              <span className="pf-muted pf-small">
                {data.totals.bySignal.verified}/{data.totals.outcomes} outcomes
              </span>
            </div>
            <div className="hc-kpi-card">
              <span className="hc-kpi-label">Verification streak</span>
              <strong className="hc-kpi-val">{data.streakDays}d</strong>
              <span className="pf-muted pf-small">consecutive active days</span>
            </div>
            <div className="hc-kpi-card">
              <span className="hc-kpi-label">Ready / Blocked</span>
              <strong className="hc-kpi-val">
                {data.totals.readyNext} / {data.totals.blockedManual + data.totals.blockedByDependency}
              </strong>
              <span className="pf-muted pf-small">
                {data.totals.deferred > 0 ? `${data.totals.deferred} deferred · ` : ""}
                {data.totals.inbox} pending
              </span>
            </div>
            <div className="hc-kpi-card">
              <span className="hc-kpi-label">Climb keep rate</span>
              <strong className="hc-kpi-val">
                {data.climbs.keepRatePct !== null ? `${data.climbs.keepRatePct}%` : "—"}
              </strong>
              <span className="pf-muted pf-small">
                {data.climbs.keptSteps}/{data.climbs.totalSteps} steps · {data.climbs.totalClimbs} climb
                {data.climbs.totalClimbs === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <section className="pf-card" aria-labelledby="hc-ins-daily">
            <header className="pf-card-head">
              <div>
                <h3 className="pf-card-title" id="hc-ins-daily">
                  Outcomes verified per day ({days}d)
                </h3>
                <p className="pf-muted pf-small">Click any bar to inspect outcomes confirmed or broken that day.</p>
              </div>
              <span className="pf-muted pf-small">
                {data.byDay.reduce((sum, b) => sum + b.verified, 0)} verified ·{" "}
                {data.byDay.reduce((sum, b) => sum + b.broken, 0)} broken
              </span>
            </header>

            {data.byDay.length === 0 ? (
              <p className="pf-muted pf-small">No daily verification events recorded in the last {days} days.</p>
            ) : (
              <div className="hc-bar-chart" role="list" aria-label="Daily verifications chart">
                {data.byDay.map((bucket) => {
                  const total = bucket.verified + bucket.broken;
                  const verifiedH = Math.round((bucket.verified / maxDayVal) * 100);
                  const brokenH = Math.round((bucket.broken / maxDayVal) * 100);
                  const isSelected = selectedDay === bucket.date;
                  return (
                    <button
                      key={bucket.date}
                      type="button"
                      role="listitem"
                      className={`hc-bar-col${isSelected ? " is-selected" : ""}`}
                      title={`${bucket.date}: ${bucket.verified} verified, ${bucket.broken} broken (${bucket.evidenceCount} evidence)`}
                      onClick={() => setSelectedDay(isSelected ? null : bucket.date)}
                    >
                      <span className="hc-bar-track">
                        {bucket.broken > 0 ? (
                          <span className="hc-bar-seg hc-bar-broken" style={{ height: `${Math.max(8, brokenH)}%` }} />
                        ) : null}
                        {bucket.verified > 0 ? (
                          <span className="hc-bar-seg hc-bar-verified" style={{ height: `${Math.max(8, verifiedH)}%` }} />
                        ) : null}
                        {total === 0 ? <span className="hc-bar-seg hc-bar-zero" /> : null}
                      </span>
                      <span className="hc-bar-label">{bucket.date.slice(5)}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {activeBucket ? (
              <div className="hc-day-detail">
                <strong>{activeBucket.date}</strong>: {activeBucket.verified} verified, {activeBucket.broken} broken (
                {activeBucket.evidenceCount} evidence rows)
                {activeBucket.outcomeKeys.length > 0 ? (
                  <div className="pf-actions" style={{ marginTop: 6 }}>
                    {activeBucket.outcomeKeys.map((k) => (
                      <button key={k} type="button" className="pf-chip" onClick={() => onSelectOutcome(k)}>
                        {k}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <div className="pf-cols">
            <section className="pf-card" aria-labelledby="hc-ins-climbs">
              <header className="pf-card-head">
                <div>
                  <h3 className="pf-card-title" id="hc-ins-climbs">
                    Climb performance
                  </h3>
                  <p className="pf-muted pf-small">Kept edits, regression guards, and holdout checks.</p>
                </div>
                <button type="button" className="pf-btn pf-btn-ghost" onClick={onOpenClimbs}>
                  Open Climbs →
                </button>
              </header>
              <table className="pf-table">
                <tbody>
                  <tr>
                    <th>Active / Total climbs</th>
                    <td>
                      <strong>{data.climbs.activeClimbs}</strong> active · {data.climbs.totalClimbs} total ·{" "}
                      {data.climbs.barReachedCount} bar reached
                    </td>
                  </tr>
                  <tr>
                    <th>Steps kept vs. undone</th>
                    <td>
                      {data.climbs.keptSteps} kept / {data.climbs.discardedSteps} undone (
                      {data.climbs.keepRatePct !== null ? `${data.climbs.keepRatePct}%` : "n/a"})
                    </td>
                  </tr>
                  <tr>
                    <th>Guard regressions caught</th>
                    <td>
                      <strong>{data.climbs.guardRegressionsCaught}</strong>
                    </td>
                  </tr>
                  <tr>
                    <th>Unseen holdout checks</th>
                    <td>
                      <strong>{data.climbs.holdoutChecksRun}</strong>
                      {data.climbs.largestHoldoutGap ? (
                        <div className="pf-muted pf-small">
                          Largest dev-vs-holdout gap: <code>{data.climbs.largestHoldoutGap.climb}</code> (dev{" "}
                          {data.climbs.largestHoldoutGap.devScore} vs. holdout {data.climbs.largestHoldoutGap.holdoutScore}, Δ{" "}
                          {data.climbs.largestHoldoutGap.gap})
                        </div>
                      ) : null}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="pf-card" aria-labelledby="hc-ins-actors">
              <header className="pf-card-head">
                <div>
                  <h3 className="pf-card-title" id="hc-ins-actors">
                    Activity by contributor
                  </h3>
                  <p className="pf-muted pf-small">Human, agent, CI, and climb contributions.</p>
                </div>
              </header>
              {data.byActor.length === 0 ? (
                <p className="pf-muted pf-small">No actor-attributed evidence or actions yet.</p>
              ) : (
                <table className="pf-table">
                  <thead>
                    <tr>
                      <th scope="col">Actor</th>
                      <th scope="col">Via</th>
                      <th scope="col">Confirms</th>
                      <th scope="col">Denies</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byActor.map((row) => (
                      <tr key={`${row.actor}:${row.via}`}>
                        <td>
                          <code>{row.actor}</code>
                        </td>
                        <td>
                          <span className="pf-pill">{row.via}</span>
                        </td>
                        <td>{row.confirms}</td>
                        <td>{row.denies}</td>
                        <td>{row.actions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="pf-card" aria-labelledby="hc-ins-recent">
            <h3 className="pf-card-title" id="hc-ins-recent">
              Recent verifications
            </h3>
            {data.recentVerifications.length === 0 ? (
              <p className="pf-muted pf-small">No confirming evidence recorded yet on track {track}.</p>
            ) : (
              <table className="pf-table">
                <thead>
                  <tr>
                    <th scope="col">Outcome</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Actor</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentVerifications.slice(0, 15).map((item) => (
                    <tr key={`${item.evidenceId}:${item.at}`}>
                      <td>
                        <button type="button" className="pf-link" onClick={() => onSelectOutcome(item.key)}>
                          <code>{item.key}</code> {item.title}
                        </button>
                      </td>
                      <td className="pf-muted pf-small">
                        <code>{item.evidenceId}</code> · {item.source}
                      </td>
                      <td className="pf-small">
                        <code>{item.actor}</code> <span className="pf-muted">({item.via})</span>
                      </td>
                      <td className="pf-muted pf-small">{new Date(item.at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </section>
  );
}
