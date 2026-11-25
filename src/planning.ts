// Planning: everything people and agents agree on around an outcome, before and
// while they climb it.
//
// Plans are versioned full-text revisions, comments are threads (a comment with
// options is a question), answers are decisions that stay on the work, tracks
// prove a replacement against the same outcomes, releases name what ships
// together, flows are ordered criterion-bound frames with pinned comments.
//
// Every operation mutates the supplied tree and appends one activity row, so
// replaying the history reconstructs the same state. Nothing here deletes: a
// revision, a comment, an answer and a cut-over are all appends. The one
// exception is a comment's `answer`, which is null until a person decides.
//
// Status is never stored. It is derived from evidence at the outcome's current
// version, which is why `snapshot` from ./tree.ts is the authority for per-track
// readiness in `previewPromotion`. A cut-over only appends live "confirms"
// evidence that cites the track's own confirming evidence for the current
// version; it never copies a green status from an older version.

import type { Comment, Evidence, Frame, Outcome, Plan, Signal, Tree } from './model.js'
import type { PlanningAction } from './actions.js'
import { snapshot } from './tree.js'

/** The evidence namespace live status is computed from. */
export const LIVE_TRACK = 'main'

export type PromotionReadiness = 'proven' | 'stale' | 'gap' | 'untouched' | 'missing'

export interface PromotionOutcome {
  key: string
  title: string | null
  /** The outcome version the cut-over is judged against. */
  version: number | null
  readiness: PromotionReadiness
  /** Signal on the track being promoted, as snapshot reports it. */
  track: Signal | null
  /** Signal on the live track right now. */
  live: Signal | null
  /** Live status already stands on this version; a cut-over would add nothing. */
  alreadyLive: boolean
  /** Criteria the track's confirming evidence covers at this version. */
  criterionIds: string[]
  /** Current criteria the track has not confirmed at this version. */
  unprovenCriteria: string[]
  /** Live-confirmed criteria that the cut-over would no longer rest on. */
  loses: string[]
  reason: string
}

export interface PromotionPreview {
  track: string
  trackExists: boolean
  keys: string[]
  outcomes: PromotionOutcome[]
  /** Keys proven on the track at the current version, in named order. */
  proven: string[]
  /** Keys worked on but not proven at the current version. */
  gaps: string[]
  /** Named keys with no outcome in the tree. */
  missing: string[]
  /** Keys live-verified today that this cut-over would leave unproven. */
  verifiedGaps: string[]
  /** Duplicate names in `keys`, preserved in input order. */
  duplicates: string[]
  canApply: boolean
  /** Why `canApply` is false, or null when the cut-over can land. */
  reason: string | null
  summary: { total: number; proven: number; gaps: number; missing: number; alreadyLive: number }
}

// ---------------------------------------------------------------------------
// Validation helpers. Every action validates fully before writing, so a refused
// action leaves the tree untouched.
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message)
}

function stamp(now: string): string {
  if (typeof now !== 'string' || now.trim() === '' || !Number.isFinite(Date.parse(now))) {
    fail('now must be an ISO date-time')
  }
  return now
}

function text(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be non-empty`)
  return value.trim()
}

function realDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated: string[] = []
  for (const value of values) {
    if (seen.has(value)) repeated.push(value)
    else seen.add(value)
  }
  return repeated
}

function outcomeOf(tree: Tree, key: string): Outcome {
  const outcome = tree.outcomes.find((candidate) => candidate.key === key)
  return outcome ?? fail(`unknown outcome "${key}"`)
}

function latestPlanVersion(tree: Tree, key: string): number {
  return tree.plans.reduce((latest, plan) => (plan.key === key ? Math.max(latest, plan.version) : latest), 0)
}

function takenIds(tree: Tree, prefix: 'cm' | 'ev'): Set<string> {
  const ids = new Set<string>()
  if (prefix === 'cm') for (const comment of tree.comments) ids.add(comment.id)
  else for (const evidence of tree.evidence) ids.add(evidence.id)
  return ids
}

/** Deterministic, unique, and readable in a log: cm_HC-12_3. */
function nextId(prefix: string, hint: string, taken: Set<string>): string {
  const base = `${prefix}_${hint.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  let index = 1
  while (taken.has(`${base}_${index}`)) index += 1
  return `${base}_${index}`
}

function log(tree: Tree, at: string, key: string, message: string, signal: Signal|null = null): void {
  tree.activity.push({ at, key, text: message, signal })
}

function clip(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

// ---------------------------------------------------------------------------
// Promotion preview
// ---------------------------------------------------------------------------

const isProven = (signal: Signal | null): boolean => signal === 'verified' || signal === 'recheck'

function rankedSignals(tree: Tree, track: string, now: string): Map<string, Signal> {
  const signals = new Map<string, Signal>()
  for (const row of snapshot(tree, track, now).ranked) signals.set(row.key, row.signal)
  return signals
}

/**
 * Criteria a track's confirming evidence covers on the outcome's current
 * version. A "confirms" with no criterion ids is evidence for the whole outcome,
 * so it covers every current criterion. Ids that no longer exist are ignored.
 */
function confirmedCriteria(tree: Tree, key: string, track: string, outcome: Outcome): string[] {
  const current = outcome.criteria.map((criterion) => criterion.id)
  const known = new Set(current)
  const covered = new Set<string>()
  let all = false
  for (const evidence of tree.evidence) {
    if (evidence.key !== key || evidence.track !== track) continue
    if (evidence.version !== outcome.version || evidence.kind !== 'confirms') continue
    if (evidence.criterionIds.length === 0) all = true
    else for (const id of evidence.criterionIds) if (known.has(id)) covered.add(id)
  }
  if (all) for (const id of current) covered.add(id)
  return current.filter((id) => covered.has(id))
}

// `snapshot` reports `unverified` for an outcome nobody has touched as well as
// for one worked on but not proven, so the tree's own track evidence is what
// separates a gap from untouched work.
function readinessOf(track: Signal | null, touched: boolean): PromotionReadiness {
  if (isProven(track)) return 'proven'
  if (track === 'stale') return 'stale'
  return touched ? 'gap' : 'untouched'
}

function readinessReason(readiness: PromotionReadiness, track: string, version: number): string {
  switch (readiness) {
    case 'proven':
      return `proven on track "${track}" at v${version}`
    case 'stale':
      return `verified on track "${track}" at an older version; re-check it there`
    case 'gap':
      return `worked on track "${track}" but not proven at v${version}`
    case 'untouched':
      return `never worked on track "${track}"`
    default:
      return 'unknown outcome'
  }
}

/**
 * What a cut-over of `keys` from track `name` would do, without touching the
 * tree. Readiness is per outcome and comes from `snapshot(tree, name)`; live
 * status comes from `snapshot(tree, 'main')`.
 */
export function previewPromotion(tree: Tree, name: string, keys: string[], now = new Date().toISOString()): PromotionPreview {
  const at = stamp(now)
  const track = name.trim()
  const trackExists = track !== '' && track !== LIVE_TRACK && tree.tracks.some((candidate) => candidate.name === track)
  const named = Array.isArray(keys) ? keys : []
  const repeated = duplicates(named)
  const unique = [...new Set(named)]

  const trackSignals = trackExists ? rankedSignals(tree, track, at) : new Map<string, Signal>()
  const liveSignals = rankedSignals(tree, LIVE_TRACK, at)

  const outcomes: PromotionOutcome[] = unique.map((key): PromotionOutcome => {
    const outcome = tree.outcomes.find((candidate) => candidate.key === key)
    if (outcome === undefined) {
      return {
        key,
        title: null,
        version: null,
        readiness: 'missing',
        track: null,
        live: null,
        alreadyLive: false,
        criterionIds: [],
        unprovenCriteria: [],
        loses: [],
        reason: readinessReason('missing', track, 0),
      }
    }
    const trackSignal = trackSignals.get(key) ?? null
    const liveSignal = liveSignals.get(key) ?? null
    const touched = tree.evidence.some((evidence) => evidence.key === key && evidence.track === track)
    const readiness = readinessOf(trackSignal, touched)
    const trackCriteria = readiness === 'proven' ? confirmedCriteria(tree, key, track, outcome) : []
    const liveCriteria = confirmedCriteria(tree, key, LIVE_TRACK, outcome)
    const provenSet = new Set(trackCriteria)
    const current = outcome.criteria.map((criterion) => criterion.id)
    const unprovenCriteria = current.filter((id) => !provenSet.has(id))
    const loses = readiness === 'proven' ? liveCriteria.filter((id) => !provenSet.has(id)) : liveCriteria
    const alreadyLive = isProven(liveSignal)
    const reason = readinessReason(readiness, track, outcome.version)
    return {
      key,
      title: outcome.title,
      version: outcome.version,
      readiness,
      track: trackSignal,
      live: liveSignal,
      alreadyLive,
      criterionIds: trackCriteria,
      unprovenCriteria,
      loses,
      reason: alreadyLive && readiness === 'proven' ? `${reason}; already live` : reason,
    }
  })

  const proven = outcomes.filter((outcome) => outcome.readiness === 'proven').map((outcome) => outcome.key)
  const gaps = outcomes.filter((outcome) => outcome.readiness !== 'proven' && outcome.readiness !== 'missing').map((outcome) => outcome.key)
  const missing = outcomes.filter((outcome) => outcome.readiness === 'missing').map((outcome) => outcome.key)
  const verifiedGaps = outcomes
    .filter((outcome) => outcome.readiness !== 'proven' && outcome.readiness !== 'missing' && isProven(outcome.live))
    .map((outcome) => outcome.key)

  let reason: string | null = null
  if (!trackExists) reason = track === LIVE_TRACK ? 'the live track cannot be promoted' : `unknown track "${track}"`
  else if (named.length === 0) reason = 'no outcomes named'
  else if (repeated.length > 0) reason = `duplicate key(s): ${repeated.join(', ')}`
  else if (missing.length > 0) reason = `unknown outcome(s): ${missing.join(', ')}`
  else if (proven.length !== outcomes.length) reason = `not proven on track "${track}" at the current version: ${gaps.join(', ')}`
  else if (outcomes.every((outcome) => outcome.alreadyLive)) reason = 'nothing to cut over: every named outcome is already live'

  return {
    track,
    trackExists,
    keys: named,
    outcomes,
    proven,
    gaps,
    missing,
    verifiedGaps,
    duplicates: repeated,
    canApply: reason === null,
    reason,
    summary: {
      total: outcomes.length,
      proven: proven.length,
      gaps: gaps.length,
      missing: missing.length,
      alreadyLive: outcomes.filter((outcome) => outcome.alreadyLive).length,
    },
  }
}

// ---------------------------------------------------------------------------
// applyPlanning
// ---------------------------------------------------------------------------

/**
 * Apply one planning action to `tree` in place.
 *
 * Refused actions throw and leave the tree untouched; accepted actions append
 * and record one activity row. `now` is the recorded time (an ISO date-time).
 */
export function applyPlanning(tree: Tree, a: PlanningAction, now: string): void {
  const at = stamp(now)

  switch (a.op) {
    case 'write_plan': {
      const key = a.key.trim()
      const outcome = outcomeOf(tree, key)
      const latest = latestPlanVersion(tree, key)
      if (latest > 0) fail(`outcome "${key}" already has plan v${latest}; use revise_plan`)
      const body = text(a.body, 'plan body')
      tree.plans.push({ key: outcome.key, version: 1, body, created: at })
      log(tree, at, key, `Plan v1 written for ${key}`)
      return
    }

    case 'revise_plan': {
      const key = a.key.trim()
      outcomeOf(tree, key)
      const latest = latestPlanVersion(tree, key)
      if (latest === 0) fail(`outcome "${key}" has no plan; use write_plan first`)
      if (a.version !== latest) fail(`plan for "${key}" is at v${latest}; revise from that version`)
      const body = text(a.body, 'plan body')
      const version = latest + 1
      tree.plans.push({ key, version, body, created: at })
      log(tree, at, key, `Plan v${version} written for ${key}`)
      return
    }

    case 'comment': {
      const key = a.key.trim()
      outcomeOf(tree, key)
      const body = text(a.text, 'comment text')
      const options = (a.options ?? []).map((option) => text(option, 'comment option'))
      const repeated = duplicates(options)
      if (repeated.length > 0) fail(`duplicate option(s): ${repeated.join(', ')}`)
      if (options.length === 1) fail('a question needs at least two options; use a plain comment for an open answer')
      const parentId = a.parentId ?? null
      if (parentId !== null) {
        const parent = tree.comments.find((comment) => comment.id === parentId)
        if (parent === undefined) fail(`unknown parent comment "${parentId}"`)
        if (parent.key !== key) fail(`parent comment "${parentId}" belongs to "${parent.key}", not "${key}"`)
      }
      const id = nextId('cm', key, takenIds(tree, 'cm'))
      const comment: Comment = { id, key, parentId, text: body, options, answer: null, created: at }
      tree.comments.push(comment)
      log(tree, at, key, options.length > 0 ? `Question on ${key} with ${options.length} options` : `Comment on ${key}`)
      return
    }

    case 'answer': {
      const id = text(a.id, 'comment id')
      const comment = tree.comments.find((candidate) => candidate.id === id)
      if (comment === undefined) fail(`unknown comment "${id}"`)
      if (comment.answer !== null) fail(`comment "${id}" is already answered: ${comment.answer}`)
      const answer = text(a.answer, 'answer')
      if (comment.options.length > 0 && !comment.options.includes(answer)) {
        fail(`answer must be one of: ${comment.options.join(', ')}`)
      }
      comment.answer = answer
      log(tree, at, comment.key, `Answered ${id} on ${comment.key}: ${clip(answer)}`)
      return
    }

    case 'create_track': {
      const name = text(a.name, 'track name')
      if (name === LIVE_TRACK) fail(`"${LIVE_TRACK}" is the live track`)
      if (tree.tracks.some((track) => track.name === name)) fail(`track "${name}" already exists`)
      const description = text(a.description, 'track description')
      tree.tracks.push({ name, description })
      log(tree, at, name, `Track "${name}" created`)
      return
    }

    case 'promote_track': {
      const preview = previewPromotion(tree, a.name, a.keys, at)
      if (!preview.canApply) fail(`promote_track refused: ${preview.reason ?? 'not ready'}`)
      const evidenceIds = takenIds(tree, 'ev')
      const cut: string[] = []
      for (const item of preview.outcomes) {
        if (item.readiness !== 'proven' || item.alreadyLive) continue
        const outcome = outcomeOf(tree, item.key)
        const evidence: Evidence = {
          id: nextId('ev', item.key, evidenceIds),
          key: item.key,
          version: outcome.version,
          criterionIds: item.criterionIds,
          kind: 'confirms',
          track: LIVE_TRACK,
          text: `Cut over from track "${preview.track}": proven there at v${outcome.version}.`,
          source: `track:${preview.track}`,
          created: at,
        }
        evidenceIds.add(evidence.id)
        tree.evidence.push(evidence)
        cut.push(item.key)
        log(tree, at, item.key, `Cut over from track "${preview.track}" at v${outcome.version}`, "verified")
      }
      log(tree, at, preview.track, `Track "${preview.track}" cut over ${cut.length} outcome(s) to live: ${cut.join(', ')}`)
      return
    }

    case 'create_release': {
      const name = text(a.name, 'release name')
      const scenario = text(a.scenario, 'release scenario')
      // A launch is identified by its name inside one scenario: scenarios are
      // compared, so the same launch appears in each with its own window.
      if (tree.releases.some((release) => release.name === name && release.scenario === scenario)) {
        fail(`release "${name}" already exists in scenario "${scenario}"`)
      }
      const keys = Array.isArray(a.keys) ? a.keys.map((key) => key.trim()) : []
      if (keys.length === 0) fail('a release needs at least one outcome')
      const repeated = duplicates(keys)
      if (repeated.length > 0) fail(`duplicate key(s): ${repeated.join(', ')}`)
      for (const key of keys) outcomeOf(tree, key)
      if (!realDate(a.date)) fail(`release date must be a real calendar date (YYYY-MM-DD), got "${a.date}"`)
      for (const key of keys) {
        const clash = tree.releases.find((release) => release.scenario === scenario && release.keys.includes(key))
        if (clash !== undefined) fail(`outcome "${key}" is already in release "${clash.name}" in scenario "${scenario}"`)
      }
      tree.releases.push({ name, keys: [...keys], scenario, date: a.date })
      log(tree, at, name, `Release "${name}" dated ${a.date} in scenario "${scenario}" with ${keys.length} outcome(s)`)
      return
    }

    case 'create_flow': {
      const name = text(a.name, 'flow name')
      if (tree.flows.some((flow) => flow.name === name)) fail(`flow "${name}" already exists`)
      const steps = Array.isArray(a.frames) ? a.frames : []
      if (steps.length === 0) fail('a flow needs at least one frame')
      const frames: Frame[] = steps.map((step, index) => {
        const outcome = outcomeOf(tree, step.key)
        if (!outcome.criteria.some((criterion) => criterion.id === step.criterionId)) {
          fail(`frame ${index} names criterion "${step.criterionId}", which outcome "${step.key}" does not have at v${outcome.version}`)
        }
        return {
          title: text(step.title, `frame ${index} title`),
          key: outcome.key,
          criterionId: step.criterionId,
          html: text(step.html, `frame ${index} html`),
          pins: [],
        }
      })
      tree.flows.push({ name, frames })
      log(tree, at, name, `Flow "${name}" with ${frames.length} frame(s)`)
      return
    }

    case 'pin': {
      const name = text(a.name, 'flow name')
      const flow = tree.flows.find((candidate) => candidate.name === name)
      if (flow === undefined) fail(`unknown flow "${name}"`)
      if (!Number.isInteger(a.frame) || a.frame < 0 || a.frame >= flow.frames.length) {
        fail(`frame ${a.frame} is out of range for flow "${name}" (0..${flow.frames.length - 1})`)
      }
      if (!Number.isFinite(a.x) || a.x < 0 || a.x > 1) fail('pin x must be between 0 and 1')
      if (!Number.isFinite(a.y) || a.y < 0 || a.y > 1) fail('pin y must be between 0 and 1')
      const pinText = text(a.text, 'pin text')
      const frame = flow.frames[a.frame]
      if (frame === undefined) fail(`frame ${a.frame} is out of range for flow "${name}"`)
      frame.pins.push({ x: a.x, y: a.y, text: pinText })
      log(tree, at, name, `Pinned comment on frame ${a.frame} of "${name}": ${clip(pinText)}`)
      return
    }

    default:
      // A JS caller can still hand us an unknown op; refuse instead of no-op.
      fail(`unknown planning action "${(a as { op?: string }).op ?? ''}"`)
  }
}
