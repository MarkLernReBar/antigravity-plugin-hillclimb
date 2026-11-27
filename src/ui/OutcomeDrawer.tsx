// The outcome drawer: the contract, the ancestors it inherits from, the
// proposals waiting for a person, the live climb, and the evidence, plans and
// decisions recorded against one key.
//
// Everything that changes state goes through `act` (validated by
// src/actions.ts). The live climb is read-only: `dispatch` and `live` belong to
// the parent, because running a climb is not a thing a view may decide to do on
// its own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Action } from '../actions.js'
import type { Change, Comment, Contract, Evidence, Goal, Outcome, OutcomeAvailability, Plan } from '../model.js'
import type { LiveData, ViewProps } from '../view-props.js'
import { formatWhen, sortOutcomes, signalOf } from './TreeView.js'

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type DiffKind = 'same' | 'added' | 'removed' | 'changed'
export interface DiffRow {
  kind: DiffKind
  label: string
  before: string | null
  after: string | null
}

/** A row-per-field diff between the live contract and a proposal. */
export function contractDiff(current: Contract, proposed: Contract): DiffRow[] {
  const rows: DiffRow[] = []
  const field = (label: string, before: string, after: string): void => {
    rows.push({ kind: before === after ? 'same' : 'changed', label, before, after })
  }
  field('Title', current.title, proposed.title)
  field('Story', current.story, proposed.story)
  field('Rank', String(current.rank), String(proposed.rank))
  field(
    'Recheck',
    current.recheckDays === null ? 'never' : `${current.recheckDays} days`,
    proposed.recheckDays === null ? 'never' : `${proposed.recheckDays} days`,
  )
  field(
    'Depends on',
    current.dependsOn.slice().sort().join(', ') || 'none',
    proposed.dependsOn.slice().sort().join(', ') || 'none',
  )
  if ((current.tags && current.tags.length > 0) || (proposed.tags && proposed.tags.length > 0)) {
    field(
      'Tags',
      (current.tags ?? []).slice().sort().join(', ') || 'none',
      (proposed.tags ?? []).slice().sort().join(', ') || 'none',
    )
  }

  const previous = new Map(current.criteria.map((row) => [row.id, row]))
  const next = new Set(proposed.criteria.map((row) => row.id))
  const text = (row: { given: string; when: string; then: string }): string => `${row.given} / ${row.when} / ${row.then}`
  for (const row of proposed.criteria) {
    const before = previous.get(row.id)
    if (before === undefined) {
      rows.push({ kind: 'added', label: row.id, before: null, after: text(row) })
    } else {
      const beforeText = text(before)
      const afterText = text(row)
      rows.push({ kind: beforeText === afterText ? 'same' : 'changed', label: row.id, before: beforeText, after: afterText })
    }
  }
  for (const row of current.criteria) {
    if (!next.has(row.id)) rows.push({ kind: 'removed', label: row.id, before: text(row), after: null })
  }
  return rows
}

export function contractOf(outcome: Outcome): Contract {
  return {
    title: outcome.title,
    story: outcome.story,
    criteria: outcome.criteria.map((row) => ({ ...row })),
    dependsOn: outcome.dependsOn.slice(),
    rank: outcome.rank,
    recheckDays: outcome.recheckDays,
    ...(outcome.tags && outcome.tags.length > 0 ? { tags: outcome.tags.slice() } : {}),
  }
}

function computeLineDiff(before: string, after: string): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  const aSet = new Set(a)
  const bSet = new Set(b)
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if (i < a.length && !bSet.has(a[i] ?? '')) {
      out.push({ kind: 'del', text: a[i] ?? '' })
      i += 1
    } else if (j < b.length && !aSet.has(b[j] ?? '')) {
      out.push({ kind: 'add', text: b[j] ?? '' })
      j += 1
    } else {
      if (i < a.length) {
        out.push({ kind: 'del', text: a[i] ?? '' })
        i += 1
      }
      if (j < b.length) {
        out.push({ kind: 'add', text: b[j] ?? '' })
        j += 1
      }
    }
  }
  return out
}

/** `max` when the best score is above the baseline, `min` when below. */
export function inferDirection(live: LiveData): 'min' | 'max' | 'unknown' {
  if (live.baseline === null || live.best === null) return 'unknown'
  if (live.best > live.baseline) return 'max'
  if (live.best < live.baseline) return 'min'
  return 'unknown'
}

/**
 * The measure's direction, using the bar as the tie-break when the best score
 * still equals the baseline (the chart alone cannot tell which way is better).
 */
export function directionOf(live: LiveData): 'min' | 'max' {
  const inferred = inferDirection(live)
  if (inferred !== 'unknown') return inferred
  if (live.baseline !== null && live.target !== null && live.baseline !== live.target) {
    return live.target > live.baseline ? 'max' : 'min'
  }
  return 'max'
}

/**
 * What the numbers actually support, as distinct states. “The bar is met” and
 * “the climb improved something” are different claims, and a baseline that
 * already sits on the bar demonstrates no improvement at all.
 */
export type ScoreVerdict =
  | 'no-baseline'
  | 'no-gain-yet'
  | 'improved-below-target'
  | 'baseline-at-target'
  | 'target-met-with-gain'
  | 'improved'

export interface Verdict {
  kind: ScoreVerdict
  label: string
  detail: string
}

const meets = (score: number, target: number, direction: 'min' | 'max'): boolean =>
  direction === 'max' ? score >= target : score <= target

const improved = (live: LiveData, direction: 'min' | 'max'): boolean => {
  if (live.baseline === null || live.best === null) return false
  return direction === 'max' ? live.best > live.baseline : live.best < live.baseline
}

export function verdictOf(live: LiveData): Verdict {
  if (live.baseline === null) {
    return { kind: 'no-baseline', label: 'No baseline yet', detail: 'The run has not scored the unchanged starting point, so no comparison exists.' }
  }
  const direction = directionOf(live)
  const gain = improved(live, direction)
  const holdout =
    live.holdout === null ? ' No holdout is recorded, so nothing here catches overfitting to the visible cases.' : ''
  if (live.target === null) {
    return gain
      ? { kind: 'improved', label: 'Improved, no bar set', detail: `Best ${formatScore(live.best)} is better than the baseline ${formatScore(live.baseline)}.${holdout}` }
      : { kind: 'no-gain-yet', label: 'No gain yet', detail: `Best still equals the baseline ${formatScore(live.baseline)}.${holdout}` }
  }
  if (meets(live.best ?? live.baseline, live.target, direction)) {
    if (!gain) {
      return {
        kind: 'baseline-at-target',
        label: 'Bar met without a demonstrated gain',
        detail: `The unchanged baseline already scores ${formatScore(live.baseline)} against a bar of ${formatScore(live.target)}. That is attainment, not improvement.${holdout}`,
      }
    }
    return {
      kind: 'target-met-with-gain',
      label: 'Bar met with a demonstrated gain',
      detail: `Best ${formatScore(live.best)} beats the baseline ${formatScore(live.baseline)} and meets the bar of ${formatScore(live.target)}.${holdout}`,
    }
  }
  if (gain) {
    return {
      kind: 'improved-below-target',
      label: 'Improved, bar not met',
      detail: `Best ${formatScore(live.best)} beats the baseline ${formatScore(live.baseline)} but is short of the bar ${formatScore(live.target)}.${holdout}`,
    }
  }
  return {
    kind: 'no-gain-yet',
    label: 'No gain yet',
    detail: `Best still equals the baseline ${formatScore(live.baseline)}, and the bar is ${formatScore(live.target)}.${holdout}`,
  }
}

/** The worker's own account of where it is; optional, so an older read still renders. */
export type WorkerStatus = NonNullable<LiveData['worker']>

const workerOf = (live: LiveData): WorkerStatus | null => live.worker ?? null

/** One readable line per fact an operator or agent needs to resume this climb. */
export interface ProgressLine {
  label: string
  detail: string
}

export function progressLines(live: LiveData): ProgressLine[] {
  const verdict = verdictOf(live)
  const lines: ProgressLine[] = []
  if (live.engine === 'search') {
    const shape = live.search ?? null
    lines.push({
      label: 'Engine',
      detail:
        shape === null
          ? 'evolutionary search · the run’s own record of which search this is has not been read yet'
          : `evolutionary search · climber ${shape.climber ?? 'recorded by the run, not named here'}` +
            (shape.featureDimensions === null ? '' : ` over ${shape.featureDimensions.join(', ')}`) +
            (shape.count > 1 ? ` · ${shape.count} searches in this run, showing ${shape.id}` : ''),
    })
  } else if (live.engine === 'repo') {
    lines.push({ label: 'Engine', detail: 'repo climb · each kept step is a commit, scored by the check' })
  } else {
    lines.push({ label: 'Engine', detail: 'no engine has run for this outcome yet' })
  }
  lines.push({ label: 'Where it stands', detail: `${verdict.label}. ${verdict.detail}` })
  const last = live.rows.length === 0 ? null : live.rows[live.rows.length - 1]
  lines.push({
    label: 'Last observation',
    detail:
      last === null
        ? 'nothing measured yet: no step or candidate has a score'
        : `${live.rows.length} recorded · last “${last.label}” scored ${formatScore(last.score)} at ${formatTime(last.at)}`,
  })
  // The worker's phase is the one fact that means something before any score
  // exists, so it is shown even when the run has recorded no row at all.
  const worker = workerOf(live)
  if (worker !== null) {
    lines.push({
      label: 'Worker',
      detail:
        `${worker.phase} · ${worker.liveness}` +
        (worker.retries > 0 ? ` · ${worker.retries} retr${worker.retries === 1 ? 'y' : 'ies'} so far` : '') +
        (worker.heartbeatAt === null ? ' · no heartbeat recorded' : ` · last heartbeat ${formatTime(worker.heartbeatAt)}`),
    })
    lines.push({ label: 'Next action', detail: worker.nextAction })
  }
  lines.push({
    label: 'Resume',
    detail:
      live.engine === 'search'
        ? 'The run resumes rather than restarts: an existing run folder is re-entered with the climber it started with, so its history stays one run.'
        : 'The climb resumes from its incumbent commit: reading the status does not run the check, and the next attempt is scored against the incumbent.',
  })
  lines.push({
    label: 'Not in this read',
    detail: 'the allowance, the repeat count and the spread between runs live in the run’s own log; this view does not guess them.',
  })
  return lines
}

function formatTime(value: string): string {
  const parsed = parseTime(value)
  return Number.isFinite(parsed) ? formatWhen(parsed) : value
}

export interface LineageNode {
  id: string
  parent: string | null
  depth: number
  row: number
  label: string
  score: number | null
  at: string
}

export interface Lineage {
  nodes: LineageNode[]
  edges: Array<{ from: string; to: string }>
  depthCount: number
  rowCount: number
}

/**
 * Lay a candidate tree out by descent depth; a missing parent is a root.
 *
 * Candidate ids are recording slots and repeat inside one slot, so each
 * candidate gets its own node id and a parent reference resolves to the first
 * candidate that carried it. Duplicates are shown, never silently merged.
 */
export function lineageGraph(rows: LiveData['rows']): Lineage {
  const used = new Set<string>()
  const entries = rows.map((row, index) => {
    const candidate = used.has(row.id) ? `${row.id}#${index}` : row.id
    used.add(candidate)
    return { row, id: candidate }
  })
  const firstById = new Map<string, string>()
  for (const entry of entries) {
    if (!firstById.has(entry.row.id)) firstById.set(entry.row.id, entry.id)
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const parentOf = (entry: (typeof entries)[number]): string | null => {
    if (entry.row.parent === null) return null
    return firstById.get(entry.row.parent) ?? null
  }

  const depth = new Map<string, number>()
  const resolve = (id: string, seen: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const entry = byId.get(id)
    const parent = entry === undefined ? null : parentOf(entry)
    if (entry === undefined || parent === null) {
      depth.set(id, 0)
      return 0
    }
    const value = resolve(parent, seen) + 1
    depth.set(id, value)
    return value
  }
  for (const entry of entries) resolve(entry.id, new Set())

  const perDepth = new Map<number, number>()
  const nodes: LineageNode[] = entries.map((entry) => {
    const level = depth.get(entry.id) ?? 0
    const rowIndex = perDepth.get(level) ?? 0
    perDepth.set(level, rowIndex + 1)
    return {
      id: entry.id,
      parent: parentOf(entry),
      depth: level,
      row: rowIndex,
      label: entry.row.label,
      score: entry.row.score,
      at: entry.row.at,
    }
  })
  const edges = nodes
    .filter((node): node is LineageNode & { parent: string } => node.parent !== null)
    .map((node) => ({ from: node.parent, to: node.id }))
  return {
    nodes,
    edges,
    depthCount: Math.max(...nodes.map((node) => node.depth), 0) + 1,
    rowCount: Math.max(...nodes.map((node) => node.row), 0) + 1,
  }
}

/** The evidence, as text an agent can paste into a message or a PR body. */
export function evidenceOutput(evidence: Evidence[], outcome: Outcome): string {
  const head = `${outcome.key} · ${outcome.title} (v${outcome.version})`
  if (evidence.length === 0) return `${head}\nNo evidence recorded.`
  const lines: string[] = [head]
  for (const row of evidence) {
    const criteria = row.criterionIds.length === 0 ? '—' : row.criterionIds.join(', ')
    const stale = row.version !== outcome.version ? ' [earlier version]' : ''
    lines.push(`${row.kind.toUpperCase()} ${criteria} ${formatWhen(Date.parse(row.created.replace(' ', 'T')))}${stale}`)
    lines.push(`  ${row.text}`)
    lines.push(`  source: ${row.source} · track: ${row.track}`)
  }
  return lines.join('\n')
}

export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '—'
  return Number.isInteger(score) ? String(score) : String(Math.round(score * 1e6) / 1e6)
}

function parseTime(value: string): number {
  const parsed = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

const CHART = { w: 560, h: 200, l: 56, r: 48, t: 14, b: 26 }

/** A quiet re-read while the Live tab is open. Live data is cheap; a stale chart is not. */
const LIVE_POLL_MS = 15_000

function LiveChart({ live }: { live: LiveData }): JSX.Element {
  const points = useMemo(() => {
    // `id` is the recording slot, and a slot may hold several candidates, so the
    // React key is positional: duplicate ids must not collapse points away.
    const usable = live.rows
      .filter((row): row is typeof row & { score: number } => typeof row.score === 'number')
      .map((row, index) => ({
        key: `p${index}`,
        id: row.id,
        label: row.label,
        score: row.score,
        t: parseTime(row.at),
        index,
        at: row.at,
      }))
    // Timestamps only order the x-axis when they are all readable and actually
    // differ. A batch of candidates written in the same second is laid out in
    // recorded order instead of stacking every point on one x.
    const allTimed = usable.every((point) => Number.isFinite(point.t))
    const distinct = new Set(usable.map((point) => point.t)).size
    const timed = allTimed && distinct > 1
    return { usable, timed }
  }, [live.rows])

  const scores = points.usable.map((point) => point.score)
  const values = [live.baseline, live.best, live.target, ...scores].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  if (values.length === 0) {
    return <p className="hc-empty-note">No scores recorded for this climb yet.</p>
  }
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const pad = rawMin === rawMax ? Math.max(1, Math.abs(rawMin) * 0.1) : (rawMax - rawMin) * 0.08
  const min = rawMin - pad
  const max = rawMax + pad
  const innerW = CHART.w - CHART.l - CHART.r
  const innerH = CHART.h - CHART.t - CHART.b
  const y = (value: number): number => CHART.t + innerH - ((value - min) / (max - min)) * innerH

  const xs = points.usable.map((point) => (points.timed ? point.t : point.index))
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const x = (value: number): number =>
    xs.length <= 1 || xMin === xMax ? CHART.l + innerW / 2 : CHART.l + ((value - xMin) / (xMax - xMin)) * innerW

  const ordered = points.usable.slice().sort((a, b) => (points.timed ? a.t - b.t : a.index - b.index))
  const path =
    ordered.length === 1
      ? (() => {
          const only = ordered[0] as (typeof ordered)[number]
          const px = x(points.timed ? only.t : only.index)
          const py = y(only.score)
          const tick = Math.min(18, innerW / 2)
          return `M ${px - tick} ${py} L ${px + tick} ${py}`
        })()
      : ordered.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(points.timed ? point.t : point.index)} ${y(point.score)}`).join(' ')

  const placedRuleYs: number[] = []
  const rule = (value: number | null, className: string, label: string): JSX.Element | null => {
    if (value === null || !Number.isFinite(value)) return null
    const lineY = y(value)
    let textY = lineY + 3
    for (const prev of placedRuleYs) {
      if (Math.abs(textY - prev) < 11) {
        textY = prev + 11
      }
    }
    textY = Math.min(CHART.t + innerH + 4, Math.max(CHART.t + 8, textY))
    placedRuleYs.push(textY)
    return (
      <g className={className}>
        <line x1={CHART.l} x2={CHART.w - CHART.r} y1={lineY} y2={lineY} />
        <text x={CHART.w - CHART.r + 5} y={textY} textAnchor="start">
          {label}
        </text>
      </g>
    )
  }

  return (
    <figure className="hc-chart-figure">
      <svg
        className="hc-chart"
        viewBox={`0 0 ${CHART.w} ${CHART.h}`}
        role="img"
        aria-label={`Score over time. Baseline ${formatScore(live.baseline)}, best ${formatScore(live.best)}, target ${formatScore(live.target)}.`}
      >
        <rect className="hc-chart-bg" x={CHART.l} y={CHART.t} width={innerW} height={innerH} />
        {rule(live.target, 'hc-rule hc-rule-target', 'target')}
        {rule(live.best, 'hc-rule hc-rule-best', 'best')}
        {rule(live.baseline, 'hc-rule hc-rule-baseline', 'base')}
        <text className="hc-axis" x={CHART.l - 6} y={CHART.t + 8} textAnchor="end">
          {formatScore(rawMax)}
        </text>
        {rawMin !== rawMax ? (
          <text className="hc-axis" x={CHART.l - 6} y={CHART.t + innerH} textAnchor="end">
            {formatScore(rawMin)}
          </text>
        ) : null}
        {ordered.length > 0 ? <path className="hc-chart-line" d={path} /> : null}
        {ordered.map((point) => {
          const px = x(points.timed ? point.t : point.index)
          const py = y(point.score)
          const best = live.best !== null && point.score === live.best
          return (
            <circle key={point.key} className={best ? 'hc-point is-best' : 'hc-point'} cx={px} cy={py} r={best ? 5 : 3}>
              <title>{`${point.label}: ${formatScore(point.score)} at ${point.at}`}</title>
            </circle>
          )
        })}
      </svg>
      <figcaption className="hc-chart-legend">
        <span>
          <i className="hc-swatch hc-swatch-baseline" /> baseline {formatScore(live.baseline)}
        </span>
        <span>
          <i className="hc-swatch hc-swatch-best" /> best {formatScore(live.best)}
        </span>
        <span>
          <i className="hc-swatch hc-swatch-target" /> target {formatScore(live.target)}
        </span>
        <span className="hc-hint">
          {inferDirection(live) === 'unknown'
            ? 'direction not inferable from these two scores'
            : `${inferDirection(live) === 'max' ? 'higher' : 'lower'} is better`}
        </span>
      </figcaption>
    </figure>
  )
}

function LineageGraph({ live }: { live: LiveData }): JSX.Element {
  const lineage = useMemo(() => lineageGraph(live.rows), [live.rows])
  if (lineage.nodes.length === 0) {
    return <p className="hc-empty-note">No candidates yet. Dispatch an engine to start the climb.</p>
  }
  const colW = 132
  const rowH = 34
  const boxW = 116
  const boxH = 24
  const width = Math.max(lineage.depthCount * colW, boxW + 8)
  const height = Math.max(lineage.rowCount * rowH, rowH)
  const position = (node: LineageNode): { x: number; y: number } => ({
    x: node.depth * colW + 4,
    y: node.row * rowH + 4,
  })
  const byId = new Map(lineage.nodes.map((node) => [node.id, node]))
  return (
    <div className="hc-lineage-scroll">
      <svg
        className="hc-lineage"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Candidate lineage: ${lineage.nodes.length} candidates`}
      >
        {lineage.edges.map((edge) => {
          const from = byId.get(edge.from)
          const to = byId.get(edge.to)
          if (from === undefined || to === undefined) return null
          const a = position(from)
          const b = position(to)
          const x1 = a.x + boxW
          const y1 = a.y + boxH / 2
          const x2 = b.x
          const y2 = b.y + boxH / 2
          const dx = Math.max(12, (x2 - x1) / 2)
          return <path key={`${edge.from}→${edge.to}`} className="hc-lineage-edge" d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} />
        })}
        {lineage.nodes.map((node) => {
          const at = position(node)
          const best = live.best !== null && node.score === live.best
          return (
            <g key={node.id} className={best ? 'hc-lineage-node is-best' : 'hc-lineage-node'} transform={`translate(${at.x} ${at.y})`}>
              <rect width={boxW} height={boxH} rx={6} />
              <text x={6} y={boxH / 2 + 4} className="hc-lineage-score">
                {formatScore(node.score)}
              </text>
              <text x={boxW - 6} y={boxH / 2 + 4} textAnchor="end" className="hc-lineage-label">
                {node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label}
              </text>
              <title>{`${node.id} · ${node.label} · ${formatScore(node.score)} · parent ${node.parent ?? 'none'}`}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export interface EliteGridCell {
  island: number
  bins: number[]
  parent: string | null
  score: number | null
  attempts: number
}

export interface EliteGridRow {
  island: number
  /** Cells of one island, in the order the bridge returned them. */
  cells: EliteGridCell[]
  /** The grid's extent on each axis, from the recorded bins themselves. */
  width: number
  height: number
  best: number | null
  worst: number | null
}

/**
 * Group the recorded cells by island and give each island its own extent.
 *
 * The extent comes from the bins the engine wrote, never from a bin count this
 * module guessed: a search that recorded `[3, 7]` and `[9, 4]` has a 7-wide,
 * 4-tall picture even when the selector's own `feature_bins` was different.
 * A one-dimensional grid is a single row.
 */
export function eliteGridRows(cells: EliteGridCell[] | undefined): EliteGridRow[] {
  const byIsland = new Map<number, EliteGridCell[]>()
  for (const cell of cells ?? []) {
    if (cell.bins.length === 0) continue
    const seen = byIsland.get(cell.island)
    if (seen === undefined) byIsland.set(cell.island, [cell])
    else seen.push(cell)
  }
  return [...byIsland.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([island, islandCells]) => {
      const xs = islandCells.map((cell) => cell.bins[0] ?? 0)
      const ys = islandCells.map((cell) => cell.bins[1] ?? 0)
      const scores = islandCells.map((cell) => cell.score).filter((score): score is number => score !== null)
      return {
        island,
        cells: islandCells,
        width: Math.max(1, Math.max(...xs) - Math.min(...xs) + 1),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys) + 1),
        best: scores.length === 0 ? null : Math.max(...scores),
        worst: scores.length === 0 ? null : Math.min(...scores),
      }
    })
}

/** Where a cell sits in a grid drawn at 44px, with its recorded bins as the axes. */
const ELITE = { cell: 44, gap: 3, label: 30 }

/**
 * The MAP-Elites cells the search recorded, one grid per island.
 *
 * A cell is a bin the engine wrote when it expanded from it
 * (`climber_meta.cell`), not an archive slot this view reconstructs; the
 * caption says so, because the live archive lives in the search process and is
 * never persisted. No cells recorded means an honest empty state.
 */
function EliteGrid({ live }: { live: LiveData }): JSX.Element {
  const rows = useMemo(() => eliteGridRows(live.elite), [live.elite])
  if (rows.length === 0) {
    return (
      <p className="hc-empty-note">
        {live.engine === 'search'
          ? 'This search recorded no grid cells. A MAP-Elites climber records them on every candidate built from the archive; greedy does not have a grid.'
          : 'Only a search climb has a feature grid.'}
      </p>
    )
  }
  const dimensions = live.search?.featureDimensions ?? null
  const axis = (index: number): string => {
    const name = dimensions?.[index]
    return name === undefined ? `bin ${index + 1}` : name
  }
  return (
    <figure className="hc-elite">
      {rows.map((row) => {
        const xs = row.cells.map((cell) => cell.bins[0] ?? 0)
        const ys = row.cells.map((cell) => cell.bins[1] ?? 0)
        const minX = Math.min(...xs)
        const minY = Math.min(...ys)
        const width = row.width * (ELITE.cell + ELITE.gap) + ELITE.label
        const height = row.height * (ELITE.cell + ELITE.gap) + ELITE.label
        const fill = (score: number | null): number => {
          if (score === null || row.best === null || row.worst === null) return 0.25
          if (row.best === row.worst) return 0.55
          return 0.2 + (0.75 * (score - row.worst)) / (row.best - row.worst)
        }
        return (
          <section key={row.island} className="hc-elite-island" aria-label={`Island ${row.island}`}>
            <figcaption className="hc-hint">
              island {row.island} · {row.cells.length} recorded cell{row.cells.length === 1 ? '' : 's'}
            </figcaption>
            <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Island ${row.island}: ${row.cells.length} recorded cells`}>
              <text x={0} y={ELITE.label - 10} className="hc-elite-axis">
                {axis(1)}↑
              </text>
              <text x={ELITE.label} y={height - 4} className="hc-elite-axis">
                {axis(0)}→
              </text>
              {row.cells.map((cell) => {
                const x = ELITE.label + ((cell.bins[0] ?? 0) - minX) * (ELITE.cell + ELITE.gap)
                const y = ELITE.label + (row.height - 1 - ((cell.bins[1] ?? 0) - minY)) * (ELITE.cell + ELITE.gap)
                const best = live.best !== null && cell.score === live.best
                return (
                  <g key={`${cell.island}:${cell.bins.join(',')}`} transform={`translate(${x} ${y})`} className={best ? 'hc-elite-cell is-best' : 'hc-elite-cell'}>
                    <rect width={ELITE.cell} height={ELITE.cell} rx={5} fillOpacity={fill(cell.score)} />
                    <text x={ELITE.cell / 2} y={ELITE.cell / 2 + 4} textAnchor="middle" className="hc-elite-score">
                      {formatScore(cell.score)}
                    </text>
                    <title>{`island ${cell.island} · cell [${cell.bins.join(', ')}] · parent ${cell.parent ?? 'unknown'} · ${formatScore(cell.score)} · ${cell.attempts} attempt${cell.attempts === 1 ? '' : 's'} recorded here`}</title>
                  </g>
                )
              })}
              <text x={ELITE.label - 6} y={ELITE.label - 10} className="hc-elite-axis" textAnchor="end">
                {Math.max(...ys)}
              </text>
            </svg>
          </section>
        )
      })}
      <figcaption className="hc-hint">
        Cells the engine journaled when it expanded from them (<code>climber_meta.cell</code>), best parent per cell.
        {dimensions === null ? ' Axes are the recorded bins: this search did not record its feature dimensions.' : ''}
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Drawer pieces
// ---------------------------------------------------------------------------

interface DrawerChangeProps {
  change: Change
  current: Contract
  act: (action: Action) => Promise<void>
  onError: (message: string) => void
}

function ChangeCard({ change, current, act, onError }: DrawerChangeProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => contractDiff(current, change.proposed), [current, change.proposed])
  const changed = rows.filter((row) => row.kind !== 'same')
  const run = async (action: Action): Promise<void> => {
    setBusy(true)
    try {
      await act(action)
    } catch (thrown) {
      onError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className={`hc-change hc-change-${change.state}`} aria-label={`Proposal ${change.id}`}>
      <header className="hc-change-head">
        <code>{change.id}</code>
        <span className={`hc-badge hc-change-state-${change.state}`}>{change.state}</span>
        <span className="hc-hint">
          base v{change.baseVersion} · {formatWhen(parseTime(change.created))}
        </span>
      </header>
      {changed.length === 0 ? (
        <p className="hc-hint">Identical to the current contract.</p>
      ) : (
        <table className="hc-diff">
          <caption className="hc-sr-only">Proposed changes</caption>
          <tbody>
            {changed.map((row) => (
              <tr key={row.label} className={`hc-diff-${row.kind}`}>
                <th scope="row">{row.label}</th>
                <td>
                  {row.before === null ? <span className="hc-hint">—</span> : <del>{row.before}</del>}
                  {row.after === null ? null : <ins>{row.after}</ins>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {change.state === 'pending' ? (
        <div className="hc-row-actions">
          <button type="button" className="hc-btn hc-btn-primary" disabled={busy} onClick={() => void run({ op: 'approve_change', id: change.id })}>
            Approve
          </button>
          <button type="button" className="hc-btn" disabled={busy} onClick={() => void run({ op: 'reject_change', id: change.id })}>
            Not yet
          </button>
        </div>
      ) : null}
    </article>
  )
}

interface EditFormProps {
  outcome: Outcome
  act: (action: Action) => Promise<void>
  onError: (message: string) => void
  onDone: () => void
}

function EditProposal({ outcome, act, onError, onDone }: EditFormProps): JSX.Element {
  const [draft, setDraft] = useState<Contract>(() => contractOf(outcome))
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (draft.criteria.length === 0) {
      onError('An outcome needs at least one criterion.')
      return
    }
    if (draft.criteria.some((row) => row.given.trim() === '' || row.when.trim() === '' || row.then.trim() === '')) {
      onError('Every criterion needs a given, a when and a then.')
      return
    }
    setBusy(true)
    try {
      await act({
        op: 'propose_change',
        key: outcome.key,
        version: outcome.version,
        contract: {
          title: draft.title.trim(),
          story: draft.story.trim(),
          criteria: draft.criteria.map((row) => ({
            id: row.id.trim(),
            given: row.given.trim(),
            when: row.when.trim(),
            then: row.then.trim(),
          })),
          dependsOn: draft.dependsOn,
          rank: draft.rank,
          recheckDays: draft.recheckDays,
          ...(draft.tags && draft.tags.length > 0 ? { tags: draft.tags } : {}),
        },
      })
      onDone()
    } catch (thrown) {
      onError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hc-edit" onSubmit={(event) => void submit(event)} aria-label="Propose an edit">
      <div className="hc-field">
        <label htmlFor="hc-edit-title">Title</label>
        <input id="hc-edit-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required />
      </div>
      <div className="hc-field">
        <label htmlFor="hc-edit-story">Story</label>
        <textarea id="hc-edit-story" rows={2} value={draft.story} onChange={(event) => setDraft({ ...draft, story: event.target.value })} required />
      </div>
      <fieldset className="hc-criteria-edit">
        <legend>Criteria</legend>
        {draft.criteria.map((row, index) => (
          <div className="hc-criterion-draft" key={`${row.id}-${index}`}>
            <input
              aria-label={`Criterion ${index + 1} id`}
              className="hc-criterion-id"
              value={row.id}
              onChange={(event) => {
                const next = draft.criteria.slice()
                next[index] = { ...row, id: event.target.value }
                setDraft({ ...draft, criteria: next })
              }}
              required
            />
            <input
              aria-label={`Criterion ${index + 1} given`}
              value={row.given}
              onChange={(event) => {
                const next = draft.criteria.slice()
                next[index] = { ...row, given: event.target.value }
                setDraft({ ...draft, criteria: next })
              }}
              required
            />
            <input
              aria-label={`Criterion ${index + 1} when`}
              value={row.when}
              onChange={(event) => {
                const next = draft.criteria.slice()
                next[index] = { ...row, when: event.target.value }
                setDraft({ ...draft, criteria: next })
              }}
              required
            />
            <input
              aria-label={`Criterion ${index + 1} then`}
              value={row.then}
              onChange={(event) => {
                const next = draft.criteria.slice()
                next[index] = { ...row, then: event.target.value }
                setDraft({ ...draft, criteria: next })
              }}
              required
            />
            <button
              type="button"
              className="hc-icon-btn"
              aria-label={`Remove criterion ${index + 1}`}
              disabled={draft.criteria.length === 1}
              onClick={() => setDraft({ ...draft, criteria: draft.criteria.filter((_, at) => at !== index) })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="hc-btn"
          onClick={() =>
            setDraft({
              ...draft,
              criteria: [...draft.criteria, { id: `ac${draft.criteria.length + 1}`, given: '', when: '', then: '' }],
            })
          }
        >
          Add criterion
        </button>
      </fieldset>
      <div className="hc-field hc-field-row">
        <label htmlFor="hc-edit-rank">Rank</label>
        <input
          id="hc-edit-rank"
          type="number"
          min={0}
          step={1}
          value={draft.rank}
          onChange={(event) => setDraft({ ...draft, rank: Number(event.target.value) })}
        />
        <label htmlFor="hc-edit-recheck">Recheck (days)</label>
        <input
          id="hc-edit-recheck"
          type="number"
          min={1}
          step={1}
          value={draft.recheckDays ?? ''}
          placeholder="never"
          onChange={(event) =>
            setDraft({ ...draft, recheckDays: event.target.value.trim() === '' ? null : Number(event.target.value) })
          }
        />
      </div>
      <div className="hc-field">
        <label htmlFor="hc-edit-depends">Depends on (comma-separated keys)</label>
        <input
          id="hc-edit-depends"
          value={draft.dependsOn.join(', ')}
          onChange={(event) =>
            setDraft({
              ...draft,
              dependsOn: event.target.value
                .split(',')
                .map((part) => part.trim())
                .filter((part) => part !== ''),
            })
          }
        />
      </div>
      <div className="hc-row-actions">
        <span className="hc-hint">
          Proposes v{outcome.version + 1} (based on v{outcome.version})
        </span>
        <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
          {busy ? 'Proposing…' : 'Propose change'}
        </button>
        <button type="button" className="hc-btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

interface CommentThreadProps {
  comment: Comment
  replies: Comment[]
  act: (action: Action) => Promise<void>
  onError: (message: string) => void
}

function CommentNode({ comment, replies, act, onError }: CommentThreadProps): JSX.Element {
  const [answering, setAnswering] = useState(false)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (action: Action): Promise<void> => {
    setBusy(true)
    try {
      await act(action)
      setReplying(false)
      setReply('')
    } catch (thrown) {
      onError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
      setAnswering(false)
    }
  }

  return (
    <li className={`hc-comment${comment.answer !== null ? ' is-answered' : ''}`}>
      <div className="hc-comment-body">
        <p className="hc-comment-text">{comment.text}</p>
        <p className="hc-hint">
          {formatWhen(parseTime(comment.created))}
          {comment.planVersion ? ` · plan v${comment.planVersion}` : ''}
          {comment.actor ? ` · ${comment.actor}${comment.via ? ` (${comment.via})` : ''}` : ''}
          {comment.answer !== null ? ` · answered: ${comment.answer}` : ''}
        </p>
        {comment.options.length > 0 ? (
          <div className="hc-row-actions" role="group" aria-label="Answer with an option">
            {comment.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`hc-chip${comment.answer === option ? ' is-active' : ''}`}
                aria-pressed={comment.answer === option}
                disabled={busy || comment.answer !== null}
                onClick={() => void run({ op: 'answer', id: comment.id, answer: option })}
              >
                {option}
              </button>
            ))}
            {comment.answer === null ? (
              <button type="button" className="hc-link" onClick={() => setAnswering(!answering)}>
                {answering ? 'Cancel' : 'Answer in my own words'}
              </button>
            ) : null}
          </div>
        ) : null}
        {answering && comment.answer === null ? (
          <form
            className="hc-inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              const value = new FormData(event.currentTarget).get('answer')
              if (typeof value === 'string' && value.trim() !== '') {
                void run({ op: 'answer', id: comment.id, answer: value.trim() })
              }
            }}
          >
            <input name="answer" aria-label="Your answer" placeholder="Your answer" required />
            <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
              Answer
            </button>
          </form>
        ) : null}
        {replying ? (
          <form
            className="hc-inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (reply.trim() === '') return
              void run({ op: 'comment', key: comment.key, text: reply.trim(), options: [], parentId: comment.id })
            }}
          >
            <input value={reply} onChange={(event) => setReply(event.target.value)} aria-label="Reply" placeholder="Reply" required />
            <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
              Reply
            </button>
          </form>
        ) : (
          <button type="button" className="hc-link" onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
      </div>
      {replies.length > 0 ? (
        <ul className="hc-comment-children">
          {replies.map((child) => (
            <CommentNode
              key={child.id}
              comment={child}
              replies={replies.filter((row) => row.parentId === child.id)}
              act={act}
              onError={onError}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

type DrawerTab = 'contract' | 'evidence' | 'live' | 'plan'

const TABS: Array<{ id: DrawerTab; label: string }> = [
  { id: 'contract', label: 'Overview' },
  { id: 'evidence', label: 'Proof' },
  { id: 'live', label: 'Climb' },
  { id: 'plan', label: 'Plan & Notes' },
]

function extractLocalPath(raw: string): string | null {
  const match = raw.match(/(?:^|[\s(:`])((?:\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/)
  if (!match?.[1]) return null
  const candidate = match[1]
  if (/^https?:\/\//i.test(candidate)) return null
  return candidate
}

function buildOutcomeContextMarkdown(
  outcome: Outcome | undefined,
  goal: Goal | undefined,
  signal: string,
  track: string,
  evidence: Evidence[],
  plans: Plan[],
): string {
  if (outcome) {
    const lines = [
      `Hill Climb Outcome: ${outcome.key} — ${outcome.title}`,
      `Status: ${signal} | Version: v${outcome.version} | Track: ${track}${outcome.availability && outcome.availability !== 'active' ? ` | Availability: ${outcome.availability}` : ''}`,
      '',
      `Story: ${outcome.story}`,
      '',
      'Acceptance criteria:',
      ...outcome.criteria.map((c) => `- ${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}.`),
    ]
    if (plans[0]) {
      lines.push('', `Latest plan (v${plans[0].version}):`, plans[0].body.slice(0, 1200))
    }
    if (evidence.length > 0) {
      lines.push(
        '',
        'Recent proof:',
        ...evidence.slice(0, 4).map((e) => `- [${e.kind}] (${e.source}): ${e.text.slice(0, 300)}`),
      )
    }
    return lines.join('\n')
  }
  if (goal) {
    return [`Hill Climb Goal: ${goal.key} — ${goal.title}`, `Brief: ${goal.brief}`].join('\n')
  }
  return ''
}

export function OutcomeDrawer(props: ViewProps): JSX.Element | null {
  const { data, track, selected, select, act, dispatch, live, projectDirectory, attachedContextId, onAttachContext, onOpenFile } = props
  const outcome = useMemo(
    () => (selected === null ? undefined : data.outcomes.find((row) => row.key === selected)),
    [data.outcomes, selected],
  )
  const goal = useMemo(
    () => (selected === null ? undefined : data.goals.find((row) => row.key === selected)),
    [data.goals, selected],
  )
  const ranked = useMemo(
    () => (selected === null ? undefined : data.ranked.find((row) => row.key === selected)),
    [data.ranked, selected],
  )

  const [tab, setTab] = useState<DrawerTab>('contract')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [liveData, setLiveData] = useState<LiveData | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [engine, setEngine] = useState<'repo' | 'search'>('repo')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchNote, setDispatchNote] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [configureError, setConfigureError] = useState<string | null>(null)
  const [planDraft, setPlanDraft] = useState('')
  const isOutcome = data.outcomes.some((row) => row.key === selected)
  const [reply, setReply] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [availMode, setAvailMode] = useState<OutcomeAvailability>('active')
  const [availReason, setAvailReason] = useState('')
  const [availUntil, setAvailUntil] = useState('')
  const [editingGoal, setEditingGoal] = useState(false)
  const [goalTitle, setGoalTitle] = useState('')
  const [goalBrief, setGoalBrief] = useState('')
  const [goalRank, setGoalRank] = useState('100')
  const [goalParent, setGoalParent] = useState('')
  const [diffPlanVersion, setDiffPlanVersion] = useState<number | null>(null)
  const [planCommentVersion, setPlanCommentVersion] = useState<number | null>(null)
  const [planCommentText, setPlanCommentText] = useState('')

  const liveRef = useRef(live)
  liveRef.current = live
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  useEffect(() => {
    setError(null)
    setEditing(false)
    setEditingGoal(false)
    setTab('contract')
    setDispatchNote(null)
    setDiffPlanVersion(null)
    setPlanCommentVersion(null)
    setPlanCommentText('')
  }, [selected])

  useEffect(() => {
    if (outcome) {
      setAvailMode(outcome.availability ?? 'active')
      setAvailReason(outcome.availabilityReason ?? '')
      setAvailUntil(outcome.deferredUntil ? outcome.deferredUntil.slice(0, 10) : '')
    }
  }, [outcome])

  useEffect(() => {
    if (goal) {
      setGoalTitle(goal.title)
      setGoalBrief(goal.brief)
      setGoalRank(String(goal.rank))
      setGoalParent(goal.parentGoalKey ?? '')
    }
  }, [goal])

  const loadLive = useCallback(async (key: string): Promise<void> => {
    setLiveLoading(true)
    try {
      const next = await liveRef.current(key)
      setLiveData(next)
      setLiveError(null)
      if (next.engine !== null) setEngine(next.engine)
    } catch (thrown) {
      setLiveError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setLiveLoading(false)
    }
  }, [])

  // Read live data once when the selected outcome or track changes (never on unrelated tab switches).
  useEffect(() => {
    if (isOutcome === false || selected === null) {
      setLiveData(null)
      setLiveError(null)
      setLiveLoading(false)
      return
    }
    let alive = true
    setLiveLoading(true)
    void liveRef.current(selected)
      .then((next) => {
        if (!alive) return
        setLiveData(next)
        setLiveError(null)
        if (next.engine !== null) setEngine(next.engine)
      })
      .catch((thrown) => {
        if (!alive) return
        setLiveError(thrown instanceof Error ? thrown.message : String(thrown))
      })
      .finally(() => {
        if (alive) setLiveLoading(false)
      })
    return () => {
      alive = false
    }
  }, [isOutcome, selected, track])

  // Poll quietly only while the Live tab is actively on screen.
  useEffect(() => {
    if (isOutcome === false || selected === null || tab !== 'live') return
    let alive = true
    const timer = window.setInterval(() => {
      void liveRef.current(selected)
        .then((next) => {
          if (!alive) return
          setLiveData(next)
          setLiveError(null)
          if (next.engine !== null) setEngine(next.engine)
        })
        .catch((thrown) => {
          if (!alive) return
          setLiveError(thrown instanceof Error ? thrown.message : String(thrown))
        })
    }, LIVE_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [isOutcome, selected, tab, track])

  const evidenceOnKey = useMemo(
    () => (selected === null ? [] : data.evidence.filter((row) => row.key === selected)),
    [data.evidence, selected],
  )
  // The drawer is a view of one track: its evidence, its output and its live
  // climb. Evidence recorded on another track is counted, never silently lost.
  const evidence = useMemo(
    () => evidenceOnKey.filter((row) => row.track === track).slice().sort((a, b) => parseTime(b.created) - parseTime(a.created)),
    [evidenceOnKey, track],
  )
  const evidenceElsewhere = evidenceOnKey.length - evidence.length
  const changes = useMemo(
    () => (selected === null ? [] : data.changes.filter((row) => row.key === selected).slice().sort((a, b) => parseTime(b.created) - parseTime(a.created))),
    [data.changes, selected],
  )
  const plans = useMemo(
    () => (selected === null ? [] : data.plans.filter((row) => row.key === selected).slice().sort((a, b) => b.version - a.version)),
    [data.plans, selected],
  )
  const comments = useMemo(
    () => (selected === null ? [] : data.comments.filter((row) => row.key === selected).slice().sort((a, b) => parseTime(a.created) - parseTime(b.created))),
    [data.comments, selected],
  )
  const childGoals = useMemo(
    () => (selected === null ? [] : data.goals.filter((row) => row.parentGoalKey === selected).slice().sort((a, b) => a.rank - b.rank)),
    [data.goals, selected],
  )
  const goalOutcomes = useMemo(
    () => (selected === null ? [] : data.outcomes.filter((row) => row.goalKey === selected).slice().sort(sortOutcomes)),
    [data.outcomes, selected],
  )
  const linkedFlows = useMemo(
    () =>
      selected === null
        ? []
        : data.flows
            .map((flow) => ({
              flow,
              frames: flow.frames.filter((f) => f.key === selected),
            }))
            .filter((entry) => entry.frames.length > 0),
    [data.flows, selected],
  )
  const linkedFlowProposals = useMemo(
    () =>
      selected === null
        ? []
        : (data.flowProposals ?? []).filter(
            (p) =>
              p.state === 'pending' &&
              (p.frame?.key === selected || (p.frames ?? []).some((f) => f.key === selected)),
          ),
    [data.flowProposals, selected],
  )

  if (selected === null) return null

  const current: Contract | null = outcome !== undefined ? contractOf(outcome) : null
  const pending = changes.filter((row) => row.state === 'pending')
  const signal = ranked?.signal ?? (selected === null ? 'unverified' : signalOf(data.ranked, selected))
  const ancestors = ranked?.ancestors ?? []
  const claim = ranked?.claim ?? null
  const title = outcome?.title ?? goal?.title ?? selected
  const version = outcome?.version ?? null
  const evidenceText = outcome !== undefined ? evidenceOutput(evidence, outcome) : ''

  const run = async (action: Action, clear?: () => void): Promise<void> => {
    setError(null)
    try {
      await act(action)
      clear?.()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    }
  }

  // The host owns the editor dialog; this view only asks for it.
  const configure = props.configure

  const doConfigure = async (): Promise<void> => {
    if (configure === undefined || outcome === undefined) return
    setConfiguring(true)
    setConfigureError(null)
    setDispatchNote(null)
    try {
      await configure(outcome.key, engine)
      setDispatchNote(`Verifier for ${outcome.key} saved. Dispatch when ready.`)
      await loadLive(outcome.key)
    } catch (thrown) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      if (msg !== 'cancelled') {
        setConfigureError(msg)
      }
    } finally {
      setConfiguring(false)
    }
  }

  const doDispatch = async (): Promise<void> => {
    if (outcome === undefined) return
    setDispatching(true)
    setDispatchNote(null)
    setError(null)
    try {
      await dispatchRef.current(outcome.key, engine)
      setDispatchNote(`Dispatched to the ${engine} engine.`)
      await loadLive(outcome.key)
    } catch (thrown) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      if (msg !== 'cancelled') {
        setError(msg)
      }
    } finally {
      setDispatching(false)
    }
  }

  const switchTab = (next: DrawerTab): void => {
    setError(null)
    setTab(next)
  }

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = TABS.findIndex((row) => row.id === tab)
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      switchTab(TABS[(index + 1) % TABS.length]?.id ?? 'contract')
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      switchTab(TABS[(index - 1 + TABS.length) % TABS.length]?.id ?? 'contract')
    }
  }

  return (
    <section
      className="hc-drawer"
      aria-label={`${outcome === undefined ? 'Goal' : 'Outcome'} ${selected}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        const tag = (event.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        event.stopPropagation()
        select(null)
      }}
    >
      <header className="hc-drawer-head">
        <div className="hc-drawer-title">
          <p className="hc-crumbs" aria-label="Ancestors">
            {ancestors.map((ancestor: Goal) => (
              <span key={ancestor.key}>
                <button type="button" className="hc-link" onClick={() => select(ancestor.key)}>
                  {ancestor.title}
                </button>
                <span aria-hidden="true"> / </span>
              </span>
            ))}
            <code>{selected}</code>
          </p>
          <h2>{title}</h2>
          <p className="hc-drawer-meta">
            {outcome !== undefined ? (
              <span className={`hc-badge hc-signal-${signal}`}>{signal}</span>
            ) : (
              <span className="hc-chip">goal</span>
            )}
            {version !== null ? <span>v{version}</span> : null}
            {ranked !== undefined ? (
              <span>#{data.ranked.findIndex((row) => row.key === selected) + 1}</span>
            ) : null}
            {outcome && (outcome.availability ?? 'active') !== 'active' ? (
              <span className="hc-chip hc-chip-warn">
                {outcome.availability}
                {outcome.deferredUntil ? ` until ${outcome.deferredUntil.slice(0, 10)}` : ''}
              </span>
            ) : null}
            {claim !== null ? (
              <span className="hc-claim">
                claimed · <code>{claim.threadId}</code>
              </span>
            ) : null}
            {pending.length > 0 ? <span className="hc-chip hc-chip-warn">{pending.length} pending review</span> : null}
          </p>
        </div>
        <div className="hc-drawer-actions">
          {onAttachContext ? (
            <button
              type="button"
              className={`hc-btn hc-attach-btn${attachedContextId === `item:${selected}` ? ' is-attached' : ''}`}
              aria-pressed={attachedContextId === `item:${selected}`}
              title="Attach this item as context for your next chat message"
              onClick={() => {
                const md = buildOutcomeContextMarkdown(outcome, goal, signal, track, evidence, plans)
                void onAttachContext(`item:${selected}`, selected, md)
              }}
            >
              {attachedContextId === `item:${selected}` ? 'Attached ✓' : 'Attach to chat'}
            </button>
          ) : null}
          <button type="button" className="hc-icon-btn" onClick={() => select(null)} aria-label="Close the drawer">
            ×
          </button>
        </div>
      </header>

      {error !== null ? (
        <p className="hc-error hc-drawer-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="hc-tabs" role="tablist" aria-label="Sections" onKeyDown={onTabKey}>
        {TABS.map((row) => {
          const badgeCount =
            row.id === 'evidence'
              ? evidence.length
              : row.id === 'plan'
                ? plans.length + comments.length
                : 0
          return (
            <button
              key={row.id}
              type="button"
              role="tab"
              aria-label={row.label}
              id={`hc-tab-${row.id}`}
              aria-selected={tab === row.id}
              aria-controls={`hc-panel-${row.id}`}
              tabIndex={tab === row.id ? 0 : -1}
              className={tab === row.id ? 'hc-tab is-active' : 'hc-tab'}
              onClick={() => switchTab(row.id)}
            >
              {row.label}
              {badgeCount > 0 ? <span className="hc-tab-count">{badgeCount}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="hc-drawer-body">
        {tab === 'contract' ? (
          <div role="tabpanel" id="hc-panel-contract" aria-labelledby="hc-tab-contract" className="hc-panel">
            {outcome !== undefined && current !== null ? (
              <>
                <section className="hc-section" aria-label="Acceptance checks">
                  <header className="hc-section-head">
                    <h3>Acceptance checks</h3>
                    <div className="hc-inline-group">
                      {props.onSendToChat ? (
                        <button
                          type="button"
                          className="hc-btn"
                          title="Ask the agent in chat to pull repo UI components and propose a visual mockup inline"
                          onClick={() => {
                            const prompt = `Design a visual screen flow for Hill Climb outcome ${outcome.key} (${outcome.title}). First call hillclimb_design(mode="kit") to inspect our repo's UI components and CSS tokens, then propose an interactive mockup inline with hillclimb_design(mode="propose") so I can draw visual feedback and accept or revise it right in this thread.`
                            void props.onSendToChat?.(prompt)
                          }}
                        >
                          Design screen
                        </button>
                      ) : null}
                      <button type="button" className="hc-btn" onClick={() => setEditing(!editing)} aria-expanded={editing}>
                        {editing ? 'Cancel edit' : 'Propose edit'}
                      </button>
                    </div>
                  </header>
                  <p className="hc-story">{outcome.story}</p>
                  <ol className="hc-criteria-clean">
                    {outcome.criteria.map((row) => (
                      <li key={row.id}>
                        <code className="hc-criterion-key">{row.id}</code>
                        <div className="hc-criteria-line">
                          <span className="hc-criteria-kw">Given</span>
                          <span>{row.given}</span>
                        </div>
                        <div className="hc-criteria-line">
                          <span className="hc-criteria-kw">When</span>
                          <span>{row.when}</span>
                        </div>
                        <div className="hc-criteria-line">
                          <span className="hc-criteria-kw">Then</span>
                          <span>{row.then}</span>
                        </div>
                      </li>
                    ))}
                  </ol>

                  {editing ? (
                    <EditProposal outcome={outcome} act={act} onError={setError} onDone={() => setEditing(false)} />
                  ) : null}

                  <details className="hc-disclosure-box">
                    <summary>
                      <span>Status, tags &amp; settings</span>
                      <span className="hc-hint">
                        {outcome.availability && outcome.availability !== 'active' ? outcome.availability : 'active'}
                        {(outcome.tags ?? []).length > 0
                          ? ` · ${(outcome.tags ?? []).length} tag${(outcome.tags ?? []).length === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </summary>
                    <div className="hc-meta-editor">
                      <p className="hc-hint" style={{ margin: 0 }}>
                        rank {outcome.rank}
                        {ranked?.sectionNumber ? ` · §${ranked.sectionNumber}` : ''}
                        {' · '}
                        {outcome.dependsOn.length > 0 ? `depends on ${outcome.dependsOn.join(', ')}` : 'no dependencies'}
                        {' · '}
                        {outcome.recheckDays === null ? 'no recheck' : `recheck every ${outcome.recheckDays}d`}
                      </p>
                      <div className="hc-meta-row">
                        <label htmlFor="hc-avail-select" className="hc-meta-label">
                          Status
                        </label>
                        <select
                          id="hc-avail-select"
                          className="hc-mini-select"
                          value={availMode}
                          onChange={(e) => setAvailMode(e.target.value as OutcomeAvailability)}
                        >
                          <option value="active">Active (eligible for next)</option>
                          <option value="blocked">Paused (blocked manually)</option>
                          <option value="deferred">Deferred (snoozed)</option>
                        </select>
                        {availMode !== 'active' ? (
                          <input
                            className="hc-mini-input"
                            value={availReason}
                            onChange={(e) => setAvailReason(e.target.value)}
                            placeholder="Reason (optional)"
                            aria-label="Availability reason"
                          />
                        ) : null}
                        {availMode === 'deferred' ? (
                          <input
                            type="date"
                            className="hc-mini-input"
                            value={availUntil}
                            onChange={(e) => setAvailUntil(e.target.value)}
                            aria-label="Deferred until date"
                          />
                        ) : null}
                        <button
                          type="button"
                          className="hc-btn"
                          onClick={() =>
                            void run({
                              op: 'set_outcome_availability',
                              key: outcome.key,
                              availability: availMode,
                              reason: availMode === 'active' ? null : availReason.trim() || null,
                              deferredUntil: availMode === 'deferred' && availUntil ? `${availUntil}T00:00:00Z` : null,
                            })
                          }
                        >
                          Apply
                        </button>
                      </div>

                      <div className="hc-meta-row">
                        <span className="hc-meta-label">Tags</span>
                        <div className="hc-chips">
                          {(outcome.tags ?? []).map((t) => (
                            <span key={t} className="hc-chip hc-tag-chip">
                              #{t}{' '}
                              <button
                                type="button"
                                className="hc-saved-view-del"
                                aria-label={`Remove tag ${t}`}
                                onClick={() =>
                                  void run({
                                    op: 'set_tags',
                                    key: outcome.key,
                                    tags: (outcome.tags ?? []).filter((x) => x !== t),
                                  })
                                }
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <form
                            className="hc-inline-group"
                            onSubmit={(e) => {
                              e.preventDefault()
                              const nextTag = tagDraft.trim().toLowerCase().replace(/^#+/, '')
                              if (!nextTag) return
                              const merged = [...new Set([...(outcome.tags ?? []), nextTag])]
                              void run({ op: 'set_tags', key: outcome.key, tags: merged }, () => setTagDraft(''))
                            }}
                          >
                            <input
                              className="hc-mini-input"
                              style={{ width: 96 }}
                              value={tagDraft}
                              onChange={(e) => setTagDraft(e.target.value)}
                              placeholder="+ tag"
                              aria-label="Add tag"
                            />
                            <button type="submit" className="hc-btn">
                              Add
                            </button>
                          </form>
                        </div>
                      </div>
                    </div>
                  </details>
                </section>

                {linkedFlows.length > 0 || linkedFlowProposals.length > 0 ? (
                  <section className="hc-section" aria-label="Linked flows">
                    <header className="hc-section-head">
                      <h3>Linked Flows</h3>
                      <span className="hc-hint">
                        {linkedFlows.length} flow{linkedFlows.length === 1 ? '' : 's'}
                        {linkedFlowProposals.length > 0 ? ` · ${linkedFlowProposals.length} pending` : ''}
                      </span>
                    </header>
                    <ul className="hc-key-list">
                      {linkedFlows.map(({ flow, frames }) => (
                        <li key={flow.name}>
                          <button
                            type="button"
                            className="hc-link"
                            onClick={() => props.onOpenFlow?.(flow.name)}
                          >
                            {flow.folder ? `${flow.folder} / ` : ''}
                            <strong>{flow.name}</strong>
                          </button>
                          <span className="hc-hint">
                            {frames.length} frame{frames.length === 1 ? '' : 's'} ·{' '}
                            {frames.reduce((s, f) => s + f.pins.filter((p) => !p.resolved).length, 0)} open pin(s)
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {changes.length > 0 ? (
                  <section className="hc-section" aria-label="Proposals">
                    <header className="hc-section-head">
                      <h3>Proposed changes</h3>
                      <span className="hc-hint">{pending.length} pending</span>
                    </header>
                    {changes.map((change) => (
                      <ChangeCard key={change.id} change={change} current={current} act={act} onError={setError} />
                    ))}
                  </section>
                ) : null}
              </>
            ) : null}

            {goal !== undefined ? (
              <section className="hc-section" aria-label="Goal">
                <header className="hc-section-head">
                  <h3>Brief</h3>
                  <button type="button" className="hc-btn" onClick={() => setEditingGoal((v) => !v)}>
                    {editingGoal ? 'Cancel edit' : 'Edit goal'}
                  </button>
                </header>
                <p className="hc-story">{goal.brief}</p>
                {editingGoal ? (
                  <form
                    className="hc-edit"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const rankNum = Number(goalRank)
                      void run(
                        {
                          op: 'update_goal',
                          key: goal.key,
                          title: goalTitle.trim(),
                          brief: goalBrief.trim(),
                          rank: Number.isInteger(rankNum) && rankNum >= 0 ? rankNum : goal.rank,
                          parentGoalKey: goalParent === '' ? null : goalParent,
                        },
                        () => setEditingGoal(false),
                      )
                    }}
                  >
                    <div className="hc-field">
                      <label htmlFor="hc-goal-edit-title">Title</label>
                      <input id="hc-goal-edit-title" value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} required />
                    </div>
                    <div className="hc-field">
                      <label htmlFor="hc-goal-edit-brief">Brief</label>
                      <textarea id="hc-goal-edit-brief" rows={2} value={goalBrief} onChange={(e) => setGoalBrief(e.target.value)} required />
                    </div>
                    <div className="hc-field hc-field-row">
                      <label htmlFor="hc-goal-edit-rank">Rank</label>
                      <input id="hc-goal-edit-rank" type="number" min={0} value={goalRank} onChange={(e) => setGoalRank(e.target.value)} />
                      <label htmlFor="hc-goal-edit-parent">Parent</label>
                      <select id="hc-goal-edit-parent" value={goalParent} onChange={(e) => setGoalParent(e.target.value)}>
                        <option value="">None (root)</option>
                        {data.goals
                          .filter((g) => g.key !== goal.key)
                          .map((g) => (
                            <option key={g.key} value={g.key}>
                              {g.key} · {g.title}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="hc-row-actions">
                      <button type="submit" className="hc-btn hc-btn-primary">
                        Save goal
                      </button>
                      <button type="button" className="hc-btn" onClick={() => setEditingGoal(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                <details className="hc-disclosure-box">
                  <summary>
                    <span>Tags &amp; settings</span>
                    <span className="hc-hint">
                      rank {goal.rank}
                      {(goal.tags ?? []).length > 0 ? ` · ${(goal.tags ?? []).length} tag${(goal.tags ?? []).length === 1 ? '' : 's'}` : ''}
                    </span>
                  </summary>
                  <div className="hc-meta-editor">
                    <p className="hc-hint" style={{ margin: 0 }}>
                      rank {goal.rank} · parent {goal.parentGoalKey === null ? 'none (root)' : goal.parentGoalKey}
                    </p>
                    <div className="hc-meta-row">
                      <span className="hc-meta-label">Tags</span>
                      <div className="hc-chips">
                        {(goal.tags ?? []).map((t) => (
                          <span key={t} className="hc-chip hc-tag-chip">
                            #{t}{' '}
                            <button
                              type="button"
                              className="hc-saved-view-del"
                              aria-label={`Remove tag ${t}`}
                              onClick={() =>
                                void run({ op: 'set_tags', key: goal.key, tags: (goal.tags ?? []).filter((x) => x !== t) })
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <form
                          className="hc-inline-group"
                          onSubmit={(e) => {
                            e.preventDefault()
                            const nextTag = tagDraft.trim().toLowerCase().replace(/^#+/, '')
                            if (!nextTag) return
                            void run({ op: 'set_tags', key: goal.key, tags: [...new Set([...(goal.tags ?? []), nextTag])] }, () =>
                              setTagDraft(''),
                            )
                          }}
                        >
                          <input
                            className="hc-mini-input"
                            style={{ width: 96 }}
                            value={tagDraft}
                            onChange={(e) => setTagDraft(e.target.value)}
                            placeholder="+ tag"
                            aria-label="Add goal tag"
                          />
                          <button type="submit" className="hc-btn">
                            Add
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                </details>

                {childGoals.length > 0 ? (
                  <>
                    <h4>Sub-goals</h4>
                    <ul className="hc-key-list">
                      {childGoals.map((kid) => (
                        <li key={kid.key}>
                          <button type="button" className="hc-link" onClick={() => select(kid.key)}>
                            <code>{kid.key}</code> {kid.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h4>Outcomes</h4>
                {goalOutcomes.length === 0 ? (
                  <p className="hc-empty-note">No outcomes under this goal yet.</p>
                ) : (
                  <ul className="hc-key-list">
                    {goalOutcomes.map((row) => (
                      <li key={row.key}>
                        <button type="button" className="hc-link" onClick={() => select(row.key)}>
                          <code>{row.key}</code> {row.title}
                        </button>
                        <span className={`hc-badge hc-signal-${signalOf(data.ranked, row.key)}`}>{signalOf(data.ranked, row.key)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === 'live' && outcome !== undefined ? (
          <div role="tabpanel" id="hc-panel-live" aria-labelledby="hc-tab-live" className="hc-panel">
            <section className="hc-section" aria-label="Automated climb">
              <header className="hc-section-head">
                <h3>Automated climb</h3>
                <button type="button" className="hc-btn" onClick={() => void loadLive(outcome.key)} disabled={liveLoading}>
                  {liveLoading ? 'Reading…' : 'Refresh'}
                </button>
              </header>
              <div className="hc-row-actions" role="group" aria-label="Engine">
                {(['repo', 'search'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`hc-chip${engine === option ? ' is-active' : ''}`}
                    aria-pressed={engine === option}
                    onClick={() => setEngine(option)}
                  >
                    {option}
                  </button>
                ))}
                {configure === undefined ? null : (
                  <button type="button" className="hc-btn" onClick={() => void doConfigure()} disabled={configuring}>
                    {configuring ? 'Opening…' : 'Verifier'}
                  </button>
                )}
                <button type="button" className="hc-btn hc-btn-primary" onClick={() => void doDispatch()} disabled={dispatching}>
                  {dispatching ? 'Starting…' : 'Start climb'}
                </button>
                {liveData?.engine !== null && liveData?.engine !== undefined ? (
                  <span className="hc-hint">
                    {liveData.worker?.liveness === 'active'
                      ? `running (${liveData.engine})`
                      : `${liveData.engine} · ${liveData.worker?.phase ?? 'idle'}`}
                  </span>
                ) : null}
              </div>
              {liveData !== null && liveData.baseline === null ? (
                <p className="hc-hint">No verifier has scored this outcome yet. Set up a verifier before starting a climb.</p>
              ) : null}
              {configureError === null ? null : (
                <p className="hc-error" role="alert">
                  Could not open the verifier editor: {configureError}
                </p>
              )}
              {dispatchNote !== null ? (
                <p className="hc-hint" role="status">
                  {dispatchNote}
                </p>
              ) : null}
              {liveError !== null ? (
                <p className="hc-error" role="alert">
                  {liveError}
                </p>
              ) : null}
            </section>

            {liveData === null ? (
              <p className="hc-empty-note">{liveLoading ? 'Reading the climb…' : 'No climb data yet for this outcome.'}</p>
            ) : (
              <>
                <section className="hc-section" aria-label="Scores">
                  <header className="hc-section-head">
                    <h3>Score</h3>
                    <span className={`hc-badge hc-verdict-${verdictOf(liveData).kind}`}>{verdictOf(liveData).label}</span>
                  </header>
                  <p className="hc-hint" style={{ margin: 0 }}>
                    {formatScore(liveData.baseline)} → {formatScore(liveData.best)}
                    {liveData.target === null ? '' : ` · target ${formatScore(liveData.target)}`}
                  </p>
                  <LiveChart live={liveData} />
                  {liveData.holdout !== null ? (
                    <p className="hc-hint">
                      Holdout score: <code>{liveData.holdout}</code>
                    </p>
                  ) : null}
                </section>

                {liveData.engine === 'search' || (liveData.elite && liveData.elite.length > 0) ? (
                  <section className="hc-section" aria-label="MAP-Elites grid">
                    <h3>Feature grid</h3>
                    <EliteGrid live={liveData} />
                  </section>
                ) : null}

                <details className="hc-disclosure-box">
                  <summary>
                    <span>Technical details &amp; step log</span>
                    <span className="hc-hint">
                      {liveData.rows.length} step{liveData.rows.length === 1 ? '' : 's'}
                    </span>
                  </summary>
                  <div className="hc-panel" style={{ gap: 14 }}>
                    <dl className="hc-progress">
                      {progressLines(liveData).map((line) => (
                        <div key={line.label}>
                          <dt>{line.label}</dt>
                          <dd>{line.detail}</dd>
                        </div>
                      ))}
                    </dl>

                    {liveData.rows.length > 0 ? (
                      <>
                        <div>
                          <h4 style={{ margin: '0 0 6px', fontSize: 12.5 }}>Candidates</h4>
                          {liveData.search !== null && liveData.search !== undefined && liveData.search.count > 1 ? (
                            <p className="hc-hint">
                              Showing <code>{liveData.search.id}</code> ({liveData.search.count} searches in run).
                            </p>
                          ) : null}
                          <LineageGraph live={liveData} />
                        </div>

                        <div>
                          <h4 style={{ margin: '0 0 6px', fontSize: 12.5 }}>Step log</h4>
                          <ol className="hc-stream">
                            {liveData.rows
                              .slice()
                              .sort((a, b) => parseTime(a.at) - parseTime(b.at))
                              .map((row) => {
                                const best = liveData.best !== null && row.score === liveData.best
                                return (
                                  <li key={row.id} className={best ? 'hc-stream-row is-best' : 'hc-stream-row'}>
                                    <span className="hc-stream-when">{formatWhen(parseTime(row.at))}</span>
                                    <code className="hc-stream-id">{row.id}</code>
                                    <span className="hc-stream-label">{row.label}</span>
                                    <span className="hc-stream-score">{formatScore(row.score)}</span>
                                    <span className="hc-stream-parent">{row.parent === null ? 'root' : `← ${row.parent}`}</span>
                                  </li>
                                )
                              })}
                          </ol>
                        </div>
                      </>
                    ) : null}
                  </div>
                </details>
              </>
            )}
          </div>
        ) : null}

        {tab === 'live' && outcome === undefined ? (
          <div role="tabpanel" id="hc-panel-live" aria-labelledby="hc-tab-live" className="hc-panel">
            <p className="hc-empty-note">Select an outcome under this goal to view or start an automated climb.</p>
          </div>
        ) : null}

        {tab === 'evidence' && selected !== null ? (
          <div role="tabpanel" id="hc-panel-evidence" aria-labelledby="hc-tab-evidence" className="hc-panel">
            <section className="hc-section" aria-label="Evidence list">
              <header className="hc-section-head">
                <h3>Recorded proof ({evidence.length})</h3>
                <span className="hc-hint">track {track}</span>
              </header>
              {evidenceElsewhere > 0 ? (
                <p className="hc-hint" role="status">
                  {evidenceElsewhere} more recorded on another track.
                </p>
              ) : null}
              {evidence.length === 0 ? (
                <p className="hc-empty-note">
                  {evidenceElsewhere > 0
                    ? `No proof recorded on track ${track} yet.`
                    : 'No proof recorded yet. Record test output or verification notes below.'}
                </p>
              ) : (
                <ul className="hc-evidence">
                  {evidence.map((row) => (
                    <li key={row.id} className={`hc-evidence-row hc-kind-${row.kind}`}>
                      <div className="hc-evidence-head">
                        <span className={`hc-badge hc-kind-${row.kind}`}>{row.kind}</span>
                        <code>v{row.version}</code>
                        <span className="hc-hint">{formatWhen(parseTime(row.created))}</span>
                        {row.criterionIds.map((id) => (
                          <span key={id} className="hc-chip">
                            {id}
                          </span>
                        ))}
                      </div>
                      <p>{row.text}</p>
                      <p className="hc-hint">
                        {row.source}
                        {row.actor ? ` · ${row.actor}${row.via ? ` (${row.via})` : ''}` : ''}
                        {(() => {
                          if (!onOpenFile) return null
                          const detected = extractLocalPath(row.source) ?? extractLocalPath(row.text)
                          if (!detected || (!detected.startsWith('/') && !projectDirectory)) return null
                          return (
                            <>
                              {' · '}
                              <button
                                type="button"
                                className="hc-link hc-file-link"
                                onClick={() => void onOpenFile(detected, projectDirectory)}
                              >
                                Open {detected.split('/').pop()} ↗
                              </button>
                            </>
                          )
                        })()}
                      </p>
                      {row.attachments && row.attachments.length > 0 ? (
                        <div className="hc-attachments">
                          {row.attachments.map((att, idx) => {
                            const canOpen =
                              Boolean(onOpenFile) &&
                              !att.path.startsWith('data:') &&
                              (/^https?:\/\//i.test(att.path) || att.path.startsWith('/') || Boolean(projectDirectory))
                            return (
                              <div key={`${row.id}:att:${idx}`} className="hc-attachment-item">
                                {canOpen ? (
                                  <button
                                    type="button"
                                    className="hc-chip hc-file-chip"
                                    title={`Open ${att.path}`}
                                    onClick={() => void onOpenFile?.(att.path, projectDirectory)}
                                  >
                                    📎 {att.label}: <code>{att.path.slice(0, 56)}{att.path.length > 56 ? '…' : ''}</code> ↗
                                  </button>
                                ) : (
                                  <span className="hc-chip" title={att.path}>
                                    📎 {att.label}: <code>{att.path.slice(0, 60)}{att.path.length > 60 ? '…' : ''}</code>
                                  </span>
                                )}
                                {att.path.startsWith('data:image/') ? (
                                  <img src={att.path} alt={att.label} className="hc-attachment-thumb" />
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                      {outcome !== undefined && row.version !== outcome.version ? (
                        <p className="hc-warn">Recorded against an earlier version of this outcome.</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {outcome !== undefined ? (
              <details className="hc-disclosure-box">
                <summary>
                  <span>+ Record proof</span>
                  <span className="hc-hint">confirm, deny, or add note</span>
                </summary>
                <EvidenceForm outcome={outcome} track={track} act={act} onError={setError} />
              </details>
            ) : (
              <p className="hc-empty-note">Proof attaches to an outcome.</p>
            )}

            {outcome !== undefined && evidence.length > 0 ? (
              <details className="hc-disclosure-box">
                <summary>
                  <span>PR summary export</span>
                  <button
                    type="button"
                    className="hc-btn"
                    onClick={(event) => {
                      event.preventDefault()
                      void navigator.clipboard?.writeText(evidenceText).catch(() => setError('The clipboard is not available.'))
                    }}
                  >
                    Copy
                  </button>
                </summary>
                <pre className="hc-output" tabIndex={0} aria-label="Evidence as text">
                  {evidenceText}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {tab === 'plan' && selected !== null ? (
          <div role="tabpanel" id="hc-panel-plan" aria-labelledby="hc-tab-plan" className="hc-panel">
            <section className="hc-section" aria-label="Plans">
              <h3>Plan</h3>
              {plans.length === 0 ? (
                <p className="hc-empty-note">No plan written yet.</p>
              ) : (
                plans.map((plan: Plan, idx) => {
                  const prevPlan = plans[idx + 1]
                  const showingDiff = diffPlanVersion === plan.version && prevPlan !== undefined
                  const diffLines = showingDiff ? computeLineDiff(prevPlan.body, plan.body) : []
                  const planComments = comments.filter((c) => c.planVersion === plan.version)
                  return (
                    <article key={plan.key + plan.version} className="hc-plan">
                      <header className="hc-plan-head">
                        <div className="hc-inline-group">
                          <strong>v{plan.version}</strong>
                          <span className="hc-hint">
                            {formatWhen(parseTime(plan.created))}
                            {plan.actor ? ` · ${plan.actor}${plan.via ? ` (${plan.via})` : ''}` : ''}
                          </span>
                        </div>
                        <div className="hc-inline-group">
                          {prevPlan ? (
                            <button
                              type="button"
                              className={`hc-chip${showingDiff ? ' is-active' : ''}`}
                              onClick={() => setDiffPlanVersion(showingDiff ? null : plan.version)}
                            >
                              {showingDiff ? 'Hide diff' : `Diff vs v${prevPlan.version}`}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="hc-chip"
                            onClick={() =>
                              setPlanCommentVersion(planCommentVersion === plan.version ? null : plan.version)
                            }
                          >
                            Note on v{plan.version}
                            {planComments.length > 0 ? ` (${planComments.length})` : ''}
                          </button>
                        </div>
                      </header>
                      {showingDiff ? (
                        <pre className="hc-plan-diff">
                          {diffLines.map((line, i) => (
                            <div key={i} className={`hc-diff-line hc-diff-line-${line.kind}`}>
                              {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                              {line.text}
                            </div>
                          ))}
                        </pre>
                      ) : (
                        <pre className="hc-plan-body">{plan.body}</pre>
                      )}
                      {planComments.length > 0 ? (
                        <ul className="hc-plan-comments">
                          {planComments.map((c) => (
                            <li key={c.id}>
                              <strong>{c.actor ?? 'note'}:</strong> {c.text}
                              {c.answer ? <span className="hc-hint"> → {c.answer}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {planCommentVersion === plan.version ? (
                        <form
                          className="hc-inline-form"
                          style={{ marginTop: 6 }}
                          onSubmit={(e) => {
                            e.preventDefault()
                            if (!planCommentText.trim()) return
                            void run(
                              {
                                op: 'comment',
                                key: selected,
                                text: planCommentText.trim(),
                                options: [],
                                parentId: null,
                                planVersion: plan.version,
                              },
                              () => {
                                setPlanCommentText('')
                                setPlanCommentVersion(null)
                              },
                            )
                          }}
                        >
                          <input
                            value={planCommentText}
                            onChange={(e) => setPlanCommentText(e.target.value)}
                            placeholder={`Review note on plan v${plan.version}…`}
                            aria-label={`Comment on plan v${plan.version}`}
                            autoFocus
                          />
                          <button type="submit" className="hc-btn hc-btn-primary">
                            Post
                          </button>
                        </form>
                      ) : null}
                    </article>
                  )
                })
              )}
              <details className="hc-disclosure-box" open={plans.length === 0}>
                <summary>
                  <span>{plans.length === 0 ? '+ Write a plan' : '+ Revise plan'}</span>
                </summary>
                <form
                  className="hc-plan-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (planDraft.trim() === '') return
                    const action: Action =
                      plans.length === 0
                        ? { op: 'write_plan', key: selected, body: planDraft.trim() }
                        : { op: 'revise_plan', key: selected, version: plans[0]?.version ?? 1, body: planDraft.trim() }
                    void run(action, () => setPlanDraft(''))
                  }}
                >
                  <label htmlFor="hc-plan-draft" className="hc-sr-only">
                    {plans.length === 0 ? 'Write a plan' : 'Revise the plan'}
                  </label>
                  <textarea
                    id="hc-plan-draft"
                    rows={4}
                    value={planDraft}
                    onChange={(event) => setPlanDraft(event.target.value)}
                    placeholder="What you will change, and how you will verify it…"
                  />
                  <button type="submit" className="hc-btn hc-btn-primary" disabled={planDraft.trim() === ''}>
                    {plans.length === 0 ? 'Save plan' : `Save v${(plans[0]?.version ?? 0) + 1}`}
                  </button>
                </form>
              </details>
            </section>

            <section className="hc-section" aria-label="Notes and questions">
              <h3>Notes &amp; questions ({comments.length})</h3>
              {comments.length === 0 ? (
                <p className="hc-empty-note">No notes or questions yet.</p>
              ) : (
                <ul className="hc-comments">
                  {comments
                    .filter((row) => row.parentId === null || !comments.some((other) => other.id === row.parentId))
                    .map((row) => (
                      <CommentNode
                        key={row.id}
                        comment={row}
                        replies={comments.filter((other) => other.parentId === row.id)}
                        act={act}
                        onError={setError}
                      />
                    ))}
                </ul>
              )}
              <form
                className="hc-plan-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (reply.trim() === '') return
                  void run({ op: 'comment', key: selected, text: reply.trim(), options: [], parentId: null }, () => setReply(''))
                }}
              >
                <label htmlFor="hc-reply" className="hc-sr-only">
                  Add a note or question
                </label>
                <textarea
                  id="hc-reply"
                  rows={2}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="Add a note or question…"
                />
                <button type="submit" className="hc-btn hc-btn-primary" disabled={reply.trim() === ''}>
                  Post note
                </button>
              </form>
            </section>
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Evidence form
// ---------------------------------------------------------------------------

interface EvidenceFormProps {
  outcome: Outcome
  track: string
  act: (action: Action) => Promise<void>
  onError: (message: string) => void
}

function EvidenceForm({ outcome, track, act, onError }: EvidenceFormProps): JSX.Element {
  const [kind, setKind] = useState<'confirms' | 'denies' | 'note'>('confirms')
  const [criterionIds, setCriterionIds] = useState<string[]>(() => outcome.criteria.map((row) => row.id))
  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [trackValue, setTrackValue] = useState(track)
  const [attachLabel, setAttachLabel] = useState('')
  const [attachPath, setAttachPath] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCriterionIds(outcome.criteria.map((row) => row.id))
  }, [outcome.key, outcome.version])

  useEffect(() => {
    setTrackValue(track)
  }, [track])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text.trim() === '' || source.trim() === '') {
      onError('Evidence needs a result and a source.')
      return
    }
    setBusy(true)
    try {
      const attachments =
        attachPath.trim() !== ''
          ? [{ label: attachLabel.trim() || 'Attachment', path: attachPath.trim() }]
          : undefined
      await act({
        op: 'add_evidence',
        key: outcome.key,
        version: outcome.version,
        kind,
        criterionIds,
        text: text.trim(),
        source: source.trim(),
        ...(attachments ? { attachments } : {}),
        track: trackValue.trim() === '' ? track : trackValue.trim(),
      })
      setText('')
      setSource('')
      setAttachLabel('')
      setAttachPath('')
    } catch (thrown) {
      onError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hc-evidence-form" onSubmit={(event) => void submit(event)} aria-label="Record evidence">
      <div className="hc-evidence-meta-grid">
        <div className="hc-field">
          <label htmlFor="hc-evidence-kind">Kind</label>
          <select id="hc-evidence-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="confirms">confirms</option>
            <option value="denies">denies</option>
            <option value="note">note</option>
          </select>
        </div>
        <div className="hc-field">
          <label htmlFor="hc-evidence-track">Track</label>
          <input id="hc-evidence-track" value={trackValue} onChange={(event) => setTrackValue(event.target.value)} />
        </div>
      </div>
      <fieldset className="hc-criteria-pick">
        <legend>Criteria</legend>
        {outcome.criteria.map((row) => {
          const checked = criterionIds.includes(row.id)
          return (
            <label key={row.id} className="hc-toggle">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  setCriterionIds(checked ? criterionIds.filter((id) => id !== row.id) : [...criterionIds, row.id])
                }
              />
              <span>{row.id}</span>
            </label>
          )
        })}
      </fieldset>
      <div className="hc-field">
        <label htmlFor="hc-evidence-text">Result</label>
        <textarea
          id="hc-evidence-text"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="booking.test.ts passes; the day view renders 80 bookings in 240ms"
          required
        />
      </div>
      <div className="hc-field">
        <label htmlFor="hc-evidence-source">Source</label>
        <input
          id="hc-evidence-source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="PR #418 · CI run 2191"
          required
        />
      </div>
      <div className="hc-evidence-meta-grid">
        <div className="hc-field">
          <label htmlFor="hc-evidence-att-label">Attachment label (optional)</label>
          <input
            id="hc-evidence-att-label"
            value={attachLabel}
            onChange={(event) => setAttachLabel(event.target.value)}
            placeholder="Screenshot / trace"
          />
        </div>
        <div className="hc-field">
          <label htmlFor="hc-evidence-att-path">Attachment path or URL</label>
          <input
            id="hc-evidence-att-path"
            value={attachPath}
            onChange={(event) => setAttachPath(event.target.value)}
            placeholder="artifacts/run-42.png"
          />
        </div>
      </div>
      <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Add evidence'}
      </button>
    </form>
  )
}
