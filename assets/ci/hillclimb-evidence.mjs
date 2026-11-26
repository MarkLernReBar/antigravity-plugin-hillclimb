#!/usr/bin/env node
// CI evidence hook: turn a test run into Hillclimb evidence, without guessing.
//
// The model is `src/model.ts` (Evidence) and `src/actions.ts` (add_evidence).
// This script never writes to a tree: it builds Evidence records and prints the
// exact `hillclimb act` command for each one, so the tree change goes through
// the same validation and approval path as an agent's action.
//
// A test opts in by naming the outcome it covers, optionally pinned to a
// contract version and to criteria:
//
//   it('HC-12: marks a verified outcome broken when denying evidence arrives', ...)
//   it('HC-12@3#ac1,ac2 refuses an export on a Free workspace', ...)
//
// Grammar:  <PREFIX>-<key>[ @<contractVersion> ][ #<criterionId>[,<criterionId>] ]
//
// Version rules, and the one that matters most: evidence belongs to the contract
// version it was observed against. A test tagged with an older version than the
// contract in hand proves the old contract, so it is refused (exit 2) rather than
// recorded against the current one: no downgrade. A tag naming a *newer* version
// than the contract in hand means the checkout is stale; that fails too, with the
// sync command that fixes it. An untagged version means "whatever is current".
//
// Usage:
//   node hillclimb-evidence.mjs --report results.json --format json \
//     --contract .hillclimb/tree.json --source "$RUN_URL" \
//     --project <project-id> --commands
//
// Exit codes: 0 built (or nothing tagged), 1 usage, 2 stale or invalid contract
// mapping. Never 0 for a run whose evidence could not be attached honestly.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const MAX_FAILING_NAMES = 20;
const MAX_TEXT = 4000;

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(text) {
  const out = {};
  const pattern = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    out[match[1]] = unescapeXml(match[2]);
  }
  return out;
}

/** The tag in a test name, or null. One tag per name; a second is an error. */
export function parseTestTag(name, options = {}) {
  const prefixes = normalisePrefixes(options.prefixes ?? "HC");
  if (prefixes.length === 0) return null;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_-])(${prefixes.map(escapeRegExp).join("|")})-([A-Za-z0-9][A-Za-z0-9_-]{0,95}?)(?:@(\\d+))?(?:#([A-Za-z0-9_-]+(?:\\s*,\\s*[A-Za-z0-9_-]+)*))?(?![A-Za-z0-9_-])`,
    "g",
  );
  const matches = [...String(name).matchAll(pattern)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      error: `names ${matches.length} outcome keys; a test proves one outcome`,
      matches: matches.map((match) => match[0]),
    };
  }
  const match = matches[0];
  const key = `${match[1]}-${match[2]}`;
  if (!KEY_PATTERN.test(key)) {
    return { error: `key "${key}" is not a valid outcome key`, matches: [match[0]] };
  }
  const version = match[3] === undefined ? null : Number(match[3]);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    return { error: `version "${match[3]}" is not a positive integer`, matches: [match[0]] };
  }
  const criteria =
    match[4] === undefined
      ? []
      : [...new Set(match[4].split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  return { key, version, criteria, raw: match[0] };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalisePrefixes(value) {
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return list
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== "")
    .map((prefix) => prefix.replace(/-\s*$/, ""))
    .filter((prefix) => /^[A-Za-z][A-Za-z0-9]*$/.test(prefix));
}

// ---------------------------------------------------------------------------
// Report parsers
// ---------------------------------------------------------------------------

/** JUnit XML -> [{ name, status, message }] */
export function parseJUnit(xml) {
  const results = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = attributes(match[1] ?? "");
    const body = match[3] ?? "";
    const name = attrs.name ?? attrs.classname ?? "(unnamed test)";
    let status = "passed";
    let message;
    if (/<failure\b/.test(body)) {
      status = "failed";
      const failure = /<failure\b([^>]*)>([\s\S]*?)(?:<\/failure>|$)/.exec(body);
      message = failure === null ? undefined : (attributes(failure[1] ?? "").message ?? failure[2]?.trim());
    } else if (/<error\b/.test(body)) {
      status = "failed";
      const error = /<error\b([^>]*)>([\s\S]*?)(?:<\/error>|$)/.exec(body);
      message = error === null ? undefined : (attributes(error[1] ?? "").message ?? error[2]?.trim());
    } else if (/<skipped\b/.test(body)) {
      status = "skipped";
    }
    results.push({ name, status, message });
  }
  return results;
}

/** Jest and vitest JSON -> [{ name, status, message }] */
export function parseJestJson(text) {
  const data = JSON.parse(text);
  const results = [];
  const files = Array.isArray(data.testResults) ? data.testResults : [];
  for (const file of files) {
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const assertion of assertions) {
      const name = assertion.fullName ?? assertion.title ?? "(unnamed test)";
      const status =
        assertion.status === "passed"
          ? "passed"
          : assertion.status === "failed"
            ? "failed"
            : "skipped";
      const message = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.join("\n").slice(0, 400)
        : undefined;
      results.push({ name, status, message });
    }
    if (assertions.length === 0) {
      // A file that failed to load reports at file level, not per test.
      for (const message of Array.isArray(file.messages) ? file.messages : []) {
        if (message !== null && typeof message === "object" && typeof message.message === "string") {
          results.push({
            name: file.name ?? "(file)",
            status: "failed",
            message: message.message.slice(0, 400),
          });
        }
      }
    }
  }
  return results;
}

const PASS_MARK = /^(?:[✓✔√]|PASSED\b|PASS\b|ok\s|test\s+.*\s+\.\.\.\s+ok\b)/;
const FAIL_MARK = /^(?:[✗✕×]|FAILED\b|FAIL\b|not\s+ok\b|ERROR\b)/;
const SKIP_MARK = /^(?:[-–]\s|SKIPPED\b|skipped\b|pending\b|todo\b)/i;

/**
 * Line-oriented runner output -> [{ name, status }]. Only lines that carry a tag
 * are kept: the hook reads test names, not a runner's whole transcript.
 */
export function parseTextReport(text, options = {}) {
  const prefixes = normalisePrefixes(options.prefixes ?? "HC");
  const results = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:at\s+)?/, "").trim();
    if (line === "" || parseTestTag(line, { prefixes }) === null) continue;
    const status = PASS_MARK.test(line) ? "passed" : FAIL_MARK.test(line) ? "failed" : SKIP_MARK.test(line) ? "skipped" : "unknown";
    results.push({ name: line, status });
  }
  return results;
}

export function parseReport(text, format = "auto", options = {}) {
  const chosen = format === "auto" ? detectFormat(text) : format;
  if (chosen === "junit") return parseJUnit(text);
  if (chosen === "json") return parseJestJson(text);
  return parseTextReport(text, options);
}

export function detectFormat(text) {
  const trimmed = String(text).trimStart();
  if (trimmed.startsWith("<")) return "junit";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "text";
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Accept `{ outcomes: [...] }`, `{ tree: { outcomes } }`, or a bare array. */
export function readContract(value) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  const outcomes = Array.isArray(data)
    ? data
    : Array.isArray(data?.outcomes)
      ? data.outcomes
      : Array.isArray(data?.tree?.outcomes)
        ? data.tree.outcomes
        : null;
  if (outcomes === null) {
    throw new Error("the contract must be a tree snapshot (`hillclimb tree --json`) or an outcomes array");
  }
  const byKey = new Map();
  for (const outcome of outcomes) {
    if (typeof outcome?.key !== "string") continue;
    const criteria = (Array.isArray(outcome.criteria) ? outcome.criteria : [])
      .map((criterion) => (typeof criterion === "string" ? criterion : criterion?.id))
      .filter((id) => typeof id === "string");
    if (!Number.isInteger(outcome.version) || outcome.version < 1) {
      throw new Error(
        `outcome ${outcome.key} has no positive integer version; read the contract with \`hillclimb tree --project <id> --json\``,
      );
    }
    byKey.set(outcome.key, { key: outcome.key, version: outcome.version, criteria });
  }
  return { byKey, outcomes };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function emptyTally() {
  return { passed: [], failed: [], skipped: [], messages: [] };
}

function mergeTallies(tallies) {
  const merged = emptyTally();
  for (const tally of tallies) {
    merged.passed.push(...tally.passed);
    merged.failed.push(...tally.failed);
    merged.skipped.push(...tally.skipped);
    merged.messages.push(...tally.messages);
  }
  return merged;
}

/**
 * One Evidence record, plus the `receiptId` the action carries so a retried CI
 * job posts the same receipt instead of a second piece of evidence. The id is a
 * function of (outcome, contract version, criteria, verdict, source): re-running
 * the same job on the same source yields the same id, and a different verdict,
 * scope or run yields a different one.
 */
function makeEvidence({ bucket, criterionIds, verdict, tally, riskLabel, source, track, now }) {
  const counts = `${tally.passed.length} passed, ${tally.failed.length} failed${
    tally.skipped.length > 0 ? `, ${tally.skipped.length} skipped` : ""
  }`;
  const scope = criterionIds.length > 0 ? `${criterionIds.join(", ")}: ` : "";
  // A skip is not a pass. When a tagged test did not run, a confirming record
  // says so in its own words instead of reading as "everything passed".
  const partial =
    verdict === "note" && criterionIds.length > 0 && tally.skipped.length > 0
      ? ` (partial: ${tally.skipped.length} tagged test${
          tally.skipped.length === 1 ? "" : "s"
        } skipped, so not every tagged test for this criterion ran)`
      : "";
  const summary =
    verdict === "confirms"
      ? `${riskLabel}: confirms ${scope}${counts} against contract v${bucket.version}${partial}`
      : verdict === "denies"
        ? `${riskLabel}: denies ${scope}${counts} against contract v${bucket.version}: ${tally.failed
            .slice(0, MAX_FAILING_NAMES)
            .join("; ")}`
        : `${riskLabel}: note ${scope}${counts} against contract v${bucket.version}` +
          (criterionIds.length === 0
            ? " (names no criterion, so it proves no criterion)"
            : "") + partial +
          (tally.failed.length > 0 ? `: ${tally.failed.slice(0, MAX_FAILING_NAMES).join("; ")}` : "");
  const details =
    (tally.messages.length > 0
      ? `\n\nFailing:\n${tally.messages.slice(0, MAX_FAILING_NAMES).join("\n")}`
      : "") +
    (verdict === "note" && criterionIds.length > 0 && tally.skipped.length > 0
      ? `\n\nSkipped:\n${tally.skipped.slice(0, MAX_FAILING_NAMES).join("\n")}`
      : "");
  const id = `ev_ci_${sha(
    `${bucket.key}|${bucket.version}|${criterionIds.join(",")}|${verdict}|${track}|${source}`,
  ).slice(0, 16)}`;
  return {
    id,
    key: bucket.key,
    version: bucket.version,
    criterionIds,
    kind: verdict,
    track,
    text: `${summary}${details}`.slice(0, MAX_TEXT),
    source,
    created: now,
  };
}


/**
 * Group tagged results against a contract.
 *
 * Returns evidence candidates plus three refusal lists: `skipped` (a key or test
 * that cannot be attached, reported but not fatal), `invalid` (a tag that names
 * something the contract does not have: fatal, the tag is wrong), and `stale`
 * (version drift in either direction: fatal, never attached).
 */
export function buildEvidence(input) {
  const {
    results,
    contract,
    source,
    track = "main",
    kind = "ci",
    prefixes = "HC",
    now = new Date().toISOString(),
    // The caller asserts the contract file predates the test run. Without this,
    // an unversioned tag is skipped rather than pinned to whatever the contract
    // says at post time.
    contractFrozenAt = null,
  } = input;
  const frozen = typeof contractFrozenAt === "string" && contractFrozenAt !== "";
  const byKey = contract.byKey;
  const buckets = new Map();
  const skipped = [];
  const invalid = [];
  const stale = [];

  for (const result of results) {
    const tag = parseTestTag(result.name, { prefixes });
    if (tag === null) continue;
    if (tag.error !== undefined) {
      invalid.push({ test: result.name, reason: tag.error });
      continue;
    }
    const outcome = byKey.get(tag.key);
    if (outcome === undefined) {
      skipped.push({ test: result.name, key: tag.key, reason: "names no outcome in this contract" });
      continue;
    }
    if (tag.version !== null && tag.version !== outcome.version) {
      const direction = tag.version < outcome.version ? "older" : "newer";
      stale.push({
        test: result.name,
        key: tag.key,
        taggedVersion: tag.version,
        contractVersion: outcome.version,
        direction,
        reason:
          direction === "older"
            ? `proves contract v${tag.version}; the contract is now v${outcome.version}. Never record old proof against a newer contract: re-run the test against the current contract, or drop the @version when it should track whatever is current.`
            : `names v${tag.version} but the contract in hand is v${outcome.version}: this checkout is stale. Run \`hillclimb sync --project <id>\` and re-run.`,
      });
      continue;
    }
    if (tag.version === null && !frozen) {
      // An unversioned tag cannot say which contract it ran against. Reading the
      // version from the contract in hand at post time would pin a proof to a
      // version the test never saw, so nothing is recorded.
      skipped.push({
        test: result.name,
        key: tag.key,
        reason: `names no @version, so the contract it ran against is unknown. Add @${outcome.version} to the test name, or pass --contract-frozen-at <time> when the contract was frozen before the tests ran.`,
      });
      continue;
    }
    const unknownCriteria = tag.criteria.filter((id) => !outcome.criteria.includes(id));
    if (unknownCriteria.length > 0) {
      invalid.push({
        test: result.name,
        key: tag.key,
        reason: `criterion ${unknownCriteria.join(", ")} does not exist on ${tag.key} at v${outcome.version} (has ${outcome.criteria.join(", ") || "none"})`,
      });
      continue;
    }
    if (result.status === "unknown") {
      skipped.push({ test: result.name, key: tag.key, reason: "runner output did not say pass or fail" });
      continue;
    }
    const bucket = buckets.get(tag.key) ?? {
      key: tag.key,
      version: outcome.version,
      // Contract order, so the emitted criterion list is stable across runs.
      order: outcome.criteria,
      unscoped: emptyTally(),
      byCriterion: new Map(),
    };
    // A tag with no criteria proves the outcome; it proves no individual
    // criterion, and is never expanded into one (no inferred proof).
    const tallies =
      tag.criteria.length === 0
        ? [[null, bucket.unscoped]]
        : tag.criteria.map((criterionId) => {
            const tally = bucket.byCriterion.get(criterionId) ?? emptyTally();
            bucket.byCriterion.set(criterionId, tally);
            return [criterionId, tally];
          });
    for (const [, tally] of tallies) {
      if (result.status === "passed") tally.passed.push(result.name);
      else if (result.status === "failed") {
        tally.failed.push(result.name);
        if (result.message) tally.messages.push(`${result.name}: ${result.message}`);
      } else tally.skipped.push(result.name);
    }
    buckets.set(tag.key, bucket);
  }

  // Failures first: a person reading the bundle sees what does not hold before
  // what does. Order is deterministic (bucket insertion, then contract order).
  const denials = [];
  const notes = [];
  const confirmations = [];
  const riskLabel = kind === "ci" ? "CI" : kind;

  for (const bucket of buckets.values()) {
    const record = (criterionIds, verdict, tally) =>
      makeEvidence({ bucket, criterionIds, verdict, tally, riskLabel, source, track, now });

    // A tag with no criteria proves no criterion. Core reads an empty
    // criterionIds on confirms/denies as "all criteria", so this can only ever
    // be a note: an observation about the outcome that grants no proof.
    if (bucket.unscoped.failed.length > 0 || bucket.unscoped.passed.length > 0) {
      notes.push(record([], "note", bucket.unscoped));
    } else if (bucket.unscoped.skipped.length > 0) {
      skipped.push({
        key: bucket.key,
        reason: "every outcome-level tagged test was skipped",
        tests: bucket.unscoped.skipped.length,
      });
    }

    if (bucket.byCriterion.size === 0) continue;

    const failing = [];
    const passing = [];
    for (const criterionId of bucket.order) {
      const tally = bucket.byCriterion.get(criterionId);
      if (tally === undefined) continue;
      if (tally.failed.length > 0) failing.push([criterionId, tally]);
      else if (tally.passed.length > 0) {
        if (tally.skipped.length === 0) passing.push([criterionId, tally]);
        else {
          notes.push(record([criterionId], "note", tally));
          // Real proof came from the tests that ran, but not every tagged test
          // did: say so in the record and in the run summary.
          skipped.push({
            test: bucket.key,
            key: bucket.key,
            reason: `criterion ${criterionId} had ${tally.skipped.length} skipped test${
              tally.skipped.length === 1 ? "" : "s"
            } beside ${tally.passed.length} that passed; partial coverage recorded as a note`,
          });
        }
      }
      else {
        // Skipped-only (or never run): no evidence, and said out loud.
        skipped.push({
          test: bucket.key,
          key: bucket.key,
          reason: `criterion ${criterionId} had ${tally.skipped.length} skipped test${tally.skipped.length === 1 ? "" : "s"} and none that ran`,
        });
      }
    }

    // Deny only the criteria that failed, and confirm only the criteria where
    // every tagged test passed: a failure on ac2 must not deny ac1.
    if (failing.length > 0) {
      denials.push(
        record(
          failing.map(([criterionId]) => criterionId),
          "denies",
          mergeTallies(failing.map(([, tally]) => tally)),
        ),
      );
    }
    if (passing.length > 0) {
      confirmations.push(
        record(
          passing.map(([criterionId]) => criterionId),
          "confirms",
          mergeTallies(passing.map(([, tally]) => tally)),
        ),
      );
    }
  }

  const evidence = [...denials, ...notes, ...confirmations];
  return { evidence, skipped, invalid, stale };
}

/** One `add_evidence` action per record, in the exact shape `actions.ts` accepts. */
export function toActions(evidence) {
  return evidence.map((record) => ({
    op: "add_evidence",
    key: record.key,
    version: record.version,
    kind: record.kind,
    criterionIds: record.criterionIds,
    text: record.text,
    source: record.source,
    track: record.track,
    // The tree stores this as the evidence id; retrying the same job must not
    // post the same proof twice.
    receiptId: record.id,
  }));
}

export function renderActCommands(actionList, project) {
  return actionList.map((action) => {
    const json = JSON.stringify(action).replace(/'/g, "'\\''");
    return project === null || project === undefined || project === ""
      ? `hillclimb act '${json}'`
      : `hillclimb act '${json}' --project ${project}`;
  });
}

export function renderSummary(bundle) {
  const lines = [];
  lines.push(
    `hillclimb-evidence: ${bundle.evidence.length} evidence, ${bundle.skipped.length} skipped, ${bundle.invalid.length} invalid, ${bundle.stale.length} stale (contract v${bundle.contractVersion ?? "?"})`,
  );
  for (const record of bundle.evidence) {
    lines.push(
      `  ${record.kind} ${record.key} v${record.version}${record.criterionIds.length > 0 ? ` [${record.criterionIds.join(",")}]` : ""}: ${record.text.split("\n")[0]}`,
    );
  }
  for (const entry of bundle.stale) {
    lines.push(`  STALE ${entry.key} (${entry.test}): ${entry.reason}`);
  }
  for (const entry of bundle.invalid) {
    lines.push(`  INVALID ${entry.key ?? ""} (${entry.test}): ${entry.reason}`);
  }
  for (const entry of bundle.skipped) {
    lines.push(`  skipped ${entry.key ?? entry.test}: ${entry.reason}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    reports: [],
    format: "auto",
    contract: null,
    source: null,
    track: "main",
    kind: "ci",
    prefixes: process.env.HILLCLIMB_KEY_PREFIXES ?? "HC",
    out: null,
    project: null,
    commands: false,
    now: null,
    frozenAt: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[index];
    };
    switch (flag) {
      case "--report": args.reports.push(next()); break;
      case "--format": args.format = next(); break;
      case "--contract": args.contract = next(); break;
      case "--source": args.source = next(); break;
      case "--track": args.track = next(); break;
      case "--kind": args.kind = next(); break;
      case "--prefixes": args.prefixes = next(); break;
      case "--out": args.out = next(); break;
      case "--project": args.project = next(); break;
      case "--now": args.now = next(); break;
      case "--contract-frozen-at": args.frozenAt = next(); break;
      case "--commands": args.commands = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

const HELP = `hillclimb-evidence — turn tagged test results into Hillclimb evidence

  node hillclimb-evidence.mjs --report <file> [--report <file>] --contract <tree.json>
                             [--format auto|text|junit|json] [--source <url|sha>]
                             [--track main] [--kind ci] [--prefixes HC]
                             [--contract-frozen-at <ISO time>]
                             [--project <project-id>] [--commands] [--out <file>]

A test opts in by naming the outcome, and must say which contract it ran against:
  HC-12@3#ac1,ac2        proven evidence, pinned to contract v3 and to ac1, ac2
  HC-12@3                pinned to the outcome; an outcome-level note, not proof
  HC-12#ac1              no @version: skipped, because the contract it ran against
                         is unknown. Add @<version>, or pass --contract-frozen-at
                         with the time the contract was frozen before the tests.
  HC-12                  no @version and no criteria: skipped

Never writes to a tree. --commands prints one \`hillclimb act '<json>'\` line per
record; --out writes the bundle as JSON. Exit 2 means the tags and the contract
disagree; nothing was recorded.`;

export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, readFile: readFileSync }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.reports.length === 0) {
    io.stderr.write(`--report is required (or --report - for stdin)\n`);
    return 1;
  }
  if (args.contract === null) {
    io.stderr.write(`--contract is required: the contract decides every version this run claims\n`);
    return 1;
  }
  let contractText;
  try {
    contractText = io.readFile(args.contract, "utf8");
  } catch (error) {
    io.stderr.write(`cannot read the contract: ${error.message}\n`);
    return 1;
  }
  let contract;
  try {
    contract = readContract(contractText);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (args.frozenAt !== null) {
    const frozenMs = Date.parse(args.frozenAt);
    if (Number.isNaN(frozenMs)) {
      io.stderr.write(`--contract-frozen-at needs a date the shell can parse, like 2026-11-24T09:00:00Z\n`);
      return 1;
    }
    if (frozenMs > Date.now()) {
      io.stderr.write(`--contract-frozen-at is in the future; a contract frozen later than the tests proves nothing\n`);
      return 1;
    }
    const statFile = io.statFile ?? statSync;
    let modified;
    try {
      modified = statFile(args.contract).mtimeMs;
    } catch (error) {
      io.stderr.write(`cannot stat the contract: ${error.message}\n`);
      return 1;
    }
    if (modified > frozenMs + 1000) {
      io.stderr.write(
        `the contract file is newer than the freeze time (file ${new Date(modified).toISOString()}, frozen ${new Date(frozenMs).toISOString()}). ` +
          `Fetch the contract before the tests run, or add @<version> to the test names.\n`,
      );
      return 1;
    }
  }
  const source = args.source ?? `local:${new Date().toISOString()}`;
  const results = [];
  for (const report of args.reports) {
    const text = report === "-" ? io.readFile(0, "utf8") : io.readFile(report, "utf8");
    try {
      results.push(...parseReport(text, args.format, { prefixes: args.prefixes }));
    } catch (error) {
      io.stderr.write(`cannot parse ${basename(report)}: ${error.message}\n`);
      return 1;
    }
  }
  const built = buildEvidence({
    results,
    contract,
    source,
    track: args.track,
    kind: args.kind,
    prefixes: args.prefixes,
    now: args.now ?? new Date().toISOString(),
    contractFrozenAt: args.frozenAt,
  });
  const contractVersions = [...new Set([...contract.byKey.values()].map((outcome) => outcome.version))];
  const bundle = {
    version: 1,
    source,
    track: args.track,
    created: args.now ?? new Date().toISOString(),
    contractVersion: contractVersions.length === 1 ? contractVersions[0] : null,
    contractVersions,
    contractFrozenAt: args.frozenAt,
    evidence: built.evidence,
    skipped: built.skipped,
    invalid: built.invalid,
    stale: built.stale,
  };
  const actions = toActions(built.evidence);
  if (args.out !== null) {
    writeFileSync(args.out, `${JSON.stringify(bundle, null, 2)}\n`);
    io.stderr.write(`wrote ${built.evidence.length} evidence records to ${args.out}\n`);
  } else {
    io.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  }
  io.stderr.write(`${renderSummary(bundle)}\n`);
  if (args.commands) {
    for (const line of renderActCommands(actions, args.project)) {
      io.stdout.write(`${line}\n`);
    }
  }
  if (built.stale.length > 0 || built.invalid.length > 0) return 2;
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exitCode = main();
}
