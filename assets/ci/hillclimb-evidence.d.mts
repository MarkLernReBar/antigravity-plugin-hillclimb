// Types for assets/ci/hillclimb-evidence.mjs, so tests and callers get the real
// contract instead of `any`. Mirrors src/model.ts (Evidence) and src/actions.ts
// (add_evidence).

import type { Evidence } from "../../src/model.js";
import type { CoreAction } from "../../src/actions.js";

export type TestStatus = "passed" | "failed" | "skipped" | "unknown";
export type ReportFormat = "auto" | "text" | "junit" | "json";

export interface TestResult {
  name: string;
  status: TestStatus;
  message?: string;
}

export interface TestTag {
  key: string;
  version: number | null;
  criteria: string[];
  raw: string;
  error?: undefined;
  matches?: undefined;
}

export interface TestTagError {
  error: string;
  matches: string[];
  key?: undefined;
  version?: undefined;
  criteria?: undefined;
}

export interface ContractOutcome {
  key: string;
  version: number;
  criteria: string[];
}

export interface Contract {
  byKey: Map<string, ContractOutcome>;
  outcomes: Array<{ key: string; version: number; criteria?: Array<{ id: string } | string> }>;
}

export interface StaleEntry {
  test: string;
  key: string;
  taggedVersion: number;
  contractVersion: number;
  direction: "older" | "newer";
  reason: string;
}

export interface InvalidEntry {
  test: string;
  key?: string;
  reason: string;
}

export interface SkippedEntry {
  test?: string;
  key?: string;
  reason: string;
  tests?: number;
}

export interface BuildInput {
  results: TestResult[];
  contract: Contract;
  source: string;
  track?: string;
  kind?: string;
  prefixes?: string | string[];
  now?: string;
  /**
   * The caller asserts the contract file predates the test run (the CLI checks
   * the file's mtime). Without it an unversioned tag is skipped, because pinning
   * it to whatever the contract says at post time would claim a version the test
   * never ran against.
   */
  contractFrozenAt?: string | null;
}

export interface BuildResult {
  evidence: Evidence[];
  skipped: SkippedEntry[];
  invalid: InvalidEntry[];
  stale: StaleEntry[];
}

export interface EvidenceBundle {
  version: 1;
  source: string;
  track: string;
  created: string;
  contractVersion: number | null;
  contractVersions: number[];
  contractFrozenAt: string | null;
  evidence: Evidence[];
  skipped: SkippedEntry[];
  invalid: InvalidEntry[];
  stale: StaleEntry[];
}

/**
 * `add_evidence` as emitted here. `receiptId` is the deterministic evidence id:
 * the parent's action contract carries it as an optional field so a retried CI
 * job posts one receipt, not two pieces of proof. Until that field lands in
 * `src/actions.ts`, the action still carries it and zod strips it on parse; once
 * it lands it must survive validation unchanged (asserted in the tests).
 */
export type AddEvidenceAction = Extract<CoreAction, { op: "add_evidence" }> & {
  receiptId: string;
};

export function parseTestTag(
  name: string,
  options?: { prefixes?: string | string[] },
): TestTag | TestTagError | null;

export function parseJUnit(xml: string): TestResult[];
export function parseJestJson(text: string): TestResult[];
export function parseTextReport(
  text: string,
  options?: { prefixes?: string | string[] },
): TestResult[];
export function parseReport(
  text: string,
  format?: ReportFormat,
  options?: { prefixes?: string | string[] },
): TestResult[];
export function detectFormat(text: string): "junit" | "json" | "text";
export function readContract(value: string | object): Contract;
export function buildEvidence(input: BuildInput): BuildResult;
export function toActions(evidence: Evidence[]): AddEvidenceAction[];
export function renderActCommands(actions: AddEvidenceAction[], project?: string | null): string[];
export function renderSummary(bundle: EvidenceBundle): string;
export function parseArgs(argv: string[]): Record<string, unknown>;
export function main(
  argv?: string[],
  io?: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
    readFile: (path: string | number, encoding: "utf8") => string;
    statFile?: (path: string) => { mtimeMs: number };
  },
): number;
