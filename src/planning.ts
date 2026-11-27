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

import type { Comment, Evidence, FlowProposal, FlowProposalFrameInput, Frame, Outcome, Pin, Signal, Tree } from './model.js'
import type { PlanningAction } from './actions.js'
import { snapshot, type ActionMeta } from './tree.js'

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

function log(tree: Tree, at: string, key: string, message: string, signal: Signal | null = null, meta?: ActionMeta): void {
  tree.activity.push({
    at,
    key,
    text: message,
    signal,
    ...(meta?.actor ? { actor: meta.actor } : {}),
    ...(meta?.via ? { via: meta.via } : {}),
  })
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

function normalizeFrameInput(tree: Tree, step: FlowProposalFrameInput, label: string): Frame {
  const outcome = outcomeOf(tree, step.key)
  if (!outcome.criteria.some((criterion) => criterion.id === step.criterionId)) {
    fail(`${label} names criterion "${step.criterionId}", which outcome "${step.key}" does not have at v${outcome.version}`)
  }
  const kind = step.kind ?? (step.imagePath ? 'image' : 'html')
  const html = (step.html ?? '').trim()
  const imagePath = step.imagePath?.trim() || null
  if (kind === 'html' && html === '') fail(`${label} html must be non-empty for html frames`)
  if (kind === 'image' && !imagePath) fail(`${label} imagePath must be non-empty for image frames`)
  return {
    title: text(step.title, `${label} title`),
    key: outcome.key,
    criterionId: step.criterionId,
    html,
    kind,
    ...(imagePath ? { imagePath } : {}),
    ...(step.viewport ? { viewport: step.viewport } : {}),
    ...(step.notes?.trim() ? { notes: step.notes.trim() } : {}),
    ...(step.componentRefs && step.componentRefs.length > 0 ? { componentRefs: [...new Set(step.componentRefs)] } : {}),
    version: 1,
    history: [],
    pins: [],
  }
}

/**
 * Apply one planning action to `tree` in place.
 *
 * Refused actions throw and leave the tree untouched; accepted actions append
 * and record one activity row. `now` is the recorded time (an ISO date-time).
 */
export function applyPlanning(tree: Tree, a: PlanningAction, now: string, meta?: ActionMeta): void {
  const at = stamp(now)

  switch (a.op) {
    case 'write_plan': {
      const key = a.key.trim()
      const outcome = outcomeOf(tree, key)
      const latest = latestPlanVersion(tree, key)
      if (latest > 0) fail(`outcome "${key}" already has plan v${latest}; use revise_plan`)
      const body = text(a.body, 'plan body')
      tree.plans.push({
        key: outcome.key,
        version: 1,
        body,
        ...(meta?.actor ? { actor: meta.actor } : {}),
        ...(meta?.via ? { via: meta.via } : {}),
        created: at,
      })
      log(tree, at, key, `Plan v1 written for ${key}`, null, meta)
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
      tree.plans.push({
        key,
        version,
        body,
        ...(meta?.actor ? { actor: meta.actor } : {}),
        ...(meta?.via ? { via: meta.via } : {}),
        created: at,
      })
      log(tree, at, key, `Plan v${version} written for ${key}`, null, meta)
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
      const planVersion = a.planVersion ?? null
      if (planVersion !== null && !tree.plans.some((p) => p.key === key && p.version === planVersion)) {
        fail(`outcome "${key}" has no plan v${planVersion}`)
      }
      const id = nextId('cm', key, takenIds(tree, 'cm'))
      const comment: Comment = {
        id,
        key,
        parentId,
        ...(planVersion !== null ? { planVersion } : {}),
        text: body,
        options,
        answer: null,
        ...(a.threadId ? { threadId: a.threadId } : {}),
        ...(meta?.actor ? { actor: meta.actor } : {}),
        ...(meta?.via ? { via: meta.via } : {}),
        created: at,
      }
      tree.comments.push(comment)
      log(
        tree,
        at,
        key,
        options.length > 0
          ? `Question on ${key}${planVersion ? ` (plan v${planVersion})` : ''} with ${options.length} options`
          : `Comment on ${key}${planVersion ? ` (plan v${planVersion})` : ''}`,
        null,
        meta,
      )
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
      log(tree, at, comment.key, `Answered ${id} on ${comment.key}: ${clip(answer)}`, null, meta)
      return
    }

    case 'create_track': {
      const name = text(a.name, 'track name')
      if (name === LIVE_TRACK) fail(`"${LIVE_TRACK}" is the live track`)
      if (tree.tracks.some((track) => track.name === name)) fail(`track "${name}" already exists`)
      const description = text(a.description, 'track description')
      tree.tracks.push({ name, description })
      log(tree, at, name, `Track "${name}" created`, null, meta)
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
          ...(meta?.actor ? { actor: meta.actor } : {}),
          ...(meta?.via ? { via: meta.via } : {}),
          created: at,
        }
        evidenceIds.add(evidence.id)
        tree.evidence.push(evidence)
        cut.push(item.key)
        log(tree, at, item.key, `Cut over from track "${preview.track}" at v${outcome.version}`, 'verified', meta)
      }
      log(tree, at, preview.track, `Track "${preview.track}" cut over ${cut.length} outcome(s) to live: ${cut.join(', ')}`, null, meta)
      return
    }

    case 'create_release': {
      const name = text(a.name, 'release name')
      const scenario = text(a.scenario, 'release scenario')
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
      log(tree, at, name, `Release "${name}" dated ${a.date} in scenario "${scenario}" with ${keys.length} outcome(s)`, null, meta)
      return
    }

    case 'revise_release': {
      const name = text(a.name, 'release name')
      const scenario = text(a.scenario, 'release scenario')
      const release = tree.releases.find((r) => r.name === name && r.scenario === scenario)
      if (!release) fail(`unknown release "${name}" in scenario "${scenario}"`)
      if (a.newName !== undefined) {
        const nextName = text(a.newName, 'new release name')
        if (nextName !== release.name && tree.releases.some((r) => r.name === nextName && r.scenario === scenario)) {
          fail(`release "${nextName}" already exists in scenario "${scenario}"`)
        }
        release.name = nextName
      }
      if (a.date !== undefined) {
        if (!realDate(a.date)) fail(`release date must be a real calendar date (YYYY-MM-DD), got "${a.date}"`)
        release.date = a.date
      }
      if (a.keys !== undefined) {
        const keys = a.keys.map((k) => k.trim())
        if (keys.length === 0) fail('a release needs at least one outcome')
        const repeated = duplicates(keys)
        if (repeated.length > 0) fail(`duplicate key(s): ${repeated.join(', ')}`)
        for (const k of keys) outcomeOf(tree, k)
        for (const k of keys) {
          const clash = tree.releases.find((r) => r !== release && r.scenario === scenario && r.keys.includes(k))
          if (clash !== undefined) fail(`outcome "${k}" is already in release "${clash.name}" in scenario "${scenario}"`)
        }
        release.keys = [...keys]
      }
      log(tree, at, release.name, `Revised release "${release.name}" (${release.date}, ${release.keys.length} outcome(s)) in "${scenario}"`, null, meta)
      return
    }

    case 'create_flow': {
      const name = text(a.name, 'flow name')
      if (tree.flows.some((flow) => flow.name === name)) fail(`flow "${name}" already exists`)
      const steps = Array.isArray(a.frames) ? a.frames : []
      if (steps.length === 0) fail('a flow needs at least one frame')
      const frames: Frame[] = steps.map((step, index) => normalizeFrameInput(tree, step, `frame ${index}`))
      tree.flows.push({
        name,
        ...(a.folder?.trim() ? { folder: a.folder.trim() } : {}),
        ...(a.designKit?.trim() ? { designKit: a.designKit.trim() } : {}),
        frames,
      })
      log(tree, at, name, `Flow "${name}" with ${frames.length} frame(s)`, null, meta)
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
      const taken = new Set(frame.pins.map((p) => p.id).filter((id): id is string => Boolean(id)))
      const pinId = nextId('pin', `${name}_${a.frame}`, taken)
      const pin: Pin = {
        id: pinId,
        x: a.x,
        y: a.y,
        text: pinText,
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.geometry ? { geometry: a.geometry } : {}),
        ...(a.selector ? { selector: a.selector } : {}),
        ...(a.forAgents !== undefined ? { forAgents: a.forAgents } : {}),
        resolved: false,
        created: at,
      }
      frame.pins.push(pin)
      log(tree, at, name, `Pinned comment on frame ${a.frame} of "${name}": ${clip(pinText)}`, null, meta)
      return
    }

    case 'resolve_pin': {
      const name = text(a.name, 'flow name')
      const flow = tree.flows.find((candidate) => candidate.name === name)
      if (flow === undefined) fail(`unknown flow "${name}"`)
      const frame = flow.frames[a.frame]
      if (frame === undefined) fail(`frame ${a.frame} is out of range for flow "${name}"`)
      const pin = a.pinId
        ? frame.pins.find((p) => p.id === a.pinId)
        : a.pinIndex !== undefined
          ? frame.pins[a.pinIndex]
          : undefined
      if (!pin) fail(`pin not found on frame ${a.frame} of "${name}"`)
      pin.resolved = a.resolved
      pin.resolvedBy = a.resolved ? (a.resolvedBy?.trim() || meta?.actor || 'resolved') : null
      log(tree, at, name, `${a.resolved ? 'Resolved' : 'Reopened'} pin on frame ${a.frame} of "${name}"`, null, meta)
      return
    }

    case 'propose_flow_change': {
      const proposals = (tree.flowProposals ??= [])
      const flowName = text(a.flowName, 'flowName')
      const kind = a.kind ?? 'change'
      if (kind === 'new_flow') {
        if (tree.flows.some((f) => f.name === flowName)) fail(`flow "${flowName}" already exists`)
        const list = a.frames ?? (a.frame ? [a.frame] : null)
        if (!list || list.length === 0) fail('propose_flow_change (new_flow) requires frames')
        list.forEach((step, idx) => normalizeFrameInput(tree, step, `proposed frame ${idx}`))
      } else if (kind === 'new_step') {
        if (!tree.flows.some((f) => f.name === flowName)) fail(`unknown flow "${flowName}"`)
        if (!a.frame) fail('propose_flow_change (new_step) requires frame')
        normalizeFrameInput(tree, a.frame, 'proposed step')
      } else {
        const flow = tree.flows.find((f) => f.name === flowName)
        if (!flow) fail(`unknown flow "${flowName}"`)
        const idx = a.frameIndex ?? -1
        const target = flow.frames[idx]
        if (!target) fail(`frame ${idx} is out of range for flow "${flowName}"`)
        const curVer = target.version ?? 1
        if (a.basedOnVersion !== undefined && a.basedOnVersion !== null && a.basedOnVersion !== curVer) {
          fail(`stale flow proposal: frame ${idx} of "${flowName}" is at v${curVer}, not v${a.basedOnVersion}`)
        }
        if (!a.frame) fail('propose_flow_change (change) requires frame')
        normalizeFrameInput(tree, a.frame, `proposed frame ${idx}`)
      }
      const taken = new Set(proposals.map((p) => p.id))
      const id = nextId('fp', flowName, taken)
      const proposal: FlowProposal = {
        id,
        kind,
        flowName,
        ...(a.folder ? { folder: a.folder } : {}),
        ...(a.designKit ? { designKit: a.designKit } : {}),
        frameIndex: a.frameIndex ?? null,
        basedOnVersion: a.basedOnVersion ?? null,
        frame: a.frame ?? null,
        frames: a.frames ?? null,
        ...(a.componentRefs && a.componentRefs.length > 0 ? { componentRefs: [...new Set(a.componentRefs)] } : {}),
        selfGrade: a.selfGrade ?? null,
        ref: a.ref ?? null,
        spot: a.spot ?? null,
        note: a.note ?? null,
        state: 'pending',
        reviewNote: null,
        threadId: a.threadId ?? null,
        actor: meta?.actor ?? null,
        ...(meta?.via ? { via: meta.via } : {}),
        created: at,
      }
      proposals.push(proposal)
      log(tree, at, flowName, `Proposed flow ${kind} ${id} on "${flowName}"${a.ref ? ` (${a.ref})` : ''}`, null, meta)
      return
    }

    case 'accept_flow_change': {
      const proposals = (tree.flowProposals ??= [])
      const id = text(a.id, 'flow proposal id')
      const proposal = proposals.find((p) => p.id === id)
      if (!proposal) fail(`unknown flow proposal "${id}"`)
      if (proposal.state !== 'pending') fail(`flow proposal "${id}" is ${proposal.state}, not pending`)
      if (proposal.kind === 'new_flow') {
        if (tree.flows.some((f) => f.name === proposal.flowName)) fail(`flow "${proposal.flowName}" already exists`)
        const list = proposal.frames ?? (proposal.frame ? [proposal.frame] : [])
        if (list.length === 0) fail(`flow proposal "${id}" has no frames`)
        const frames = list.map((step, idx) => normalizeFrameInput(tree, step, `frame ${idx}`))
        tree.flows.push({
          name: proposal.flowName,
          ...(proposal.folder ? { folder: proposal.folder } : {}),
          ...(proposal.designKit ? { designKit: proposal.designKit } : {}),
          frames,
        })
      } else if (proposal.kind === 'new_step') {
        const flow = tree.flows.find((f) => f.name === proposal.flowName)
        if (!flow) fail(`unknown flow "${proposal.flowName}"`)
        if (!proposal.frame) fail(`flow proposal "${id}" has no frame`)
        const frame = normalizeFrameInput(tree, proposal.frame, 'new step')
        if (proposal.frameIndex !== null && proposal.frameIndex >= 0 && proposal.frameIndex <= flow.frames.length) {
          flow.frames.splice(proposal.frameIndex, 0, frame)
        } else {
          flow.frames.push(frame)
        }
      } else {
        const flow = tree.flows.find((f) => f.name === proposal.flowName)
        if (!flow) fail(`unknown flow "${proposal.flowName}"`)
        const idx = proposal.frameIndex ?? -1
        const current = flow.frames[idx]
        if (!current) fail(`frame ${idx} no longer exists in flow "${proposal.flowName}"`)
        const curVer = current.version ?? 1
        if (proposal.basedOnVersion !== null && proposal.basedOnVersion !== curVer) {
          fail(`stale flow proposal "${id}": based on v${proposal.basedOnVersion}, now v${curVer}`)
        }
        if (!proposal.frame) fail(`flow proposal "${id}" has no frame`)
        const nextFrame = normalizeFrameInput(tree, proposal.frame, `frame ${idx}`)
        const history = [...(current.history ?? [])]
        history.push({
          version: curVer,
          title: current.title,
          html: current.html,
          kind: current.kind,
          imagePath: current.imagePath ?? null,
          viewport: current.viewport ?? null,
          notes: current.notes ?? null,
          at,
          actor: proposal.actor ?? null,
          ref: proposal.ref ?? null,
        })
        flow.frames[idx] = {
          ...nextFrame,
          version: curVer + 1,
          history,
          pins: current.pins,
          driftDetected: false,
          driftNote: null,
        }
      }
      proposal.state = 'accepted'
      proposal.reviewNote = a.reviewNote?.trim() || null
      log(tree, at, proposal.flowName, `Accepted flow ${proposal.kind} ${id} on "${proposal.flowName}"`, null, meta)
      return
    }

    case 'reject_flow_change': {
      const proposals = (tree.flowProposals ??= [])
      const id = text(a.id, 'flow proposal id')
      const proposal = proposals.find((p) => p.id === id)
      if (!proposal) fail(`unknown flow proposal "${id}"`)
      if (proposal.state !== 'pending') fail(`flow proposal "${id}" is ${proposal.state}, not pending`)
      proposal.state = 'rejected'
      proposal.reviewNote = a.reviewNote?.trim() || null
      log(tree, at, proposal.flowName, `Sent back flow ${proposal.kind} ${id} on "${proposal.flowName}"${proposal.reviewNote ? `: ${clip(proposal.reviewNote)}` : ''}`, null, meta)
      return
    }

    case 'restore_frame_version': {
      const flowName = text(a.flowName, 'flowName')
      const flow = tree.flows.find((f) => f.name === flowName)
      if (!flow) fail(`unknown flow "${flowName}"`)
      const current = flow.frames[a.frameIndex]
      if (!current) fail(`frame ${a.frameIndex} is out of range for flow "${flowName}"`)
      const targetRev = (current.history ?? []).find((rev) => rev.version === a.version)
      if (!targetRev) fail(`frame ${a.frameIndex} of "${flowName}" has no saved v${a.version}`)
      const curVer = current.version ?? 1
      const history = [...(current.history ?? [])]
      history.push({
        version: curVer,
        title: current.title,
        html: current.html,
        kind: current.kind,
        imagePath: current.imagePath ?? null,
        viewport: current.viewport ?? null,
        notes: current.notes ?? null,
        at,
        actor: meta?.actor ?? null,
        ref: `restore:v${a.version}`,
      })
      flow.frames[a.frameIndex] = {
        ...current,
        title: targetRev.title,
        html: targetRev.html,
        kind: targetRev.kind ?? current.kind,
        imagePath: targetRev.imagePath ?? null,
        viewport: targetRev.viewport ?? null,
        notes: targetRev.notes ?? null,
        version: curVer + 1,
        history,
        driftDetected: false,
        driftNote: null,
      }
      log(tree, at, flowName, `Restored frame ${a.frameIndex} of "${flowName}" from v${a.version} as v${curVer + 1}`, null, meta)
      return
    }

    case 'set_frame_drift': {
      const flowName = text(a.flowName, 'flowName')
      const flow = tree.flows.find((f) => f.name === flowName)
      if (!flow) fail(`unknown flow "${flowName}"`)
      const frame = flow.frames[a.frameIndex]
      if (!frame) fail(`frame ${a.frameIndex} is out of range for flow "${flowName}"`)
      frame.liveImagePath = a.liveImagePath ?? frame.liveImagePath ?? null
      frame.driftDetected = a.driftDetected
      frame.driftNote = a.driftNote?.trim() || null
      log(tree, at, flowName, `Frame ${a.frameIndex} of "${flowName}" drift=${a.driftDetected ? 'detected' : 'cleared'}`, null, meta)
      return
    }

    default:
      fail(`unknown planning action "${(a as { op?: string }).op ?? ''}"`)
  }
}
