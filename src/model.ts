// A tree belongs to one project. Keys are stable across plan and contract revisions.
export type ActorVia = "ui" | "mcp" | "cli" | "ci" | "auto-track" | "hook" | "rest";
export type OutcomeAvailability = "active" | "blocked" | "deferred";

export interface Criterion {
  id: string;
  given: string;
  when: string;
  then: string;
}
export interface Goal {
  key: string;
  parentGoalKey: string | null;
  title: string;
  brief: string;
  rank: number;
  tags?: string[];
  created: string;
  updated?: string;
}
export interface Contract {
  title: string;
  story: string;
  criteria: Criterion[];
  dependsOn: string[];
  rank: number;
  recheckDays: number | null;
  tags?: string[];
}
export interface Outcome extends Contract {
  key: string;
  goalKey: string;
  version: number;
  availability?: OutcomeAvailability;
  availabilityReason?: string | null;
  deferredUntil?: string | null;
  created: string;
  updated: string;
}
export type Signal = "verified" | "unverified" | "broken" | "stale" | "recheck";
export interface EvidenceAttachment {
  label: string;
  path: string;
  mimeType?: string;
}
export interface Evidence {
  id: string;
  key: string;
  version: number;
  criterionIds: string[];
  kind: "confirms" | "denies" | "note";
  track: string;
  text: string;
  source: string;
  attachments?: EvidenceAttachment[];
  actor?: string;
  via?: ActorVia;
  created: string;
}
export interface Claim {
  key: string;
  threadId: string;
  expires: string;
}
export interface Change {
  id: string;
  key: string;
  kind?: "edit" | "create";
  goalKey?: string;
  baseVersion: number;
  proposed: Contract;
  state: "pending" | "approved" | "rejected";
  threadId?: string | null;
  actor?: string;
  via?: ActorVia;
  created: string;
}
export interface Plan {
  key: string;
  version: number;
  body: string;
  actor?: string;
  via?: ActorVia;
  created: string;
}
export interface Comment {
  id: string;
  key: string;
  parentId: string | null;
  planVersion?: number | null;
  text: string;
  options: string[];
  answer: string | null;
  threadId?: string | null;
  actor?: string;
  via?: ActorVia;
  created: string;
}
export interface Track {
  name: string;
  description: string;
}
export interface Release {
  name: string;
  keys: string[];
  scenario: string;
  date: string;
}
export type PinKind = "point" | "rect" | "arrow" | "path" | "step";
export interface Pin {
  id?: string;
  x: number;
  y: number;
  text: string;
  kind?: PinKind;
  geometry?: Record<string, number | number[]>;
  selector?: string | null;
  forAgents?: boolean;
  resolved?: boolean;
  resolvedBy?: string | null;
  created?: string;
}
export interface FrameViewport {
  width: number;
  height: number;
}
export interface FrameRevision {
  version: number;
  title: string;
  html: string;
  kind?: "html" | "image";
  imagePath?: string | null;
  viewport?: FrameViewport | null;
  notes?: string | null;
  at: string;
  actor?: string | null;
  ref?: string | null;
}
export interface Frame {
  title: string;
  html: string;
  criterionId: string;
  key: string;
  kind?: "html" | "image";
  imagePath?: string | null;
  viewport?: FrameViewport | null;
  notes?: string | null;
  version?: number;
  history?: FrameRevision[];
  liveImagePath?: string | null;
  driftDetected?: boolean;
  driftNote?: string | null;
  pins: Pin[];
}
export interface Flow {
  name: string;
  folder?: string | null;
  designKit?: string | null;
  frames: Frame[];
}
export interface FlowProposalFrameInput {
  title: string;
  html: string;
  criterionId: string;
  key: string;
  kind?: "html" | "image";
  imagePath?: string | null;
  viewport?: FrameViewport | null;
  notes?: string | null;
}
export interface FlowProposal {
  id: string;
  kind: "change" | "new_flow" | "new_step";
  flowName: string;
  folder?: string | null;
  designKit?: string | null;
  frameIndex: number | null;
  basedOnVersion: number | null;
  frame?: FlowProposalFrameInput | null;
  frames?: FlowProposalFrameInput[] | null;
  selfGrade?: string | null;
  ref?: string | null;
  spot?: { x: number; y: number } | null;
  note?: string | null;
  state: "pending" | "accepted" | "rejected";
  reviewNote?: string | null;
  threadId?: string | null;
  actor?: string | null;
  via?: ActorVia;
  created: string;
}
export interface Activity {
  track?: string;
  at: string;
  key: string;
  text: string;
  signal: Signal | null;
  actor?: string;
  via?: ActorVia;
}
export interface Tree {
  goals: Goal[];
  outcomes: Outcome[];
  evidence: Evidence[];
  claims: Claim[];
  changes: Change[];
  plans: Plan[];
  comments: Comment[];
  tracks: Track[];
  releases: Release[];
  flows: Flow[];
  flowProposals?: FlowProposal[];
  activity: Activity[];
}
export interface Ranked {
  key: string;
  signal: Signal;
  effectiveRank: number;
  sectionNumber?: string;
  availability?: OutcomeAvailability;
  availabilityReason?: string | null;
  deferredUntil?: string | null;
  tags?: string[];
  ancestors: Goal[];
  blockedBy: string[];
  claim: Claim | null;
}
export interface Snapshot extends Tree {
  flowProposals: FlowProposal[];
  ranked: Ranked[];
  next: string[];
  inbox: number;
}
export const emptyTree = (): Tree => ({
  goals: [],
  outcomes: [],
  evidence: [],
  claims: [],
  changes: [],
  plans: [],
  comments: [],
  tracks: [{ name: "main", description: "Current contract" }],
  releases: [],
  flows: [],
  flowProposals: [],
  activity: [],
});

/**
 * A comment counts as an open decision waiting on a human ONLY when it is still
 * unanswered AND actually asks for a decision:
 * - Any unanswered comment with multiple-choice `options` (root or follow-up).
 * - Or an unanswered root question ending in `?` that was not posted as a plain
 *   human UI note or plan review note.
 * Replies without options (`parentId !== null`) and plain notes NEVER reopen Decisions.
 */
export function isOpenQuestion(comment: Comment): boolean {
  if (comment.answer !== null) return false;
  if (comment.options.length > 0) return true;
  if (comment.parentId !== null) return false;
  if (comment.actor === "human" || comment.via === "ui") return false;
  if (comment.planVersion !== null && comment.planVersion !== undefined) return false;
  return comment.text.trim().endsWith("?");
}
