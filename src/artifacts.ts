import type { ArtifactRecord, Repository } from "./repository.js";
import type { ScannedProjectClimbs } from "./repo-ops.js";
import { computeInsights } from "./insights.js";
import { redactSecrets } from "./state.js";

export type ArtifactTemplateId =
  | "weekly-update"
  | "release-readiness"
  | "climb-experiment-report"
  | "compliance-audit"
  | "postmortem";

export const ARTIFACT_TEMPLATES: ReadonlyArray<{
  id: ArtifactTemplateId;
  title: string;
  folder: string;
  description: string;
}> = [
  {
    id: "weekly-update",
    title: "Weekly Progress Update",
    folder: "Updates",
    description: "Evidence-backed weekly summary of verified outcomes, blockers, inbox decisions, and live climb gains.",
  },
  {
    id: "release-readiness",
    title: "Release Readiness Brief",
    folder: "Releases",
    description: "Per-release verification coverage, unproven gaps, and sign-off provenance.",
  },
  {
    id: "climb-experiment-report",
    title: "Climb & Eval Experiment Report",
    folder: "Experiments",
    description: "Inner-loop climb trajectories, baseline-to-best gains, dev vs. unseen holdout checks, and keep rates.",
  },
  {
    id: "compliance-audit",
    title: "Contract & Evidence Audit Pack",
    folder: "Compliance",
    description: "Version-scoped contract ledger with confirming evidence IDs, sources, and actor provenance.",
  },
  {
    id: "postmortem",
    title: "Regression Postmortem",
    folder: "Postmortems",
    description: "Broken outcomes, denying evidence records, root-cause guardrails, and follow-up outcomes.",
  },
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateArtifactFromTemplate(
  repo: Repository,
  projectId: string,
  opts: {
    template: ArtifactTemplateId;
    title?: string;
    folder?: string;
    releaseName?: string;
    days?: number;
    track?: string;
    scannedClimbs?: ScannedProjectClimbs | null;
    actor?: string | null;
    save?: boolean;
  },
): { title: string; folder: string; body: string; citations: string[]; saved?: ArtifactRecord } {
  const track = opts.track ?? "main";
  const days = opts.days ?? 7;
  const snap = repo.view(projectId, track);
  const insights = computeInsights(repo, projectId, { days, track, scannedClimbs: opts.scannedClimbs });
  const proj = repo.getProject(projectId);
  const projName = proj?.name ?? projectId;
  const today = new Date().toISOString().slice(0, 10);
  const citations = new Set<string>();
  const lines: string[] = [];

  const tplMeta = ARTIFACT_TEMPLATES.find((t) => t.id === opts.template);
  const folder = opts.folder?.trim() || tplMeta?.folder || "General";
  const title = opts.title?.trim() || `${tplMeta?.title ?? opts.template} — ${projName} (${today})`;

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- **Project:** ${projName} (\`${projectId}\`)`);
  lines.push(`- **Track:** \`${track}\` · **Generated:** ${insights.generatedAt}`);
  lines.push(
    `- **Coverage:** ${insights.totals.bySignal.verified + insights.totals.bySignal.recheck}/${insights.totals.outcomes} outcomes verified (${insights.totals.verifiedRatePct}%) · ${insights.totals.bySignal.broken} broken · ${insights.totals.inbox} inbox pending`,
  );
  lines.push("");

  if (opts.template === "release-readiness") {
    const releases = opts.releaseName
      ? snap.releases.filter((r) => r.name.toLowerCase() === opts.releaseName!.toLowerCase())
      : snap.releases;
    lines.push("## Release Readiness");
    lines.push("");
    if (releases.length === 0) {
      lines.push("_No releases defined yet. Create a release in Roadmap to track launch readiness._");
    } else {
      const rankMap = new Map(snap.ranked.map((r) => [r.key, r]));
      const outMap = new Map(snap.outcomes.map((o) => [o.key, o]));
      for (const rel of releases) {
        const ready = rel.keys.filter((k) => {
          const sig = rankMap.get(k)?.signal;
          return sig === "verified" || sig === "recheck";
        });
        const pct = rel.keys.length > 0 ? Math.round((ready.length / rel.keys.length) * 100) : 0;
        lines.push(`### ${rel.name} (${rel.scenario}) — Target ${rel.date} · ${pct}% ready (${ready.length}/${rel.keys.length})`);
        lines.push("");
        for (const k of rel.keys) {
          const r = rankMap.get(k);
          const o = outMap.get(k);
          citations.add(`outcome:${k}@v${o?.version ?? 1}`);
          lines.push(`- \`${k}\` **${o?.title ?? k}** — \`${r?.signal ?? "unverified"}\`${r?.blockedBy.length ? ` (blocked by ${r.blockedBy.join(", ")})` : ""}`);
        }
        lines.push("");
      }
    }
  } else if (opts.template === "climb-experiment-report") {
    const climbs = opts.scannedClimbs?.climbs ?? [];
    lines.push("## Inner-Loop Climb & Eval Summary");
    lines.push("");
    lines.push(
      `- **Climbs scanned:** ${insights.climbs.totalClimbs} (${insights.climbs.activeClimbs} active, ${insights.climbs.barReachedCount} bar reached)`,
    );
    lines.push(
      `- **Step efficiency:** ${insights.climbs.keptSteps}/${insights.climbs.totalSteps} kept (${insights.climbs.keepRatePct ?? 0}% keep rate) · ${insights.climbs.guardRegressionsCaught} guard regressions blocked · ${insights.climbs.holdoutChecksRun} unseen holdout runs`,
    );
    if (insights.climbs.largestHoldoutGap) {
      const g = insights.climbs.largestHoldoutGap;
      lines.push(`- **Largest dev-vs-holdout catch:** \`${g.climb}\` (dev \`${g.devScore}\` vs. holdout \`${g.holdoutScore}\`, gap \`${g.gap}\`)`);
    }
    lines.push("");
    if (climbs.length > 0) {
      lines.push("| Climb | Origin | Direction | Baseline | Best | Target | Holdout | Steps (Kept) | Verdict |");
      lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
      for (const c of climbs) {
        const holdoutScore = [...c.rows].reverse().find((r) => r.kind === "holdout" && typeof r.score === "number")?.score ?? null;
        citations.add(`climb:${c.name}`);
        lines.push(
          `| \`${c.name}\` | ${c.workerLabel} | ${c.direction ?? "—"} | ${c.baseline ?? "—"} | ${c.best ?? "—"} | ${c.target ?? "—"} | ${holdoutScore ?? "—"} | ${c.steps} (${c.kept}) | ${c.verdict} |`,
        );
      }
      lines.push("");
    }
  } else if (opts.template === "compliance-audit") {
    lines.push("## Contract & Evidence Ledger");
    lines.push("");
    const rankMap = new Map(snap.ranked.map((r) => [r.key, r]));
    for (const o of snap.outcomes) {
      const r = rankMap.get(o.key);
      citations.add(`outcome:${o.key}@v${o.version}`);
      lines.push(`### ${o.key} v${o.version} — ${o.title} (\`${r?.signal ?? "unverified"}\`)`);
      lines.push("");
      lines.push(`> ${o.story}`);
      lines.push("");
      const evs = snap.evidence.filter((e) => e.key === o.key && e.track === track && e.version === o.version);
      if (evs.length === 0) {
        lines.push("- _No current-version evidence recorded._");
      } else {
        for (const e of evs) {
          citations.add(`evidence:${e.id}`);
          lines.push(`- \`${e.id}\` **${e.kind}** [${e.criterionIds.join(", ") || "all"}] — ${e.text} _(source: \`${e.source}\`, ${e.created})_`);
        }
      }
      lines.push("");
    }
  } else if (opts.template === "postmortem") {
    lines.push("## Broken Outcomes & Regressions");
    lines.push("");
    const broken = snap.ranked.filter((r) => r.signal === "broken");
    if (broken.length === 0) {
      lines.push("_No outcomes are currently broken on this track._");
    } else {
      for (const r of broken) {
        const o = snap.outcomes.find((x) => x.key === r.key);
        citations.add(`outcome:${r.key}@v${o?.version ?? 1}`);
        lines.push(`### ${r.key} — ${o?.title ?? r.key}`);
        const denies = snap.evidence.filter((e) => e.key === r.key && e.track === track && e.kind === "denies");
        for (const d of denies.slice(-5)) {
          citations.add(`evidence:${d.id}`);
          lines.push(`- \`${d.id}\` (${d.created}) [${d.criterionIds.join(", ") || "all"}]: ${d.text} _(source: \`${d.source}\`)_`);
        }
        lines.push("");
      }
    }
  } else {
    // weekly-update
    lines.push(`## Verified in the Last ${days} Days`);
    lines.push("");
    if (insights.recentVerifications.length === 0) {
      lines.push(`_No outcomes confirmed in the last ${days} days._`);
    } else {
      for (const v of insights.recentVerifications.slice(0, 20)) {
        citations.add(`outcome:${v.key}`);
        citations.add(`evidence:${v.evidenceId}`);
        lines.push(`- \`${v.key}\` **${v.title}** — verified via \`${v.source}\` by \`${v.actor}\` (${v.at.slice(0, 10)})`);
      }
    }
    lines.push("");
    if (insights.climbs.totalClimbs > 0) {
      lines.push("## Optimization Climbs");
      lines.push("");
      lines.push(
        `${insights.climbs.totalClimbs} climb(s) scanned · ${insights.climbs.keptSteps}/${insights.climbs.totalSteps} edits kept (${insights.climbs.keepRatePct ?? 0}%) · ${insights.climbs.barReachedCount} reached bar · ${insights.climbs.holdoutChecksRun} unseen holdout check(s).`,
      );
      lines.push("");
    }
    const blockers = snap.ranked.filter(
      (r) => r.signal === "broken" || r.availability === "blocked" || r.blockedBy.length > 0,
    );
    if (blockers.length > 0) {
      lines.push("## Risks & Blockers");
      lines.push("");
      for (const b of blockers.slice(0, 15)) {
        const o = snap.outcomes.find((x) => x.key === b.key);
        const why =
          b.signal === "broken"
            ? "broken (failing evidence)"
            : b.availability === "blocked"
              ? `blocked: ${b.availabilityReason ?? "external"}`
              : `waiting on ${b.blockedBy.join(", ")}`;
        lines.push(`- \`${b.key}\` **${o?.title ?? b.key}** — ${why}`);
      }
      lines.push("");
    }
  }

  const body = redactSecrets(lines.join("\n").trim() + "\n");
  const citationList = [...citations];
  if (opts.save) {
    const saved = repo.saveArtifact(projectId, {
      folder,
      title,
      template: opts.template,
      body,
      citations: citationList,
      actor: opts.actor ?? null,
    });
    return { title: saved.title, folder: saved.folder, body: saved.body, citations: saved.citations, saved };
  }
  return { title, folder, body, citations: citationList };
}

export function exportShareableReport(
  repo: Repository,
  projectId: string,
  opts?: {
    format?: "html" | "markdown";
    track?: string;
    scope?: string;
    releaseName?: string;
    goalKey?: string;
    scannedClimbs?: ScannedProjectClimbs | null;
  },
): { format: "html" | "markdown"; filename: string; content: string; outcomesIncluded: number } {
  const format = opts?.format ?? "html";
  const track = opts?.track ?? "main";
  const snap = repo.view(projectId, track);
  const insights = computeInsights(repo, projectId, { days: 30, track, scannedClimbs: opts?.scannedClimbs });
  const proj = repo.getProject(projectId);
  const projName = proj?.name ?? projectId;

  let allowedKeys: Set<string> | null = null;
  if (opts?.releaseName) {
    const rel = snap.releases.find((r) => r.name.toLowerCase() === opts.releaseName!.toLowerCase());
    allowedKeys = new Set(rel?.keys ?? []);
  } else if (opts?.goalKey) {
    allowedKeys = new Set(snap.ranked.filter((r) => r.ancestors.some((g) => g.key === opts.goalKey)).map((r) => r.key));
  } else if (opts?.scope) {
    allowedKeys = repo.resolveScopeOutcomeKeys(projectId, opts.scope, snap);
  }

  const ranked = allowedKeys ? snap.ranked.filter((r) => allowedKeys!.has(r.key)) : snap.ranked;
  const outByKey = new Map(snap.outcomes.map((o) => [o.key, o]));
  const slug = projName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "hillclimb";
  const dateTag = new Date().toISOString().slice(0, 10);

  if (format === "markdown") {
    const gen = generateArtifactFromTemplate(repo, projectId, {
      template: opts?.releaseName ? "release-readiness" : "weekly-update",
      releaseName: opts?.releaseName,
      track,
      scannedClimbs: opts?.scannedClimbs,
      save: false,
    });
    return {
      format: "markdown",
      filename: `${slug}-report-${dateTag}.md`,
      content: gen.body,
      outcomesIncluded: ranked.length,
    };
  }

  const verifiedCount = ranked.filter((r) => r.signal === "verified" || r.signal === "recheck").length;
  const pct = ranked.length > 0 ? Math.round((verifiedCount / ranked.length) * 100) : 0;
  const climbs = opts?.scannedClimbs?.climbs ?? [];

  const outcomeRows = ranked
    .map((r, idx) => {
      const o = outByKey.get(r.key);
      const tags = (r.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const avail =
        r.availability && r.availability !== "active"
          ? `<span class="pill pill-warn">${escapeHtml(r.availability)}${r.availabilityReason ? `: ${escapeHtml(r.availabilityReason)}` : ""}</span>`
          : "";
      const criteriaHtml = (o?.criteria ?? [])
        .map(
          (c) =>
            `<li><code>${escapeHtml(c.id)}</code> Given ${escapeHtml(redactSecrets(c.given))}, when ${escapeHtml(redactSecrets(c.when))}, then ${escapeHtml(redactSecrets(c.then))}</li>`,
        )
        .join("");
      return `<tr>
        <td class="mono">#${idx + 1}</td>
        <td><code class="key">${escapeHtml(r.key)}</code> <strong>${escapeHtml(redactSecrets(o?.title ?? r.key))}</strong><div class="sub">${escapeHtml(redactSecrets(o?.story ?? ""))}</div>${tags}${avail}${criteriaHtml ? `<ul class="crit">${criteriaHtml}</ul>` : ""}</td>
        <td><span class="sig sig-${escapeHtml(r.signal)}">${escapeHtml(r.signal)}</span></td>
        <td class="mono">v${o?.version ?? 1}</td>
      </tr>`;
    })
    .join("\n");

  const climbRows = climbs
    .map((c) => {
      const holdoutScore = [...c.rows].reverse().find((r) => r.kind === "holdout" && typeof r.score === "number")?.score ?? null;
      return `<tr>
        <td><code>${escapeHtml(c.name)}</code><div class="sub">${escapeHtml(c.workerLabel)}</div></td>
        <td class="mono">${c.baseline ?? "—"}</td>
        <td class="mono"><strong>${c.best ?? "—"}</strong></td>
        <td class="mono">${c.target ?? "—"}</td>
        <td class="mono">${holdoutScore ?? "—"}</td>
        <td class="mono">${c.kept}/${c.steps}</td>
        <td><span class="pill">${escapeHtml(c.verdict)}</span></td>
      </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Hill Climb Snapshot — ${escapeHtml(projName)}</title>
<style>
  :root { color-scheme: light dark; --bg: #0f1115; --card: #171a21; --ink: #e8ecf2; --muted: #9aa4b2; --line: #282e3b; --ok: #22c55e; --bad: #ef4444; --warn: #f59e0b; --accent: #3b82f6; }
  @media (prefers-color-scheme: light) { :root { --bg: #f7f8fa; --card: #ffffff; --ink: #111827; --muted: #5c6573; --line: #e2e6ee; } }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); padding: 28px 20px 56px; }
  main { max-width: 1020px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 24px; }
  h2 { margin: 28px 0 12px; font-size: 16px; }
  .meta { color: var(--muted); font-size: 12.5px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .kpi-label { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-val { font-size: 24px; font-weight: 700; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .key { background: color-mix(in srgb, var(--accent) 16%, transparent); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
  .crit { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
  .sig, .pill, .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; margin-right: 4px; margin-top: 4px; }
  .sig-verified { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .sig-broken { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
  .sig-stale, .sig-recheck, .pill-warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .sig-unverified, .pill, .tag { background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--ink); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Hill Climb · ${escapeHtml(projName)}</h1>
      <div class="meta">Track <code>${escapeHtml(track)}</code>${opts?.releaseName ? ` · Release <strong>${escapeHtml(opts.releaseName)}</strong>` : ""}${opts?.scope ? ` · Scope <strong>${escapeHtml(opts.scope)}</strong>` : ""} · Snapshot generated ${escapeHtml(insights.generatedAt)}</div>
    </div>
    <div class="meta">Self-contained local snapshot · zero external requests</div>
  </header>
  <section class="kpis">
    <div class="kpi"><div class="kpi-label">Verified</div><div class="kpi-val">${pct}%</div><div class="sub">${verifiedCount} of ${ranked.length} outcomes</div></div>
    <div class="kpi"><div class="kpi-label">Broken</div><div class="kpi-val">${insights.totals.bySignal.broken}</div><div class="sub">Failing current evidence</div></div>
    <div class="kpi"><div class="kpi-label">Ready Next</div><div class="kpi-val">${insights.totals.readyNext}</div><div class="sub">Unblocked &amp; unclaimed</div></div>
    <div class="kpi"><div class="kpi-label">Climbs Kept</div><div class="kpi-val">${insights.climbs.keptSteps}/${insights.climbs.totalSteps}</div><div class="sub">${insights.climbs.holdoutChecksRun} unseen holdout check(s)</div></div>
  </section>
  <h2>Outcomes (${ranked.length})</h2>
  <table>
    <thead><tr><th>Rank</th><th>Outcome</th><th>Signal</th><th>Ver</th></tr></thead>
    <tbody>${outcomeRows || '<tr><td colspan="4" class="sub">No outcomes in scope.</td></tr>'}</tbody>
  </table>
  ${
    climbs.length > 0
      ? `<h2>Repo Climbs (${climbs.length})</h2>
  <table>
    <thead><tr><th>Climb</th><th>Baseline</th><th>Best</th><th>Target</th><th>Holdout</th><th>Kept</th><th>Verdict</th></tr></thead>
    <tbody>${climbRows}</tbody>
  </table>`
      : ""
  }
</main>
</body>
</html>
`;

  return {
    format: "html",
    filename: `${slug}-snapshot-${dateTag}.html`,
    content: redactSecrets(html),
    outcomesIncluded: ranked.length,
  };
}
