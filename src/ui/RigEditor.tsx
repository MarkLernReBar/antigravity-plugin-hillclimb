import correctnessKit from "../../assets/kits/correctness/kit.json"
import latencyKit from "../../assets/kits/latency-cost/kit.json"
import retrievalKit from "../../assets/kits/retrieval/kit.json"
import agentKit from "../../assets/kits/agent-outcomes/kit.json"
import tuningKit from "../../assets/kits/tuning/kit.json"
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Outcome } from '../model.js'
import type { RepoRig, Rig, SearchRig } from '../search-bridge.js'

// ---------------------------------------------------------------------------
// The shipped kits
// ---------------------------------------------------------------------------

/** `kit.json` as shipped in `assets/kits/<id>/`. */
export interface KitMeta {
  id: string
  title: string
  summary: string
  goal: string
  metric: string
  metricLabel: string
  unit: string
  /** The adapter's own word for what the number is: count, percentile, rank, … */
  scoreMode: string
  direction: 'min' | 'max'
  targetGuidance: string
  /** `score.py` invocation with `{kit}`, `{manifest}`, `{holdout}`, `{candidate}`. */
  check: string
  /** The disjoint holdout invocation, same placeholders. */
  holdout?: string
  guards: string[]
  guardDetails?: Record<string, string>
  /** The kit's own fixture baseline. Not the project's baseline. */
  baseline: { fixture: string; expected: number | null }
  knownBad: Array<{ id: string; fixture: string; expect: 'worse' | 'rejected' | 'guard_fail'; guard?: string }>
  repeats: { runs: number; maxSpread: number; why: string }
  data: { manifest: string; holdout: string; sample: boolean; label: string }
  notes: string
}

export const KITS: readonly KitMeta[] = [correctnessKit, latencyKit, retrievalKit, agentKit, tuningKit].map(kit => {
  if (kit.direction !== "min" && kit.direction !== "max") throw new Error("Invalid direction in " + kit.id);
  const knownBad = kit.knownBad.map(control => {
    const expect = control.expect;
    if (expect !== "worse" && expect !== "rejected" && expect !== "guard_fail") {
      throw new Error("Invalid known-bad expectation in " + kit.id);
    }
    return { ...control, expect } as KitMeta["knownBad"][number];
  });
  const label = "label" in kit.data ? kit.data.label : "Packaged example";
  return { ...kit, direction: kit.direction, knownBad, data: { ...kit.data, label } };
});

export function kitById(id: string, kits: readonly KitMeta[] = KITS): KitMeta | null {
  return kits.find((kit) => kit.id === id) ?? null
}

/** Where the kits are installed in the project checkout. */
export const DEFAULT_KIT_ROOT = '.hill-climb/kits'

// ---------------------------------------------------------------------------
// The commands: the kit's CLI, the project's data
// ---------------------------------------------------------------------------

/**
 * Python's `shlex.quote`, which `preflight.py` uses. Byte-for-byte matters:
 * these strings are the commands a person reads and the engine runs.
 */
export function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export interface KitInputs {
  kitRoot: string
  /** The project's data directory: its own kit.json, manifest, holdout, fixtures. */
  dataDir: string
  /** The project command that writes validation JSON rows to stdout. */
  candidate: string
  /** The command for the held-out split; the kit's holdout command runs it. */
  holdoutCandidate: string
  /** The project's holdout manifest; defaults to the kit's own name in the data dir. */
  holdoutPath: string
}

const trimSlash = (path: string): string => path.replace(/\/+$/, '')

/** Where the kits are installed, and this kit's folder inside it. */
export function kitDir(kit: KitMeta, kitRoot: string): string {
  return `${trimSlash(kitRoot)}/${kit.id}`
}

/** The project's manifest and holdout, named by the kit's own descriptor. */
export function manifestPath(kit: KitMeta, inputs: KitInputs): string {
  return `${trimSlash(inputs.dataDir)}/${kit.data.manifest}`
}

export function holdoutPathOf(kit: KitMeta, inputs: KitInputs): string {
  return inputs.holdoutPath.trim() === '' ? `${trimSlash(inputs.dataDir)}/${kit.data.holdout}` : inputs.holdoutPath.trim()
}

/** `preflight.py`'s `substitute()`: kit dir verbatim, everything else quoted. */
function substitute(
  template: string,
  kit: KitMeta,
  inputs: KitInputs,
  candidate: string,
  holdout: { path: string; placeholder: string } | null,
): string {
  return template
    .replace(/\{kit\}/g, kitDir(kit, inputs.kitRoot))
    .replace(/\{manifest\}/g, shellQuote(manifestPath(kit, inputs)))
    .replace(/\{holdout\}/g, holdout === null ? '<holdout>' : shellQuote(holdout.path))
    .replace(/\{candidate\}/g, candidate === '' ? '<candidate>' : shellQuote(candidate))
}

export interface KitCommands {
  score: string
  guards: Record<string, string>
  /** The holdout invocation: scored on the held-out split, run by its own command. */
  holdout: string | null
  /** The preflight the worker runs before `init`; the shipped CLI is the whole proof. */
  preflight: string
}

export function kitCommands(kit: KitMeta, inputs: KitInputs): KitCommands {
  const score = substitute(kit.check, kit, inputs, inputs.candidate, null)
  const guards: Record<string, string> = {}
  for (const guard of kit.guards) guards[guard] = `${score} --guard ${shellQuote(guard)}`
  const preflight = [
    'python3',
    shellQuote(`${trimSlash(inputs.kitRoot)}/preflight.py`),
    'preflight',
    '--kit',
    shellQuote(kit.id),
    '--data',
    shellQuote(inputs.dataDir),
    '--candidate',
    shellQuote(inputs.candidate),
    '--holdout-candidate',
    shellQuote(inputs.holdoutCandidate),
  ].join(' ')
  return {
    score,
    guards,
    holdout:
      kit.holdout === undefined
        ? null
        : substitute(kit.holdout, kit, inputs, inputs.holdoutCandidate, { path: holdoutPathOf(kit, inputs), placeholder: '<holdout candidate>' }),
    preflight,
  }
}

/** The files a step may not edit: the project's data and the kit that scores it. */
export function lockPaths(kit: KitMeta, inputs: KitInputs): string[] {
  const paths = [inputs.dataDir.trim(), holdoutPathOf(kit, inputs), kitDir(kit, inputs.kitRoot)].filter((path) => path !== '')
  return [...new Set(paths)]
}

const normalize = (path: string): string => path.trim().replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')

/**
 * The packaged example is refused as project data. `preflight.py` itself needs
 * `--data <dir>/kit.json` with `data.sample: false` and its own baseline and
 * known-bad fixtures; a verifier pointed at the kit folder would certify the
 * sample, never the project.
 */
export function isPackagedSample(kit: KitMeta, inputs: KitInputs): boolean {
  const data = normalize(inputs.dataDir)
  return data === '' || data === normalize(kitDir(kit, inputs.kitRoot)) || data === normalize(trimSlash(inputs.kitRoot))
}

// ---------------------------------------------------------------------------
// The form, as data
// ---------------------------------------------------------------------------


export interface Draft {
  kit: string
  engine: 'repo' | 'search'
  kitRoot: string
  /** The project's own data directory: its kit.json, manifest, holdout, fixtures. */
  dataDir: string
  /** The project's holdout manifest; blank means the kit's own name in the data dir. */
  holdoutPath: string
  /** The validation command, and the separate held-out command. */
  candidate: string
  holdoutCandidate: string
  /** Which of the kit's guards run on every step. */
  guards: Record<string, boolean>
  /** Criteria this verifier is asserted to cover. */
  covers: Record<string, boolean>
  scoreMode: 'numeric' | 'failure-count'
  /** True once a person or a kit made the meaning a decision; legacy rigs stay quiet. */
  scoreModeChosen: boolean
  direction: 'min' | 'max'
  target: string
  runs: string
  minGain: string
  paired: boolean
  hard: boolean
  maxSteps: string
  maxHours: string
  after: 'stop' | 'raise'
  name: string
  /** Hand-written verifiers keep their own fields; a kit generates them. */
  check: string
  score: string
  guard: string
  lock: string
  holdout: string
  preflight: string
  problemId: string
  metric: string
  verifier: string
  baseline: string
  budget: string
  agent: string
  model: string
  parallelSearches: string
  climber: 'greedy' | 'openevolve' | 'gepa'
  tuner: 'random' | 'optuna'
  features: string
  tuneBudget: string
}

export function emptyDraft(engine: 'repo' | 'search'): Draft {
  return {
    kit: '',
    engine,
    kitRoot: DEFAULT_KIT_ROOT,
    dataDir: '',
    holdoutPath: '',
    candidate: '',
    holdoutCandidate: '',
    guards: {},
    covers: {},
    scoreMode: 'failure-count',
    scoreModeChosen: false,
    direction: engine === 'repo' ? 'min' : 'max',
    target: '',
    runs: '',
    minGain: '',
    paired: false,
    hard: false,
    maxSteps: '',
    maxHours: '',
    after: 'stop',
    name: '',
    check: '',
    score: '',
    guard: '',
    lock: '',
    holdout: '',
    preflight: '',
    problemId: '',
    metric: '',
    verifier: '',
    baseline: '',
    budget: '',
    agent: '',
    model: '',
    parallelSearches: '',
    climber: 'greedy',
    tuner: 'random',
    features: '',
    tuneBudget: '',
  }
}

/** Choosing a kit sets what the kit decides: direction, guards, repeats, meaning. */
export function draftForKit(draft: Draft, kit: KitMeta): Draft {
  const guards: Record<string, boolean> = {}
  for (const guard of kit.guards) guards[guard] = true
  return {
    ...draft,
    kit: kit.id,
    engine: 'repo',
    direction: kit.direction,
    guards,
    // A kit's adapter always prints a number the score must contain; that is a
    // required observation, never the failure-count reading.
    scoreMode: 'numeric',
    scoreModeChosen: true,
    runs: String(kit.repeats.runs),
    minGain: draft.minGain === '' ? '0' : draft.minGain,
  }
}

/** A stored rig as the editor's strings. */
export function seedDraft(existing: Rig | null, engine: 'repo' | 'search'): Draft {
  const draft = emptyDraft(engine)
  if (existing === null) return draft
  const covered = (): Record<string, boolean> => Object.fromEntries((existing.criterionIds ?? []).map((id) => [id, true]))
  if (existing.engine === 'repo') {
    return {
      ...draft,
      covers: covered(),
      preflight: existing.preflight ?? '',
      // Without a recorded meaning, read it off what the stored rig does: a
      // pattern that may match nothing is the count convention; no pattern
      // means the check has to print the number.
      scoreModeChosen: existing.scoreMode !== undefined,
      scoreMode: existing.scoreMode ?? ((existing.score ?? []).length > 0 ? 'failure-count' : 'numeric'),
      engine: 'repo',
      check: existing.check.join('\n'),
      score: (existing.score ?? []).join('\n'),
      direction: existing.direction,
      target: String(existing.target),
      guard: existing.guard.join('\n'),
      lock: existing.lock.join('\n'),
      holdout: existing.holdout,
      runs: existing.runs === undefined ? '' : String(existing.runs),
      minGain: existing.minGain ?? '',
      paired: existing.paired === true,
      hard: existing.hard === true,
      maxSteps: existing.maxSteps === undefined ? '' : String(existing.maxSteps),
      maxHours: existing.maxHours === undefined ? '' : String(existing.maxHours),
      after: existing.after ?? 'stop',
      name: existing.name ?? '',
    }
  }
  const climber = existing.climber
  return {
    ...draft,
    covers: covered(),
    engine: 'search',
    problemId: existing.problemId,
    metric: existing.metric,
    direction: existing.higherIsBetter ? 'max' : 'min',
    target: String(existing.target),
    verifier: existing.verifier,
    baseline: existing.baseline,
    budget: existing.budget ?? '',
    agent: existing.agent ?? '',
    model: existing.model ?? '',
    parallelSearches: existing.parallelSearches === undefined ? '' : String(existing.parallelSearches),
    climber: climber?.name ?? 'greedy',
    tuner: climber?.tuner ?? 'random',
    features: (climber?.featureDimensions ?? []).join(', '),
    tuneBudget: climber?.tuneBudget === undefined ? '' : String(climber.tuneBudget),
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FieldError {
  /** The control's element id, so the first one can take focus. */
  field: string
  message: string
}

const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

const numeric = (text: string): number | null => {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

const integer = (text: string): number | null => {
  const value = numeric(text)
  return value !== null && Number.isInteger(value) ? value : null
}

export function covered(draft: Draft): string[] {
  return Object.keys(draft.covers)
    .filter((id) => draft.covers[id])
    .sort()
}

export function selectedGuards(draft: Draft, kit: KitMeta): string[] {
  return kit.guards.filter((guard) => draft.guards[guard] === true)
}

const MIN_GAIN = /^\d+(?:\.\d+)?%?$/
const BUDGET = /^\d+(?:\.\d+)?[smh]$/
const PROBLEM_ID = /^[a-z0-9][a-z0-9._-]*$/

/** The draft's kit inputs, as the command builder wants them. */
export function inputsOf(draft: Draft): KitInputs {
  return {
    kitRoot: draft.kitRoot.trim() === '' ? DEFAULT_KIT_ROOT : draft.kitRoot.trim(),
    dataDir: draft.dataDir.trim(),
    candidate: draft.candidate.trim(),
    holdoutCandidate: draft.holdoutCandidate.trim(),
    holdoutPath: draft.holdoutPath.trim(),
  }
}

export function validateDraft(draft: Draft, outcome: Outcome, kit: KitMeta | null, existing: Rig | null = null): FieldError[] {
  const errors: FieldError[] = []
  const need = (field: string, message: string): void => {
    errors.push({ field, message })
  }

  if (draft.kit !== '' && kit === null) need('kit', 'That kit is not installed here; choose another or configure the verifier by hand.')
  if (existing === null && outcome.criteria.length > 0 && covered(draft).length === 0) {
    need('covers', 'Say which criteria these checks cover before saving a new verifier.')
  }
  if (numeric(draft.target) === null) need('target', 'Give the bar as a number: the score that means done.')

  if (draft.engine === 'repo' && kit !== null) {
    // The project's data directory, not the kit's packaged example.
    if (draft.dataDir.trim() === '') need('dataDir', 'Give your project’s data directory: it holds a kit.json with data.sample false, the manifest, the holdout and the project’s own fixtures.')
    else if (isPackagedSample(kit, inputsOf(draft))) {
      need('dataDir', `That is the kit’s packaged example (${kit.data.label.toLowerCase()}). Name your project’s own data directory: the shipped CLI refuses a directory without a project kit.json.`)
    }
    if (draft.candidate.trim() === '') need('candidate', 'Give the project command that writes validation JSON rows to stdout.')
    if (draft.holdoutCandidate.trim() === '') need('holdoutCandidate', 'Give the command for the held-out split. The kit scores the holdout with its own command, never the visible one.')
    if (selectedGuards(draft, kit).length === 0) need('guards', 'Keep at least one guard: the conditions that must stay true whatever the score does.')
  }

  if (draft.engine === 'repo' && kit === null) {
    if (linesOf(draft.check).length === 0) need('check', 'Give at least one scoring command.')
    if (linesOf(draft.guard).length === 0) need('guard', 'Give at least one guard: the commands that must keep passing.')
    if (linesOf(draft.lock).length === 0) need('lock', 'Lock the check and its fixtures, so a step cannot edit what scores it.')
    if (draft.holdout.trim() === '') need('holdout', 'Give the holdout check: the cases the climber never sees.')
    if (draft.scoreMode === 'failure-count' && linesOf(draft.score).length === 0) {
      need('score', 'Count mode reads a number from a pattern, usually one that matches nothing when nothing failed. Give the pattern, or switch to a required measurement.')
    }
    const patterns = linesOf(draft.score)
    if (patterns.length > 1 && patterns.length !== linesOf(draft.check).length) {
      need('score', `Give one pattern for all checks, or one per check: ${patterns.length} for ${linesOf(draft.check).length}.`)
    }
  }

  if (draft.engine === 'repo') {
    const runs = integer(draft.runs)
    if (draft.runs.trim() !== '' && (runs === null || runs < 1)) need('runs', 'Runs is a whole number of measurements per score, at least 1.')
    if (draft.minGain.trim() !== '' && !MIN_GAIN.test(draft.minGain.trim())) need('minGain', 'Minimum gain is a number or a percentage, like 1.5 or 2%.')
    if (draft.paired && runs !== null && runs < 2) need('runs', 'Paired measurement alternates candidate and incumbent, so it needs at least 2 runs per score.')
    if (draft.maxSteps.trim() !== '' && (integer(draft.maxSteps) ?? 0) < 1) need('maxSteps', 'Max steps is a whole number, at least 1.')
    if (draft.maxHours.trim() !== '' && (numeric(draft.maxHours) ?? 0) <= 0) need('maxHours', 'Max hours is a positive number.')
    if (draft.hard && draft.maxSteps.trim() === '' && draft.maxHours.trim() === '') need('maxSteps', 'A hard stop needs a step or an hour limit to stop at.')
  } else {
    if (!PROBLEM_ID.test(draft.problemId.trim())) need('problemId', 'Problem id is lowercase letters, digits, dot, dash or underscore.')
    if (draft.metric.trim() === '') need('metric', 'Name the metric the verifier reports.')
    if (draft.verifier.trim() === '') need('verifier', 'Paste the verifier script: it prints the score.')
    if (draft.baseline.trim() === '') need('baseline', 'Paste the starting solution; it is scored as the baseline candidate.')
    if (draft.budget.trim() !== '' && !BUDGET.test(draft.budget.trim())) need('budget', 'Budget is a wall-clock span like 30m or 2h.')
    if (draft.parallelSearches.trim() !== '' && (integer(draft.parallelSearches) ?? 0) < 1) need('parallelSearches', 'Parallel searches is a whole number, at least 1.')
    if (draft.features.trim() !== '' && draft.climber !== 'openevolve') need('features', 'Feature dimensions are a MAP-Elites setting, and this climber has no grid.')
    if (draft.tuneBudget.trim() !== '' && (integer(draft.tuneBudget) ?? -1) < 0) need('tuneBudget', 'Tuning trials is a whole number, 0 to switch tuning off.')
    if (draft.tuner === 'optuna' && integer(draft.tuneBudget) === 0) need('tuneBudget', 'Optuna is selected and no trial is allowed, so the tuner would never run.')
  }
  return errors
}

/** The tuning default a climber ships, as measured on the pinned 0.8.2 catalog. */
export function tuneDefaultFor(climber: Draft['climber']): { trials: number | null; text: string } {
  if (climber === 'greedy') return { trials: 8, text: '8 extra trials per tuned candidate' }
  if (climber === 'openevolve') return { trials: 0, text: '0 extra trials, so tuning is off' }
  return { trials: null, text: 'not declared by this climber' }
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export interface BuildResult {
  rig: Rig | null
  errors: FieldError[]
}

/**
 * The editor's payload: the stored rig as the typed base, overwritten with what
 * the form holds. Setting a field to `undefined` removes it rather than keeping
 * a stale value, which is how clearing a bar, name or allowance works. For a
 * kit the check, guards, holdout and preflight are generated from the kit's
 * own CLI and the project's paths; for a hand-written rig they are typed in.
 */
// The SDK rejects undefined even for optional keys. Omission also clears fields
// that the operator removed while editing a previously saved rig.
function omitUnset<T extends object>(value: T): T {
  const result = { ...value }
  for (const key in result) {
    if (result[key] === undefined) delete result[key]
  }
  return result
}

export function buildRig(draft: Draft, outcome: Outcome, existing: Rig | null, kit: KitMeta | null): BuildResult {
  const errors = validateDraft(draft, outcome, kit, existing)
  if (errors.length > 0) return { rig: null, errors }
  const inputs = inputsOf(draft)
  const commands = kit === null ? null : kitCommands(kit, inputs)
  const features = draft.features
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  if (draft.engine === 'repo') {
    const check = commands === null ? linesOf(draft.check) : [commands.score]
    const guard = commands === null ? linesOf(draft.guard) : selectedGuards(draft, kit!).map((name) => commands.guards[name])
    const holdout = commands === null ? draft.holdout.trim() : (commands.holdout ?? '')
    const lock = kit === null ? linesOf(draft.lock) : lockPaths(kit, inputs)
    const preflight = kit === null ? draft.preflight.trim() : commands!.preflight
    const rig: RepoRig = {
      ...(existing?.engine === 'repo' ? existing : {}),
      engine: 'repo',
      check,
      direction: draft.direction,
      target: numeric(draft.target)!,
      guard,
      holdout,
      lock,
      name: draft.name.trim() === '' ? undefined : draft.name.trim(),
      score: commands === null && linesOf(draft.score).length > 0 ? linesOf(draft.score) : undefined,
      runs: integer(draft.runs) ?? undefined,
      minGain: draft.minGain.trim() === '' ? undefined : draft.minGain.trim(),
      maxSteps: integer(draft.maxSteps) ?? undefined,
      maxHours: numeric(draft.maxHours) ?? undefined,
      after: draft.after === 'raise' ? 'raise' : undefined,
      preflight: preflight === '' ? undefined : preflight,
      criterionIds: covered(draft).length === 0 ? undefined : covered(draft),
      scoreMode: draft.scoreModeChosen ? draft.scoreMode : undefined,
      paired: draft.paired || undefined,
      hard: draft.hard || undefined,
    }
    return { rig: omitUnset(rig), errors: [] }
  }

  // The climber block stays absent for a plain greedy run with no tuner, no grid
  // and no tuning allowance: that is the legacy command line, unchanged.
  const plainClimber = draft.climber === 'greedy' && draft.tuner === 'random' && features.length === 0 && draft.tuneBudget.trim() === ''
  const climber: SearchRig['climber'] | undefined = plainClimber
    ? undefined
    : {
        name: draft.climber,
        tuner: draft.tuner === 'random' ? undefined : draft.tuner,
        featureDimensions: features.length === 0 ? undefined : features,
        tuneBudget: integer(draft.tuneBudget) ?? undefined,
      }
  const rig: SearchRig = {
    ...(existing?.engine === 'search' ? existing : {}),
    engine: 'search',
    problemId: draft.problemId.trim(),
    metric: draft.metric.trim(),
    higherIsBetter: draft.direction === 'max',
    target: numeric(draft.target)!,
    verifier: draft.verifier,
    baseline: draft.baseline,
    budget: draft.budget.trim() === '' ? undefined : draft.budget.trim(),
    agent: draft.agent.trim() === '' ? undefined : draft.agent.trim(),
    model: draft.model.trim() === '' ? undefined : draft.model.trim(),
    parallelSearches: integer(draft.parallelSearches) ?? undefined,
    climber: climber && omitUnset(climber),
    criterionIds: covered(draft).length === 0 ? undefined : covered(draft),
  }
  return { rig: omitUnset(rig), errors: [] }
}

// ---------------------------------------------------------------------------
// Cost preview
// ---------------------------------------------------------------------------

export interface BudgetLine {
  label: string
  detail: string
  /** False when the real number cannot be known from what was entered. */
  known: boolean
}

/**
 * What the run may spend, in the four currencies that differ: steps, verifier
 * executions, wall clock, and money. A price is never filled in: an unpriced
 * run reads `unknown` instead of a comfortable zero.
 */
export function budgetPreview(draft: Draft, kit: KitMeta | null): BudgetLine[] {
  const out: BudgetLine[] = []
  const runs = integer(draft.runs)
  const steps = integer(draft.maxSteps)
  const hours = numeric(draft.maxHours)
  const guards = kit === null ? linesOf(draft.guard).length : selectedGuards(draft, kit).length
  if (draft.engine === 'repo') {
    out.push({
      label: 'Scored steps',
      detail: steps === null ? 'no step limit recorded' : `${steps} steps · ${draft.hard ? 'hard stop at that count' : 'soft: past it, only steps that still gain'}`,
      known: steps !== null,
    })
    out.push({
      label: 'Verifier runs',
      detail:
        runs === null
          ? 'runs per score not stated, so the run count cannot be stated in verifier time'
          : `${runs} runs plus the engine’s warm-up per step${draft.paired ? ', paired against the incumbent' : ''}` +
            (steps === null ? '' : ` → up to ${(runs + 1) * steps} scoring runs`),
      known: runs !== null,
    })
    out.push({ label: 'Guard runs', detail: `${guards} guard command${guards === 1 ? '' : 's'} on every kept step`, known: true })
    if (draft.paired) out.push({ label: 'Paired measurement', detail: 'candidate and incumbent are measured alternately in the same step', known: true })
    out.push({
      label: 'Wall clock',
      detail: hours === null ? 'no hour limit recorded' : `${hours} h since init · ${draft.hard ? 'hard stop' : 'soft: keeps going while steps gain'}`,
      known: hours !== null,
    })
  } else {
    const parallel = integer(draft.parallelSearches)
    out.push({ label: 'Search budget', detail: draft.budget.trim() === '' ? 'no wall-clock budget recorded' : draft.budget.trim(), known: draft.budget.trim() !== '' })
    out.push({
      label: 'Generators',
      detail:
        draft.agent.trim() === ''
          ? 'agent unset here, so the engine’s own default runs · its cost cannot be attributed'
          : `${draft.agent}${draft.model.trim() === '' ? ' on its default model' : ` running ${draft.model}`}${parallel === null ? '' : ` · ${parallel} searches at once`}`,
      known: draft.agent.trim() !== '',
    })
    const trials = integer(draft.tuneBudget)
    out.push({
      label: 'Tuning trials',
      detail: trials === null ? `not stated here · the climber default is ${tuneDefaultFor(draft.climber).text}` : `${trials} extra trials per tuned candidate, on top of its own scored trial`,
      known: trials !== null,
    })
    out.push({ label: 'Search candidates', detail: 'each candidate is one agent generation, and each may add tuning trials and verifier calls', known: true })
  }
  out.push({ label: 'Model spend', detail: 'unknown · no price is configured for this run, so a money figure here would be invented', known: false })
  out.push({ label: 'Cost of a false win', detail: `a rejected step still pays for its scoring runs${draft.engine === 'search' ? ' and its generation' : ''}`, known: true })
  return out
}

// ---------------------------------------------------------------------------
// The rendered form (no hooks, so a test can walk it)
// ---------------------------------------------------------------------------

export interface RigFieldsProps {
  outcome: Outcome
  draft: Draft
  kit: KitMeta | null
  kits: readonly KitMeta[]
  errors: readonly FieldError[]
  onChange: (patch: Partial<Draft>) => void
  onCover: (criterion: string, covers: boolean) => void
  onGuard: (guard: string, on: boolean) => void
  onKit: (id: string) => void
}

interface Spec {
  key: keyof Draft & string
  label: string
  hint?: string
  kind?: 'input' | 'textarea' | 'select'
  rows?: number
  type?: 'text' | 'number'
  min?: number
  step?: string | number
  options?: ReadonlyArray<readonly [string, string]>
}

const errorOf = (errors: readonly FieldError[], field: string): string | null => errors.find((row) => row.field === field)?.message ?? null

function Control(props: { spec: Spec; draft: Draft; errors: readonly FieldError[]; onChange: (patch: Partial<Draft>) => void }): React.ReactElement {
  const { spec, draft, errors, onChange } = props
  const error = errorOf(errors, spec.key)
  const described = [spec.hint === undefined ? '' : `${spec.key}-hint`, error === null ? '' : `${spec.key}-error`].filter(Boolean).join(' ')
  const common = {
    id: spec.key,
    name: spec.key,
    'aria-invalid': error !== null,
    'aria-describedby': described === '' ? undefined : described,
  }
  const value = String(draft[spec.key])
  const set = (next: string): void => onChange({ [spec.key]: next })
  return (
    <p className="hc-field">
      <label htmlFor={spec.key}>{spec.label}</label>
      {spec.kind === 'select' ? (
        <select {...common} value={value} onChange={(event) => set(event.target.value)}>
          {spec.options?.map(([optionValue, optionLabel]) => (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          ))}
        </select>
      ) : spec.kind === 'textarea' ? (
        <textarea {...common} rows={spec.rows ?? 2} value={value} onChange={(event) => set(event.target.value)} />
      ) : (
        <input
          {...common}
          type={spec.type ?? 'text'}
          {...(spec.min === undefined ? {} : { min: spec.min })}
          {...(spec.step === undefined ? {} : { step: spec.step })}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
      {spec.hint === undefined ? null : <small id={`${spec.key}-hint`}>{spec.hint}</small>}
      {error === null ? null : (
        <small className="hc-field-error" id={`${spec.key}-error`} role="alert">
          {error}
        </small>
      )}
    </p>
  )
}

const PROJECT_FIELDS: readonly Spec[] = [
  { key: 'dataDir', label: 'Project data directory', hint: 'Holds your kit.json (data.sample false, baseline.fixture, knownBad fixtures), the manifest and the holdout. The kit folder itself is refused.' },
  { key: 'holdoutPath', label: 'Holdout manifest (optional override)', hint: 'Defaults to the kit’s holdout name inside the data directory.' },
  { key: 'candidate', label: 'Validation candidate command', hint: 'The project command that writes validation JSON rows to stdout.' },
  { key: 'holdoutCandidate', label: 'Held-out candidate command', hint: 'Used only by the holdout invocation; the preflight never runs it.' },
]

const MANUAL_FIELDS: readonly Spec[] = [
  { key: 'check', label: 'Scoring commands, one per line', kind: 'textarea', rows: 3, hint: 'Each prints the score; the engine sums their numbers.' },
  { key: 'score', label: 'Score patterns, one per command (optional except in count mode)', kind: 'textarea', hint: 'A regular expression with one group, like (\\d+) failed.' },
  { key: 'guard', label: 'Regression guards, one per line', kind: 'textarea', hint: 'Each must exit 0 whatever the score does.' },
  { key: 'lock', label: 'Locked check files, one per line', kind: 'textarea', hint: 'A step that edits these is refused.' },
  { key: 'holdout', label: 'Holdout check (cases the climber never sees)' },
  { key: 'preflight', label: 'Preflight command (optional)', hint: 'The worker runs it before init; a nonzero exit stops the activation.' },
  { key: 'name', label: 'Climb name (optional)', hint: 'Defaults to the run’s own id.' },
]

const ALLOWANCE: readonly Spec[] = [
  { key: 'runs', label: 'Runs per score', type: 'number', min: 1, step: 1, hint: 'Median wins; the engine also runs one warm-up.' },
  { key: 'minGain', label: 'Minimum gain that counts', hint: 'A number or a percentage, like 2%.' },
  { key: 'maxSteps', label: 'Max steps', type: 'number', min: 1, step: 1 },
  { key: 'maxHours', label: 'Max hours', type: 'number', min: 0.01, step: 'any' },
]

const SEARCH_FIELDS: readonly Spec[] = [
  { key: 'problemId', label: 'Problem id', hint: 'Lowercase letters, digits, dot, dash or underscore.' },
  { key: 'metric', label: 'Metric name' },
  { key: 'verifier', label: 'Verifier script (verifier.sh)', kind: 'textarea', rows: 4, hint: 'Prints the score for one candidate.' },
  { key: 'baseline', label: 'Starting solution (baseline.py)', kind: 'textarea', rows: 4 },
  { key: 'budget', label: 'Wall-clock budget', hint: 'Like 30m or 2h.' },
  { key: 'parallelSearches', label: 'Parallel searches', type: 'number', min: 1, step: 1, hint: 'Independent searches at once; blank is one.' },
  {
    key: 'agent',
    label: 'Generator',
    kind: 'select',
    hint: 'The coding agent that proposes candidates.',
    options: [
      ['', 'engine default (unstated)'],
      ['claude-code', 'claude-code'],
      ['codex', 'codex'],
      ['pi', 'pi'],
      ['dummy', 'dummy — plumbing check, no model'],
      ['toy', 'toy — plumbing check, no model'],
    ],
  },
  { key: 'model', label: 'Generator model', hint: 'What the generator runs, so the cost line is attributable.' },
  {
    key: 'climber',
    label: 'Climber',
    kind: 'select',
    hint: 'Which search policy runs; the engine snapshots it for a resume.',
    options: [
      ['greedy', 'greedy — one improvement at a time'],
      ['openevolve', 'openevolve — MAP-Elites over a feature grid'],
      ['gepa', 'gepa — reflective search over examples'],
    ],
  },
  {
    key: 'tuner',
    label: 'Tuner',
    kind: 'select',
    hint: 'Optuna needs its extra installed on the worker host.',
    options: [
      ['random', 'random'],
      ['optuna', 'optuna'],
    ],
  },
  { key: 'tuneBudget', label: 'Tuning trials per tuned candidate', type: 'number', min: 0, step: 1 },
  { key: 'features', label: 'MAP-Elites dimensions (openevolve only)', hint: 'Comma separated, 1 to 3 lowercase names.' },
]

export function RigFields(props: RigFieldsProps): React.ReactElement {
  const { outcome, draft, kit, kits, errors, onChange, onCover, onGuard, onKit } = props
  const inputs = inputsOf(draft)
  const commands = kit === null ? null : kitCommands(kit, inputs)
  const guards = kit === null ? [] : selectedGuards(draft, kit)
  const generated: Array<[string, string]> =
    kit === null || commands === null
      ? []
      : [
          ['Score', commands.score],
          ...guards.map((name) => [`Guard · ${name}`, commands.guards[name]] as [string, string]),
          ...(commands.holdout === null ? [] : ([['Holdout', commands.holdout]] as Array<[string, string]>)),
          ['Preflight', commands.preflight],
        ]

  return (
    <>
      <p className="hc-hint">
        These checks apply to version {outcome.version} of the contract. Start from what should improve; the check has to
        be shown to detect a worse candidate before a run is worth its cost.
      </p>

      <fieldset className="hc-step">
        <legend>1 · What should improve</legend>
        <div role="radiogroup" aria-label="Measurement kit" className="hc-kits">
          {kits.map((option) => (
            <label key={option.id} className="hc-kit-option">
              <input
                type="radio"
                name="kit"
                value={option.id}
                checked={draft.kit === option.id}
                aria-describedby={`kit-${option.id}-hint`}
                onChange={() => onKit(option.id)}
              />
              <span>
                <strong>{option.title}</strong>
                <small id={`kit-${option.id}-hint`}>
                  {option.metricLabel} ({option.unit}), {option.direction === 'max' ? 'higher' : 'lower'} is better.
                </small>
              </span>
            </label>
          ))}
          <label className="hc-kit-option">
            <input type="radio" name="kit" value="" checked={draft.kit === ''} onChange={() => onKit('')} />
            <span>
              <strong>No kit — configure by hand</strong>
              <small>Keep an existing verifier, or write the commands yourself.</small>
            </span>
          </label>
        </div>
        {errorOf(errors, 'kit') === null ? null : (
          <p className="hc-field-error" role="alert">
            {errorOf(errors, 'kit')}
          </p>
        )}
        {kit === null ? null : (
          <div className="hc-kit-detail">
            <p>{kit.summary}</p>
            <p>
              <strong>What counts as a real measured win:</strong> {kit.goal}
            </p>
            <p className="hc-hint">
              <strong>Bar:</strong> {kit.targetGuidance}
            </p>
            <p className="hc-hint">
              <strong>The kit’s own fixture baseline</strong> is {kit.baseline.expected ?? 'not stated'} {kit.unit} on{' '}
              <code>{kit.baseline.fixture}</code>. That number proves the adapter works; it is not your project’s baseline.
            </p>
            <p className="hc-hint">
              <strong>Known-bad controls the kit ships:</strong>{' '}
              {kit.knownBad.map((control) => `${control.id} (${control.expect}${control.guard === undefined ? '' : `, ${control.guard}`})`).join(', ')}.
            </p>
            <p className="hc-hint">
              <strong>Repeats:</strong> {kit.repeats.runs} runs, spread at most {kit.repeats.maxSpread}. {kit.repeats.why}
            </p>
            <p className="hc-hint">{kit.notes}</p>
          </div>
        )}
      </fieldset>

      {kit !== null ? (
        <fieldset className="hc-step">
          <legend>2 · Your project’s data</legend>
          <p className="hc-hint">
            The kit ships a packaged example (<code>{kit.data.label}</code>) and the CLI refuses it as project data unless
            someone passes <code>--allow-sample</code>. Name your own data directory instead: a verifier pointed at the
            sample proves the command runs, never that the project got better.
          </p>
          {PROJECT_FIELDS.map((spec) => (
            <Control key={spec.key} spec={spec} draft={draft} errors={errors} onChange={onChange} />
          ))}
          <Control spec={{ key: 'kitRoot', label: 'Kit install directory', hint: `Where the kit tree is copied in the project (default ${DEFAULT_KIT_ROOT}).` }} draft={draft} errors={errors} onChange={onChange} />
          <fieldset className="hc-substep">
            <legend>Guards that must stay true</legend>
            {kit.guards.map((guard) => (
              <label key={guard} className="hc-radio">
                <input type="checkbox" name={`guard-${guard}`} checked={draft.guards[guard] === true} onChange={(event) => onGuard(guard, event.target.checked)} />
                <span>
                  {guard}
                  <small>{kit.guardDetails?.[guard] === undefined ? '' : ` ${kit.guardDetails[guard]}`}</small>
                </span>
              </label>
            ))}
            {errorOf(errors, 'guards') === null ? null : (
              <p className="hc-field-error" role="alert">
                {errorOf(errors, 'guards')}
              </p>
            )}
          </fieldset>
        </fieldset>
      ) : (
        <fieldset className="hc-step">
          <legend>2 · The verifier</legend>
          <div role="group" aria-label="Engine" className="hc-row-actions">
            {(['repo', 'search'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`hc-chip${draft.engine === option ? ' is-active' : ''}`}
                aria-pressed={draft.engine === option}
                onClick={() => onChange({ engine: option, kit: '' })}
              >
                {option === 'repo' ? 'repo climb' : 'evolutionary search'}
              </button>
            ))}
          </div>
          <Control
            spec={{
              key: 'direction',
              label: 'Better scores are',
              kind: 'select',
              options: [
                ['min', 'lower'],
                ['max', 'higher'],
              ],
            }}
            draft={draft}
            errors={errors}
            onChange={onChange}
          />
          {draft.engine === 'repo' ? (
            <>
              <fieldset className="hc-substep">
                <legend>What the number means</legend>
                {(['numeric', 'failure-count'] as const).map((mode) => (
                  <label key={mode} className="hc-radio">
                    <input
                      type="radio"
                      name="scoreMode"
                      value={mode}
                      checked={draft.scoreMode === mode}
                      onChange={() => onChange({ scoreMode: mode, scoreModeChosen: true })}
                    />
                    <span>
                      {mode === 'numeric' ? 'A required measurement' : 'A count of failures'}
                      <small>
                        {mode === 'numeric'
                          ? ' The check has to print a number; a step that prints none fails instead of scoring 0.'
                          : ' The engine’s existing convention: a pattern that matches nothing counts 0.'}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {MANUAL_FIELDS.map((spec) => (
                <Control key={spec.key} spec={spec} draft={draft} errors={errors} onChange={onChange} />
              ))}
            </>
          ) : (
            SEARCH_FIELDS.map((spec) => (
              <Control
                key={spec.key}
                spec={spec.key === 'tuneBudget' ? { ...spec, hint: `Extra trials beyond the candidate’s own scored trial. The ${draft.climber} default is ${tuneDefaultFor(draft.climber).text}.` } : spec}
                draft={draft}
                errors={errors}
                onChange={onChange}
              />
            ))
          )}
        </fieldset>
      )}

      {outcome.criteria.length === 0 ? null : (
        <fieldset className="hc-step">
          <legend>3 · What this verifier covers</legend>
          <p className="hc-hint">The run binds this contract version’s criteria. Tick the ones these checks actually cover.</p>
          <ul className="hc-criteria-pick">
            {outcome.criteria.map((criterion) => (
              <li key={criterion.id}>
                <label>
                  <input
                    type="checkbox"
                    name={`covers-${criterion.id}`}
                    checked={draft.covers[criterion.id] === true}
                    onChange={(event) => onCover(criterion.id, event.target.checked)}
                  />{' '}
                  <code>{criterion.id}</code> {criterion.then}
                </label>
              </li>
            ))}
          </ul>
          {errorOf(errors, 'covers') === null ? null : (
            <p className="hc-field-error" role="alert">
              {errorOf(errors, 'covers')}
            </p>
          )}
        </fieldset>
      )}

      {kit === null ? null : (
        <fieldset className="hc-step">
          <legend>4 · The commands this saves</legend>
          <p className="hc-hint">
            Generated from the kit’s own CLI and the paths above. The preflight is recorded here; the worker runs it before{' '}
            <code>init</code>, and only its exit status and output prove the check.
          </p>
          <dl className="hc-commands">
            {generated.map(([label, command]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <code>{command}</code>
                </dd>
              </div>
            ))}
          </dl>
        </fieldset>
      )}

      <fieldset className="hc-step">
        <legend>{kit === null ? (outcome.criteria.length === 0 ? '3' : '4') : '5'} · Allowance</legend>
        <p className="hc-grid">
          <Control spec={{ key: 'target', label: 'Target score (the bar)', type: 'number', step: 'any' }} draft={draft} errors={errors} onChange={onChange} />
          {ALLOWANCE.map((spec) => (
            <Control key={spec.key} spec={spec} draft={draft} errors={errors} onChange={onChange} />
          ))}
        </p>
        {draft.engine === 'repo' ? (
          <>
            <label className="hc-toggle" htmlFor="paired">
              <input id="paired" name="paired" type="checkbox" checked={draft.paired} onChange={(event) => onChange({ paired: event.target.checked })} />
              Paired measurement
            </label>
            <p className="hc-hint">Score each step against the incumbent in alternating runs, for checks the machine’s load moves.</p>
            <label className="hc-toggle" htmlFor="hard">
              <input id="hard" name="hard" type="checkbox" checked={draft.hard} onChange={(event) => onChange({ hard: event.target.checked })} />
              Hard stop
            </label>
            <p className="hc-hint">Stop exactly at the step or hour limit. Unchecked, those limits are soft: past them, only steps that still gain are allowed.</p>
            <Control
              spec={{
                key: 'after',
                label: 'At the bar',
                kind: 'select',
                options: [
                  ['stop', 'stop'],
                  ['raise', 'raise the bar and continue'],
                ],
              }}
              draft={draft}
              errors={errors}
              onChange={onChange}
            />
          </>
        ) : null}
        <div className="hc-budget" aria-label="What this run may spend">
          <h4>What this run may spend</h4>
          <dl>
            {budgetPreview(draft, kit).map((line) => (
              <div key={line.label} className={line.known ? 'hc-budget-row' : 'hc-budget-row is-unknown'}>
                <dt>{line.label}</dt>
                <dd>
                  {line.detail}
                  {line.known ? null : <span className="hc-badge hc-badge-unknown">unknown</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </fieldset>

      {errors.length === 0 ? null : (
        <div className="hc-field-error" role="alert">
          <p>{errors.length === 1 ? 'One field needs attention.' : `${errors.length} fields need attention.`}</p>
          <ul>
            {errors.map((row) => (
              <li key={`${row.field}:${row.message}`}>{row.message}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export interface Props {
  outcome: Outcome
  engine: Rig['engine']
  onSave: (rig: Rig) => Promise<void>
  onClose: () => void
  /** The verifier already stored for this version, if any: seeded, never reset. */
  existing?: Rig | null
  /** The shipped kit descriptors; override only for a test or a host with its own set. */
  kits?: readonly KitMeta[]
}

export function RigEditor({ outcome, engine, onSave, onClose, existing = null, kits = KITS }: Props): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<Draft>(() => seedDraft(existing, engine))
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const kit = kitById(draft.kit, kits)

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  const change = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setNotice(null)
  }

  const chooseKit = (id: string): void => {
    const chosen = kitById(id, kits)
    if (id === '' || chosen === null) {
      change({ kit: '' })
      return
    }
    setDraft((current) => draftForKit(current, chosen))
    setNotice(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const built = buildRig(draft, outcome, existing, kit)
    if (built.rig === null) {
      setErrors(built.errors)
      setNotice('Not saved: a field above needs attention.')
      const first = built.errors[0]
      if (first !== undefined) document.getElementById(first.field)?.focus()
      return
    }
    setErrors([])
    setBusy(true)
    setNotice(null)
    try {
      await onSave(built.rig)
    } catch (reason) {
      setNotice(`Not saved: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="hill-rig" aria-label={`Configure climb verifier for ${outcome.key}`} onCancel={onClose}>
      <form onSubmit={(event) => void submit(event)} aria-label={`Verifier for ${outcome.key}`}>
        <h2>Configure {outcome.key}</h2>
        <RigFields
          outcome={outcome}
          draft={draft}
          kit={kit}
          kits={kits}
          errors={errors}
          onChange={change}
          onCover={(criterion, covers) => change({ covers: { ...draft.covers, [criterion]: covers } })}
          onGuard={(guard, on) => change({ guards: { ...draft.guards, [guard]: on } })}
          onKit={chooseKit}
        />
        {notice === null ? null : (
          <p className="hc-hint" role="status">
            {notice}
          </p>
        )}
        <footer className="hc-rig-footer">
          <button type="button" className="hc-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save verifier'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
