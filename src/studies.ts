// Studies: was a more sophisticated search policy worth the budget?
//
// A study is one problem × named experiments × N repeats at one budget per
// search. The native 0.8.2 facility (`hillclimb experiment run|report`) owns the
// execution, the store and the report. This module adds the two reads a person
// or agent needs *before* and *after* spending anything:
//
//   * `study-preview` parses the spec, expands the exact job matrix the native
//     launcher would run (repeat-major, experiments round-robin), and prints the
//     cost/allocation plan plus the checks that decide whether the comparison
//     can answer the question at all. It never runs a search.
//   * `study-report` imports the native artifact (`hillclimb experiment report
//     --json`) or reconstructs the same summary from the run store
//     (`runs/<run>/searches/<search>/{search.yaml,status.json,journal.jsonl}`),
//     then adds an actionable layer: matched budget/repeats, failures,
//     inconclusives, and the exact worker-local command that produced the
//     artifact.
//
// No provider call, no server-side shell. The importer is pure file reading, so
// it works on a completed study offline and in tests. A `--json` run prints one
// typed object; the text run is the same data for a person.
//
// Division of labour: every read is bound to the selected study directory via
// a StudyIO adapter; `--dir` may only narrow that root. Standalone tests may
// inject a fake `StudyIO` explicitly.

import { readFile, readdir, stat } from "node:fs/promises";
import { posix } from "node:path";
import { HillClimbError as PluginCliError } from "./errors.js";

const join = posix.join;
const resolve = posix.resolve;
const isAbsolute = posix.isAbsolute;

export const STUDY_PREVIEW_SCHEMA = "hillclimb.study.preview.v1" as const;
export const STUDY_REPORT_SCHEMA = "hillclimb.study.report.v1" as const;

const OUTPUT_LIMIT = 24_000;

// ---------------------------------------------------------------------------
// IO the parent can route to the right machine
// ---------------------------------------------------------------------------

export interface StudyDirEntry {
  name: string;
  kind: "file" | "directory";
}

/** One file read. `truncated` is true when the host returned less than its
 * declared size; a caller must not silently parse a truncated YAML/JSON file. */
export interface StudyFile {
  content: string | null;
  truncated: boolean;
  sizeBytes: number | null;
}

/** A directory listing plus whether the host capped it. */
export interface StudyListing {
  entries: StudyDirEntry[];
  truncated: boolean;
}

/**
 * Every operation is a path in, data out, and every path is checked against the
 * selected `--dir` before reading. Tests may inject a custom implementation.
 */
export interface StudyIO {
  readFile(path: string): Promise<StudyFile>;
  listDir(path: string): Promise<StudyListing>;
}

const MISSING = /ENOENT|no such file|not found|does not exist/i;

function isMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return MISSING.test(String(error));
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (code === "ENOENT" || code === "not_found")) return true;
  const message = (error as { message?: unknown }).message;
  return MISSING.test(typeof message === "string" ? message : String(error));
}

function readFailure(path: string, error: unknown): PluginCliError {
  const message = error instanceof Error ? error.message : String(error);
  return new PluginCliError(`could not read ${path}: ${message}`, {
    code: "read_failed",
    hint: "Check that the path exists on the worker host and that this thread can read it.",
  });
}

function decodeHostContent(result: { content?: string; contentEncoding?: string }): string {
  if (typeof result.content !== "string") return "";
  if (result.contentEncoding === "base64") return Buffer.from(result.content, "base64").toString("utf8");
  return result.content;
}

/** Offline default, for standalone tests and local CLI use. */
export function localStudyIO(): StudyIO {
  return {
    async readFile(path) {
      try {
        const info = await stat(path);
        const content = await readFile(path, "utf8");
        const sizeBytes = info.size;
        return { content, truncated: Buffer.byteLength(content, "utf8") < sizeBytes, sizeBytes };
      } catch (error) {
        if (isMissingError(error)) return { content: null, truncated: false, sizeBytes: null };
        throw readFailure(path, error);
      }
    },
    async listDir(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return {
          entries: entries.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
          })),
          truncated: false,
        };
      } catch (error) {
        if (isMissingError(error)) return { entries: [], truncated: false };
        throw readFailure(path, error);
      }
    },
  };
}

function stripTrailing(path: string): string {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
}

/** True when `candidate` is `root` or below it, with no `..` escape. */
export function isWithin(root: string, candidate: string): boolean {
  const base = stripTrailing(root);
  const target = stripTrailing(candidate);
  if (target === base) return true;
  const relative = posix.relative(base, target);
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

function assertWithin(root: string, candidate: string, operation: string): void {
  void operation;
  if (isWithin(root, candidate)) return;
  throw new PluginCliError(`${candidate} is outside the selected directory ${root}`, {
    code: "path_outside_root",
    hint: `A study path from YAML/JSON or --artifact must stay under --dir. Move it under ${root} or pass the right --dir.`,
  });
}

/** Wraps any IO with the containment rule. Content-derived paths never escape. */
function containedStudyIO(root: string, io: StudyIO): StudyIO {
  return {
    async readFile(path) {
      assertWithin(root, path, "read");
      return io.readFile(path);
    },
    async listDir(path) {
      assertWithin(root, path, "list");
      return io.listDir(path);
    },
  };
}

export interface StudySession {
  io: StudyIO;
  /** The selected study directory (the containment root for every later read). */
  root: string;
  workspace: string | null;
  via: "flag" | "cwd" | "local";
}

export function openStudySession(
  override: string | null,
  cwdOverride?: string,
  io: StudyIO = localStudyIO(),
): StudySession {
  const cwd = typeof cwdOverride === "string" && cwdOverride !== "" ? posix.resolve(cwdOverride) : posix.resolve(process.cwd());
  let root: string;
  let via: StudySession["via"];
  if (override !== null && override !== "") {
    root = isAbsolute(override) ? posix.resolve(override) : posix.resolve(cwd, override);
    via = "flag";
  } else {
    root = cwd;
    via = "cwd";
  }
  root = stripTrailing(root) || "/";
  return { io: containedStudyIO(root, io), root, workspace: root, via };
}

async function readText(io: StudyIO, path: string): Promise<string | null> {
  return (await io.readFile(path)).content;
}

/** A required metadata file: a truncated read is an error, never a partial parse. */
async function readStrictText(io: StudyIO, path: string, what: string): Promise<string | null> {
  const file = await io.readFile(path);
  if (file.content === null) return null;
  if (file.truncated) {
    throw new PluginCliError(`${what} at ${path} was truncated by the host reader`, {
      code: "file_truncated",
      hint: "Import the native JSON artifact instead (hillclimb experiment report <study> --json), or read a smaller run.",
    });
  }
  return file.content;
}

// ---------------------------------------------------------------------------
// A study spec
// ---------------------------------------------------------------------------

export interface StudyExperiment {
  name: string;
  /** Overrides exactly as written in the spec, after `defaults` are applied. */
  overrides: Record<string, unknown>;
  /** Dotted overrides, as the native launcher flattens them. */
  flattened: Record<string, unknown>;
}

export interface StudySpec {
  name: string;
  problems: string[];
  experiments: StudyExperiment[];
  repeats: number;
  budget: string | null;
  schedule: "sequential" | "parallel";
  maxConcurrent: number | null;
  noiseFloor: number | Record<string, number> | null;
  defaults: Record<string, unknown>;
  seedFrom: string | null;
  path: string | null;
  control: string;
}

export interface StudyJob {
  index: number;
  experiment: string;
  problem: string;
  repeat: number;
}

/** The subset of YAML a study/run/search file uses: block mappings, block and
 * indentless sequences, inline flow collections, quoted and plain scalars. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function parseYamlSubset(source: string): YamlValue {
  const lines: Array<{ indent: number; text: string }> = [];
  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const leading = /^([ \t]*)/.exec(raw)?.[1] ?? "";
    if (leading.includes("\t")) {
      throw new Error("study YAML uses a tab for indentation; spaces are required");
    }
    const content = stripYamlComment(raw.slice(leading.length)).trimEnd();
    if (content.trim() === "") continue;
    lines.push({ indent: leading.length, text: content });
  }
  if (lines.length === 0) return {};
  const [value, next] = parseYamlNode(lines, 0, lines[0]?.indent ?? 0);
  if (next !== lines.length) {
    throw new Error(`unexpected YAML content at line ${next + 1}: ${lines[next]?.text ?? ""}`);
  }
  return value;
}

function stripYamlComment(text: string): string {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "#" && depth === 0 && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function isYamlSequenceLine(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseYamlNode(
  lines: Array<{ indent: number; text: string }>,
  index: number,
  indent: number,
): [YamlValue, number] {
  const line = lines[index];
  if (line === undefined || line.indent !== indent) {
    throw new Error(`expected an indented block at YAML line ${index + 1}`);
  }
  return isYamlSequenceLine(line.text) ? parseYamlSequence(lines, index, indent) : parseYamlMapping(lines, index, indent);
}

function parseYamlMapping(
  lines: Array<{ indent: number; text: string }>,
  index: number,
  indent: number,
): [Record<string, YamlValue>, number] {
  const out: Record<string, YamlValue> = {};
  let i = index;
  while (i < lines.length && lines[i]?.indent === indent && !isYamlSequenceLine(lines[i]!.text)) {
    const { key, rest } = splitYamlKey(lines[i]!.text, i);
    i += 1;
    if (rest !== "") {
      out[key] = parseYamlScalar(rest);
      continue;
    }
    const next = lines[i];
    if (next !== undefined && next.indent === indent && isYamlSequenceLine(next.text)) {
      const [sequence, after] = parseYamlSequence(lines, i, indent);
      out[key] = sequence;
      i = after;
    } else if (next !== undefined && next.indent > indent) {
      const [child, after] = parseYamlNode(lines, i, next.indent);
      out[key] = child;
      i = after;
    } else {
      out[key] = null;
    }
  }
  return [out, i];
}

function parseYamlSequence(
  lines: Array<{ indent: number; text: string }>,
  index: number,
  indent: number,
): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = index;
  while (i < lines.length && lines[i]?.indent === indent && isYamlSequenceLine(lines[i]!.text)) {
    const text = lines[i]!.text;
    const rest = text === "-" ? "" : text.slice(2).trim();
    i += 1;
    if (rest === "") {
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const [child, after] = parseYamlNode(lines, i, next.indent);
        out.push(child);
        i = after;
      } else {
        out.push(null);
      }
      continue;
    }
    if (yamlKeyAt(rest) !== null) {
      // `- target: fitness-landscape` starts a mapping on the item's own line;
      // the remaining keys are indented two spaces under the dash.
      const childIndent = indent + 2;
      const { key, rest: valueText } = splitYamlKey(rest, i);
      const item: Record<string, YamlValue> = {};
      if (valueText !== "") {
        item[key] = parseYamlScalar(valueText);
      } else {
        const next = lines[i];
        if (next !== undefined && next.indent > childIndent) {
          const [child, after] = parseYamlNode(lines, i, next.indent);
          item[key] = child;
          i = after;
        } else if (next !== undefined && next.indent === childIndent && isYamlSequenceLine(next.text)) {
          const [sequence, after] = parseYamlSequence(lines, i, childIndent);
          item[key] = sequence;
          i = after;
        } else {
          item[key] = null;
        }
      }
      if (i < lines.length && lines[i]?.indent === childIndent && !isYamlSequenceLine(lines[i]!.text)) {
        const [more, after] = parseYamlMapping(lines, i, childIndent);
        Object.assign(item, more);
        i = after;
      }
      out.push(item);
      continue;
    }
    out.push(parseYamlScalar(rest));
  }
  return [out, i];
}

function yamlKeyAt(text: string): number | null {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1] ?? ""))) return i;
  }
  return null;
}

function splitYamlKey(text: string, line: number): { key: string; rest: string } {
  const at = yamlKeyAt(text);
  if (at === null) throw new Error(`expected "key: value" at YAML line ${line + 1}: ${text}`);
  const key = unquoteYamlString(text.slice(0, at).trim());
  if (key === "") throw new Error(`empty key at YAML line ${line + 1}`);
  return { key, rest: text.slice(at + 1).trim() };
}

function parseYamlScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = new FlowParser(trimmed).parseValue();
    return parsed;
  }
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return unquoteYamlString(trimmed);
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function unquoteYamlString(text: string): string {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

class FlowParser {
  private readonly text: string;
  private i = 0;

  constructor(text: string) {
    this.text = text;
  }

  parseValue(): YamlValue {
    this.skipSpace();
    const ch = this.text[this.i];
    if (ch === "[") return this.parseSequence();
    if (ch === "{") return this.parseMapping();
    if (ch === "'" || ch === '"') return this.parseQuoted();
    return parseYamlScalar(this.parseBare());
  }

  private parseSequence(): YamlValue[] {
    this.expect("[");
    const out: YamlValue[] = [];
    this.skipSpace();
    if (this.text[this.i] === "]") {
      this.i += 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipSpace();
      const ch = this.text[this.i];
      if (ch === ",") {
        this.i += 1;
        this.skipSpace();
        if (this.text[this.i] === "]") {
          this.i += 1;
          return out;
        }
        continue;
      }
      this.expect("]");
      return out;
    }
  }

  private parseMapping(): Record<string, YamlValue> {
    this.expect("{");
    const out: Record<string, YamlValue> = {};
    this.skipSpace();
    if (this.text[this.i] === "}") {
      this.i += 1;
      return out;
    }
    for (;;) {
      const key = this.parseKey();
      this.skipSpace();
      this.expect(":");
      out[key] = this.parseValue();
      this.skipSpace();
      const ch = this.text[this.i];
      if (ch === ",") {
        this.i += 1;
        this.skipSpace();
        if (this.text[this.i] === "}") {
          this.i += 1;
          return out;
        }
        continue;
      }
      this.expect("}");
      return out;
    }
  }

  private parseKey(): string {
    this.skipSpace();
    if (this.text[this.i] === "'" || this.text[this.i] === '"') {
      const value = this.parseQuoted();
      return String(value);
    }
    return this.parseBare(":");
  }

  private parseQuoted(): string {
    const quote = this.text[this.i] as string;
    const start = this.i;
    this.i += 1;
    for (; this.i < this.text.length; this.i += 1) {
      const ch = this.text[this.i];
      if (quote === '"' && ch === "\\") {
        this.i += 1;
        continue;
      }
      if (ch === quote) {
        this.i += 1;
        return unquoteYamlString(this.text.slice(start, this.i));
      }
    }
    throw new Error(`unterminated quoted value: ${this.text.slice(start)}`);
  }

  private parseBare(stopAt = ",]}"): string {
    const start = this.i;
    while (this.i < this.text.length && !stopAt.includes(this.text[this.i] as string)) this.i += 1;
    return this.text.slice(start, this.i).trim();
  }

  private skipSpace(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i] as string)) this.i += 1;
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.i] !== ch) {
      throw new Error(`expected ${JSON.stringify(ch)} in flow YAML at ${this.i}: ${this.text}`);
    }
    this.i += 1;
  }
}

// ---------------------------------------------------------------------------
// Spec normalization and expansion (mirrors hillclimb 0.8.2 experiment.py)
// ---------------------------------------------------------------------------

const NAMES_THE_CLIMBER = new Set(["climber", "climber.ref", "search.policy"]);

export function flattenStudyOverrides(overrides: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const name = `${prefix}${key}`;
    const whole = name === "climber" || name.endsWith("policy_params") || name.endsWith("routing");
    if (isRecord(value) && !whole) {
      Object.assign(flat, flattenStudyOverrides(value, `${name}.`));
    } else {
      flat[name] = value;
    }
  }
  return flat;
}

function flattenExperimentOverrides(defaults: Record<string, unknown>, experiment: Record<string, unknown>): Record<string, unknown> {
  const flat = flattenStudyOverrides({ ...defaults, ...experiment });
  const named = Object.fromEntries(Object.entries(flat).filter(([key]) => NAMES_THE_CLIMBER.has(key)));
  const rest = Object.fromEntries(Object.entries(flat).filter(([key]) => !NAMES_THE_CLIMBER.has(key)));
  return { ...named, ...rest };
}

export function normalizeStudySpec(raw: unknown, fallbackName: string, path: string | null = null): StudySpec {
  if (!isRecord(raw)) throw new Error("a study spec is a mapping");
  const problemsRaw = raw.problems ?? (typeof raw.problem === "string" ? [raw.problem] : []);
  if (!Array.isArray(problemsRaw) || problemsRaw.length === 0 || !problemsRaw.every((item) => typeof item === "string" && item !== "")) {
    throw new Error("a study spec needs a non-empty `problems: [ … ]` list of problem ids or paths");
  }
  const experimentsRaw = (raw.experiments ?? raw.arms) as unknown;
  if (!isRecord(experimentsRaw)) throw new Error("a study spec needs `experiments:` (name → config overrides)");
  const entries = Object.entries(experimentsRaw);
  if (entries.length < 2) throw new Error("a study needs at least two experiments to compare");
  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  const experiments: StudyExperiment[] = entries.map(([name, value]) => {
    if (!isRecord(value)) throw new Error(`experiment ${JSON.stringify(name)} must map config settings to values`);
    return {
      name,
      overrides: value,
      flattened: flattenExperimentOverrides(defaults, value),
    };
  });
  const repeatsRaw = raw.repeats ?? 1;
  if (typeof repeatsRaw !== "number" || !Number.isInteger(repeatsRaw) || repeatsRaw < 1) {
    throw new Error("`repeats` must be an integer >= 1");
  }
  const schedule = raw.schedule ?? "sequential";
  if (schedule !== "sequential" && schedule !== "parallel") {
    throw new Error(`\`schedule\` must be sequential or parallel, got ${JSON.stringify(schedule)}`);
  }
  const maxConcurrent = raw.max_concurrent ?? null;
  if (maxConcurrent !== null && (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1)) {
    throw new Error("`max_concurrent` must be an integer >= 1");
  }
  const noiseFloor = raw.noise_floor ?? null;
  if (noiseFloor !== null && typeof noiseFloor !== "number" && !isRecord(noiseFloor)) {
    throw new Error("`noise_floor` must be a number or a mapping of problem id → number");
  }
  const budget = raw.budget === undefined || raw.budget === null ? null : String(raw.budget);
  const name = typeof raw.name === "string" && raw.name !== "" ? raw.name : fallbackName;
  return {
    name,
    problems: problemsRaw as string[],
    experiments,
    repeats: repeatsRaw,
    budget,
    schedule,
    maxConcurrent,
    noiseFloor: noiseFloor as number | Record<string, number> | null,
    defaults,
    seedFrom: typeof raw.seed_from === "string" ? raw.seed_from : null,
    path,
    control: experiments[0]?.name ?? "",
  };
}

export function expandStudyJobs(spec: StudySpec, firstRepeat = 1): StudyJob[] {
  if (!Number.isInteger(firstRepeat) || firstRepeat < 1) throw new Error("firstRepeat must be >= 1");
  const jobs: StudyJob[] = [];
  for (let repeat = firstRepeat; repeat < firstRepeat + spec.repeats; repeat += 1) {
    for (const problem of spec.problems) {
      for (const experiment of spec.experiments) {
        jobs.push({ index: jobs.length + 1, experiment: experiment.name, problem, repeat });
      }
    }
  }
  return jobs;
}

/** `25s`, `10m`, `1.5h`, or a bare number of seconds → seconds. */
export function parseBudgetSeconds(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smh])?\s*$/i.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  return value * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}

// ---------------------------------------------------------------------------
// Preview: the plan and the checks, before anything runs
// ---------------------------------------------------------------------------

export interface StudyCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  action: string | null;
}

export interface StudyPreview {
  schema: typeof STUDY_PREVIEW_SCHEMA;
  study: string;
  specPath: string | null;
  hillclimbDir: string;
  problems: string[];
  repeats: number;
  schedule: "sequential" | "parallel";
  maxConcurrent: number | null;
  control: string;
  budget: { text: string | null; seconds: number | null };
  experiments: Array<{
    name: string;
    control: boolean;
    overrides: Record<string, unknown>;
    effective: Record<string, unknown>;
    searches: number;
    agent: string | null;
    deterministicAgent: boolean;
  }>;
  jobs: StudyJob[];
  allocation: {
    equalBudget: boolean;
    matchedRepeats: boolean;
    searches: number;
    searchesPerExperiment: number;
    perSearchBudgetSeconds: number | null;
    sequentialWallClockSeconds: number | null;
    parallelWallClockSeconds: number | null;
    candidateGenerations: { perSearch: number | null; total: number | null; source: string };
    verifierRepeats: { perSearch: number; total: number };
    parameterTrials: { perSearch: number; total: number };
    paidModelCalls: { value: number | null; basis: string };
  };
  checks: StudyCheck[];
  commands: { run: string; dryRun: string; report: string; reportImport: string; verifyNoise: string };
}

export interface PreviewOptions {
  hillclimbDir: string;
  specPath: string | null;
  spec: StudySpec;
  candidates?: number | null;
  verifierRepeat?: number;
  trialAllowance?: number;
  repeatsOverride?: number | null;
  budgetOverride?: string | null;
}

const DETERMINISTIC_AGENTS = new Set(["toy", "dummy"]);

export function buildStudyPreview(options: PreviewOptions): StudyPreview {
  const spec = options.spec;
  const repeats = options.repeatsOverride ?? spec.repeats;
  const budgetText = options.budgetOverride ?? spec.budget;
  const budgetSeconds = parseBudgetSeconds(budgetText);
  const effectiveSpec: StudySpec = { ...spec, repeats };
  const jobs = expandStudyJobs(effectiveSpec);
  const searchesPerExperiment = jobs.length / spec.experiments.length;
  const candidates = options.candidates ?? null;
  const verifierRepeat = options.verifierRepeat ?? 1;
  const trialAllowance = options.trialAllowance ?? 0;

  const experiments = spec.experiments.map((experiment) => {
    const agentValue = experiment.flattened.agent ?? spec.defaults.agent ?? null;
    const agent = typeof agentValue === "string" ? agentValue : null;
    return {
      name: experiment.name,
      control: experiment.name === spec.control,
      overrides: experiment.overrides,
      effective: experiment.flattened,
      searches: jobs.filter((job) => job.experiment === experiment.name).length,
      agent,
      deterministicAgent: agent !== null && DETERMINISTIC_AGENTS.has(agent.toLowerCase()),
    };
  });

  const paid = experiments.every((experiment) => experiment.deterministicAgent);
  const sequential =
    budgetSeconds === null ? null : budgetSeconds * jobs.length;
  const parallel =
    budgetSeconds === null
      ? null
      : budgetSeconds * Math.ceil(jobs.length / Math.max(1, spec.maxConcurrent ?? jobs.length));

  const checks: StudyCheck[] = [
    {
      id: "two-experiments",
      status: experiments.length >= 2 ? "pass" : "fail",
      detail: `${experiments.length} experiment(s); the first is the control`,
      action: experiments.length >= 2 ? null : "Add a control and a treatment to the spec.",
    },
    {
      id: "matched-budget",
      status: "pass",
      detail:
        budgetSeconds === null
          ? "no explicit per-search budget in the spec; every arm inherits the same run default"
          : `every arm gets ${budgetText} (${budgetSeconds}s) per search`,
      action: budgetSeconds === null ? "Set `budget: 15m` so the comparison has one explicit allowance." : null,
    },
    {
      id: "matched-repeats",
      status: repeats >= 2 ? "pass" : "fail",
      detail:
        repeats >= 2
          ? `${repeats} independent repeats per experiment`
          : "one repeat per experiment cannot separate an effect from run-to-run noise",
      action: repeats >= 2 ? null : "Set `repeats: 3` (or more) before calling a winner.",
    },
    {
      id: "noise-floor",
      status: spec.noiseFloor !== null ? "pass" : "warn",
      detail:
        spec.noiseFloor !== null
          ? "a declared noise floor exists; gaps below it are reported inconclusive"
          : "no noise floor; with two repeats the report will fall back to the spread across repeats",
      action: spec.noiseFloor !== null ? null : "Measure it once with the verify command below, then set `noise_floor:`.",
    },
    {
      id: "verifier-stability",
      status: verifierRepeat >= 2 ? "pass" : "warn",
      detail: `verifier repeats per search: ${verifierRepeat}`,
      action: verifierRepeat >= 2 ? null : "Preview with `--verifier-repeat 3` to show the verifier cost of a stable score.",
    },
    {
      id: "candidate-allowance",
      status: candidates !== null ? "pass" : "warn",
      detail:
        candidates !== null
          ? `${candidates} candidate generations per search is the planning allowance`
          : "candidate generations are not bounded in the spec; the preview cannot size the run",
      action: candidates !== null ? null : "Pass `--candidates N` to size the worst-case generations and cost.",
    },
    {
      id: "paid-model",
      status: paid ? "pass" : "warn",
      detail: paid
        ? `every arm uses a deterministic agent (${experiments.map((e) => e.agent).join(", ")})`
        : "at least one arm leaves the default coding agent in place; model calls are billed by the provider",
      action: paid ? null : "For a plumbing study use `defaults: {agent: toy}`; expect provider spend otherwise.",
    },
  ];

  const base = options.hillclimbDir;
  const specArg = options.specPath === null ? `<spec>` : displayPath(options.specPath, base);
  return {
    schema: STUDY_PREVIEW_SCHEMA,
    study: spec.name,
    specPath: options.specPath,
    hillclimbDir: base,
    problems: spec.problems,
    repeats,
    schedule: spec.schedule,
    maxConcurrent: spec.maxConcurrent,
    control: spec.control,
    budget: { text: budgetText, seconds: budgetSeconds },
    experiments,
    jobs,
    allocation: {
      equalBudget: true,
      matchedRepeats: repeats >= 2,
      searches: jobs.length,
      searchesPerExperiment,
      perSearchBudgetSeconds: budgetSeconds,
      sequentialWallClockSeconds: sequential,
      parallelWallClockSeconds: parallel,
      candidateGenerations: {
        perSearch: candidates,
        total: candidates === null ? null : candidates * jobs.length,
        source: candidates === null ? "unbounded by preview" : "preview allowance",
      },
      verifierRepeats: { perSearch: verifierRepeat, total: verifierRepeat * jobs.length },
      parameterTrials: { perSearch: trialAllowance, total: trialAllowance * jobs.length },
      paidModelCalls: {
        value: paid ? 0 : null,
        basis: paid ? "deterministic agents" : "unknown: provider bills model calls",
      },
    },
    checks,
    commands: {
      dryRun: `cd ${quote(base)} && hillclimb experiment run ${quote(specArg)} --dry-run`,
      run: `cd ${quote(base)} && hillclimb experiment run ${quote(specArg)}`,
      report: `cd ${quote(base)} && hillclimb experiment report ${quote(spec.name)} --json > ${quote(
        join(base, `${spec.name}-report.json`),
      )}`,
      reportImport: `hillclimb study-report --dir ${quote(base)} --artifact ${quote(
        join(base, `${spec.name}-report.json`),
      )}`,
      verifyNoise: `cd ${quote(base)} && hillclimb verify ${quote(spec.problems[0] ?? "<problem>")} --repeat 5`,
    },
  };
}

export function renderStudyPreview(preview: StudyPreview): string {
  const lines = [
    `Study ${preview.study} · ${preview.specPath ?? "(spec name only)"}`,
    `${preview.problems.join(", ")} · ${preview.experiments.length} experiments × ${preview.repeats} repeats × ${preview.problems.length} problem(s) = ${preview.allocation.searches} searches, ${preview.schedule}`,
    `Budget: ${preview.budget.text ?? "(run default)"} per search · sequential wall clock ${duration(preview.allocation.sequentialWallClockSeconds)} · parallel ${duration(preview.allocation.parallelWallClockSeconds)}`,
    `Control: ${preview.control} (first experiment) · arms: ${preview.experiments.map((e) => e.name).join(", ")}`,
    "",
    "Allocation",
    `  searches per arm: ${preview.allocation.searchesPerExperiment}`,
    `  candidate generations: ${preview.allocation.candidateGenerations.total ?? "unknown"} (${preview.allocation.candidateGenerations.source})`,
    `  verifier repeats: ${preview.allocation.verifierRepeats.total}`,
    `  parameter trials: ${preview.allocation.parameterTrials.total}`,
    `  paid model calls: ${preview.allocation.paidModelCalls.value ?? "unknown"} (${preview.allocation.paidModelCalls.basis})`,
    "",
    "Checks",
    ...preview.checks.map((check) => `  ${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}`),
  ];
  const fixes = preview.checks.filter((check) => check.action !== null);
  if (fixes.length > 0) {
    lines.push("", "Fix before spending");
    for (const check of fixes) lines.push(`  ${check.id}: ${check.action}`);
  }
  lines.push(
    "",
    "Worker-local commands (this plugin never runs them)",
    `  dry run: ${preview.commands.dryRun}`,
    `  run: ${preview.commands.run}`,
    `  report artifact: ${preview.commands.report}`,
    `  import the artifact: ${preview.commands.reportImport}`,
    `  measure the noise floor: ${preview.commands.verifyNoise}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report: the native summary, imported or reconstructed
// ---------------------------------------------------------------------------

export interface StudyRow {
  study: string;
  experiment: string;
  repeat: number;
  problemId: string;
  problemKey: string;
  runId: string;
  searchId: string;
  state: string;
  holdout: number | null;
  val: number | null;
  higherIsBetter: boolean;
  startedAt: string;
  candidates: number;
  tokens: number;
  minutesToBest: number | null;
  budgetSeconds: number | null;
  lastError: string | null;
}

export interface NativeExperimentStats {
  experiment: string;
  control: boolean;
  n: number;
  scores: number[];
  mean: number | null;
  median: number | null;
  spread: number | null;
  wins: number;
  minutes_to_best: number | null;
  tokens: number | null;
  searches: string[];
}

export interface NativeComparison {
  experiment: string;
  control: string;
  gap: number | null;
  wins: number;
  losses: number;
  ties: number;
  within_noise: boolean | null;
  threshold: number | null;
  threshold_source: string | null;
  verdict: "better" | "worse" | "tie" | "within-noise" | "unknown";
}

export interface NativeSummary {
  study: string;
  problem_id: string;
  problem_key: string;
  higher_is_better: boolean;
  noise_floor: number | null;
  experiments: NativeExperimentStats[];
  comparisons: NativeComparison[];
  unfinished: Array<{ search: string; experiment: string; state: string }>;
}

export interface StudyReport {
  schema: typeof STUDY_REPORT_SCHEMA;
  status: "complete" | "inconclusive" | "incomplete";
  source: {
    kind: "artifact" | "store";
    path: string;
    runs: string[];
    studies: string[];
    truncated: string[];
  };
  matched: {
    basis: "store" | "artifact";
    sameBudget: boolean | null;
    sameRepeats: boolean | null;
    sameRunCounts: boolean | null;
    budgets: Record<string, number | null>;
    repeats: Record<string, number[]>;
    problems: string[];
    notes: string[];
  };
  summaries: NativeSummary[];
  arms: Array<{
    study: string;
    problem_key: string;
    experiment: string;
    role: "control" | "treatment";
    runs: number;
    scored: number;
    failed: number;
    state: Record<string, number>;
    mean: number | null;
    median: number | null;
    spread: number | null;
    wins: number;
    budgetSeconds: number | null;
    repeats: number[];
  }>;
  failures: Array<{ search: string; experiment: string; state: string; error: string | null }>;
  inconclusives: Array<{
    study: string;
    problem_key: string;
    experiment: string;
    control: string;
    gap: number | null;
    threshold: number | null;
    threshold_source: string | null;
    reason: string;
  }>;
  actions: string[];
  commands: { nativeReport: string; preview: string; resumeFailed: string[]; addRepeats: string | null };
}

export interface ReportOptions {
  io: StudyIO;
  /** Hillclimb dir, runs dir, or one run dir. */
  root: string;
  study?: string | null;
  run?: string | null;
  problem?: string | null;
  control?: string | null;
  noiseFloor?: number | null;
  artifactPath?: string | null;
}

export async function buildStudyReport(options: ReportOptions): Promise<StudyReport> {
  const { io, root } = options;
  const artifactPath = options.artifactPath ?? null;
  if (artifactPath !== null) {
    assertWithin(root, artifactPath, "read");
    const text = await readStrictText(io, artifactPath, "study artifact");
    if (text === null) {
      throw new PluginCliError(`no study artifact at ${artifactPath}`, {
        code: "artifact_not_found",
        hint: "Produce it in the worker's own shell: hillclimb experiment report <study> --json > report.json",
      });
    }
    const summaries = parseArtifact(text, artifactPath);
    return assembleReport({
      summaries,
      rows: [],
      source: { kind: "artifact", path: artifactPath, runs: [], studies: unique(summaries.map((s) => s.study)), truncated: [] },
      control: options.control ?? null,
      noiseFloor: options.noiseFloor ?? null,
      root,
      studyFilter: options.study ?? null,
      problemFilter: options.problem ?? null,
    });
  }

  const truncated = new Set<string>();
  const runs = await findRunDirs(io, root, truncated);
  if (runs.length === 0) {
    throw new PluginCliError(`no study run records under ${root}`, {
      code: "no_study_runs",
      hint: `Run a study in the worker's own shell first: cd ${quote(root)} && hillclimb experiment run <spec>. ` +
        `Then import the artifact with --artifact <report.json>, or point --dir at the hillclimb folder.`,
    });
  }

  const { rows, studies, runIds, specByRun, hillclimbDir } = await collectRows(io, root, runs, {
    study: options.study ?? null,
    run: options.run ?? null,
  }, truncated);
  if (rows.length === 0) {
    throw new PluginCliError(`no finished study-tagged searches under ${root}`, {
      code: "no_study_rows",
      hint: options.study !== null && options.study !== undefined
        ? `No search is tagged study=${JSON.stringify(options.study)}. Drop --study or check the run's search.yaml.`
        : "Searches need `study:` and `experiment:` tags; `hillclimb experiment run` writes them.",
    });
  }

  const summaries = summarizeRows(rows, {
    control: options.control ?? controlFromSpecs(specByRun, rows),
    noiseFloor: noiseFloorFor(rows, specByRun, hillclimbDir, options.noiseFloor ?? null),
    problemFilter: options.problem ?? null,
    studyFilter: options.study ?? null,
  });
  return assembleReport({
    summaries,
    rows,
    source: { kind: "store", path: root, runs: unique(runIds), studies: unique(studies), truncated: [...truncated] },
    control: options.control ?? null,
    noiseFloor: options.noiseFloor ?? null,
    root,
    studyFilter: options.study ?? null,
    problemFilter: options.problem ?? null,
  });
}

function assembleReport(input: {
  summaries: NativeSummary[];
  rows: StudyRow[];
  source: StudyReport["source"];
  control: string | null;
  noiseFloor: number | null;
  root: string;
  studyFilter: string | null;
  problemFilter: string | null;
}): StudyReport {
  const { summaries, rows } = input;
  const budgets: Record<string, number | null> = {};
  const repeats: Record<string, number[]> = {};
  for (const row of rows) {
    budgets[row.experiment] = row.budgetSeconds;
    const set = repeats[row.experiment] ?? [];
    if (!set.includes(row.repeat)) set.push(row.repeat);
    repeats[row.experiment] = set;
  }
  for (const key of Object.keys(repeats)) repeats[key] = (repeats[key] ?? []).sort((a, b) => a - b);
  const budgetValues = Object.values(budgets);
  const sameBudget =
    budgetValues.length === 0
      ? null
      : budgetValues.every((value) => value !== null && value === budgetValues[0]);
  const repeatSets = Object.values(repeats);
  const sameRepeats =
    repeatSets.length < 2
      ? repeatSets.length === 1
        ? repeatSets[0]!.length >= 2
        : null
      : repeatSets.every((set) => set.length === repeatSets[0]!.length && set.every((r) => repeatSets[0]!.includes(r)));

  const unfinishedByArm = new Map<string, number>();
  for (const summary of summaries) {
    for (const row of summary.unfinished) {
      const key = `${summary.study}\u0000${summary.problem_key}\u0000${row.experiment}`;
      unfinishedByArm.set(key, (unfinishedByArm.get(key) ?? 0) + 1);
    }
  }
  const arms: StudyReport["arms"] = [];
  for (const summary of summaries) {
    for (const stats of summary.experiments) {
      const matching = rows.filter(
        (row) => row.study === summary.study && row.problemKey === summary.problem_key && row.experiment === stats.experiment,
      );
      const states: Record<string, number> = {};
      for (const row of matching) states[row.state] = (states[row.state] ?? 0) + 1;
      const budgets = matching.map((row) => row.budgetSeconds);
      const budgetSeconds =
        budgets.length > 0 && budgets.every((value) => value === budgets[0]) ? (budgets[0] ?? null) : null;
      arms.push({
        study: summary.study,
        problem_key: summary.problem_key,
        experiment: stats.experiment,
        role: stats.control ? "control" : "treatment",
        runs: stats.n,
        scored: stats.n,
        failed:
          matching.length > 0
            ? matching.filter((row) => row.state !== "done" && scoreOf(row) === null).length
            : (unfinishedByArm.get(`${summary.study}\u0000${summary.problem_key}\u0000${stats.experiment}`) ?? 0),
        state: states,
        mean: stats.mean,
        median: stats.median,
        spread: stats.spread,
        wins: stats.wins,
        budgetSeconds,
        repeats: repeats[stats.experiment] ?? [],
      });
    }
  }

  const failures = [
    ...rows
      .filter((row) => row.state !== "done" && scoreOf(row) === null)
      .map((row) => ({
        search: `${row.runId}/${row.searchId}`,
        experiment: row.experiment,
        state: row.state,
        error: row.lastError,
      })),
    ...summaries.flatMap((summary) =>
      summary.unfinished.map((row) => ({
        search: row.search,
        experiment: row.experiment,
        state: row.state,
        error: null,
      })),
    ),
  ].filter((failure, index, all) => all.findIndex((other) => other.search === failure.search) === index);

  const inconclusives: StudyReport["inconclusives"] = [];
  for (const summary of summaries) {
    for (const comparison of summary.comparisons) {
      if (comparison.verdict === "within-noise" || comparison.verdict === "unknown") {
        inconclusives.push({
          study: summary.study,
          problem_key: summary.problem_key,
          experiment: comparison.experiment,
          control: comparison.control,
          gap: comparison.gap,
          threshold: comparison.threshold,
          threshold_source: comparison.threshold_source,
          reason:
            comparison.verdict === "within-noise"
              ? `the paired gap is smaller than ${comparison.threshold_source ?? "the noise threshold"} (${comparison.threshold ?? "?"})`
              : "no decision rule applies: no scores, or neither a noise floor nor two repeats to measure a spread",
        });
      }
    }
  }

  const truncated = input.source.truncated;
  const status: StudyReport["status"] =
    failures.length > 0 || truncated.length > 0 ? "incomplete" : inconclusives.length > 0 ? "inconclusive" : "complete";
  const actions = reportActions(summaries, failures, inconclusives, input.root, input.studyFilter);
  if (truncated.length > 0) {
    actions.unshift(
      `This report read truncated input(s): ${truncated.slice(0, 3).join(", ")}${truncated.length > 3 ? ", …" : ""}. ` +
        `Treat scores as partial; re-run the native report and import its artifact.`,
    );
  }
  const studyName = input.studyFilter ?? summaries[0]?.study ?? "<study>";
  const specHint = `experiments/${studyName}.yaml`;
  const nativeReport =
    `cd ${quote(input.root)} && hillclimb experiment report ${quote(studyName)} --json`;

  return {
    schema: STUDY_REPORT_SCHEMA,
    status,
    source: input.source,
    matched: {
      basis: input.source.kind === "artifact" ? "artifact" : "store",
      sameBudget,
      sameRepeats,
      sameRunCounts:
        summaries.length === 0
          ? null
          : summaries.every((summary) => {
              const counts = summary.experiments.map((stats) => stats.n);
              return counts.length < 2 || counts.every((count) => count === counts[0]);
            }),
      budgets,
      repeats,
      problems: unique(summaries.map((summary) => summary.problem_key)),
      notes:
        input.source.kind === "artifact"
          ? ["the native artifact records scores and n, not per-search budgets or repeat numbers; import the run store with --dir for exact matching"]
          : [],
    },
    summaries,
    arms,
    failures,
    inconclusives,
    actions,
    commands: {
      nativeReport,
      preview: `hillclimb study-preview ${quote(specHint)} --dir ${quote(input.root)}`,
      resumeFailed: failures.map((failure) => `hillclimb resume ${quote(failure.search)}`),
      addRepeats: nextRepeatCommand(input.root, studyName, rows, specHint),
    },
  };
}

function reportActions(
  summaries: NativeSummary[],
  failures: StudyReport["failures"],
  inconclusives: StudyReport["inconclusives"],
  root: string,
  studyFilter: string | null,
): string[] {
  const actions: string[] = [];
  if (failures.length > 0) {
    actions.push(
      `Finish or resume ${failures.length} search(es) before reading a winner: ${failures
        .slice(0, 3)
        .map((failure) => `${failure.search} (${failure.state})`)
        .join(", ")}${failures.length > 3 ? ", …" : ""}.`,
    );
  }
  if (inconclusives.length > 0) {
    actions.push(
      `Treat ${inconclusives.length} comparison(s) as inconclusive. Add independent repeats to both arms; ` +
        `the spread across repeats, not a point estimate, is what separates the arms.`,
    );
    const missingFloor = summaries.some((summary) => summary.noise_floor === null);
    if (missingFloor) {
      actions.push(
        `Measure the verifier noise once: cd ${quote(root)} && hillclimb verify ${
          quote(summaries[0]?.problem_id ?? "<problem>")
        } --repeat 5, then set it in the spec as noise_floor.`,
      );
    }
  }
  const decided = summaries.flatMap((summary) =>
    summary.comparisons.filter((comparison) => comparison.verdict === "better" || comparison.verdict === "worse"),
  );
  for (const comparison of decided) {
    const direction = comparison.verdict === "better" ? "ahead of" : "behind";
    actions.push(
      `${comparison.experiment} is ${direction} ${comparison.control} by ${comparison.gap ?? "?"} beyond ${
        comparison.threshold_source ?? "the threshold"
      } (${comparison.threshold ?? "?"}); record the criterion it proves before calling it a win.`,
    );
  }
  if (decided.length === 0 && inconclusives.length === 0 && failures.length === 0) {
    actions.push("No comparison reached a decision rule; extend repeats or set a noise floor.");
  }
  if (studyFilter === null) {
    actions.push("Pass --study <name> to narrow the report when the store holds more than one study.");
  }
  return unique(actions);
}

function nextRepeatCommand(root: string, study: string, rows: StudyRow[], specHint: string): string | null {
  const repeats = rows.map((row) => row.repeat);
  const max = repeats.length > 0 ? Math.max(...repeats) : 0;
  if (max === 0) return null;
  return `cd ${quote(root)} && hillclimb experiment run ${quote(specHint)} --first-repeat ${max + 1}`;
}

export function renderStudyReport(report: StudyReport): string {
  const lines: string[] = [];
  lines.push(`Study report · ${report.source.kind} · ${report.source.path}`);
  lines.push(
    `status: ${report.status} · matched budget: ${report.matched.sameBudget ?? "unknown"} · matched repeats: ${
      report.matched.sameRepeats ?? "unknown"
    } · matched run counts: ${report.matched.sameRunCounts ?? "unknown"} · basis: ${report.matched.basis}`,
  );
  for (const note of report.matched.notes) lines.push(`note: ${note}`);
  if (report.source.truncated.length > 0) {
    lines.push(
      `WARNING: truncated read(s): ${report.source.truncated.slice(0, 3).join(", ")}${
        report.source.truncated.length > 3 ? ", …" : ""
      }; results may be partial`,
    );
  }
  for (const summary of report.summaries) {
    const direction = summary.higher_is_better ? "higher is better" : "lower is better";
    lines.push("", `## ${summary.study} · ${summary.problem_key} (${direction})`, "");
    lines.push("| experiment | n | mean | median | spread | wins | min→best | tokens |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const stats of summary.experiments) {
      const tag = stats.control && summary.experiments.length > 1 ? " (control)" : "";
      lines.push(
        `| ${stats.experiment}${tag} | ${stats.n} | ${fmtNumber(stats.mean)} | ${fmtNumber(stats.median)} | ${fmtNumber(
          stats.spread,
          3,
        )} | ${stats.wins} | ${fmtNumber(stats.minutes_to_best, 3)} | ${fmtTokens(stats.tokens)} |`,
      );
    }
    lines.push("");
    for (const comparison of summary.comparisons) {
      lines.push(`${comparison.experiment}: ${comparisonLine(comparison)}`);
    }
    if (summary.unfinished.length > 0) {
      lines.push(
        `not finished: ${summary.unfinished
          .map((row) => `${row.search} (${row.experiment}, ${row.state})`)
          .join(", ")}`,
      );
    }
  }
  if (report.failures.length > 0) {
    lines.push("", "Failures / unfinished");
    for (const failure of report.failures) {
      lines.push(`  ${failure.search} · ${failure.experiment} · ${failure.state}${failure.error === null ? "" : ` · ${failure.error}`}`);
    }
  }
  if (report.inconclusives.length > 0) {
    lines.push("", "Inconclusive");
    for (const item of report.inconclusives) {
      lines.push(`  ${item.experiment} vs ${item.control} (${item.problem_key}): ${item.reason}`);
    }
  }
  if (report.actions.length > 0) {
    lines.push("", "Actions");
    for (const action of report.actions) lines.push(`  - ${action}`);
  }
  lines.push("", "Next (worker-local; this plugin never runs it)", `  ${report.commands.nativeReport} > report.json`);
  if (report.commands.resumeFailed.length > 0) {
    lines.push(`  ${report.commands.resumeFailed[0]}${report.commands.resumeFailed.length > 1 ? "  (and the other failures above)" : ""}`);
  }
  if (report.commands.addRepeats !== null) lines.push(`  ${report.commands.addRepeats}`);
  return lines.join("\n");
}

function comparisonLine(comparison: NativeComparison): string {
  if (comparison.gap === null) return `no scores to compare against ${comparison.control}`;
  const sign = comparison.gap >= 0 ? "+" : "";
  let text = `${sign}${trimNumber(comparison.gap, 4)} vs ${comparison.control}`;
  if (comparison.within_noise === true) {
    text += ` — within noise (${comparison.threshold ?? "?"}${
      comparison.threshold_source === "repeat spread" ? ", the spread across repeats" : ""
    }), not a result`;
  } else if (comparison.gap === 0) {
    text += " — tie";
  } else if (comparison.within_noise === false) {
    text += ` — ${comparison.verdict} beyond ${comparison.threshold_source ?? "noise"} (${comparison.threshold ?? "?"})`;
  } else {
    text += ` — ${comparison.verdict} (no noise floor or repeat spread known)`;
  }
  text += `; wins ${comparison.wins}, loses ${comparison.losses}, ties ${comparison.ties}`;
  return text;
}

// ---------------------------------------------------------------------------
// Native summary math (a faithful port of hillclimb/experiment.py)
// ---------------------------------------------------------------------------

export function summarizeRows(
  rows: StudyRow[],
  options: {
    control?: string | null;
    noiseFloor?: Record<string, number | null> | number | null;
    problemFilter?: string | null;
    studyFilter?: string | null;
  } = {},
): NativeSummary[] {
  const floorFor = (problemId: string): number | null => {
    if (typeof options.noiseFloor === "number") return options.noiseFloor;
    if (isRecord(options.noiseFloor)) return (options.noiseFloor as Record<string, number | null>)[problemId] ?? null;
    return null;
  };
  const groups = new Map<string, StudyRow[]>();
  for (const row of rows) {
    if (options.studyFilter !== null && options.studyFilter !== undefined && row.study !== options.studyFilter) continue;
    if (options.problemFilter !== null && options.problemFilter !== undefined && row.problemKey !== options.problemFilter && row.problemId !== options.problemFilter) continue;
    const key = `${row.study}\u0000${row.problemKey}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const summaries: NativeSummary[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = [...(groups.get(key) ?? [])].sort(
      (a, b) => a.repeat - b.repeat || a.startedAt.localeCompare(b.startedAt),
    );
    const first = group[0];
    if (first === undefined) continue;
    const higher = first.higherIsBetter;
    const finished = group.filter((row) => row.state === "done" || scoreOf(row) !== null);
    const unfinished = group.filter((row) => !finished.includes(row));
    const order: string[] = [];
    for (const row of [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (!order.includes(row.experiment)) order.push(row.experiment);
    }
    const control = options.control ?? order[0] ?? null;
    if (control !== null && order.includes(control)) {
      const at = order.indexOf(control);
      order.splice(at, 1);
      order.unshift(control);
    }
    const byExperiment = new Map<string, StudyRow[]>();
    for (const name of order) byExperiment.set(name, finished.filter((row) => row.experiment === name));

    const wins = new Map<string, number>(order.map((name) => [name, 0]));
    const byRepeat = new Map<number, StudyRow[]>();
    for (const row of finished) {
      if (scoreOf(row) === null) continue;
      const repeat = byRepeat.get(row.repeat) ?? [];
      repeat.push(row);
      byRepeat.set(row.repeat, repeat);
    }
    for (const contenders of byRepeat.values()) {
      const top = contenders[0];
      if (top === undefined) continue;
      let winner = top;
      for (const row of contenders.slice(1)) {
        if (better(scoreOf(row), scoreOf(winner), higher)) winner = row;
      }
      const tied = contenders.some((row) => row !== winner && scoreOf(row) === scoreOf(winner));
      if (!tied) wins.set(winner.experiment, (wins.get(winner.experiment) ?? 0) + 1);
    }

    const experiments: NativeExperimentStats[] = order.map((name) => {
      const stats = byExperiment.get(name) ?? [];
      return {
        experiment: name,
        control: name === order[0] && order.length > 1,
        n: stats.filter((row) => scoreOf(row) !== null).length,
        scores: stats.map(scoreOf).filter((score): score is number => score !== null),
        mean: mean(stats.map(scoreOf).filter((score): score is number => score !== null)),
        median: median(stats.map(scoreOf).filter((score): score is number => score !== null)),
        spread: spread(stats.map(scoreOf).filter((score): score is number => score !== null)),
        wins: wins.get(name) ?? 0,
        minutes_to_best: mean(stats.map((row) => row.minutesToBest).filter((value): value is number => value !== null)),
        tokens: stats.length === 0 ? null : mean(stats.map((row) => row.tokens)),
        searches: stats.map((row) => `${row.runId}/${row.searchId}`),
      };
    });

    const floor = floorFor(first.problemId);
    const comparisons: NativeComparison[] = [];
    const controlStats = experiments[0];
    if (controlStats !== undefined) {
      const controlByRepeat = new Map<number, StudyRow>();
      for (const row of byExperiment.get(controlStats.experiment) ?? []) {
        if (scoreOf(row) !== null) controlByRepeat.set(row.repeat, row);
      }
      for (const stats of experiments.slice(1)) {
        let w = 0;
        let l = 0;
        let t = 0;
        const diffs: number[] = [];
        for (const row of byExperiment.get(stats.experiment) ?? []) {
          const partner = controlByRepeat.get(row.repeat);
          const score = scoreOf(row);
          if (partner === undefined || score === null) continue;
          const partnerScore = scoreOf(partner);
          if (partnerScore === null) continue;
          diffs.push(score - partnerScore);
          if (better(score, partnerScore, higher)) w += 1;
          else if (better(partnerScore, score, higher)) l += 1;
          else t += 1;
        }
        let gap: number | null;
        if (diffs.length > 0) gap = mean(diffs);
        else if (stats.mean !== null && controlStats.mean !== null) gap = stats.mean - controlStats.mean;
        else gap = null;
        const judged = threshold(floor, controlStats.spread, stats.spread);
        const within = gap !== null && judged.threshold !== null ? Math.abs(gap) < judged.threshold : null;
        comparisons.push({
          experiment: stats.experiment,
          control: controlStats.experiment,
          gap,
          wins: w,
          losses: l,
          ties: t,
          within_noise: within,
          threshold: judged.threshold,
          threshold_source: judged.source,
          verdict: verdictFor(gap, within, t, higher),
        });
      }
    }

    summaries.push({
      study: first.study,
      problem_id: first.problemId,
      problem_key: first.problemKey,
      higher_is_better: higher,
      noise_floor: floor,
      experiments,
      comparisons,
      unfinished: unfinished.map((row) => ({ search: `${row.runId}/${row.searchId}`, experiment: row.experiment, state: row.state })),
    });
  }
  return summaries;
}

function verdictFor(
  gap: number | null,
  withinNoise: boolean | null,
  _ties: number,
  higherIsBetter: boolean,
): NativeComparison["verdict"] {
  if (gap === null) return "unknown";
  if (withinNoise === true) return "within-noise";
  if (gap === 0) return "tie";
  if (withinNoise === null) return "unknown";
  return (gap > 0) === higherIsBetter ? "better" : "worse";
}

function threshold(floor: number | null, ...spreads: Array<number | null>): { threshold: number | null; source: string | null } {
  const spreadValue = spreads.reduce<number | null>((max, value) => {
    if (value === null) return max;
    return max === null || value > max ? value : max;
  }, null);
  if (floor === null && spreadValue === null) return { threshold: null, source: null };
  if (spreadValue !== null && (floor === null || spreadValue > floor)) return { threshold: spreadValue, source: "repeat spread" };
  return { threshold: floor, source: "noise floor" };
}

function better(a: number | null, b: number | null, higherIsBetter: boolean): boolean {
  if (a === null || b === null) return false;
  return higherIsBetter ? a > b : a < b;
}

export function scoreOf(row: StudyRow): number | null {
  return row.holdout ?? row.val;
}

// ---------------------------------------------------------------------------
// Reading the run store
// ---------------------------------------------------------------------------

async function collectRows(
  io: StudyIO,
  root: string,
  runs: string[],
  filter: { study: string | null; run: string | null },
  truncated: Set<string>,
): Promise<{
  rows: StudyRow[];
  studies: string[];
  runIds: string[];
  specByRun: Map<string, StudySpec | null>;
  hillclimbDir: string;
}> {
  const rows: StudyRow[] = [];
  const studies: string[] = [];
  const runIds: string[] = [];
  const specByRun = new Map<string, StudySpec | null>();
  for (const runDir of runs) {
    const runText = await readStrictText(io, join(runDir, "run.yaml"), "run record");
    if (runText === null) continue;
    const run = asRecord(parseYamlSubset(runText));
    const runId = typeof run.run_id === "string" ? run.run_id : basename(runDir);
    if (filter.run !== null && runId !== filter.run) continue;
    runIds.push(runId);
    const hillclimbDir = resolveRunHillclimbDir(runDir);
    const spec = await loadSpecForRun(io, run, hillclimbDir, root);
    specByRun.set(runId, spec);
    if (spec !== null) studies.push(spec.name);
    const searchesDir = join(runDir, "searches");
    const searches = await io.listDir(searchesDir);
    if (searches.truncated) truncated.add(`listing:${searchesDir}`);
    for (const entry of searches.entries) {
      if (entry.kind !== "directory") continue;
      const searchDir = join(searchesDir, entry.name);
      const metaText = await readStrictText(io, join(searchDir, "search.yaml"), "search record");
      if (metaText === null) continue;
      const meta = asRecord(parseYamlSubset(metaText));
      const study = typeof meta.study === "string" ? meta.study : "";
      const experiment = typeof meta.experiment === "string" ? meta.experiment : "";
      if (study === "" || experiment === "") continue;
      if (filter.study !== null && study !== filter.study) continue;
      const status = await readJsonObject(io, join(searchDir, "status.json"));
      const state = status !== null && typeof status.state === "string" ? status.state : "unknown";
      if (state === "running") continue;
      const selected = status !== null && isRecord(status.selected) ? status.selected : null;
      const holdout = selected === null ? null : numberOrNull(selected.holdout_score);
      const val = selected === null ? null : numberOrNull(selected.val_score);
      const journal = await readJournal(io, join(searchDir, "journal.jsonl"));
      if (journal.truncated) truncated.add(join(searchDir, "journal.jsonl"));
      const candidates = [...journal.candidates.values()];
      const scored = candidates.filter((candidate) => candidateValScore(candidate) !== null);
      const higher = meta.higher_is_better !== false;
      const created = typeof meta.started_at === "string" ? meta.started_at : "";
      const best = lastAccepted(candidates, higher);
      const tokens = candidates.reduce((sum, candidate) => {
        const agent = isRecord(candidate.agent) ? candidate.agent : null;
        return sum + (agent === null ? 0 : numberOrZero(agent.total_tokens));
      }, 0);
      const searchId = typeof meta.search_id === "string" ? meta.search_id : entry.name;
      const studyName = study;
      rows.push({
        study: studyName,
        experiment,
        repeat: typeof meta.repeat === "number" && Number.isFinite(meta.repeat) ? meta.repeat : 0,
        problemId: typeof meta.problem_id === "string" ? meta.problem_id : "",
        problemKey:
          typeof meta.problem_key === "string" && meta.problem_key !== ""
            ? meta.problem_key
            : typeof meta.problem_id === "string"
              ? meta.problem_id
              : "",
        runId: typeof meta.run_id === "string" ? meta.run_id : runId,
        searchId,
        state,
        holdout,
        val,
        higherIsBetter: higher,
        startedAt: created,
        candidates: scored.length,
        tokens,
        minutesToBest: best === null || created === "" ? null : minutesSince(bestFinished(best), created),
        budgetSeconds: numberOrNull(meta.budget_s),
        lastError: status !== null && typeof status.last_error === "string" ? status.last_error : null,
      });
      studies.push(studyName);
    }
  }
  rows.sort(
    (a, b) =>
      a.study.localeCompare(b.study) ||
      a.problemKey.localeCompare(b.problemKey) ||
      a.repeat - b.repeat ||
      a.startedAt.localeCompare(b.startedAt),
  );
  return { rows, studies, runIds, specByRun, hillclimbDir: runs[0] === undefined ? "" : resolveRunHillclimbDir(runs[0]) };
}

async function findRunDirs(io: StudyIO, root: string, truncated: Set<string>): Promise<string[]> {
  if ((await readText(io, join(root, "run.yaml"))) !== null) return [root];
  const runsListing = await io.listDir(join(root, "runs"));
  if (runsListing.truncated) truncated.add(`listing:${join(root, "runs")}`);
  const runsChildren = runsListing.entries.filter((entry) => entry.kind === "directory");
  if (runsChildren.length > 0) {
    return runsChildren.map((entry) => join(root, "runs", entry.name)).sort();
  }
  const directListing = await io.listDir(root);
  if (directListing.truncated) truncated.add(`listing:${root}`);
  const direct = directListing.entries.filter((entry) => entry.kind === "directory");
  const valid: string[] = [];
  for (const entry of direct) {
    const dir = join(root, entry.name);
    if ((await readText(io, join(dir, "run.yaml"))) !== null) valid.push(dir);
  }
  return valid.sort();
}

function resolveRunHillclimbDir(runDir: string): string {
  // <hillclimb>/runs/<run-id> → <hillclimb>; a bare run dir is its own root's child.
  return resolve(runDir, "..", "..");
}

async function loadSpecForRun(
  io: StudyIO,
  run: Record<string, unknown>,
  hillclimbDir: string,
  root: string,
): Promise<StudySpec | null> {
  const specRef = typeof run.spec === "string" ? run.spec : null;
  if (specRef === null) return null;
  const candidates = [resolve(hillclimbDir, specRef), resolve(hillclimbDir, "experiments", `${String(run.name)}.yaml`)];
  for (const candidate of candidates) {
    // A spec path comes from run.yaml: never read it outside the selected root.
    if (!isWithin(root, candidate)) continue;
    const text = await readStrictText(io, candidate, "study spec");
    if (text === null) continue;
    try {
      return normalizeStudySpec(parseYamlSubset(text), typeof run.name === "string" ? run.name : specStem(candidate), candidate);
    } catch {
      return null;
    }
  }
  return null;
}

function controlFromSpecs(specByRun: Map<string, StudySpec | null>, rows: StudyRow[]): string | null {
  for (const row of rows) {
    const spec = specByRun.get(row.runId);
    if (spec !== null && spec !== undefined) return spec.control;
  }
  return null;
}

function noiseFloorFor(
  rows: StudyRow[],
  specByRun: Map<string, StudySpec | null>,
  hillclimbDir: string,
  override: number | null,
): Record<string, number | null> {
  void hillclimbDir;
  const floors: Record<string, number | null> = {};
  for (const row of rows) {
    const spec = specByRun.get(row.runId) ?? null;
    const floor = spec === null ? null : spec.noiseFloor;
    let value: number | null = override;
    if (value === null && typeof floor === "number") value = floor;
    if (value === null && isRecord(floor)) {
      value = numberOrNull(floor[row.problemId] ?? floor[row.problemKey] ?? null);
    }
    floors[row.problemId] = value;
    floors[row.problemKey] = value;
  }
  return floors;
}

async function readJournal(
  io: StudyIO,
  path: string,
): Promise<{ candidates: Map<string, Record<string, unknown>>; truncated: boolean }> {
  const file = await io.readFile(path);
  const out = new Map<string, Record<string, unknown>>();
  if (file.content === null) return { candidates: out, truncated: false };
  for (const line of file.content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.event !== "candidate_result") continue;
    if (typeof parsed.candidate_id !== "string") continue;
    out.set(parsed.candidate_id, parsed);
  }
  return { candidates: out, truncated: file.truncated };
}

function trialValScore(trial: Record<string, unknown>): number | null {
  const replicates = Array.isArray(trial.replicates) ? trial.replicates : [];
  const scores = replicates
    .map((replicate) => (isRecord(replicate) ? numberOrNull(replicate.val_score) : null))
    .filter((value): value is number => value !== null);
  if (scores.length > 0) return median(scores);
  return numberOrNull(trial.val_score);
}

function candidateValScore(candidate: Record<string, unknown>): number | null {
  const trials = (Array.isArray(candidate.trials) ? candidate.trials : []).filter(isRecord);
  const scored = trials.filter((trial) => trialValScore(trial) !== null);
  if (scored.length === 0) return null;
  const flagged = scored.filter((trial) => trial.is_best === true);
  const chosen = flagged.length > 0 ? flagged[flagged.length - 1] : scored[scored.length - 1];
  return chosen === undefined ? null : trialValScore(chosen);
}

function lastAccepted(candidates: Array<Record<string, unknown>>, higherIsBetter: boolean): Record<string, unknown> | null {
  const ordered = [...candidates].sort((a, b) => when(a).localeCompare(when(b)));
  let best: number | null = null;
  let accepted: Record<string, unknown> | null = null;
  for (const candidate of ordered) {
    const score = candidateValScore(candidate);
    if (score === null || candidate.status !== "passing" || candidate.pruned === true) continue;
    if (best === null || better(score, best, higherIsBetter)) {
      best = score;
      accepted = candidate;
    }
  }
  return accepted;
}

function when(candidate: Record<string, unknown>): string {
  if (typeof candidate.finished_at === "string" && candidate.finished_at !== "") return candidate.finished_at;
  if (typeof candidate.created_at === "string" && candidate.created_at !== "") return candidate.created_at;
  return "";
}

function bestFinished(candidate: Record<string, unknown>): string | null {
  return typeof candidate.finished_at === "string" && candidate.finished_at !== "" ? candidate.finished_at : null;
}

function minutesSince(stamp: string | null, origin: string | null): number | null {
  if (stamp === null || origin === null) return null;
  const then = Date.parse(stamp);
  const from = Date.parse(origin);
  if (!Number.isFinite(then) || !Number.isFinite(from)) return null;
  return Math.max(0, (then - from) / 60_000);
}

async function readJsonObject(io: StudyIO, path: string): Promise<Record<string, unknown> | null> {
  const text = await readStrictText(io, path, "search status");
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The artifact (`hillclimb experiment report --json`)
// ---------------------------------------------------------------------------

function parseArtifact(text: string, path: string): NativeSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PluginCliError(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      code: "artifact_invalid",
      hint: "Produce it with: hillclimb experiment report <study> --json > report.json",
    });
  }
  if (!Array.isArray(parsed)) {
    throw new PluginCliError(`${path} is not a native study report (expected a JSON array of summaries)`, {
      code: "artifact_invalid",
      hint: "Import the output of `hillclimb experiment report <study> --json`; the text report is not machine-parseable.",
    });
  }
  return parsed.map((entry, index) => {
    const fail = (message: string): never => {
      throw new PluginCliError(`${path} entry ${index}: ${message}`, {
        code: "artifact_invalid",
        hint: "Re-run `hillclimb experiment report <study> --json` with hillclimb 0.8.2; do not hand-edit the artifact.",
      });
    };
    if (!isRecord(entry)) fail("not a JSON object");
    const study = textField(entry.study);
    if (study === null) fail("missing study");
    const problemId = textField(entry.problem_id);
    if (problemId === null) fail("missing problem_id");
    const problemKey = textField(entry.problem_key) ?? problemId;
    const higherIsBetter = entry.higher_is_better !== false;
    if (!Array.isArray(entry.experiments)) fail("missing experiments array");
    if (!Array.isArray(entry.comparisons)) fail("missing comparisons array");
    const experiments = entry.experiments as unknown[];
    if (experiments.length === 0) fail("experiments is empty");
    const comparisons = entry.comparisons as unknown[];
    return {
      study: study as string,
      problem_id: problemId as string,
      problem_key: problemKey as string,
      higher_is_better: higherIsBetter,
      noise_floor: strictNumberOrNull(entry.noise_floor, "noise_floor", fail),
      experiments: experiments.map((statsRaw, statsIndex) => {
        if (!isRecord(statsRaw)) fail(`experiments[${statsIndex}] is not an object`);
        const stats = statsRaw as Record<string, unknown>;
        const experiment = textField(stats.experiment);
        if (experiment === null) fail(`experiments[${statsIndex}].experiment is missing`);
        const scores = Array.isArray(stats.scores) ? stats.scores : fail(`experiments[${statsIndex}].scores is missing`);
        const parsedScores = scores.map((score: unknown, scoreIndex: number) => {
          const value = strictNumber(score, `experiments[${statsIndex}].scores[${scoreIndex}]`, fail);
          return value;
        });
        const n = strictInteger(stats.n, `experiments[${statsIndex}].n`, fail);
        return {
          experiment: experiment as string,
          control: stats.control === true,
          n,
          scores: parsedScores,
          mean: strictNumberOrNull(stats.mean, `experiments[${statsIndex}].mean`, fail),
          median: strictNumberOrNull(stats.median, `experiments[${statsIndex}].median`, fail),
          spread: strictNumberOrNull(stats.spread, `experiments[${statsIndex}].spread`, fail),
          wins: strictInteger(stats.wins, `experiments[${statsIndex}].wins`, fail),
          minutes_to_best: strictNumberOrNull(stats.minutes_to_best, `experiments[${statsIndex}].minutes_to_best`, fail),
          tokens: strictNumberOrNull(stats.tokens, `experiments[${statsIndex}].tokens`, fail),
          searches: Array.isArray(stats.searches)
            ? stats.searches.map((search: unknown, searchIndex: number) => {
                const value = textField(search);
                if (value === null) fail(`experiments[${statsIndex}].searches[${searchIndex}] is not a string`);
                return value as string;
              })
            : [],
        };
      }),
      comparisons: comparisons.map((comparisonRaw, comparisonIndex) => {
        if (!isRecord(comparisonRaw)) fail(`comparisons[${comparisonIndex}] is not an object`);
        const comparison = comparisonRaw as Record<string, unknown>;
        const experiment = textField(comparison.experiment);
        if (experiment === null) fail(`comparisons[${comparisonIndex}].experiment is missing`);
        const control = textField(comparison.control);
        if (control === null) fail(`comparisons[${comparisonIndex}].control is missing`);
        const withinNoise = typeof comparison.within_noise === "boolean" ? comparison.within_noise : null;
        const gap = strictNumberOrNull(comparison.gap, `comparisons[${comparisonIndex}].gap`, fail);
        return {
          experiment: experiment as string,
          control: control as string,
          gap,
          wins: strictInteger(comparison.wins, `comparisons[${comparisonIndex}].wins`, fail),
          losses: strictInteger(comparison.losses, `comparisons[${comparisonIndex}].losses`, fail),
          ties: strictInteger(comparison.ties, `comparisons[${comparisonIndex}].ties`, fail),
          within_noise: withinNoise,
          threshold: strictNumberOrNull(comparison.threshold, `comparisons[${comparisonIndex}].threshold`, fail),
          threshold_source: textField(comparison.threshold_source),
          verdict: nativeVerdict(comparison.verdict, withinNoise, gap, higherIsBetter),
        };
      }),
      unfinished: Array.isArray(entry.unfinished)
        ? (entry.unfinished as unknown[]).map((rowRaw, rowIndex) => {
            if (!isRecord(rowRaw)) fail(`unfinished[${rowIndex}] is not an object`);
            const row = rowRaw as Record<string, unknown>;
            const search = textField(row.search);
            const experiment = textField(row.experiment);
            const state = textField(row.state);
            if (search === null || experiment === null || state === null) {
              fail(`unfinished[${rowIndex}] needs search, experiment and state strings`);
            }
            return { search: search as string, experiment: experiment as string, state: state as string };
          })
        : [],
    };
  });
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strictNumber(value: unknown, field: string, fail: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} is not a finite number`);
  return value as number;
}

function strictNumberOrNull(value: unknown, field: string, fail: (message: string) => never): number | null {
  if (value === null || value === undefined) return null;
  return strictNumber(value, field, fail);
}

function strictInteger(value: unknown, field: string, fail: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`${field} is not a non-negative integer`);
  return value as number;
}

function nativeVerdict(
  value: unknown,
  withinNoise: boolean | null,
  gap: number | null,
  higherIsBetter: boolean,
): NativeComparison["verdict"] {
  if (value === "better" || value === "worse" || value === "tie" || value === "within-noise" || value === "unknown") {
    return value;
  }
  if (withinNoise === true) return "within-noise";
  if (gap === null) return "unknown";
  if (gap === 0) return "tie";
  const better = higherIsBetter ? gap > 0 : gap < 0;
  return better ? "better" : "worse";
}

// ---------------------------------------------------------------------------
// High-level entrypoints for MCP tools & CLI
// ---------------------------------------------------------------------------

export interface StudyPreviewOptions {
  spec?: string;
  dir?: string;
  candidates?: number;
  verifierRepeat?: number;
  trialAllowance?: number;
  repeats?: number;
  budget?: string;
  io?: StudyIO;
}

export async function runStudyPreview(options: StudyPreviewOptions = {}) {
  const session = openStudySession(stringOption(options.dir), undefined, options.io);
  const specPath = await resolveStudySpec(session.io, session.root, stringOption(options.spec));
  const text = await readStrictText(session.io, specPath, "study spec");
  if (text === null) {
    throw new PluginCliError(`no study spec at ${specPath}`, {
      code: "spec_not_found",
      hint: "Pass a spec path, or a name under experiments/ (e.g. self-study).",
    });
  }
  let spec: StudySpec;
  try {
    spec = normalizeStudySpec(parseYamlSubset(text), specStem(specPath), specPath);
  } catch (error) {
    throw new PluginCliError(`${specPath}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "spec_invalid",
      hint: "A study spec needs problems, experiments, repeats and an optional budget; see skills/hill-climb/references/studies.md.",
    });
  }
  const preview = buildStudyPreview({
    hillclimbDir: session.root,
    specPath,
    spec,
    candidates: integerOption(options.candidates),
    verifierRepeat: integerOption(options.verifierRepeat) ?? 1,
    trialAllowance: integerOption(options.trialAllowance) ?? 0,
    repeatsOverride: integerOption(options.repeats),
    budgetOverride: stringOption(options.budget),
  });
  return {
    preview,
    text: cap(renderStudyPreview(preview)),
    jsonText: boundedJson(preview, "preview_too_large", "Drop json mode for the text preview, or reduce the job matrix."),
  };
}

export interface StudyReportOptions {
  dir?: string;
  artifact?: string;
  study?: string;
  run?: string;
  problem?: string;
  control?: string;
  noiseFloor?: number | string;
  io?: StudyIO;
}

export async function runStudyReport(options: StudyReportOptions = {}) {
  const session = openStudySession(stringOption(options.dir), undefined, options.io);
  const artifactOption = stringOption(options.artifact);
  let artifactPath: string | null = null;
  if (artifactOption !== null) {
    artifactPath = isAbsolute(artifactOption) ? artifactOption : posix.resolve(session.root, artifactOption);
    assertWithin(session.root, artifactPath, "read");
  }
  const noiseFloor =
    options.noiseFloor === undefined || options.noiseFloor === ""
      ? null
      : typeof options.noiseFloor === "number"
        ? options.noiseFloor
        : Number(options.noiseFloor);
  if (noiseFloor !== null && !Number.isFinite(noiseFloor)) {
    throw new PluginCliError(`--noise-floor must be a number, got ${JSON.stringify(options.noiseFloor)}`, {
      code: "invalid_noise_floor",
      hint: "Example: --noise-floor 0.02",
    });
  }
  const report = await buildStudyReport({
    io: session.io,
    root: session.root,
    study: stringOption(options.study),
    run: stringOption(options.run),
    problem: stringOption(options.problem),
    control: stringOption(options.control),
    noiseFloor,
    artifactPath,
  });
  return {
    report,
    text: cap(renderStudyReport(report)),
    jsonText: boundedJson(report, "report_too_large", "Narrow it with --study <name>, --run <id> or --problem <id>."),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function resolveStudySpec(io: StudyIO, root: string, target: string | null): Promise<string> {
  if (target !== null && target !== "") {
    const candidates = isAbsolute(target)
      ? [target]
      : [resolve(root, target), resolve(root, "experiments", `${target}.yaml`), resolve(root, "experiments", `${target}.yml`)];
    for (const candidate of candidates) {
      if (!isWithin(root, candidate)) continue;
      if ((await readText(io, candidate)) !== null) return candidate;
    }
    if (isAbsolute(target) && !isWithin(root, target)) {
      throw new PluginCliError(`${target} is outside the selected directory ${root}`, {
        code: "path_outside_root",
        hint: "Study paths must stay under --dir; move the spec there or pass the right --dir.",
      });
    }
    throw new PluginCliError(`no study spec ${JSON.stringify(target)}`, {
      code: "spec_not_found",
      hint: `Looked under ${root}: ${candidates.filter((candidate) => isWithin(root, candidate)).join(", ")}.`,
    });
  }
  const experimentsDir = join(root, "experiments");
  const listing = await io.listDir(experimentsDir);
  if (listing.truncated) {
    throw new PluginCliError(`the host capped the listing of ${experimentsDir}`, {
      code: "listing_truncated",
      hint: "Name the spec explicitly, e.g. `hillclimb study-preview self-study`.",
    });
  }
  const specs = listing.entries
    .filter((entry) => entry.kind === "file" && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(experimentsDir, entry.name))
    .sort();
  if (specs.length === 1) return specs[0] as string;
  if (specs.length === 0) {
    throw new PluginCliError(`no study spec under ${experimentsDir}`, {
      code: "spec_not_found",
      hint: `Create ${join(experimentsDir, "self-study.yaml")} or pass a spec path. See skills/hill-climb/references/studies.md.`,
    });
  }
  throw new PluginCliError(`name the study spec: ${experimentsDir} has ${specs.length}`, {
    code: "ambiguous_spec",
    hint: `Specs: ${specs.map((path) => displayPath(path, root)).join(", ")}.`,
  });
}

function boundedJson(value: unknown, code: string, hint: string): string {
  const body = JSON.stringify(value, null, 2);
  if (body.length > OUTPUT_LIMIT) {
    throw new PluginCliError(`JSON output is ${body.length} characters, over the ${OUTPUT_LIMIT} output limit`, {
      code,
      hint,
    });
  }
  return body;
}

function displayPath(path: string, base: string): string {
  if (path === base) return ".";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

function specStem(path: string): string {
  return basename(path).replace(/\.ya?ml$/i, "");
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function cap(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n\n[output truncated at ${OUTPUT_LIMIT} characters — narrow the query]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: YamlValue): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOption(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function integerOption(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function firstPositional(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  return Array.isArray(value) ? (value[0] ?? null) : null;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function spread(values: number[]): number | null {
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}

function trimNumber(value: number, digits: number): string {
  return String(Number(value.toPrecision(digits)));
}

function fmtNumber(value: number | null, digits = 5): string {
  return value === null ? "-" : trimNumber(value, digits);
}

function fmtTokens(value: number | null): string {
  if (value === null) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds >= 3600) return `${trimNumber(seconds / 3600, 3)}h`;
  if (seconds >= 60) return `${trimNumber(seconds / 60, 3)}m`;
  return `${trimNumber(seconds, 3)}s`;
}