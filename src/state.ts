// Reading a climb's state the way climb.py reads it.
//
// The script is the authority: it decides keep or undo, and its own `status`
// is the last word. This module re-reads the same two files (card.json,
// log.jsonl) and reaches the same verdict, so `hillclimb status` and an
// agent tool can answer without a shell on the repo's machine. Anything that
// changes state stays in the script.

export type Direction = "min" | "max";

export const PLATEAU = 5;
const BARS = "▁▂▃▄▅▆▇█";

export interface ClimbBest {
  score: number;
  step: number;
  commit?: string;
}

export interface ClimbCard {
  name: string;
  goal: string;
  direction: Direction;
  baseline: number;
  target: number | null;
  target_text?: string | null;
  after?: "stop" | "raise" | string;
  best: ClimbBest;
  branch?: string;
  base?: string;
  check?: string | string[];
  score?: string[];
  score_mode?: "numeric" | "failure-count";
  guards?: string[];
  lock?: string[];
  fingerprint?: string | null;
  holdout?: string | null;
  timeout?: number;
  repos?: Array<{ path: string; base?: string; branch?: string }>;
  runs?: number;
  min_gain?: number | string;
  paired?: boolean;
  max_steps?: number | null;
  max_hours?: number | null;
  hard?: boolean;
  started?: number;
}

export type LogKind = "baseline" | "step" | "review" | "holdout" | "raise" | "relock" | "budget";

export interface LogRow {
  time?: string;
  kind: LogKind | string;
  step?: number;
  idea?: string;
  result?: "kept" | "undone" | "broke";
  score?: number;
  seconds?: number;
  why?: string;
  gain?: boolean;
}

export interface ClimbFiles {
  card: ClimbCard;
  rows: LogRow[];
  notes: string | null;
  pendingTree: boolean;
}

export type Verdict = "bar-reached" | "stuck" | "plateau" | "climbing";

export interface ClimbSummary {
  name: string;
  goal: string;
  branch: string | null;
  direction: Direction;
  baseline: number;
  best: number;
  bestStep: number;
  target: number | null;
  after: string;
  steps: number;
  kept: number;
  sinceGain: number;
  hours: number;
  minutesPerStep: number | null;
  checkSeconds: number | null;
  trail: number[];
  spark: string;
  raises: string[];
  holdouts: Array<{ score: number; why: string }>;
  verdict: Verdict;
  maxSteps: number | null;
  maxHours: number | null;
  pendingTree: boolean;
  hasHoldout: boolean;
  notes: string | null;
  recent: ClimbSummaryRow[];
}

export interface ClimbSummaryRow {
  step: number | null;
  kind: string;
  result?: string;
  score: number | null;
  idea: string;
  note: string;
}

/** Python's `f"{value:.6g}"`, so a score reads the same in both surfaces. */
export function number(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const exponential = value.toExponential(5);
  const [mantissa, exponentText] = exponential.split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 6) {
    const trimmed = (mantissa ?? "").replace(/0+$/, "").replace(/\.$/, "");
    return `${trimmed}e${exponent >= 0 ? "+" : "-"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const fixed = value.toFixed(Math.max(0, 5 - exponent));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export function spark(values: number[], direction: Direction): string {
  if (values.length < 2) return "";
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const levels = values.map((value) => (value - low) / span);
  const oriented = direction === "min" ? levels.map((level) => 1 - level) : levels;
  return oriented.map((level) => BARS[Math.round(level * (BARS.length - 1))] ?? "").join("");
}

export function parseCard(text: string): ClimbCard {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("card.json is not an object");
  const card = raw as Partial<ClimbCard> & { best?: Partial<ClimbBest> };
  if (typeof card.name !== "string") throw new Error("card.json has no name");
  if (typeof card.baseline !== "number") throw new Error("card.json has no baseline");
  if (card.direction !== "min" && card.direction !== "max") throw new Error("card.json has no direction");
  if (card.score_mode !== undefined && card.score_mode !== "numeric" && card.score_mode !== "failure-count") {
    throw new Error("card.json has an unknown score mode");
  }
  const best: Partial<ClimbBest> = card.best ?? {};
  return {
    ...card,
    name: card.name,
    goal: card.goal ?? "",
    direction: card.direction,
    baseline: card.baseline,
    target: typeof card.target === "number" ? card.target : null,
    after: card.after ?? "stop",
    best: {
      score: typeof best.score === "number" ? best.score : card.baseline,
      step: typeof best.step === "number" ? best.step : 0,
      commit: best.commit,
    },
  } as ClimbCard;
}

export function parseLog(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row === "object" && row !== null) rows.push(row as LogRow);
    } catch {
      // A half-written last line after a crash is not a reason to lose the trail.
    }
  }
  return rows;
}

function at(time: string | undefined): number {
  if (!time) return Number.NaN;
  const parsed = Date.parse(time.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Mirror of climb.py's `cmd_status`, including its verdict precedence. */
export function summarize(files: ClimbFiles, recentLimit = 15, now = Date.now()): ClimbSummary {
  const { card, rows, notes, pendingTree } = files;
  const steps = rows.filter((row) => row.kind === "step");
  const kept = steps.filter((row) => row.result === "kept");
  const trail = [card.baseline, ...kept.map((row) => row.score ?? card.baseline)];
  const sinceGain = steps.length - card.best.step;
  const reviews = rows.filter((row) => row.kind === "review");
  const lastReview = reviews.length > 0 ? (reviews[reviews.length - 1]?.step ?? null) : null;
  const previousReview = reviews.length >= 2 ? (reviews[reviews.length - 2]?.step ?? null) : null;
  const stuck = reviews.length >= 2 && previousReview !== null && previousReview >= card.best.step;
  const timed = rows.map((row) => row.seconds).filter((value): value is number => typeof value === "number");
  const started = typeof card.started === "number" ? card.started * 1000 : null;
  const hours = started === null ? 0 : Math.max(0, (now - started) / 3_600_000);

  const reached = card.target !== null && (card.direction === "max" ? card.best.score >= card.target : card.best.score <= card.target);
  const plateau =
    sinceGain >= PLATEAU && (lastReview === null || steps.length - lastReview >= PLATEAU);
  const verdict: Verdict = reached ? "bar-reached" : stuck ? "stuck" : plateau ? "plateau" : "climbing";

  const recent: ClimbSummaryRow[] = rows.slice(-recentLimit).map((row) => {
    if (row.kind === "step") {
      return {
        step: row.step ?? null,
        kind: "step",
        result: row.result,
        score: typeof row.score === "number" ? row.score : null,
        idea: row.idea ?? "",
        note: row.result === "kept" ? "" : (row.why ?? ""),
      };
    }
    return {
      step: row.step ?? null,
      kind: String(row.kind),
      score: typeof row.score === "number" ? row.score : null,
      idea: "",
      note: row.why ?? "",
    };
  });

  return {
    name: card.name,
    goal: card.goal,
    branch: card.branch ?? null,
    direction: card.direction,
    baseline: card.baseline,
    best: card.best.score,
    bestStep: card.best.step,
    target: card.target,
    after: card.after ?? "stop",
    steps: steps.length,
    kept: kept.length,
    sinceGain,
    hours,
    minutesPerStep: steps.length > 0 ? (60 * hours) / steps.length : null,
    checkSeconds: timed.length > 0 ? timed.reduce((total, value) => total + value, 0) / timed.length : null,
    trail,
    spark: spark(trail, card.direction),
    raises: rows.filter((row) => row.kind === "raise").map((row) => row.why ?? ""),
    holdouts: rows
      .filter((row) => row.kind === "holdout")
      .map((row) => ({ score: typeof row.score === "number" ? row.score : 0, why: row.why ?? "" })),
    verdict,
    maxSteps: card.max_steps ?? null,
    maxHours: card.max_hours ?? null,
    pendingTree,
    hasHoldout: typeof card.holdout === "string" && card.holdout !== "",
    notes: notes === null ? null : tail(notes, 40),
    recent,
  };
}

export function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/** The single line an agent must act on. */
export function verdictLine(summary: ClimbSummary): string {
  switch (summary.verdict) {
    case "bar-reached":
      // climb.py status owns this wording; match it so either surface greps the same.
      return `BAR REACHED. ${summary.hasHoldout ? "Check the holdout, then " : "Then "}${summary.after}.`;
    case "stuck":
      return "STUCK: two blocker reviews with no gain between them. Stop and report.";
    case "plateau":
      return `PLATEAU: ${summary.sinceGain} steps with no gain. Do a blocker review, then log it with: climb.py review`;
    default:
      return "";
  }
}

/** Same shape as `climb.py status`, so either surface tells the same story. */
export function formatSummary(summary: ClimbSummary): string {
  const lines: string[] = [];
  lines.push(`Climb ${summary.name} on ${summary.branch ?? "(no branch)"}: ${summary.goal}`);
  lines.push(
    `Score ${number(summary.baseline)} -> ${number(summary.best)} (${summary.direction})  ${summary.spark}`.trimEnd(),
  );
  const bar = summary.target === null ? "none" : `${number(summary.target)}, then ${summary.after}`;
  const budget = summary.maxSteps ? ` of ${summary.maxSteps}` : "";
  lines.push(`Bar ${bar}. Steps ${summary.steps}${budget}, kept ${summary.kept}, ${summary.sinceGain} since the last gain.`);
  const limit = summary.maxHours ? ` of ${number(summary.maxHours)}` : "";
  const pace = summary.minutesPerStep === null ? "" : `, about ${summary.minutesPerStep.toFixed(1)} min a step`;
  lines.push(`Time ${summary.hours.toFixed(1)}${limit} hours${pace}.`);
  if (summary.checkSeconds !== null) lines.push(`Check takes ${summary.checkSeconds.toFixed(1)}s on average.`);
  for (const raised of summary.raises) lines.push(`Raised ${raised}`);
  if (summary.holdouts.length > 0) {
    lines.push(`Holdout ${summary.holdouts.map((row) => `${number(row.score)} (${row.why})`).join(", ")}`);
  }
  for (const row of summary.recent) {
    if (row.kind === "step") {
      const score = row.score === null ? "-" : number(row.score);
      const note = row.note === "" ? "" : `  [${row.note}]`;
      const step = String(row.step ?? 0).padStart(4);
      lines.push(`  ${step} ${(row.result ?? "").padEnd(6)} ${score.padStart(10)}  ${row.idea}${note}`);
    } else if (row.kind !== "holdout") {
      lines.push(`  ---- ${row.kind}: ${row.note || number(row.score ?? 0)}`);
    }
  }
  if (summary.pendingTree) {
    lines.push(
      "A paired step was cut off and the tree may hold the old code. Run `climb.py status` in the repo for the exact restore command.",
    );
  }
  if (summary.notes !== null) lines.push(`Notes:\n${summary.notes}`);
  const line = verdictLine(summary);
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

export interface ClimbEntry {
  name: string;
  best: number;
  baseline: number;
  direction: Direction;
  steps: number;
  verdict: Verdict;
}

export function listClimbs(entries: Array<{ card: ClimbCard; rows: LogRow[] }>, now = Date.now()): ClimbEntry[] {
  return entries.map(({ card, rows }) => {
    const summary = summarize({ card, rows, notes: null, pendingTree: false }, 0, now);
    return {
      name: card.name,
      best: summary.best,
      baseline: summary.baseline,
      direction: summary.direction,
      steps: summary.steps,
      verdict: summary.verdict,
    };
  });
}

/**
 * The rig, as the engine recorded it in card.json.
 *
 * A resumed session has to know what it must not edit (the lock), what must
 * still pass (the guards), and which files it must never look at (the holdout).
 * Guessing those from a score line is how a climb gets cheated by accident, so
 * print them, including the ones that are absent.
 */
export function formatRig(card: ClimbCard): string {
  const checks = Array.isArray(card.check) ? card.check : typeof card.check === "string" ? [card.check] : [];
  const patterns = card.score ?? [];
  const guards = card.guards ?? [];
  const locks = card.lock ?? [];
  const repos = card.repos ?? [];

  const rows: Array<[string, string]> = [];
  const bar =
    card.target === null
      ? `none (${card.direction} is the direction; no target set)`
      : `${number(card.target)}${card.target_text && card.target_text !== String(card.target) ? ` (${card.target_text})` : ""}, then ${card.after ?? "stop"}`;
  rows.push(["Goal", card.goal]);
  rows.push(["Bar", bar]);
  rows.push(["Mode", card.score_mode ?? "failure-count (legacy card)"]);
  if (checks.length === 0) rows.push(["Check", "none recorded"]);
  checks.forEach((command, index) => {
    const pattern = patterns.length === 1 ? patterns[0] : patterns[index];
    rows.push([index === 0 ? "Check" : "", pattern ? `${command}\nscore: ${pattern}` : command]);
  });
  if (checks.length > 0 && patterns.length === 0) {
    rows.push(["Score", "the last line of check output must be the number"]);
  }
  const modifiers: string[] = [];
  if ((card.runs ?? 1) > 1) modifiers.push(`${card.runs} runs, median`);
  if (card.paired) modifiers.push("paired (old and new code in turns)");
  if (card.min_gain !== undefined && card.min_gain !== null && String(card.min_gain) !== "0") modifiers.push(`min gain ${String(card.min_gain)}`);
  if (modifiers.length > 0) rows.push(["Scoring", modifiers.join(", ")]);
  rows.push(["Guards", guards.length > 0 ? guards.join("\n") : "none — a kept step can break anything the check does not measure"]);
  rows.push([
    "Holdout",
    typeof card.holdout === "string" && card.holdout !== ""
      ? `${card.holdout}\nnever read it again; run holdout --why "…" at the bar`
      : "none — nothing catches overfitting to the visible cases",
  ]);
  rows.push(["Locked", locks.length > 0 ? locks.join("\n") : "none — nothing stops a step from editing the check"]);
  rows.push([
    "Lock hash",
    typeof card.fingerprint === "string" && card.fingerprint !== ""
      ? `${card.fingerprint.slice(0, 12)} — the engine re-checks it on every try`
      : "none",
  ]);
  if (repos.length > 0) rows.push(["Repos", repos.map((repo) => repo.path).join("\n")]);
  const limits: string[] = [];
  if (card.max_steps) limits.push(`${card.max_steps} steps`);
  if (card.max_hours) limits.push(`${number(card.max_hours)} hours`);
  if (limits.length > 0) rows.push(["Limits", `${limits.join(", ")} (${card.hard ? "hard" : "soft"})`]);

  const head = `Climb ${card.name} on ${card.branch ?? "(no branch)"}${card.base ? ` (base ${card.base})` : ""}`;
  const body = rows.map(([label, value]) => {
    const [first, ...rest] = value.split("\n");
    return [`${label.padEnd(10)} ${first ?? ""}`, ...rest.map((line) => `${" ".repeat(11)}${line}`)].join("\n");
  });
  return [head, ...body].join("\n");
}
