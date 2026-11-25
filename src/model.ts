// A tree belongs to one project. Keys are stable across plan and contract revisions.
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
  created: string;
}
export interface Contract {
  title: string;
  story: string;
  criteria: Criterion[];
  dependsOn: string[];
  rank: number;
  recheckDays: number | null;
}
export interface Outcome extends Contract {
  key: string;
  goalKey: string;
  version: number;
  created: string;
  updated: string;
}
export type Signal = "verified" | "unverified" | "broken" | "stale" | "recheck";
export interface Evidence {
  id: string;
  key: string;
  version: number;
  criterionIds: string[];
  kind: "confirms" | "denies" | "note";
  track: string;
  text: string;
  source: string;
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
  baseVersion: number;
  proposed: Contract;
  state: "pending" | "approved" | "rejected";
  created: string;
}
export interface Plan {
  key: string;
  version: number;
  body: string;
  created: string;
}
export interface Comment {
  id: string;
  key: string;
  parentId: string | null;
  text: string;
  options: string[];
  answer: string | null;
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
export interface Pin {
  x: number;
  y: number;
  text: string;
}
export interface Frame {
  title: string;
  html: string;
  criterionId: string;
  key: string;
  pins: Pin[];
}
export interface Flow {
  name: string;
  frames: Frame[];
}
export interface Activity {
  track?: string;
  at: string;
  key: string;
  text: string;
  signal: Signal | null;
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
  activity: Activity[];
}
export interface Ranked {
  key: string;
  signal: Signal;
  effectiveRank: number;
  ancestors: Goal[];
  blockedBy: string[];
  claim: Claim | null;
}
export interface Snapshot extends Tree {
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
  activity: [],
});
