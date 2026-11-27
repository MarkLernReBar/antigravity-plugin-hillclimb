import type { Snapshot } from './model.js'
import type { Action } from './actions.js'

/** A MAP-Elites cell the search recorded when it expanded from it. */
export interface EliteCell {
  island: number
  bins: number[]
  parent: string | null
  score: number | null
  attempts: number
}

/** Which search the rows come from, and how many siblings the run holds. */
export interface LiveSearch {
  id: string
  climber: string | null
  featureDimensions: string[] | null
  count: number
}

export interface LiveData {
  engine: 'repo' | 'search' | null
  baseline: number | null
  best: number | null
  target: number | null
  rows: { id: string; parent: string | null; score: number | null; label: string; at: string }[]
  holdout: string | null
  /** Absent for a repo climb and for a reading cached before this field existed. */
  search?: LiveSearch | null
  worker?: { phase: string; liveness: string; nextAction: string; retries: number; heartbeatAt: string | null }
  /** Cells the engine itself journaled; empty (or absent) means it recorded none. */
  elite?: EliteCell[]
}

export interface SavedViewFilterDto {
  query?: string
  signals?: string[]
  tags?: string[]
  blockedOnly?: boolean
  availability?: string[]
  scope?: string | null
  sortMode?: 'rank' | 'key' | 'signal' | 'updated'
}

export interface SavedViewDto {
  id: string
  name: string
  filter: SavedViewFilterDto
  created: string
  updated: string
}

export interface FocusScopeDto {
  id: string
  name: string
  owner: string | null
  releaseName: string | null
  goalKeys: string[]
  tags: string[]
  active: boolean
  created: string
  updated: string
}

export interface ProjectSettingsDto {
  autoSyncMirror: boolean
  wakeOnAnswer: boolean
  requireApprovalForNewOutcomes: boolean
  designKit: string | null
}

export interface HookRecordDto {
  id: string
  event:
    | 'outcome.broken'
    | 'outcome.verified'
    | 'climb.bar_reached'
    | 'question.answered'
    | 'change.approved'
    | 'flow.accepted'
    | '*'
  targetType: 'shell' | 'webhook' | 'notify'
  target: string
  enabled: boolean
  secret: string | null
  created: string
  updated: string
}

export interface SearchHitDto {
  project: string
  entityType: 'goal' | 'outcome' | 'plan' | 'evidence' | 'comment' | 'flow' | 'artifact' | 'climb'
  entityId: string
  title: string
  snippet: string
  rank: number
}

export interface ArtifactRevisionDto {
  version: number
  title: string
  body: string
  actor: string | null
  at: string
}

export interface ArtifactRecordDto {
  id: string
  folder: string
  title: string
  template: string | null
  body: string
  locked: boolean
  version: number
  history: ArtifactRevisionDto[]
  citations: string[]
  actor: string | null
  created: string
  updated: string
}

export interface ArtifactTemplateDto {
  id: 'weekly-update' | 'release-readiness' | 'climb-experiment-report' | 'compliance-audit' | 'postmortem'
  title: string
  folder: string
  description: string
}

export interface BlueprintSummaryDto {
  id: string
  name: string
  description: string
  tags: string[]
  goalCount: number
  outcomeCount: number
}

export interface InsightsDto {
  projectId: string
  track: string
  days: number
  generatedAt: string
  totals: {
    goals: number
    outcomes: number
    bySignal: Record<'verified' | 'unverified' | 'broken' | 'stale' | 'recheck', number>
    blockedManual: number
    deferred: number
    blockedByDependency: number
    readyNext: number
    inbox: number
    verifiedRatePct: number
  }
  streakDays: number
  byDay: Array<{
    date: string
    verified: number
    broken: number
    evidenceCount: number
    outcomeKeys: string[]
  }>
  byActor: Array<{
    actor: string
    via: string
    confirms: number
    denies: number
    notes: number
    actions: number
    outcomeKeys: string[]
  }>
  recentVerifications: Array<{
    at: string
    key: string
    title: string
    evidenceId: string
    source: string
    actor: string
    via: string
  }>
  climbs: {
    totalClimbs: number
    activeClimbs: number
    barReachedCount: number
    totalSteps: number
    keptSteps: number
    discardedSteps: number
    keepRatePct: number | null
    guardRegressionsCaught: number
    holdoutChecksRun: number
    largestHoldoutGap: { climb: string; devScore: number; holdoutScore: number; gap: number } | null
  }
}

export interface ViewProps {
  data: Snapshot
  track: string
  selected: string | null
  select: (key: string | null) => void
  act: (a: Action) => Promise<void>
  configure?: (key: string, engine: 'repo' | 'search') => Promise<void>
  dispatch: (key: string, engine: 'repo' | 'search') => Promise<void>
  live: (key: string) => Promise<LiveData>
  views?: SavedViewDto[]
  scopes?: FocusScopeDto[]
  onSaveView?: (name: string, filter: SavedViewFilterDto) => Promise<void>
  onDeleteView?: (id: string) => Promise<void>
  onSaveScope?: (scope: {
    id?: string
    name: string
    owner?: string | null
    releaseName?: string | null
    goalKeys: string[]
    tags: string[]
    active: boolean
  }) => Promise<void>
  onDeleteScope?: (id: string) => Promise<void>
  onOpenFlow?: (flowName: string) => void
  onOpenInbox?: () => void
}
