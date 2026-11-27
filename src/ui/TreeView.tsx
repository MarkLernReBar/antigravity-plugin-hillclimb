// The tree: a pan-and-zoom map of goals and outcomes, a ranked outline of the
// same data, filters over both, a replay of the recorded timeline, and a
// coverage read-out.
//
// This file is a view. It never decides a signal, a rank or an approval — the
// Snapshot already carries those (see src/model.ts and src/state.ts). Everything
// it changes goes through `act`, so the same validation that guards the HTTP
// surface guards the UI.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Action } from '../actions.js'
import type { Activity, Goal, Outcome, OutcomeAvailability, Ranked, Signal, Snapshot } from '../model.js'
import type { SavedViewDto, ViewProps } from '../view-props.js'

export type ViewMode = 'map' | 'outline'
export type WindowKey = '24h' | '7d' | '30d'

export const WINDOWS: Record<WindowKey, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const WINDOW_LABEL: Record<WindowKey, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
}

export const SIGNALS: Array<{ id: Signal; label: string }> = [
  { id: 'verified', label: 'Verified' },
  { id: 'unverified', label: 'Unverified' },
  { id: 'broken', label: 'Broken' },
  { id: 'stale', label: 'Stale' },
  { id: 'recheck', label: 'Recheck' },
]

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and for the drawer)
// ---------------------------------------------------------------------------

/** A repo key that satisfies src/actions.ts's `key` schema. */
export function slugKey(title: string, taken: Iterable<string>): string {
  const seen = new Set(taken)
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  const head = /^[a-z0-9]/.test(base) ? base : `k-${base}`
  let candidate = head
  let n = 2
  while (seen.has(candidate)) {
    candidate = `${head}-${n}`
    n += 1
  }
  return candidate.slice(0, 96)
}

export function signalOf(ranked: Ranked[], key: string): Signal {
  return ranked.find((row) => row.key === key)?.signal ?? 'unverified'
}

export function sortGoals(a: Goal, b: Goal): number {
  return a.rank - b.rank || a.created.localeCompare(b.created) || a.key.localeCompare(b.key)
}

export function sortOutcomes(a: Outcome, b: Outcome): number {
  return a.rank - b.rank || a.created.localeCompare(b.created) || a.key.localeCompare(b.key)
}

export interface LayoutNode {
  key: string
  kind: 'goal' | 'outcome'
  title: string
  depth: number
  x: number
  y: number
  w: number
  h: number
  parent: string | null
  goalKey: string | null
}

export interface Layout {
  nodes: LayoutNode[]
  byKey: Map<string, LayoutNode>
  edges: Array<{ from: string; to: string }>
  width: number
  height: number
}

const COL_GAP = 312
const ROW_GAP = 54
const GOAL_W = 252
const OUTCOME_W = 292
const NODE_H = 46

/**
 * Tidy layout: each goal sits at its depth, vertically centred on its subtree.
 * Outcomes are the leaves, so a goal with nothing under it still gets a row.
 */
export function layoutTree(goals: Goal[], outcomes: Outcome[]): Layout {
  const goalByKey = new Map(goals.map((goal) => [goal.key, goal]))
  const childGoals = new Map<string, Goal[]>()
  for (const goal of goals) {
    if (goal.parentGoalKey === null || !goalByKey.has(goal.parentGoalKey)) continue
    const list = childGoals.get(goal.parentGoalKey) ?? []
    list.push(goal)
    childGoals.set(goal.parentGoalKey, list)
  }
  const ownOutcomes = new Map<string, Outcome[]>()
  for (const outcome of outcomes) {
    if (!goalByKey.has(outcome.goalKey)) continue
    const list = ownOutcomes.get(outcome.goalKey) ?? []
    list.push(outcome)
    ownOutcomes.set(outcome.goalKey, list)
  }

  const nodes: LayoutNode[] = []
  const byKey = new Map<string, LayoutNode>()
  const edges: Array<{ from: string; to: string }> = []
  const placed = new Set<string>()
  let cursor = 0
  let maxDepth = 0

  const add = (node: LayoutNode): LayoutNode => {
    nodes.push(node)
    byKey.set(node.key, node)
    maxDepth = Math.max(maxDepth, node.depth)
    return node
  }

  const place = (key: string, depth: number, parent: string | null): number => {
    const goal = goalByKey.get(key)
    if (goal === undefined || placed.has(key)) return cursor
    placed.add(key)
    const kids = (childGoals.get(key) ?? []).slice().sort(sortGoals)
    const leaves = (ownOutcomes.get(key) ?? []).slice().sort(sortOutcomes)
    const childYs: number[] = []

    for (const kid of kids) {
      const y = place(kid.key, depth + 1, key)
      edges.push({ from: key, to: kid.key })
      childYs.push(y)
    }
    for (const outcome of leaves) {
      const y = cursor
      cursor += ROW_GAP
      add({
        key: outcome.key,
        kind: 'outcome',
        title: outcome.title,
        depth: depth + 1,
        x: (depth + 1) * COL_GAP,
        y,
        w: OUTCOME_W,
        h: NODE_H,
        parent: key,
        goalKey: key,
      })
      edges.push({ from: key, to: outcome.key })
      childYs.push(y)
    }

    const y =
      childYs.length > 0
        ? ((childYs[0] as number) + (childYs[childYs.length - 1] as number)) / 2
        : (() => {
            const row = cursor
            cursor += ROW_GAP
            return row
          })()

    add({
      key: goal.key,
      kind: 'goal',
      title: goal.title,
      depth,
      x: depth * COL_GAP,
      y,
      w: GOAL_W,
      h: NODE_H,
      parent,
      goalKey: goal.key,
    })
    return y
  }

  const roots = goals
    .filter((goal) => goal.parentGoalKey === null || !goalByKey.has(goal.parentGoalKey))
    .sort(sortGoals)
  for (const root of roots) place(root.key, 0, null)

  // A cycle in parentGoalKey would leave goals unplaced; park the rest in a row
  // rather than dropping them silently.
  for (const goal of goals) {
    if (placed.has(goal.key)) continue
    const y = cursor
    cursor += ROW_GAP
    add({
      key: goal.key,
      kind: 'goal',
      title: goal.title,
      depth: 0,
      x: 0,
      y,
      w: GOAL_W,
      h: NODE_H,
      parent: null,
      goalKey: goal.key,
    })
  }

  nodes.sort((a, b) => a.y - b.y || a.x - b.x)
  return {
    nodes,
    byKey,
    edges,
    width: Math.max((maxDepth + 1) * COL_GAP, GOAL_W),
    height: Math.max(cursor, ROW_GAP),
  }
}

export interface Coverage {
  total: number
  proven: number
  broken: number
  stale: number
  unverified: number
  recheck: number
  blocked: number
  pct: number
}

function countCoverage(
  keys: string[],
  signalFor: (key: string) => Signal,
  blockedFor: (key: string) => boolean,
): Coverage {
  const counts: Coverage = {
    total: 0,
    proven: 0,
    broken: 0,
    stale: 0,
    unverified: 0,
    recheck: 0,
    blocked: 0,
    pct: 0,
  }
  for (const key of keys) {
    counts.total += 1
    switch (signalFor(key)) {
      case 'verified':
        counts.proven += 1
        break
      case 'broken':
        counts.broken += 1
        break
      case 'stale':
        counts.stale += 1
        break
      case 'recheck':
        counts.recheck += 1
        break
      default:
        counts.unverified += 1
    }
    if (blockedFor(key)) counts.blocked += 1
  }
  counts.pct = counts.total === 0 ? 0 : Math.round((counts.proven / counts.total) * 100)
  return counts
}

export function coverageOf(keys: string[], ranked: Ranked[]): Coverage {
  const byKey = new Map(ranked.map((row) => [row.key, row]))
  return countCoverage(
    keys,
    (key) => byKey.get(key)?.signal ?? 'unverified',
    (key) => (byKey.get(key)?.blockedBy.length ?? 0) > 0,
  )
}

/**
 * Coverage as it stood at a replay cursor: a recorded signal wins over today's,
 * so an outcome that was proven and then broke drops out of the proven count
 * before the break and leaves it after.
 */
export function coverageAt(keys: string[], ranked: Ranked[], recorded: Map<string, Signal>): Coverage {
  const byKey = new Map(ranked.map((row) => [row.key, row]))
  return countCoverage(
    keys,
    (key) => recorded.get(key) ?? 'unverified',
    (key) => (byKey.get(key)?.blockedBy.length ?? 0) > 0,
  )
}

export interface TimelineEvent {
  id: string
  at: number
  key: string
  kind: 'activity' | 'evidence' | 'change' | 'comment'
  text: string
  /** The signal an activity row recorded at that moment; null for every other kind. */
  signal: Signal | null
  actor?: string
  via?: string
}

function timeOf(value: string): number {
  const parsed = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * A row's track. `Activity.track` is optional in the shared model; an activity
 * without one belongs to `main`, which is the only track every tree has.
 */
export function activityTrack(row: Activity): string {
  const value = (row as Activity & { track?: string | null }).track
  return typeof value === 'string' && value !== '' ? value : 'main'
}

/**
 * Every recorded event, in time order. Invalid timestamps are dropped, not
 * guessed.
 *
 * With a `track`, evidence and activity are narrowed to that track: a replay of
 * `main` must not be coloured by a rewrite branch's checks. Changes, plans and
 * comments carry no track, so they always belong to the key.
 *
 * Text describes the event *at the moment it happened*. A comment's answer and
 * a proposal's approval are later facts with no timestamp of their own, so they
 * are never printed on the creation row.
 */
export function timelineOf(data: Snapshot, track?: string): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const push = (event: TimelineEvent): void => {
    if (Number.isFinite(event.at)) events.push(event)
  }
  for (const row of data.activity) {
    if (track !== undefined && activityTrack(row) !== track) continue
    push({
      id: `a:${row.at}:${row.key}:${row.text.slice(0, 12)}`,
      at: timeOf(row.at),
      key: row.key,
      kind: 'activity',
      text: row.text,
      signal: row.signal,
      actor: row.actor,
      via: row.via,
    })
  }
  for (const row of data.evidence) {
    if (track !== undefined && row.track !== track) continue
    push({
      id: `e:${row.id}`,
      at: timeOf(row.created),
      key: row.key,
      kind: 'evidence',
      text: `${row.kind}: ${row.text}`,
      signal: null,
      actor: row.actor,
      via: row.via,
    })
  }
  for (const row of data.changes) {
    push({
      id: `c:${row.id}`,
      at: timeOf(row.created),
      key: row.key,
      kind: 'change',
      text:
        row.kind === 'create'
          ? `proposed new outcome — ${row.proposed.title}`
          : `proposal for base v${row.baseVersion} — ${row.proposed.title}`,
      signal: null,
      actor: row.actor,
      via: row.via,
    })
  }
  for (const row of data.comments) {
    push({
      id: `m:${row.id}`,
      at: timeOf(row.created),
      key: row.key,
      kind: 'comment',
      text: row.text,
      signal: null,
      actor: row.actor,
      via: row.via,
    })
  }
  events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return events
}

export interface SignalTransition {
  key: string
  at: number
  signal: Signal
  text: string
}

/** Every signal an activity row recorded, in time order. */
export function signalTransitions(events: TimelineEvent[]): SignalTransition[] {
  return events
    .filter((event): event is TimelineEvent & { signal: Signal } => event.signal !== null)
    .map((event) => ({ key: event.key, at: event.at, signal: event.signal, text: event.text }))
    .sort((a, b) => a.at - b.at)
}

/**
 * The signal each key carried at `cursor`, from recorded transitions only.
 *
 * A key has no historical proof before its first recorded transition.
 */
export function historicalSignals(transitions: SignalTransition[], cursor: number): Map<string, Signal> {
  const byKey = new Map<string, SignalTransition[]>()
  for (const transition of transitions) {
    const list = byKey.get(transition.key) ?? []
    list.push(transition)
    byKey.set(transition.key, list)
  }
  const signals = new Map<string, Signal>()
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.at - b.at)
    let chosen: Signal | undefined
    for (const transition of list) {
      if (transition.at > cursor) break
      chosen = transition.signal
    }
    if (chosen === undefined) chosen = "unverified"
    if (chosen !== undefined) signals.set(key, chosen)
  }
  return signals
}

export interface ReplayWindow {
  from: number
  to: number
  events: TimelineEvent[]
}

export function eventsInWindow(events: TimelineEvent[], windowKey: WindowKey, now: number): ReplayWindow {
  const span = WINDOWS[windowKey]
  const from = now - span
  return { from, to: now, events: events.filter((event) => event.at >= from && event.at <= now) }
}

/** When each key was last touched, including its ancestors. */
export function reachedTimes(layout: Layout, events: TimelineEvent[]): Map<string, number> {
  const times = new Map<string, number>()
  const touch = (key: string, at: number): void => {
    const previous = times.get(key)
    if (previous === undefined || at > previous) times.set(key, at)
  }
  for (const event of events) {
    const node = layout.byKey.get(event.key)
    if (node === undefined) continue
    let cursorKey: string | null = node.key
    let hops = 0
    while (cursorKey !== null && hops < 64) {
      touch(cursorKey, event.at)
      const current: LayoutNode | undefined = layout.byKey.get(cursorKey)
      cursorKey = current?.parent ?? null
      hops += 1
    }
  }
  return times
}

export function formatWhen(at: number): string {
  if (!Number.isFinite(at)) return '—'
  const date = new Date(at)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function SignalBadge({ signal }: { signal: Signal }): JSX.Element {
  return (
    <span className={`hc-badge hc-signal-${signal}`} title={`Signal: ${signal}`}>
      {signal}
    </span>
  )
}

function CoverageBar({ coverage, replaying }: { coverage: Coverage; replaying: boolean }): JSX.Element {
  const segments: Array<{ id: string; count: number }> = [
    { id: 'verified', count: coverage.proven },
    { id: 'unverified', count: coverage.unverified },
    { id: 'recheck', count: coverage.recheck },
    { id: 'stale', count: coverage.stale },
    { id: 'broken', count: coverage.broken },
  ]
  return (
    <div className="hc-coverage">
      <div
        className="hc-coverage-bar"
        role="img"
        aria-label={`${coverage.proven} of ${coverage.total} outcomes proven, ${coverage.pct} percent${replaying ? ', as recorded at the replay cursor' : ''}`}
      >
        {segments.map((segment) =>
          segment.count === 0 ? null : (
            <span
              key={segment.id}
              className={`hc-seg hc-signal-${segment.id}`}
              style={{ flexGrow: segment.count }}
              title={`${segment.count} ${segment.id}`}
            />
          ),
        )}
        {coverage.total === 0 ? <span className="hc-seg hc-seg-empty" style={{ flexGrow: 1 }} /> : null}
      </div>
      <p className="hc-coverage-text">
        <strong>{coverage.pct}%</strong> proven · {coverage.proven}/{coverage.total}{' '}
        {coverage.total === 1 ? 'outcome' : 'outcomes'}
        {coverage.blocked > 0 ? ` · ${coverage.blocked} blocked` : ''}
        {coverage.broken > 0 ? ` · ${coverage.broken} broken` : ''}
        {coverage.stale > 0 ? ` · ${coverage.stale} stale` : ''}
        {coverage.recheck > 0 ? ` · ${coverage.recheck} recheck` : ''}
        {replaying ? <span className="hc-coverage-asof"> · as recorded</span> : null}
      </p>
    </div>
  )
}

interface NodeMeta {
  signal: Signal
  rank: number | null
  ordinal: number | null
  sectionNumber: string | null
  availability: OutcomeAvailability
  availabilityReason: string | null
  deferredUntil: string | null
  tags: string[]
  goalProgress: { proven: number; total: number } | null
  blocked: boolean
  proposed: boolean
  claim: string | null
  evidence: number
  criteria: number
  next: number | null
}

function metaFor(data: Snapshot, track: string): Map<string, NodeMeta> {
  const ranked = new Map(data.ranked.map((row) => [row.key, row]))
  const ordinalByKey = new Map<string, number>(data.ranked.map((row, idx) => [row.key, idx + 1]))
  const evidence = new Map<string, number>()
  // The badge counts this track's evidence; another track's checks are not a
  // reason to say an outcome has proof here.
  for (const row of data.evidence) {
    if (row.track !== track) continue
    evidence.set(row.key, (evidence.get(row.key) ?? 0) + 1)
  }
  const proposed = new Set(data.changes.filter((row) => row.state === 'pending').map((row) => row.key))
  const meta = new Map<string, NodeMeta>()
  const nextIndex = new Map<string, number>(data.next.map((key, index) => [key, index + 1] as [string, number]))

  const childGoalsByParent = new Map<string, string[]>()
  for (const g of data.goals) {
    if (g.parentGoalKey) {
      const list = childGoalsByParent.get(g.parentGoalKey) ?? []
      list.push(g.key)
      childGoalsByParent.set(g.parentGoalKey, list)
    }
  }
  const outcomesByGoal = new Map<string, Outcome[]>()
  for (const o of data.outcomes) {
    const list = outcomesByGoal.get(o.goalKey) ?? []
    list.push(o)
    outcomesByGoal.set(o.goalKey, list)
  }
  const countGoal = (goalKey: string, seen = new Set<string>()): { proven: number; total: number } => {
    if (seen.has(goalKey)) return { proven: 0, total: 0 }
    seen.add(goalKey)
    let proven = 0
    let total = 0
    for (const o of outcomesByGoal.get(goalKey) ?? []) {
      total += 1
      if (ranked.get(o.key)?.signal === 'verified') proven += 1
    }
    for (const kid of childGoalsByParent.get(goalKey) ?? []) {
      const sub = countGoal(kid, seen)
      proven += sub.proven
      total += sub.total
    }
    return { proven, total }
  }

  const goalSection = new Map<string, string>()
  const goalByKeyMap = new Map(data.goals.map((g) => [g.key, g]))
  const walkGoalSections = (parentKey: string | null, prefix: string): void => {
    const kids = data.goals
      .filter((g) => (parentKey === null ? g.parentGoalKey === null || !goalByKeyMap.has(g.parentGoalKey) : g.parentGoalKey === parentKey))
      .slice()
      .sort(sortGoals)
    kids.forEach((g, idx) => {
      const sec = prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`
      if (!goalSection.has(g.key)) {
        goalSection.set(g.key, sec)
        walkGoalSections(g.key, sec)
      }
    })
  }
  walkGoalSections(null, '')

  for (const goal of data.goals) {
    const row = ranked.get(goal.key)
    const goalProgress = countGoal(goal.key)
    const derivedGoalSignal: Signal =
      goalProgress.total > 0 && goalProgress.proven === goalProgress.total ? 'verified' : 'unverified'
    meta.set(goal.key, {
      signal: row?.signal ?? derivedGoalSignal,
      rank: row?.effectiveRank ?? goal.rank,
      ordinal: null,
      sectionNumber: goalSection.get(goal.key) ?? null,
      availability: 'active',
      availabilityReason: null,
      deferredUntil: null,
      tags: goal.tags ?? [],
      goalProgress,
      blocked: (row?.blockedBy.length ?? 0) > 0,
      proposed: proposed.has(goal.key),
      claim: row?.claim?.threadId ?? null,
      evidence: evidence.get(goal.key) ?? 0,
      criteria: 0,
      next: nextIndex.get(goal.key) ?? null,
    })
  }
  for (const outcome of data.outcomes) {
    const row = ranked.get(outcome.key)
    meta.set(outcome.key, {
      signal: row?.signal ?? 'unverified',
      rank: row?.effectiveRank ?? outcome.rank,
      ordinal: ordinalByKey.get(outcome.key) ?? null,
      sectionNumber: row?.sectionNumber ?? null,
      availability: row?.availability ?? outcome.availability ?? 'active',
      availabilityReason: row?.availabilityReason ?? outcome.availabilityReason ?? null,
      deferredUntil: row?.deferredUntil ?? outcome.deferredUntil ?? null,
      tags: row?.tags ?? outcome.tags ?? [],
      goalProgress: null,
      blocked: (row?.blockedBy.length ?? 0) > 0,
      proposed: proposed.has(outcome.key),
      claim: row?.claim?.threadId ?? null,
      evidence: evidence.get(outcome.key) ?? 0,
      criteria: outcome.criteria.length,
      next: nextIndex.get(outcome.key) ?? null,
    })
  }
  return meta
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

interface MapProps {
  layout: Layout
  meta: Map<string, NodeMeta>
  visible: Set<string>
  selected: string | null
  select: (key: string | null) => void
  view: { k: number; tx: number; ty: number }
  unreached: Set<string> | null
  /** Signals as recorded at the replay cursor, or null when not replaying. */
  recorded: Map<string, Signal> | null
}

function MapCanvas(props: MapProps): JSX.Element {
  const { layout, meta, visible, selected, select, view, unreached, recorded } = props
  const nodes = layout.nodes.filter((node) => visible.has(node.key))
  const edges = layout.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to))
  const byKey = layout.byKey

  return (
    <div
      className="hc-map"
      style={{
        width: layout.width,
        height: layout.height,
        transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
      }}
    >
      <svg
        className="hc-edges"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
        focusable="false"
      >
        {edges.map((edge) => {
          const from = byKey.get(edge.from)
          const to = byKey.get(edge.to)
          if (from === undefined || to === undefined) return null
          const x1 = from.x + from.w
          const y1 = from.y
          const x2 = to.x
          const y2 = to.y
          const dx = Math.max(24, (x2 - x1) / 2)
          const dim = unreached !== null && (!unreached.has(edge.from) || !unreached.has(edge.to))
          return (
            <path
              key={`${edge.from}→${edge.to}`}
              className={dim ? 'hc-edge is-unreached' : 'hc-edge'}
              d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
            />
          )
        })}
      </svg>

      {nodes.map((node) => {
        const info = meta.get(node.key)
        const signal = (recorded ? recorded.get(node.key) : info?.signal) ?? 'unverified'
        const classes = [
          'hc-node',
          `hc-node-${node.kind}`,
          `hc-signal-${signal}`,
          selected === node.key ? 'is-selected' : '',
          info?.blocked === true ? 'is-blocked' : '',
          unreached !== null && !unreached.has(node.key) ? 'is-unreached' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={node.key}
            type="button"
            className={classes}
            style={{ left: node.x, top: node.y - node.h / 2, width: node.w, height: node.h }}
            onClick={() => select(node.key)}
            aria-pressed={selected === node.key}
            aria-label={`${node.kind === 'goal' ? 'Goal' : 'Outcome'} ${node.key}: ${node.title}. ${signal}${info?.blocked === true ? ', blocked' : ''}${info?.claim !== null && info?.claim !== undefined ? `, claimed by ${info.claim}` : ''}`}
            title={node.title}
          >
            <span className="hc-node-head">
              {info?.sectionNumber ? <span className="hc-node-sec">{info.sectionNumber}</span> : null}
              <span className="hc-node-key">{node.key}</span>
              {info?.next !== null && info?.next !== undefined ? (
                <span className="hc-node-next" title={`Next work, in order: #${info.next}`}>
                  next #{info.next}
                </span>
              ) : null}
              {info?.proposed === true ? <span className="hc-node-proposed">proposed</span> : null}
            </span>
            <span className="hc-node-title">{node.title}</span>
            <span className="hc-node-foot">
              {node.kind === 'goal' ? (
                <span className="hc-chip hc-goal-progress">
                  {info?.goalProgress && info.goalProgress.total > 0
                    ? `${info.goalProgress.proven}/${info.goalProgress.total} proven`
                    : 'goal'}
                </span>
              ) : (
                <SignalBadge signal={signal} />
              )}
              {info?.availability === 'blocked' ? (
                <span className="hc-chip hc-chip-warn" title={info.availabilityReason ?? 'Manually blocked'}>
                  paused
                </span>
              ) : info?.availability === 'deferred' ? (
                <span className="hc-chip" title={info.deferredUntil ? `Deferred until ${info.deferredUntil}` : 'Deferred'}>
                  deferred
                </span>
              ) : null}
              {info?.blocked === true ? <span className="hc-chip hc-chip-warn">blocked</span> : null}
              {info?.tags?.slice(0, 2).map((tag) => (
                <span key={tag} className="hc-chip hc-tag-chip">
                  #{tag}
                </span>
              ))}
              {info?.claim !== null && info?.claim !== undefined ? (
                <span className="hc-chip" title={`Claimed by ${info.claim}`}>
                  #{info.claim.slice(0, 10)}
                </span>
              ) : null}
              {node.kind === 'outcome' ? (
                <span className="hc-chip" title={`${info?.criteria ?? 0} criteria, ${info?.evidence ?? 0} evidence`}>
                  {info?.criteria ?? 0}c · {info?.evidence ?? 0}e
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

interface OutlineProps {
  data: Snapshot
  meta: Map<string, NodeMeta>
  visible: Set<string>
  selected: string | null
  select: (key: string | null) => void
  collapsed: Set<string>
  toggle: (key: string) => void
  sortMode: 'rank' | 'key'
  recorded: Map<string, Signal> | null
}

function OutlineList(props: OutlineProps): JSX.Element {
  const { data, meta, visible, selected, select, collapsed, toggle, sortMode, recorded } = props
  const byKey = new Map(data.goals.map((goal) => [goal.key, goal]))
  const children = new Map<string | null, Goal[]>()
  for (const goal of data.goals) {
    const parent = goal.parentGoalKey !== null && byKey.has(goal.parentGoalKey) ? goal.parentGoalKey : null
    const list = children.get(parent) ?? []
    list.push(goal)
    children.set(parent, list)
  }
  const outcomes = new Map<string, Outcome[]>()
  for (const outcome of data.outcomes) {
    const list = outcomes.get(outcome.goalKey) ?? []
    list.push(outcome)
    outcomes.set(outcome.goalKey, list)
  }
  const order = sortMode === 'key' ? (a: Goal, b: Goal) => a.key.localeCompare(b.key) : sortGoals
  const orderOutcome =
    sortMode === 'key' ? (a: Outcome, b: Outcome) => a.key.localeCompare(b.key) : sortOutcomes

  const row = (key: string, title: string, kind: 'goal' | 'outcome', hasKids: boolean): JSX.Element => {
    const info = meta.get(key)
    const signal = (recorded ? recorded.get(key) : info?.signal) ?? 'unverified'
    const open = !collapsed.has(key)
    return (
      <div className={`hc-outline-row hc-outline-${kind}${selected === key ? ' is-selected' : ''}`}>
        {hasKids ? (
          <button
            type="button"
            className="hc-twisty"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${key}`}
            onClick={() => toggle(key)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="hc-twisty hc-twisty-empty" aria-hidden="true" />
        )}
        <button
          type="button"
          className="hc-outline-main"
          onClick={() => select(key)}
          aria-pressed={selected === key}
          aria-label={`${kind} ${key}: ${title}. ${signal}`}
        >
          <span className="hc-outline-rank" title={info?.sectionNumber ? `Section ${info.sectionNumber}` : undefined}>
            {info?.sectionNumber ?? (kind === 'outcome' && info?.ordinal !== null && info?.ordinal !== undefined ? `#${info.ordinal}` : '—')}
          </span>
          <span className="hc-outline-key">{key}</span>
          <span className="hc-outline-title">{title}</span>
          <span className="hc-outline-tags">
            {info?.next !== null && info?.next !== undefined ? <span className="hc-chip hc-chip-next">next #{info.next}</span> : null}
            {info?.proposed === true ? <span className="hc-chip">proposed</span> : null}
            {info?.availability === 'blocked' ? (
              <span className="hc-chip hc-chip-warn" title={info.availabilityReason ?? 'Manually blocked'}>
                paused
              </span>
            ) : info?.availability === 'deferred' ? (
              <span className="hc-chip" title={info.deferredUntil ? `Deferred until ${info.deferredUntil}` : 'Deferred'}>
                deferred
              </span>
            ) : null}
            {info?.blocked === true ? <span className="hc-chip hc-chip-warn">blocked</span> : null}
            {info?.tags?.slice(0, 2).map((tag) => (
              <span key={tag} className="hc-chip hc-tag-chip">
                #{tag}
              </span>
            ))}
            {info?.claim !== null && info?.claim !== undefined ? (
              <span className="hc-chip" title={`Claimed by ${info.claim}`}>
                {info.claim.slice(0, 12)}
              </span>
            ) : null}
          </span>
          {kind === 'goal' ? (
            <span className="hc-chip hc-goal-progress">
              {info?.goalProgress && info.goalProgress.total > 0
                ? `${info.goalProgress.proven}/${info.goalProgress.total} proven`
                : 'goal'}
            </span>
          ) : (
            <SignalBadge signal={signal} />
          )}
        </button>
      </div>
    )
  }

  const renderGoal = (goal: Goal, depth: number): JSX.Element | null => {
    if (!visible.has(goal.key)) return null
    const kids = (children.get(goal.key) ?? []).filter((kid) => visible.has(kid.key)).sort(order)
    const leaves = (outcomes.get(goal.key) ?? []).slice().sort(orderOutcome)
    const visibleLeaves = leaves.filter((leaf) => visible.has(leaf.key))
    const hasKids = kids.length > 0 || visibleLeaves.length > 0
    const open = !collapsed.has(goal.key)
    return (
      <li key={goal.key} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={selected === goal.key} aria-level={depth + 1}>
        {row(goal.key, goal.title, 'goal', hasKids)}
        {hasKids && open ? (
          <ul role="group" className="hc-outline-group">
            {kids.map((kid) => renderGoal(kid, depth + 1))}
            {visibleLeaves.map((leaf) => {
              const info = meta.get(leaf.key)
              return (
                <li key={leaf.key} role="treeitem" aria-selected={selected === leaf.key} aria-level={depth + 2}>
                  {row(leaf.key, leaf.title, 'outcome', false)}
                  <p className="hc-outline-story">{info?.criteria ?? 0} criteria · {info?.evidence ?? 0} evidence</p>
                </li>
              )
            })}
          </ul>
        ) : null}
      </li>
    )
  }

  const roots = (children.get(null) ?? []).slice().sort(order)
  if (roots.length === 0) {
    return <p className="hc-empty-note">No goals yet.</p>
  }
  return (
    <ul className="hc-outline" role="tree" aria-label="Requirement outline, ranked">
      {roots.map((root) => renderGoal(root, 0))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Create panel
// ---------------------------------------------------------------------------

interface CreateProps {
  data: Snapshot
  act: (action: Action) => Promise<void>
  initialKind: 'goal' | 'outcome'
  initialGoal: string | null
  onClose: () => void
  onCreated: (key: string) => void
}

interface CriterionDraft {
  id: string
  given: string
  when: string
  then: string
}

function CreatePanel(props: CreateProps): JSX.Element {
  const { data, act, initialKind, initialGoal, onClose, onCreated } = props
  const [kind, setKind] = useState<'goal' | 'outcome'>(initialKind)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [story, setStory] = useState('')
  const [parent, setParent] = useState<string>(initialGoal ?? '')
  const [goalKey, setGoalKey] = useState<string>(initialGoal ?? data.goals[0]?.key ?? '')
  const [rank, setRank] = useState('100')
  const [recheck, setRecheck] = useState('')
  const [criteria, setCriteria] = useState<CriterionDraft[]>([{ id: '', given: '', when: '', then: '' }])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const taken = useMemo(
    () => [...data.goals.map((goal) => goal.key), ...data.outcomes.map((outcome) => outcome.key)],
    [data],
  )
  const proposedKey = slugKey(title === '' ? 'new-charter' : title, taken)
  const rankValue = rank.trim() === '' ? 100 : Number(rank)
  const recheckValue = recheck.trim() === '' ? null : Number(recheck)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    const cleanTitle = title.trim()
    if (cleanTitle === '') {
      setError('A title is required.')
      return
    }
    if (!Number.isInteger(rankValue) || rankValue < 0) {
      setError('Rank must be a whole number, 0 or more.')
      return
    }
    if (kind === 'outcome' && goalKey === '') {
      setError('An outcome belongs to a goal. Create a goal first.')
      return
    }
    setBusy(true)
    try {
      if (kind === 'goal') {
        const cleanBrief = brief.trim() === '' ? cleanTitle : brief.trim()
        await act({
          op: 'create_goal',
          key: proposedKey,
          parentGoalKey: parent === '' ? null : parent,
          title: cleanTitle,
          brief: cleanBrief,
          rank: rankValue,
        })
        onCreated(proposedKey)
        return
      }
      const rows = criteria.map((row, index) => ({
        id: row.id.trim() === '' ? `ac${index + 1}` : row.id.trim(),
        given: row.given.trim(),
        when: row.when.trim(),
        then: row.then.trim(),
      }))
      if (rows.some((row) => row.given === '' || row.when === '' || row.then === '')) {
        setError('Every criterion needs a given, a when and a then.')
        return
      }
      if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        setError('Criterion ids must be unique inside an outcome.')
        return
      }
      const cleanStory = story.trim() === '' ? cleanTitle : story.trim()
      await act({
        op: 'create_outcome',
        key: proposedKey,
        goalKey,
        contract: {
          title: cleanTitle,
          story: cleanStory,
          criteria: rows,
          dependsOn: [],
          rank: rankValue,
          recheckDays: recheckValue !== null && Number.isFinite(recheckValue) && recheckValue > 0 ? recheckValue : null,
        },
      })
      onCreated(proposedKey)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hc-create" onSubmit={(event) => void submit(event)} aria-label="Create a goal or an outcome">
      <div className="hc-create-head">
        <div className="hc-tabs" role="tablist" aria-label="What to create">
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'goal'}
            className={kind === 'goal' ? 'hc-tab is-active' : 'hc-tab'}
            onClick={() => setKind('goal')}
          >
            Goal
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'outcome'}
            className={kind === 'outcome' ? 'hc-tab is-active' : 'hc-tab'}
            onClick={() => setKind('outcome')}
          >
            Outcome
          </button>
        </div>
        <button type="button" className="hc-icon-btn" onClick={onClose} aria-label="Close the create panel">
          ×
        </button>
      </div>

      <div className="hc-field">
        <label htmlFor="hc-create-title">Title</label>
        <input
          id="hc-create-title"
          ref={titleRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={kind === 'goal' ? 'Clinics onboard themselves' : 'Clinic is live in under 10 minutes'}
          required
        />
      </div>

      {kind === 'goal' ? (
        <>
          <div className="hc-field">
            <label htmlFor="hc-create-brief">Brief</label>
            <textarea
              id="hc-create-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={2}
              placeholder="Why this goal exists, in one or two sentences."
            />
          </div>
          <div className="hc-field">
            <label htmlFor="hc-create-parent">Parent goal</label>
            <select id="hc-create-parent" value={parent} onChange={(event) => setParent(event.target.value)}>
              <option value="">None — a root goal</option>
              {data.goals.map((goal) => (
                <option key={goal.key} value={goal.key}>
                  {goal.key} · {goal.title}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <>
          <div className="hc-field">
            <label htmlFor="hc-create-goal">Goal</label>
            <select id="hc-create-goal" value={goalKey} onChange={(event) => setGoalKey(event.target.value)} required>
              {data.goals.length === 0 ? <option value="">No goals yet — create one first</option> : null}
              {data.goals.map((goal) => (
                <option key={goal.key} value={goal.key}>
                  {goal.key} · {goal.title}
                </option>
              ))}
            </select>
          </div>
          <div className="hc-field">
            <label htmlFor="hc-create-story">Story</label>
            <textarea
              id="hc-create-story"
              value={story}
              onChange={(event) => setStory(event.target.value)}
              rows={2}
              placeholder="As a clinic owner, I want…"
            />
          </div>
          <fieldset className="hc-criteria-edit">
            <legend>Criteria</legend>
            {criteria.map((row, index) => (
              <div className="hc-criterion-draft" key={index}>
                <span className="hc-criterion-index">ac{index + 1}</span>
                <input
                  aria-label={`Criterion ${index + 1} given`}
                  value={row.given}
                  onChange={(event) => {
                    const next = criteria.slice()
                    next[index] = { ...row, given: event.target.value }
                    setCriteria(next)
                  }}
                  placeholder="given"
                  required
                />
                <input
                  aria-label={`Criterion ${index + 1} when`}
                  value={row.when}
                  onChange={(event) => {
                    const next = criteria.slice()
                    next[index] = { ...row, when: event.target.value }
                    setCriteria(next)
                  }}
                  placeholder="when"
                  required
                />
                <input
                  aria-label={`Criterion ${index + 1} then`}
                  value={row.then}
                  onChange={(event) => {
                    const next = criteria.slice()
                    next[index] = { ...row, then: event.target.value }
                    setCriteria(next)
                  }}
                  placeholder="then"
                  required
                />
                <button
                  type="button"
                  className="hc-icon-btn"
                  aria-label={`Remove criterion ${index + 1}`}
                  onClick={() => setCriteria(criteria.length === 1 ? criteria : criteria.filter((_, i) => i !== index))}
                  disabled={criteria.length === 1}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="hc-btn"
              onClick={() => setCriteria([...criteria, { id: '', given: '', when: '', then: '' }])}
            >
              Add criterion
            </button>
          </fieldset>
          <div className="hc-field">
            <label htmlFor="hc-create-recheck">Recheck after (days)</label>
            <input
              id="hc-create-recheck"
              type="number"
              min={1}
              step={1}
              value={recheck}
              onChange={(event) => setRecheck(event.target.value)}
              placeholder="never"
            />
          </div>
        </>
      )}

      <div className="hc-field hc-field-row">
        <label htmlFor="hc-create-rank">Rank</label>
        <input
          id="hc-create-rank"
          type="number"
          min={0}
          step={1}
          value={rank}
          onChange={(event) => setRank(event.target.value)}
        />
        <span className="hc-hint">Key: <code>{proposedKey}</code></span>
      </div>

      {error !== null ? (
        <p className="hc-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="hc-create-actions">
        <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
          {busy ? 'Saving…' : kind === 'goal' ? 'Create goal' : 'Create outcome'}
        </button>
        <button type="button" className="hc-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface ReplayProps {
  windowKey: WindowKey
  onWindow: (key: WindowKey) => void
  cursor: number
  from: number
  to: number
  playing: boolean
  speed: number
  onPlay: () => void
  onPause: () => void
  onScrub: (at: number) => void
  onSpeed: (speed: number) => void
  onStop: () => void
  label: string
}

function ReplayBar(props: ReplayProps): JSX.Element {
  const { windowKey, onWindow, cursor, from, to, playing, speed, onPlay, onPause, onScrub, onSpeed, onStop, label } = props
  const span = Math.max(1, to - from)
  const position = Math.min(1000, Math.max(0, Math.round(((cursor - from) / span) * 1000)))
  return (
    <div className="hc-replay-bar" role="group" aria-label="Replay activity">
      <button
        type="button"
        className="hc-btn hc-replay-play"
        onClick={playing ? onPause : onPlay}
        aria-label={playing ? 'Pause replay' : 'Play replay'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <label className="hc-replay-period">
        <span className="hc-sr-only">Replay period</span>
        <select value={windowKey} onChange={(event) => onWindow(event.target.value as WindowKey)} aria-label="Replay period">
          {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
            <option key={key} value={key}>
              {WINDOW_LABEL[key]}
            </option>
          ))}
        </select>
      </label>
      <input
        className="hc-replay-scrub"
        type="range"
        min={0}
        max={1000}
        step={1}
        value={position}
        aria-label="Replay position"
        aria-valuetext={label}
        onChange={(event) => onScrub(from + (Number(event.target.value) / 1000) * span)}
      />
      <span className="hc-replay-when" aria-live="polite">
        {label}
      </span>
      <div className="hc-replay-speed" role="group" aria-label="Playback speed">
        {[1, 2, 4].map((rate) => (
          <button
            key={rate}
            type="button"
            className={speed === rate ? 'hc-chip is-active' : 'hc-chip'}
            aria-pressed={speed === rate}
            onClick={() => onSpeed(rate)}
          >
            {rate}×
          </button>
        ))}
      </div>
      <button type="button" className="hc-icon-btn" onClick={onStop} aria-label="Stop replay">
        ×
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TreeView
// ---------------------------------------------------------------------------

export function TreeView(props: ViewProps): JSX.Element {
  const { data, track, selected, select, act, views = [], scopes = [], onSaveView, onDeleteView, onSaveScope, onDeleteScope, onOpenInbox } = props
  const [mode, setMode] = useState<ViewMode>(() =>
    typeof window !== 'undefined' && window.innerWidth < 640 ? 'outline' : 'map',
  )
  const autoPickedMode = useRef(false)
  const [query, setQuery] = useState('')
  const [signals, setSignals] = useState<Set<Signal>>(() => new Set())
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string>('')
  const [availabilityFilter, setAvailabilityFilter] = useState<'all' | OutcomeAvailability>('all')
  const [scopeFilterId, setScopeFilterId] = useState<string>('')
  const [savingView, setSavingView] = useState(false)
  const [viewNameDraft, setViewNameDraft] = useState('')
  const [showAll, setShowAll] = useState(true)
  const [sortMode, setSortMode] = useState<'rank' | 'key'>('rank')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [windowKey, setWindowKey] = useState<WindowKey>('7d')
  const [replay, setReplay] = useState<{ cursor: number; playing: boolean; speed: number } | null>(null)
  const [creating, setCreating] = useState<{ kind: 'goal' | 'outcome'; goal: string | null } | null>(null)
  const [view, setViewState] = useState({ k: 1, tx: 0, ty: 0 })
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const viewportRef = useRef<HTMLDivElement>(null)
  const fitted = useRef(false)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const g of data.goals) for (const t of g.tags ?? []) set.add(t)
    for (const o of data.outcomes) for (const t of o.tags ?? []) set.add(t)
    return [...set].sort()
  }, [data.goals, data.outcomes])

  const pendingCreates = useMemo(
    () => data.changes.filter((c) => c.state === 'pending' && c.kind === 'create'),
    [data.changes],
  )

  const activeScope = useMemo(() => {
    if (scopeFilterId) return scopes.find((s) => s.id === scopeFilterId) ?? null
    return scopes.find((s) => s.active) ?? null
  }, [scopes, scopeFilterId])

  const scopeOutcomeKeys = useMemo(() => {
    if (!activeScope) return null
    const keys = new Set<string>()
    if (activeScope.releaseName) {
      const rel = data.releases.find((r) => r.name === activeScope.releaseName)
      if (rel) for (const k of rel.keys) keys.add(k)
    }
    if (activeScope.goalKeys.length > 0) {
      const goalSet = new Set(activeScope.goalKeys)
      let added = true
      while (added) {
        added = false
        for (const g of data.goals) {
          if (g.parentGoalKey && goalSet.has(g.parentGoalKey) && !goalSet.has(g.key)) {
            goalSet.add(g.key)
            added = true
          }
        }
      }
      for (const o of data.outcomes) if (goalSet.has(o.goalKey)) keys.add(o.key)
    }
    if (activeScope.tags.length > 0) {
      const tagSet = new Set(activeScope.tags)
      const taggedGoals = new Set(data.goals.filter((g) => (g.tags ?? []).some((t) => tagSet.has(t))).map((g) => g.key))
      for (const o of data.outcomes) {
        if ((o.tags ?? []).some((t) => tagSet.has(t)) || taggedGoals.has(o.goalKey)) keys.add(o.key)
      }
    }
    return keys
  }, [activeScope, data.goals, data.outcomes, data.releases])

  const applySavedView = (saved: SavedViewDto): void => {
    setQuery(saved.filter.query ?? '')
    setSignals(new Set((saved.filter.signals ?? []) as Signal[]))
    setSelectedTag(saved.filter.tags?.[0] ?? '')
    setBlockedOnly(Boolean(saved.filter.blockedOnly))
    const avail = saved.filter.availability?.[0]
    setAvailabilityFilter(avail === 'active' || avail === 'blocked' || avail === 'deferred' ? avail : 'all')
    if (saved.filter.sortMode === 'key' || saved.filter.sortMode === 'rank') setSortMode(saved.filter.sortMode)
    if (saved.filter.scope) setScopeFilterId(saved.filter.scope)
  }

  useEffect(() => {
    setNow(Date.now())
  }, [data, windowKey])

  const emptyTree = data.goals.length === 0 && data.outcomes.length === 0
  const layout = useMemo(() => layoutTree(data.goals, data.outcomes), [data.goals, data.outcomes])
  const meta = useMemo(() => metaFor(data, track), [data, track])
  const events = useMemo(() => timelineOf(data, track), [data, track])
  const transitions = useMemo(() => signalTransitions(events), [events])
  const replayWindow = useMemo(() => eventsInWindow(events, windowKey, now), [events, windowKey, now])
  const touched = useMemo(() => reachedTimes(layout, replayWindow.events), [layout, replayWindow])
  const recorded = useMemo(
    () => (replay === null ? null : historicalSignals(transitions, replay.cursor)),
    [replay, transitions],
  )

  const setView = useCallback((next: { k: number; tx: number; ty: number }) => {
    setViewState((current) => (current.k === next.k && current.tx === next.tx && current.ty === next.ty ? current : next))
  }, [])

  useEffect(() => {
    const element = viewportRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const rect = entry.contentRect
      if (rect.width > 0 && rect.height > 0) {
        setSize({ w: rect.width, h: rect.height })
        if (!autoPickedMode.current && rect.width < 640) {
          autoPickedMode.current = true
          setMode('outline')
        }
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (size === null) return
    const pad = 40
    const k = Math.min(
      1.15,
      Math.max(
        0.15,
        Math.min((size.w - pad * 2) / Math.max(layout.width, 1), (size.h - pad * 2) / Math.max(layout.height, 1)),
      ),
    )
    setView({
      k,
      tx: (size.w - layout.width * k) / 2,
      ty: (size.h - layout.height * k) / 2,
    })
  }, [layout.height, layout.width, setView, size])

  useEffect(() => {
    if (fitted.current || layout.nodes.length === 0 || size === null) return
    fitted.current = true
    fit()
  }, [fit, layout.nodes.length, size])

  useEffect(() => {
    if (mode !== 'map' || emptyTree) return
    const element = viewportRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      setViewState((current) => {
        const k = Math.min(3, Math.max(0.12, current.k * Math.exp(-event.deltaY * 0.0015)))
        const ratio = k / current.k
        return {
          k,
          tx: mx - (mx - current.tx) * ratio,
          ty: my - (my - current.ty) * ratio,
        }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [emptyTree, mode])

  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const panRaf = useRef<number | null>(null)
  const panPending = useRef<{ tx: number; ty: number } | null>(null)

  useEffect(() => {
    return () => {
      if (panRaf.current !== null) cancelAnimationFrame(panRaf.current)
    }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.hc-node, .hc-outline, .hc-create, .hc-replay-rail') !== null) return
    pan.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pan.current
    if (start === null) return
    panPending.current = {
      tx: start.tx + (event.clientX - start.x),
      ty: start.ty + (event.clientY - start.y),
    }
    if (panRaf.current !== null) return
    panRaf.current = requestAnimationFrame(() => {
      panRaf.current = null
      const next = panPending.current
      if (next === null) return
      setViewState((current) =>
        current.tx === next.tx && current.ty === next.ty ? current : { ...current, tx: next.tx, ty: next.ty },
      )
    })
  }
  const onPointerUp = (): void => {
    pan.current = null
    panPending.current = null
    if (panRaf.current !== null) {
      cancelAnimationFrame(panRaf.current)
      panRaf.current = null
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    const step = 48
    switch (event.key) {
      case 'ArrowLeft':
        setView({ ...view, tx: view.tx + step })
        break
      case 'ArrowRight':
        setView({ ...view, tx: view.tx - step })
        break
      case 'ArrowUp':
        setView({ ...view, ty: view.ty + step })
        break
      case 'ArrowDown':
        setView({ ...view, ty: view.ty - step })
        break
      case '+':
      case '=':
        setView({ ...view, k: Math.min(3, view.k * 1.2) })
        break
      case '-':
        setView({ ...view, k: Math.max(0.12, view.k / 1.2) })
        break
      case '0':
      case 'f':
        fit()
        break
      default:
        return
    }
    event.preventDefault()
  }

  const matchesOutcome = useCallback(
    (outcome: Outcome, needle: string): boolean => {
      if (needle === '') return true
      if (outcome.key.toLowerCase().includes(needle)) return true
      if (outcome.title.toLowerCase().includes(needle)) return true
      if (outcome.story.toLowerCase().includes(needle)) return true
      return outcome.criteria.some(
        (row) =>
          row.id.toLowerCase().includes(needle) ||
          row.given.toLowerCase().includes(needle) ||
          row.when.toLowerCase().includes(needle) ||
          row.then.toLowerCase().includes(needle),
      )
    },
    [],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const goalByKey = new Map(data.goals.map((goal) => [goal.key, goal]))
    const children = new Map<string, string[]>()
    for (const goal of data.goals) {
      if (goal.parentGoalKey === null || !goalByKey.has(goal.parentGoalKey)) continue
      const list = children.get(goal.parentGoalKey) ?? []
      list.push(goal.key)
      children.set(goal.parentGoalKey, list)
    }
    const outcomesByGoal = new Map<string, Outcome[]>()
    for (const outcome of data.outcomes) {
      const list = outcomesByGoal.get(outcome.goalKey) ?? []
      list.push(outcome)
      outcomesByGoal.set(outcome.goalKey, list)
    }

    const goalMatches = new Set<string>()
    for (const goal of data.goals) {
      if (needle === '') continue
      if (goal.key.toLowerCase().includes(needle) || goal.title.toLowerCase().includes(needle) || goal.brief.toLowerCase().includes(needle)) {
        goalMatches.add(goal.key)
      }
    }

    const shown = new Set<string>()
    const shownOutcome = (outcome: Outcome): boolean => {
      const info = meta.get(outcome.key)
      // While replaying, filter on the signal the map is showing, not on today's.
      const signal = (recorded ? recorded.get(outcome.key) : info?.signal) ?? 'unverified'
      if (!showAll && signal === 'verified') return false
      if (blockedOnly && info?.blocked !== true && info?.availability !== 'blocked') return false
      if (signals.size > 0 && !signals.has(signal)) return false
      if (availabilityFilter !== 'all' && (info?.availability ?? 'active') !== availabilityFilter) return false
      if (selectedTag !== '') {
        const goalTags = goalByKey.get(outcome.goalKey)?.tags ?? []
        const ownTags = info?.tags ?? []
        if (!ownTags.includes(selectedTag) && !goalTags.includes(selectedTag)) return false
      }
      if (scopeOutcomeKeys !== null && !scopeOutcomeKeys.has(outcome.key)) return false
      if (!matchesOutcome(outcome, needle)) return false
      return true
    }

    for (const outcome of data.outcomes) {
      if (!shownOutcome(outcome)) continue
      shown.add(outcome.key)
      let parent: string | null = outcome.goalKey
      let hops = 0
      while (parent !== null && hops < 64) {
        shown.add(parent)
        const goal = goalByKey.get(parent)
        parent = goal?.parentGoalKey ?? null
        hops += 1
      }
    }
    for (const key of goalMatches) {
      shown.add(key)
      let parent: string | null = goalByKey.get(key)?.parentGoalKey ?? null
      let hops = 0
      while (parent !== null && hops < 64) {
        shown.add(parent)
        parent = goalByKey.get(parent)?.parentGoalKey ?? null
        hops += 1
      }
    }
    // Filters select work, not structure: with no text query or active scope every goal stays
    // on the map so hiding verified outcomes never deletes their parent.
    if (needle === '' && scopeOutcomeKeys === null && selectedTag === '') {
      for (const goal of data.goals) shown.add(goal.key)
    }
    return shown
  }, [availabilityFilter, blockedOnly, data.goals, data.outcomes, matchesOutcome, meta, query, recorded, scopeOutcomeKeys, selectedTag, showAll, signals])

  const visibleOutcomeKeys = useMemo(
    () => data.outcomes.filter((outcome) => visible.has(outcome.key)).map((outcome) => outcome.key),
    [data.outcomes, visible],
  )
  const coverage = useMemo(
    () =>
      recorded === null
        ? coverageOf(visibleOutcomeKeys, data.ranked)
        : coverageAt(visibleOutcomeKeys, data.ranked, recorded),
    [data.ranked, recorded, visibleOutcomeKeys],
  )

  const unreached = useMemo(() => {
    if (replay === null) return null
    const reached = new Set<string>()
    for (const node of layout.nodes) {
      const at = touched.get(node.key)
      if (at === undefined || at <= replay.cursor) reached.add(node.key)
    }
    return reached
  }, [layout.nodes, replay, touched])

  const playing = replay?.playing ?? false
  const speed = replay?.speed ?? 1
  useEffect(() => {
    if (!playing) return
    const span = Math.max(1, replayWindow.to - replayWindow.from)
    const step = (span / 90) * speed
    const tick = Math.max(40, 140 / speed)
    const id = window.setInterval(() => {
      setReplay((current) => {
        if (current === null) return null
        const next = current.cursor + step
        if (next >= replayWindow.to) return { ...current, cursor: replayWindow.to, playing: false }
        return { ...current, cursor: next }
      })
    }, tick)
    return () => window.clearInterval(id)
  }, [playing, replayWindow.from, replayWindow.to, speed])

  const startReplay = (): void => {
    setReplay({ cursor: replayWindow.from, playing: true, speed: 1 })
  }

  const toggleSignal = (signal: Signal): void => {
    setSignals((current) => {
      const next = new Set(current)
      if (next.has(signal)) next.delete(signal)
      else next.add(signal)
      return next
    })
  }

  const toggleCollapsed = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const replayLabel =
    replay === null
      ? ''
      : `${formatWhen(replay.cursor)} · ${replayWindow.events.filter((event) => event.at <= (replay.cursor)).length}/${replayWindow.events.length} events`

  const railEvents = useMemo(() => {
    if (replay === null) return []
    return replayWindow.events
      .filter((event) => event.at <= replay.cursor)
      .slice(-80)
      .reverse()
  }, [replay, replayWindow.events])

  const totalOutcomes = data.outcomes.length

  return (
    <section className="hc-tree" aria-label="Requirement tree">
      <header className="hc-toolbar">
        <div className="hc-toolbar-row">
          <div className="hc-title-block">
            <h2 className="hc-title">Tree</h2>
            <p className="hc-subtitle">
              {data.goals.length} {data.goals.length === 1 ? 'goal' : 'goals'} · {totalOutcomes}{' '}
              {totalOutcomes === 1 ? 'outcome' : 'outcomes'} · track <code>{track}</code>
              {data.inbox > 0 ? ` · ${data.inbox} in the inbox` : ''}
            </p>
          </div>
          <div className="hc-toolbar-actions">
            <div className="hc-segmented" role="group" aria-label="View">
              <button
                type="button"
                className={mode === 'map' ? 'is-active' : ''}
                aria-pressed={mode === 'map'}
                onClick={() => setMode('map')}
              >
                Map
              </button>
              <button
                type="button"
                className={mode === 'outline' ? 'is-active' : ''}
                aria-pressed={mode === 'outline'}
                onClick={() => setMode('outline')}
              >
                Outline
              </button>
            </div>
            <button
              type="button"
              className="hc-btn hc-btn-primary"
              onClick={() => {
                const goalKey =
                  selected === null
                    ? null
                    : data.goals.some((row) => row.key === selected)
                      ? selected
                      : (data.outcomes.find((row) => row.key === selected)?.goalKey ?? null)
                setCreating({ kind: data.goals.length === 0 ? 'goal' : 'outcome', goal: goalKey })
              }}
            >
              New
            </button>
          </div>
        </div>

        <div className="hc-toolbar-row hc-filters" role="group" aria-label="Filters">
          <label className="hc-search">
            <span className="hc-sr-only">Filter by key or text</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by key or text"
            />
          </label>
          <div className="hc-chips" role="group" aria-label="Signal filter">
            {SIGNALS.map((signal) => (
              <button
                key={signal.id}
                type="button"
                className={`hc-chip hc-signal-${signal.id}${signals.has(signal.id) ? ' is-active' : ''}`}
                aria-pressed={signals.has(signal.id)}
                onClick={() => toggleSignal(signal.id)}
              >
                {signal.label}
              </button>
            ))}
            <button
              type="button"
              className={`hc-chip${blockedOnly ? ' is-active' : ''}`}
              aria-pressed={blockedOnly}
              onClick={() => setBlockedOnly(!blockedOnly)}
            >
              Blocked
            </button>
          </div>
          <label className="hc-toggle">
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            <span>Show all outcomes</span>
          </label>
          {mode === 'outline' ? (
            <label className="hc-toggle">
              <span className="hc-sr-only">Sort outline</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as 'rank' | 'key')} aria-label="Sort outline">
                <option value="rank">By rank</option>
                <option value="key">By key</option>
              </select>
            </label>
          ) : null}
          {replay === null ? (
            <button type="button" className="hc-btn hc-replay-open" onClick={startReplay} disabled={replayWindow.events.length === 0}>
              Replay <span className="hc-replay-badge">{windowKey}</span>
            </button>
          ) : null}
        </div>

        <div className="hc-toolbar-row hc-subfilters" role="group" aria-label="Tags, availability, saved views, and focus scopes">
          <select
            aria-label="Filter by availability"
            className="hc-mini-select"
            value={availabilityFilter}
            onChange={(e) => setAvailabilityFilter(e.target.value as 'all' | OutcomeAvailability)}
          >
            <option value="all">Availability: all</option>
            <option value="active">Active only</option>
            <option value="blocked">Manually blocked</option>
            <option value="deferred">Deferred</option>
          </select>

          {allTags.length > 0 ? (
            <select
              aria-label="Filter by tag"
              className="hc-mini-select"
              value={selectedTag}
              onChange={(e) => setSelectedTag(e.target.value)}
            >
              <option value="">All tags ({allTags.length})</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          ) : null}

          {scopes.length > 0 || onSaveScope ? (
            <div className="hc-inline-group">
              <select
                aria-label="Focus scope"
                className="hc-mini-select"
                value={activeScope?.id ?? ''}
                onChange={(e) => {
                  const id = e.target.value
                  setScopeFilterId(id)
                  const chosen = scopes.find((s) => s.id === id)
                  if (chosen && onSaveScope) {
                    void onSaveScope({ ...chosen, active: true })
                  } else if (!id && activeScope && onSaveScope) {
                    void onSaveScope({ ...activeScope, active: false })
                  }
                }}
              >
                <option value="">Focus scope: none</option>
                {scopes.map((s) => (
                  <option key={s.id} value={s.id}>
                    Scope: {s.name}
                    {s.active ? ' (active)' : ''}
                  </option>
                ))}
              </select>
              {activeScope && onDeleteScope ? (
                <button
                  type="button"
                  className="hc-icon-btn"
                  title="Delete focus scope"
                  aria-label={`Delete scope ${activeScope.name}`}
                  onClick={() => {
                    setScopeFilterId('')
                    void onDeleteScope(activeScope.id)
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : null}

          {views.length > 0 ? (
            <div className="hc-chips" role="group" aria-label="Saved views">
              {views.map((v) => (
                <span key={v.id} className="hc-saved-view-pill">
                  <button type="button" className="hc-chip" onClick={() => applySavedView(v)}>
                    {v.name}
                  </button>
                  {onDeleteView ? (
                    <button
                      type="button"
                      className="hc-saved-view-del"
                      aria-label={`Delete saved view ${v.name}`}
                      onClick={() => void onDeleteView(v.id)}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}

          {onSaveView ? (
            savingView ? (
              <form
                className="hc-inline-group"
                onSubmit={(e) => {
                  e.preventDefault()
                  const trimmed = viewNameDraft.trim()
                  if (!trimmed) return
                  void onSaveView(trimmed, {
                    query: query.trim() || undefined,
                    signals: signals.size > 0 ? [...signals] : undefined,
                    tags: selectedTag ? [selectedTag] : undefined,
                    blockedOnly: blockedOnly || undefined,
                    availability: availabilityFilter !== 'all' ? [availabilityFilter] : undefined,
                    scope: activeScope?.id ?? null,
                    sortMode,
                  }).then(() => {
                    setViewNameDraft('')
                    setSavingView(false)
                  })
                }}
              >
                <input
                  className="hc-mini-input"
                  value={viewNameDraft}
                  onChange={(e) => setViewNameDraft(e.target.value)}
                  placeholder="View name…"
                  aria-label="Saved view name"
                  autoFocus
                />
                <button type="submit" className="hc-btn hc-btn-primary">
                  Save
                </button>
                <button type="button" className="hc-btn" onClick={() => setSavingView(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button type="button" className="hc-btn" onClick={() => setSavingView(true)}>
                Save view
              </button>
            )
          ) : null}
        </div>

        {pendingCreates.length > 0 ? (
          <div className="hc-proposed-strip" role="status">
            <span>
              <strong>{pendingCreates.length}</strong> proposed new outcome{pendingCreates.length === 1 ? '' : 's'} waiting for
              approval: {pendingCreates.map((c) => c.key).slice(0, 4).join(', ')}
              {pendingCreates.length > 4 ? ` +${pendingCreates.length - 4}` : ''}
            </span>
            {onOpenInbox ? (
              <button type="button" className="hc-btn" onClick={onOpenInbox}>
                Review in Inbox →
              </button>
            ) : null}
          </div>
        ) : null}

        <CoverageBar coverage={coverage} replaying={recorded !== null} />
      </header>

      {replay !== null ? (
        <ReplayBar
          windowKey={windowKey}
          onWindow={(key) => {
            setWindowKey(key)
            setReplay((current) => (current === null ? null : { ...current, cursor: Date.now() - WINDOWS[key], playing: false }))
          }}
          cursor={replay.cursor}
          from={replayWindow.from}
          to={replayWindow.to}
          playing={replay.playing}
          speed={replay.speed}
          onPlay={() => setReplay((current) => (current === null ? null : { ...current, playing: true }))}
          onPause={() => setReplay((current) => (current === null ? null : { ...current, playing: false }))}
          onScrub={(at) => setReplay((current) => (current === null ? null : { ...current, cursor: Math.min(replayWindow.to, Math.max(replayWindow.from, at)), playing: false }))}
          onSpeed={(speed) => setReplay((current) => (current === null ? null : { ...current, speed }))}
          onStop={() => setReplay(null)}
          label={replayLabel}
        />
      ) : null}

      <div
        className={`hc-canvas-wrap${mode === 'map' ? ' is-map' : ' is-outline'}`}
        ref={viewportRef}
        tabIndex={0}
        role="group"
        aria-label={mode === 'map' ? 'Tree map. Drag to pan, scroll to zoom, arrow keys to move.' : 'Tree outline'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {emptyTree ? (
          <div className="hc-empty">
            <h3>No charter yet</h3>
            <p>
              A tree starts with one goal: what the software must do, in the order it must happen. Add an outcome under it and
              the first thing to prove.
            </p>
            <button
              type="button"
              className="hc-btn hc-btn-primary"
              onClick={() => {
                fitted.current = false
                setCreating({ kind: 'goal', goal: null })
              }}
            >
              Create the first charter
            </button>
          </div>
        ) : creating !== null ? (
          <div className="hc-create-layer" onClick={(event) => event.stopPropagation()}>
            <CreatePanel
              data={data}
              act={act}
              initialKind={creating.kind}
              initialGoal={creating.goal}
              onClose={() => setCreating(null)}
              onCreated={(key) => {
                setCreating(null)
                fitted.current = false
                select(key)
              }}
            />
          </div>
        ) : mode === 'map' ? (
          <MapCanvas
            layout={layout}
            meta={meta}
            visible={visible}
            selected={selected}
            select={select}
            view={view}
            unreached={unreached}
            recorded={recorded}
          />
        ) : (
          <OutlineList
            data={data}
            meta={meta}
            visible={visible}
            selected={selected}
            select={select}
            collapsed={collapsed}
            toggle={toggleCollapsed}
            sortMode={sortMode}
            recorded={recorded}
          />
        )}

        {!emptyTree &&
        creating === null &&
        visibleOutcomeKeys.length === 0 &&
        data.outcomes.length > 0 &&
        (query.trim() !== '' || signals.size > 0 || blockedOnly || !showAll || selectedTag !== '' || availabilityFilter !== 'all' || activeScope !== null) ? (
          <p className="hc-empty-note hc-filter-empty" role="status">
            Nothing matches these filters.{' '}
            <button
              type="button"
              className="hc-link"
              onClick={() => {
                setQuery('')
                setSignals(new Set())
                setBlockedOnly(false)
                setSelectedTag('')
                setAvailabilityFilter('all')
                setScopeFilterId('')
                setShowAll(true)
              }}
            >
              Clear filters
            </button>
          </p>
        ) : null}

        {mode === 'map' && creating === null && !emptyTree ? (
          <div className="hc-zoom" role="group" aria-label="Zoom">
            <button type="button" className="hc-icon-btn" onClick={() => setView({ ...view, k: Math.min(3, view.k * 1.25) })} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="hc-icon-btn" onClick={() => setView({ ...view, k: Math.max(0.12, view.k / 1.25) })} aria-label="Zoom out">
              −
            </button>
            <button type="button" className="hc-btn" onClick={fit}>
              Fit
            </button>
            <span className="hc-zoom-level" aria-hidden="true">
              {Math.round(view.k * 100)}%
            </span>
          </div>
        ) : null}

        {replay !== null ? (
          <aside className="hc-replay-rail" aria-label="Activity during the replay window">
            <h4>
              {WINDOW_LABEL[windowKey]} · {replayWindow.events.length} events
            </h4>
            {railEvents.length === 0 ? (
              <p className="hc-empty-note">Nothing recorded yet in this window.</p>
            ) : (
              <ol className="hc-rail-list">
                {railEvents.map((event) => (
                  <li key={event.id} className={`hc-rail-row hc-rail-${event.kind}`}>
                    <span className="hc-rail-when">{formatWhen(event.at)}</span>
                    <button type="button" className="hc-link hc-rail-key" onClick={() => select(event.key)}>
                      {event.key}
                    </button>
                    <span className="hc-rail-kind">{event.kind}</span>
                    {event.actor ? (
                      <span className="hc-rail-actor" title={event.via ? `via ${event.via}` : undefined}>
                        {event.actor}
                        {event.via ? `·${event.via}` : ''}
                      </span>
                    ) : null}
                    <span className="hc-rail-text">{event.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        ) : null}
      </div>

      <p className="hc-sr-only" aria-live="polite">
        {visibleOutcomeKeys.length} of {totalOutcomes} outcomes shown, {coverage.proven} proven.
      </p>
    </section>
  )
}
