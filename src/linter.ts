// The 22-rule contract linter.
//
// Source of truth: `skills/hill-climb/references/writing.md`, vendored unmodified
// from Desiderata-Labs/hillclimb-skills (MIT, see references/LICENSE-mit). That
// file defines six outcome rules (O1-O6), nine criterion rules (C1-C9), four goal
// rules (G1-G4) and three placement rules (P1-P3). Every code below cites the
// section of that file it enforces; `tests/linter.test.ts` fails if a code is
// missing from the rubric, missing from the vendored reference, or if a rule the
// source leaves to a person is reported as an error.
//
// Three kinds of check, and why the distinction is load-bearing:
//
//   deterministic  a pure function of the contract text (lengths, counts, closed
//                  word lists, patterns the source names explicitly). Safe to
//                  block on: severity `error` is allowed.
//   heuristic      a deterministic trigger that only nominates a candidate; a
//                  person still decides (is this surface really separate? is
//                  this name the actor's interface?). Capped at `warning`.
//   human-review   cannot be decided from the contract alone: it needs the
//                  product, a newer decision, or the rest of the tree (O6), and
//                  the source tells reviewers to list those findings first.
//                  Capped at `warning`.
//
// The linter never rewrites anything and never decides a contract. It reports
// findings with a proposed wording so a person can answer yes or no per row.

import type { Criterion } from "./model.js";

export type LintCheckCode =
  | "O1" | "O2" | "O3" | "O4" | "O5" | "O6"
  | "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9"
  | "G1" | "G2" | "G3" | "G4"
  | "P1" | "P2" | "P3";

export type LintSeverity = "error" | "warning";
export type LintDeterminism = "deterministic" | "heuristic" | "human-review";

export interface RubricEntry {
  code: LintCheckCode;
  /** Rule title, verbatim from `references/writing.md`. */
  title: string;
  /** Section of the vendored MIT reference that states the rule. */
  source: string;
  determinism: LintDeterminism;
  /** Highest severity a finding under this code may carry. */
  severityCap: LintSeverity;
  /** What the check needs beyond the item's own text. */
  needs: string[];
}

/**
 * The rubric, in source order. `tests/linter.test.ts` asserts this covers every
 * code, that each cited section exists in `references/writing.md` and names the
 * code, and that heuristic and human-review rules are capped at `warning`.
 */
export const RUBRIC: Readonly<Record<LintCheckCode, RubricEntry>> = Object.freeze({
  O1: {
    code: "O1",
    title: "Behavior title",
    source: "references/writing.md#outcomes",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  O2: {
    code: "O2",
    title: "One-sentence story",
    source: "references/writing.md#outcomes",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  O3: {
    code: "O3",
    title: "One to five criteria",
    source: "references/writing.md#outcomes",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  O4: {
    code: "O4",
    title: "One behavior",
    source: "references/writing.md#outcomes",
    determinism: "heuristic",
    severityCap: "warning",
    needs: ["a person who knows whether the surfaces are checked separately"],
  },
  O5: {
    code: "O5",
    title: "A behavior, not a task",
    source: "references/writing.md#outcomes",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  O6: {
    code: "O6",
    title: "Still true",
    source: "references/writing.md#outcomes",
    determinism: "human-review",
    severityCap: "warning",
    needs: ["the newer decision", "the rest of the tree", "the product itself"],
  },
  C1: {
    code: "C1",
    title: "One case each",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  C2: {
    code: "C2",
    title: "Observable result",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  C3: {
    code: "C3",
    title: "Short",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  C4: {
    code: "C4",
    title: "No provenance",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  C5: {
    code: "C5",
    title: "No implementation detail",
    source: "references/writing.md#criteria",
    determinism: "heuristic",
    severityCap: "warning",
    needs: ["whether the name is the interface the actor uses", "whether the number is a promise"],
  },
  C6: {
    code: "C6",
    title: "No test plan",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  C7: {
    code: "C7",
    title: "State success, not the old bug",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  C8: {
    code: "C8",
    title: "Behavior, not the definition of done",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  C9: {
    code: "C9",
    title: "No project notes",
    source: "references/writing.md#criteria",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  G1: {
    code: "G1",
    title: "Short brief",
    source: "references/writing.md#goals",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  G2: {
    code: "G2",
    title: "No plan or history in the brief",
    source: "references/writing.md#goals",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  G3: {
    code: "G3",
    title: "A lasting condition",
    source: "references/writing.md#goals",
    determinism: "deterministic",
    severityCap: "error",
    needs: [],
  },
  G4: {
    code: "G4",
    title: "Still true",
    source: "references/writing.md#goals",
    determinism: "deterministic",
    severityCap: "warning",
    needs: [],
  },
  P1: {
    code: "P1",
    title: "Criterion, not sibling",
    source: "references/writing.md#placement",
    determinism: "heuristic",
    severityCap: "warning",
    needs: ["the sibling outcomes under the same goal"],
  },
  P2: {
    code: "P2",
    title: "Generalize the bug",
    source: "references/writing.md#placement",
    determinism: "deterministic",
    severityCap: "error",
    needs: ["the outcome that owns the behavior (found by overlap, or proposed)"],
  },
  P3: {
    code: "P3",
    title: "Not in the tree at all",
    source: "references/writing.md#placement",
    determinism: "heuristic",
    severityCap: "warning",
    needs: ["whether the polish is a promise or just polish"],
  },
});

/** All 22 codes in rubric order. */
export const LINT_CODES: readonly LintCheckCode[] = Object.freeze(
  Object.keys(RUBRIC) as LintCheckCode[],
);

export interface LintFinding {
  /** Stable per (item, code, criterion): re-linting the same text yields the same id. */
  id: string;
  itemKey: string;
  itemType: "goal" | "outcome" | "criterion";
  criterionId?: string;
  checkCode: LintCheckCode;
  checkTitle: string;
  severity: LintSeverity;
  determinism: LintDeterminism;
  /** The offending text, verbatim. */
  now: string;
  issue: string;
  /** A proposed wording, or the action that resolves the finding. */
  proposed: string;
  /** Where the detail belongs instead, when the source names a home for it. */
  movesTo: string | null;
  /** For cross-item findings (O6, P1, P2): the other keys involved. */
  related?: string[];
}

/** Structurally compatible with the shared `Criterion` contract. */
export type LintCriterionInput = Criterion;

/**
 * Structurally compatible with the shared `Outcome` contract: an `Outcome` is
 * assignable to this, so the linter reads the same objects the tree stores.
 */
export interface LintOutcomeInput {
  key: string;
  goalKey: string;
  title: string;
  story: string;
  criteria: LintCriterionInput[];
  dependsOn?: string[];
  rank?: number;
  recheckDays?: number | null;
  version?: number;
  status?: "unverified" | "verified" | "broken" | "stale" | "recheck";
  /** Decisions that may have changed how the product behaves (O6 input). */
  decisions?: Array<{ key?: string; question?: string; answer: string }>;
}

export interface LintGoalInput {
  key: string;
  parentGoalKey: string | null;
  title: string;
  brief: string;
  levelLabel?: string;
}

export interface LintResult {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  findings: LintFinding[];
  /** Contract version linted, when the caller supplied one. */
  version: number | null;
  /** True when every finding can be decided from the text alone. */
  deterministicOnly: boolean;
}

// ---------------------------------------------------------------------------
// Shared patterns
// ---------------------------------------------------------------------------

const TASK_VERB_PREFIX =
  /^(?:bug\s*:|issue\s*:|task\s*:|chore\s*:|todo\s*:|(?:add|build|fix|measure|decide|document|migrate|cut\s+over|install|set\s+up|investigate|implement|refactor|create|update|write|remove|delete|wire|rename|bump|upgrade|launch|replace|rewrite|adopt|deprecate)\b)\s*/i;

const VAGUE_FEELING_PATTERN =
  /\b(?:feels?\s+(?:fast|good|clean|great|right|smooth)|people\s+want\s+to\s+share|is\s+intuitive|looks?\s+nice|nicer\s+code|is\s+clear)\b/i;

const PROVENANCE_PATTERN =
  /\b(?:PR\s*#\d+|issue\s*#\d+|commit\s+[0-9a-f]{7,40}|verbatim|per\s+[A-Z][a-z]+'s\s+ruling|approved\s+on\s+\d{4}-\d{2}-\d{2}|\b20\d{2}-\d{2}-\d{2}\b)/i;

const VENDOR_PATTERN =
  /\b(?:files?\s+live\s+in\s+(?:s3|r2|gcs)|uses?\s+(?:redis|postgres|dynamodb|kafka|bullmq|celery)|written\s+in\s+rust|reads?\s+are\s+cached|it\s+doesn'?t\s+reload\s+on\s+every\s+call)\b/i;

const IMPL_DETAIL_PATTERN =
  /(?:\b[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|py|rs|go|sql|mjs|cjs|rb|java|kt)(?::\d+)?\b|\b[a-z]+_[a-z]+_\w+\s*=\s*(?:true|false|1|0)\b|\b#[0-9a-fA-F]{6}\b|\b\d+(?:\.\d+)?\s*(?:px|ms|rem)\b)/;

/** Internal names the source says to replace when a visible result exists. */
const INTERNAL_NAME_PATTERN =
  /\b(?:[a-z]+_[a-z_]+|[a-z]+(?:Row|Flag|Column|Table|Job|Handler|Service))\b/;

const TEST_PLAN_PATTERN =
  /\b(?:run\s+\d+\s+times|with\s+fixtures?\b|stale\s+caches,\s*lost\s+events|mock\s+server|vitest\s+run|pytest\s+-q|npm\s+test|cargo\s+test|go\s+test|step\s+\d+\s+of\s+\d+\b)/i;

const NEGATIVE_ONLY_THEN_PATTERN =
  /^(?:does\s+not|doesn't|never|no\s+longer)\s+(?:crash|throw|return\s+(?:a\s+)?500|fail|error|time\s+out)\.?$/i;

const DEFINITION_OF_DONE_PATTERN =
  /^(?:(?:the\s+)?(?:docs?|documentation)\s+(?:is|are)\s+updated|(?:all\s+)?tests?\s+pass(?:es)?|ci\s+is\s+green|version\s+is\s+bumped|typecheck\s+passes|lint\s+passes)\.?$/i;

/** An outcome whose whole promise is a safeguard (C8's stated exemption). */
const SAFEGUARD_OUTCOME_PATTERN =
  /\b(?:CI\s+blocks?|pipeline\s+blocks?|build\s+breaks?|no\s+\w+\s+SDK\s+ever\s+ships|nothing\s+turns\s+green|pull\s+request\s+that\s+breaks)\b/i;

const PROJECT_NOTE_PATTERN =
  /(?:\barrives?\s+with\s+(?:the\s+next\s+release|[A-Z0-9][A-Z0-9_-]{1,})|\buntil\s+[A-Z0-9_-]+\s+ships|\bsee\s+[A-Z]{2,8}-\d+|\bblocked\s+on\s+[A-Z]{2,8}-\d+|\blands?\s+after\s+[A-Z]{2,8}-\d+)/;

/** O5: finished when something is done once. */
const ONE_OFF_CHORE_PATTERN =
  /\b(?:migration\s+is\s+run|document\s+is\s+written|measurement\s+is\s+taken|decision\s+is\s+made|cutover\s+is\s+complete|benchmark\s+is\s+recorded|service\s+is\s+switched\s+on|switch\s+the\s+service\s+on|audit\s+is\s+done)\b/i;

/** P3: pure polish and finished artifacts with no lasting promise. */
const POLISH_OR_ARTIFACT_PATTERN =
  /\b(?:rename[sd]?\s+(?:the\s+)?(?:[a-z]+\s+)?(?:route|endpoint|variable|file|command)|border[- ]radius|adjust\s+(?:the\s+)?(?:[a-z]+\s+)?(?:spacing|padding|colou?r|font\s+size|icon)|copy\s+tweak|tooltip\s+wording|changelog\s+entry|sign[- ]off\s+the\s+rfc|one[- ]off\s+backfill|write\s+the\s+(?:rfc|postmortem|report))\b/i;

/** O6: reversal language. The source names these as the usual source of staleness. */
const REMOVAL_PATTERN =
  /\b(?:no\s+longer|never\s+again|is\s+gone|are\s+gone|has\s+no|have\s+no|removed|reversed|dropped|replaced\s+by)\b/i;

/** O4: surfaces a person checks separately. */
const SURFACES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "api", pattern: /\b(?:API|endpoint|webhook|REST|GraphQL)\b/i },
  { name: "ui", pattern: /\b(?:page|screen|button|drawer|panel|form|menu|dialog)\b/i },
  { name: "phone", pattern: /\b(?:phone|mobile|narrow|tablet|touch)\b/i },
  { name: "cli", pattern: /\b(?:CLI|command\s+line|terminal)\b/i },
  { name: "email", pattern: /\b(?:email|inbox|notification)\b/i },
  { name: "data", pattern: /\b(?:database|schema|export\s+file|CSV|SQL)\b/i },
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "when", "then", "given",
  "into", "your", "their", "they", "them", "have", "has", "had", "are", "was",
  "were", "will", "would", "can", "may", "must", "not", "but", "all", "any",
  "one", "two", "its", "our", "you", "who", "what", "how", "why", "each",
  "every", "same", "only", "than", "there", "here", "does", "did", "get",
  "got", "make", "makes", "made", "use", "uses", "used", "ask", "asks",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s@#_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** A word's comparison key: plural and suffix tolerant, long enough to mean something. */
function stem(word: string): string {
  const base = word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
  return base.length >= 5 ? base.slice(0, 5) : base;
}

function overlap(a: string, b: string): string[] {
  const right = new Set(words(b).map(stem));
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const word of words(a)) {
    const key = stem(word);
    if (!right.has(key) || seen.has(key)) continue;
    seen.add(key);
    shared.push(word);
  }
  return shared;
}

function cappedSeverity(code: LintCheckCode, wanted: LintSeverity): LintSeverity {
  const cap = RUBRIC[code].severityCap;
  return cap === "warning" ? "warning" : wanted;
}

function finding(
  code: LintCheckCode,
  item: { key: string; type: "goal" | "outcome" | "criterion"; criterionId?: string },
  severity: LintSeverity,
  now: string,
  issue: string,
  proposed: string,
  movesTo: string | null,
  extra: { determinism?: LintDeterminism; related?: string[]; suffix?: string } = {},
): LintFinding {
  const determinism = extra.determinism ?? RUBRIC[code].determinism;
  const id = [item.key, item.criterionId, code, extra.suffix]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("-");
  const result: LintFinding = {
    id,
    itemKey: item.key,
    itemType: item.type,
    checkCode: code,
    checkTitle: RUBRIC[code].title,
    severity: determinism === "deterministic" ? cappedSeverity(code, severity) : "warning",
    determinism,
    now,
    issue,
    proposed,
    movesTo,
  };
  if (item.criterionId !== undefined) result.criterionId = item.criterionId;
  if (extra.related !== undefined && extra.related.length > 0) result.related = extra.related;
  return result;
}

function rewriteTaskTitleToBehavior(title: string): string {
  const stripped = title.replace(TASK_VERB_PREFIX, "").trim();
  if (stripped === "") return "The system performs the expected behavior";
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  if (/\b(?:is|are|can|can't|stays?|keeps?|sends?|returns?|shows?|refuses?|marks?|completes?|runs?|works?)\b/i.test(capitalized)) {
    return capitalized;
  }
  return `${capitalized} works as a verified product behavior`;
}

// ---------------------------------------------------------------------------
// Goals: G1..G4
// ---------------------------------------------------------------------------

export function lintGoal(goal: LintGoalInput, now: Date | string = new Date()): LintFinding[] {
  const findings: LintFinding[] = [];
  const isRoot = goal.parentGoalKey === null || goal.levelLabel?.toLowerCase() === "charter";
  const briefLen = goal.brief.trim().length;
  const maxBrief = isRoot ? 3000 : 800;
  const item = { key: goal.key, type: "goal" as const };

  // G1 Short brief.
  if (briefLen > maxBrief) {
    findings.push(
      finding(
        "G1",
        item,
        "warning",
        `${briefLen} chars: "${goal.brief.slice(0, 120)}…"`,
        isRoot
          ? `Charter brief is ${briefLen} chars (limit ${maxBrief}).`
          : `Goal brief is ${briefLen} chars (recommended <= 400, hard limit 800).`,
        `${goal.brief.slice(0, isRoot ? 600 : 360).trim()}…`,
        "Long rationale or architecture tables -> a plan on the goal, or an artifact",
      ),
    );
  }

  // G2 No plan or history in the brief.
  const g2Hit = PROVENANCE_PATTERN.test(goal.brief) || IMPL_DETAIL_PATTERN.test(goal.brief);
  if (g2Hit) {
    findings.push(
      finding(
        "G2",
        item,
        "warning",
        goal.brief,
        "Goal brief contains dates, PR/ticket numbers, commit hashes, or source file paths.",
        goal.brief
          .replace(PROVENANCE_PATTERN, "")
          .replace(IMPL_DETAIL_PATTERN, "the affected interface")
          .replace(/\s{2,}/g, " ")
          .trim(),
        "Dates/rulings -> a decision; file paths and steps -> write_plan on the goal",
      ),
    );
  }

  // G3 A lasting condition.
  if (TASK_VERB_PREFIX.test(goal.title.trim()) || VENDOR_PATTERN.test(goal.title)) {
    findings.push(
      finding(
        "G3",
        item,
        "error",
        goal.title,
        "Goal is phrased as a project or names a specific technology, vendor or mechanism instead of a lasting condition.",
        rewriteTaskTitleToBehavior(goal.title),
        "Track the migration or launch as a release, and keep the goal as the lasting promise",
      ),
    );
  }

  // G4 Still true.
  const currentYear = new Date(now).getUTCFullYear();
  const years = [...goal.brief.matchAll(/\b(19\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year < currentYear);
  if (years.length > 0) {
    findings.push(
      finding(
        "G4",
        item,
        "warning",
        goal.brief,
        `Goal brief references a past year (${[...new Set(years)].join(", ")}; now ${currentYear}).`,
        goal.brief.replace(/\b(?:19|20)\d{2}\b/g, "current"),
        "Historical targets -> a note on the outcomes they informed",
      ),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Outcomes: O1..O6, P1..P3
// ---------------------------------------------------------------------------

export function lintOutcome(
  outcome: LintOutcomeInput,
  siblings: LintOutcomeInput[] = [],
): LintFinding[] {
  const findings: LintFinding[] = [];
  const title = outcome.title.trim();
  const story = outcome.story.trim();
  const item = { key: outcome.key, type: "outcome" as const };
  const others = siblings.filter((sibling) => sibling.key !== outcome.key);

  findings.push(...lintOutcomeShape(outcome, others, { title, story, item }));
  findings.push(...lintCriteria(outcome));
  findings.push(...lintPlacement(outcome, others, { title, story, item }));

  return findings;
}

interface OutcomeShapeContext {
  title: string;
  story: string;
  item: { key: string; type: "outcome" };
}

function lintOutcomeShape(
  outcome: LintOutcomeInput,
  others: LintOutcomeInput[],
  { title, story, item }: OutcomeShapeContext,
): LintFinding[] {
  const findings: LintFinding[] = [];

  // O1 Behavior title.
  if (/^(?:bug|issue)\s*:/i.test(title)) {
    findings.push(
      finding(
        "O1",
        item,
        "error",
        title,
        "Title starts with 'Bug:' or 'Issue:'. A bug should become the behavior it broke.",
        rewriteTaskTitleToBehavior(title),
        "The bug's trace becomes 'denies' evidence on the behavior outcome that owns it (P2)",
        { suffix: "bug" },
      ),
    );
  } else if (TASK_VERB_PREFIX.test(title)) {
    findings.push(
      finding(
        "O1",
        item,
        "error",
        title,
        "Title names a task or action verb instead of a present-tense product behavior.",
        rewriteTaskTitleToBehavior(title),
        "Implementation steps -> write_plan on the outcome",
        { suffix: "task" },
      ),
    );
  } else if (VAGUE_FEELING_PATTERN.test(title)) {
    findings.push(
      finding(
        "O1",
        item,
        "error",
        title,
        "Title promises a feeling nobody could check.",
        title.replace(VAGUE_FEELING_PATTERN, "meets its observable response and layout contract"),
        null,
        { suffix: "vague" },
      ),
    );
  }

  // O2 One-sentence story.
  const hasStoryShape = /^as\s+(?:a|an|the)\s+.+,\s*i\s+want\s+.+,\s*so\s+that\s+.+/i.test(story);
  if (!hasStoryShape || story.length > 320 || IMPL_DETAIL_PATTERN.test(story) || PROVENANCE_PATTERN.test(story)) {
    const tooLong = story.length > 400;
    findings.push(
      finding(
        "O2",
        item,
        tooLong || !hasStoryShape ? "error" : "warning",
        story,
        !hasStoryShape
          ? "Story should be one sentence: 'As a <actor>, I want <behavior>, so that <harm avoided>'."
          : "Story exceeds 300 chars or embeds file paths, schema details, or historical provenance.",
        hasStoryShape
          ? (story.split(/(?<=\.)\s+/)[0]?.slice(0, 280) ?? story.slice(0, 280))
          : `As a user, I want ${title.charAt(0).toLowerCase() + title.slice(1)}, so that the workflow succeeds reliably.`,
        "Cause, file paths and history -> evidence ('note' or 'denies') or write_plan",
      ),
    );
  }

  // O3 One to five criteria.
  const count = outcome.criteria.length;
  if (count === 0 || count > 7) {
    findings.push(
      finding(
        "O3",
        item,
        "error",
        `${count} criteria`,
        count === 0
          ? "Outcome has no Given/When/Then acceptance criteria."
          : `Outcome has ${count} criteria (hard limit is 7; recommended 1-5).`,
        count === 0
          ? "Add 1-4 Given/When/Then criteria covering the primary path and key boundary."
          : "Keep the 4-5 core behavioral criteria and move exhaustive test-matrix permutations into write_plan.",
        "Test matrix permutations -> write_plan on this outcome",
      ),
    );
  } else if (count === 1 && outcome.criteria[0] !== undefined) {
    const only = outcome.criteria[0];
    if (only.then.toLowerCase().trim() === title.toLowerCase().trim()) {
      findings.push(
        finding(
          "O3",
          item,
          "warning",
          `${only.id}: Then ${only.then}`,
          "Single criterion only restates the outcome title without naming an observable result.",
          "Specify the concrete state change, response status, or user-visible output in 'then'.",
          null,
          { suffix: "restate" },
        ),
      );
    }
  }

  // O4 One behavior: criteria split into surfaces a person checks separately.
  if (count >= 2) {
    const bySurface = new Map<string, string[]>();
    for (const criterion of outcome.criteria) {
      const text = `${criterion.given} ${criterion.when} ${criterion.then}`;
      for (const surface of SURFACES) {
        if (surface.pattern.test(text)) {
          const list = bySurface.get(surface.name) ?? [];
          list.push(criterion.id);
          bySurface.set(surface.name, list);
        }
      }
    }
    if (bySurface.size >= 2) {
      const groups = [...bySurface.entries()].map(([name, ids]) => `${name}: ${ids.join(", ")}`);
      findings.push(
        finding(
          "O4",
          item,
          "warning",
          groups.join(" | "),
          `Criteria group into ${bySurface.size} surfaces a person would check separately (${groups.join("; ")}). They may be separate outcomes.`,
          `Split ${[...bySurface.keys()].join(" and ")} into their own outcomes, or keep one behavior and make the other surfaces criteria on it.`,
          "A separate outcome per surface, each with its own criteria",
        ),
      );
    }
  }

  // O5 A behavior, not a task.
  if (ONE_OFF_CHORE_PATTERN.test(title) || ONE_OFF_CHORE_PATTERN.test(story)) {
    findings.push(
      finding(
        "O5",
        item,
        "error",
        title,
        "Outcome describes a one-off chore, migration, measurement or document, finished when it happens once, rather than an ongoing product behavior.",
        "Record the output as evidence on the behavior outcome it serves, then archive this item.",
        "Evidence ('confirms' or 'note') on the parent behavior outcome, or a plan",
      ),
    );
  }

  // O6 Still true: reversal language, or criteria that contradict a newer decision.
  // O6 Still true. Two causes, reported as two rows because they call for
  // different work: a reversal this outcome makes, and the criteria elsewhere
  // that still state the old rule (or a newer decision).
  const reversalHeader = REMOVAL_PATTERN.test(title) || REMOVAL_PATTERN.test(story);
  if (reversalHeader) {
    findings.push(
      finding(
        "O6",
        item,
        "warning",
        `${title} — ${story}`,
        "This outcome removes or reverses something. Criteria that still state the old rule elsewhere in the tree have to change with it.",
        "Search the tree for criteria that still state the old rule ('only people approve plans' beside 'plans have no approval'), then propose the edit that removes them.",
        "The newer decision, and the criteria that have to change with it",
        { suffix: "reversal" },
      ),
    );
  }

  const contradiction = [
    ...findDecisionContradictions(outcome, others),
    ...findCrossOutcomeContradictions(outcome, others),
  ];
  if (contradiction.length > 0) {
    findings.push(
      finding(
        "O6",
        item,
        "warning",
        contradiction.map((entry) => entry.text).join(" | "),
        "A criterion here states the opposite of one that still stands, or of a newer decision.",
        contradiction.map((entry) => `Reconcile: ${entry.decision}`).join("; "),
        "The newer decision, and the criterion that has to change with it",
        { related: [...new Set(contradiction.map((entry) => entry.key))], suffix: "contradiction" },
      ),
    );
  }

  return findings;
}

/**
 * The source's first case: an outcome removes or reverses something, and a
 * criterion elsewhere in the tree still states the old rule ("only people
 * approve plans" beside "plans have no approval"). A reversal needs an
 * affirmative counterpart to contradict, so both halves are required.
 */
const AFFIRMATIVE_PATTERN = /\b(?:only|must|always|requires?|before|approved|approves|has to)\b/i;

function findCrossOutcomeContradictions(
  outcome: LintOutcomeInput,
  others: LintOutcomeInput[],
): Array<{ key: string; criterionId: string; text: string; decision: string }> {
  const hits: Array<{ key: string; criterionId: string; text: string; decision: string }> = [];
  for (const criterion of outcome.criteria) {
    const here = `Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`;
    if (!REMOVAL_PATTERN.test(criterion.then)) continue;
    for (const other of others) {
      for (const theirs of other.criteria) {
        const there = `Given ${theirs.given}, when ${theirs.when}, then ${theirs.then}`;
        // The polarity that matters is in the result, not in the setup: "Given an
        // approved plan" is context, "then only people approve" is the old rule.
        if (REMOVAL_PATTERN.test(theirs.then) || !AFFIRMATIVE_PATTERN.test(theirs.then)) continue;
        const shared = overlap(here, there);
        if (shared.length < 2) continue;
        hits.push({
          key: other.key,
          criterionId: theirs.id,
          text: `${outcome.key} ${criterion.id} says "${criterion.then}"; ${other.key} ${theirs.id} says "${theirs.then}"`,
          decision: `reconcile ${other.key} ${theirs.id} with ${outcome.key} ${criterion.id}`,
        });
      }
    }
  }
  return hits.slice(0, 3);
}

function findDecisionContradictions(
  outcome: LintOutcomeInput,
  others: LintOutcomeInput[],
): Array<{ key: string; criterionId: string; text: string; decision: string }> {
  const hits: Array<{ key: string; criterionId: string; text: string; decision: string }> = [];
  const decisions = outcome.decisions ?? [];
  const candidates: Array<{ key: string; criterionId: string; text: string }> = [];
  for (const criterion of outcome.criteria) {
    candidates.push({
      key: outcome.key,
      criterionId: criterion.id,
      text: `Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`,
    });
  }
  for (const other of others) {
    for (const criterion of other.criteria) {
      candidates.push({
        key: other.key,
        criterionId: criterion.id,
        text: `Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`,
      });
    }
  }
  for (const decision of decisions) {
    const answer = decision.answer.trim();
    if (answer === "" || !REMOVAL_PATTERN.test(answer)) continue;
    const subjects = words(answer);
    for (const candidate of candidates) {
      const shared = overlap(answer, candidate.text);
      // Two shared content words, and the criterion must not itself carry the
      // reversal: those are O6's reversal case, not a contradiction.
      if (shared.length < 2 || REMOVAL_PATTERN.test(candidate.text)) continue;
      if (!subjects.some((word) => candidate.text.toLowerCase().includes(word) && word.length >= 5)) continue;
      hits.push({ ...candidate, decision: answer.slice(0, 160) });
    }
  }
  return hits.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Criteria: C1..C9
// ---------------------------------------------------------------------------

function lintCriteria(outcome: LintOutcomeInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const safeguardOutcome = SAFEGUARD_OUTCOME_PATTERN.test(`${outcome.title} ${outcome.story}`);

  for (const criterion of outcome.criteria) {
    const fullText = `Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`;
    const item = { key: outcome.key, type: "criterion" as const, criterionId: criterion.id };

    // C1 One case each.
    if (/\band\s+separately\b|\bin\s+the\s+first\s+case\b.*\bin\s+the\s+second\s+case\b/i.test(fullText)) {
      findings.push(
        finding(
          "C1",
          item,
          "warning",
          fullText,
          "Criterion packs several distinct cases ('and separately', 'first case … second case') into one.",
          "Split into one Given/When/Then criterion per case on this outcome.",
          null,
        ),
      );
    }

    // C2 Observable result.
    if (VAGUE_FEELING_PATTERN.test(criterion.then)) {
      findings.push(
        finding(
          "C2",
          item,
          "error",
          criterion.then,
          "'Then' clause promises a result nobody outside the code could check.",
          criterion.then.replace(
            VAGUE_FEELING_PATTERN,
            "returns the expected response within the target bound",
          ),
          null,
          { suffix: "vague" },
        ),
      );
    } else {
      const internal = INTERNAL_NAME_PATTERN.exec(criterion.then);
      if (internal !== null && !/\b(?:CLI|API|endpoint|command|setting)\b/i.test(criterion.then)) {
        findings.push(
          finding(
            "C2",
            item,
            "warning",
            criterion.then,
            `'Then' names an internal row, flag or function ("${internal[0]}") where a visible result exists.`,
            criterion.then.replace(internal[0], "the state the actor can see"),
            "The internal detail -> write_plan on the outcome",
            { suffix: "internal" },
          ),
        );
      }
    }

    // C3 Short.
    if (fullText.length > 500) {
      findings.push(
        finding(
          "C3",
          item,
          "error",
          `${fullText.length} chars: "${fullText.slice(0, 120)}…"`,
          `Criterion is ${fullText.length} characters (typical <= 300, hard limit 500).`,
          `${fullText.slice(0, 280).trim()}…`,
          "Detailed fixture and setup tables -> write_plan on the outcome",
        ),
      );
    }

    // C4 No provenance.
    if (PROVENANCE_PATTERN.test(fullText)) {
      findings.push(
        finding(
          "C4",
          item,
          "warning",
          fullText,
          "Criterion cites a date, PR/ticket number, commit hash, or a person's ruling.",
          fullText.replace(PROVENANCE_PATTERN, "").replace(/\s{2,}/g, " ").trim(),
          `A note on ${outcome.key} (add_evidence, kind 'note')`,
        ),
      );
    }

    // C5 No implementation detail.
    if (IMPL_DETAIL_PATTERN.test(fullText)) {
      findings.push(
        finding(
          "C5",
          item,
          "warning",
          fullText,
          "Criterion references source file paths, line numbers, raw flags, or exact layout values. Keep a name only when it is the interface the actor uses, and a number only when it is the promise.",
          fullText.replace(IMPL_DETAIL_PATTERN, "the public interface"),
          `Implementation plan on ${outcome.key} (write_plan)`,
        ),
      );
    }

    // C6 No test plan.
    if (TEST_PLAN_PATTERN.test(fullText)) {
      findings.push(
        finding(
          "C6",
          item,
          "warning",
          fullText,
          "Criterion embeds test runner invocations, run counts, fixture setup, or a step-by-step procedure.",
          "State the promise that holds through those cases; move the runner recipe to write_plan or the climb check.",
          `write_plan or the climb check on ${outcome.key}`,
        ),
      );
    }

    // C7 State success, not the old bug.
    if (NEGATIVE_ONLY_THEN_PATTERN.test(criterion.then.trim())) {
      findings.push(
        finding(
          "C7",
          item,
          "warning",
          criterion.then,
          "'Then' only states that an error does not happen, without saying what succeeds.",
          `${criterion.then.replace(/\.$/, "")} and completes the requested action with the expected state.`,
          null,
        ),
      );
    }

    // C8 Behavior, not the definition of done. A safeguard outcome is exempt.
    if (DEFINITION_OF_DONE_PATTERN.test(criterion.then.trim()) && !safeguardOutcome) {
      findings.push(
        finding(
          "C8",
          item,
          "error",
          fullText,
          "Criterion only says tests pass, docs are updated, a version was bumped or CI is green: shipping hygiene, not product behavior.",
          "Remove this chore criterion; record the passing run as 'confirms' evidence instead.",
          `add_evidence (kind 'test' or 'ci') on ${outcome.key}`,
        ),
      );
    }

    // C9 No project notes.
    if (PROJECT_NOTE_PATTERN.test(fullText)) {
      findings.push(
        finding(
          "C9",
          item,
          "warning",
          fullText,
          "Criterion contains cross-outcome timing notes ('arrives with …', 'until X ships', 'see KEY-1').",
          fullText.replace(PROJECT_NOTE_PATTERN, "").replace(/\s{2,}/g, " ").trim(),
          `dependsOn on ${outcome.key}`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Placement: P1..P3
// ---------------------------------------------------------------------------

function lintPlacement(
  outcome: LintOutcomeInput,
  others: LintOutcomeInput[],
  context: { title: string; story: string; item: { key: string; type: "outcome" } },
): LintFinding[] {
  const findings: LintFinding[] = [];
  const { title, story, item } = context;

  // P1 Criterion, not sibling: a single-criterion outcome that refines a sibling.
  if (outcome.criteria.length === 1 && others.length > 0) {
    let best: { sibling: LintOutcomeInput; shared: string[] } | null = null;
    for (const sibling of others) {
      if (sibling.criteria.length < 2) continue;
      const shared = overlap(title, sibling.title);
      if (shared.length >= 2 && (best === null || shared.length > best.shared.length)) {
        best = { sibling, shared };
      }
    }
    if (best !== null) {
      findings.push(
        finding(
          "P1",
          item,
          "warning",
          `${outcome.key}: ${title}`,
          `This single-criterion outcome refines sibling outcome ${best.sibling.key} ("${best.sibling.title}"); it shares ${best.shared.join(", ")}.`,
          `Fold as ac${best.sibling.criteria.length + 1} on ${best.sibling.key} and carry its evidence over.`,
          `A new criterion on ${best.sibling.key}`,
          { related: [best.sibling.key], suffix: "sibling" },
        ),
      );
    }
  }

  // P2 Generalize the bug: a bug becomes the behavior it broke.
  const bugTagged = /^(?:bug|issue)\s*:/i.test(title);
  const bugTrace =
    /\b(?:regression|stack\s+trace|error\s+page|500\s+(?:error|when)|crash(?:es|ed)?\s+when|customer\s+clicked|got\s+an\s+error)\b/i.test(
      `${title} ${story}`,
    );
  if (bugTagged || bugTrace) {
    let owner: LintOutcomeInput | null = null;
    let ownerShared: string[] = [];
    for (const sibling of others) {
      const shared = overlap(`${title} ${story}`, `${sibling.title} ${sibling.story}`);
      if (shared.length >= 2 && shared.length > ownerShared.length) {
        owner = sibling;
        ownerShared = shared;
      }
    }
    const determinism: LintDeterminism = bugTagged ? "deterministic" : "heuristic";
    findings.push(
      finding(
        "P2",
        item,
        "error",
        title,
        owner === null
          ? "A bug is filed as an outcome. A bug becomes the behavior it broke: a criterion on the outcome that owns that behavior, or a new outcome if none does."
          : `A bug is filed as an outcome. The behavior it broke looks like ${owner.key} ("${owner.title}"), sharing ${ownerShared.join(", ")}.`,
        owner === null
          ? "Write the criterion that states what holds after the fix, on the outcome that owns that behavior; keep the trace as 'denies' evidence until it ships."
          : `Add a criterion to ${owner.key} stating what holds after the fix, and carry this item's evidence over.`,
        owner === null
          ? "A criterion on the owning behavior outcome; the trace as 'denies' evidence"
          : `A criterion on ${owner.key}; the trace as 'denies' evidence there`,
        { determinism, related: owner === null ? [] : [owner.key], suffix: "bug" },
      ),
    );
  }

  // P3 Not in the tree at all: pure polish and finished artifacts.
  if (POLISH_OR_ARTIFACT_PATTERN.test(`${title} ${story}`) && !ONE_OFF_CHORE_PATTERN.test(title)) {
    findings.push(
      finding(
        "P3",
        item,
        "warning",
        title,
        "Outcome is pure polish or a finished artifact, with no lasting promise of its own.",
        "If it is a promise, fold it into the criteria of the outcome it improves; otherwise record what it established as evidence and archive it.",
        "Evidence on the outcome it informs, then archive",
      ),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export function lintTree(
  input: { goals: LintGoalInput[]; outcomes: LintOutcomeInput[]; contractVersion?: number },
  now: Date | string = new Date(),
): LintResult {
  const findings: LintFinding[] = [];
  for (const goal of input.goals) {
    findings.push(...lintGoal(goal, now));
  }
  const byGoal = new Map<string, LintOutcomeInput[]>();
  for (const outcome of input.outcomes) {
    const list = byGoal.get(outcome.goalKey) ?? [];
    list.push(outcome);
    byGoal.set(outcome.goalKey, list);
  }
  for (const outcome of input.outcomes) {
    findings.push(...lintOutcome(outcome, byGoal.get(outcome.goalKey) ?? []));
  }
  const errorCount = findings.filter((entry) => entry.severity === "error").length;
  const warningCount = findings.filter((entry) => entry.severity === "warning").length;
  const version =
    input.contractVersion ??
    (input.outcomes.length > 0
      ? Math.max(...input.outcomes.map((outcome) => outcome.version ?? 0))
      : null);
  return {
    passed: errorCount === 0,
    errorCount,
    warningCount,
    findings,
    version: version === 0 ? null : version,
    deterministicOnly: findings.every((entry) => entry.determinism === "deterministic"),
  };
}
