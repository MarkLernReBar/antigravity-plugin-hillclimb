#!/usr/bin/env python3
"""Shared scoring core for the five Hill Climb starter kits.

Standard library only. No model, network, or third-party dependency.

Contract
--------
A kit is a manifest plus a candidate result stream. The candidate prints one
JSON object per line (JSONL) or a JSON array. The adapter validates the result
stream against the manifest, computes the kit's primary metric, and prints the
score as the last line of stdout. Data problems exit 2; candidate failures exit
3; usage errors exit 4. Guards exit 0 when they pass and 1 when they fail.

The kit-specific functions below are deliberately small. A project replaces the
sample manifest and fixtures with its own real cases; the adapter never assumes
the sample contents.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_GUARD_FAIL = 1
EXIT_INVALID = 2
EXIT_CANDIDATE = 3
EXIT_USAGE = 4

KIT_IDS = ("correctness", "latency-cost", "retrieval", "agent-outcomes", "tuning")


class Invalid(Exception):
    """A data or contract problem. The score is not trustworthy."""

    def __init__(self, message: str, code: int = EXIT_INVALID):
        super().__init__(message)
        self.code = code


def require(condition: bool, message: str, code: int = EXIT_INVALID) -> None:
    if not condition:
        raise Invalid(message, code)


def load_json(path: str | Path) -> object:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise Invalid(f"missing file: {path}")
    except json.JSONDecodeError as error:
        raise Invalid(f"invalid JSON in {path}: {error}")
    except OSError as error:
        raise Invalid(f"cannot read {path}: {error}")


def load_rows(path: str | Path) -> list[dict]:
    text = Path(path).read_text(encoding="utf-8")
    return parse_rows_text(text, source=str(path))


def parse_rows_text(text: str, source: str = "candidate") -> list[dict]:
    stripped = text.strip()
    if not stripped:
        raise Invalid(f"{source} produced no results")
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise Invalid(f"{source} is not valid JSON: {error}")
        require(isinstance(parsed, list), f"{source} must be a JSON array or JSONL")
        rows = parsed
    else:
        rows = []
        for number, line in enumerate(stripped.splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise Invalid(f"{source} line {number} is not valid JSON: {error}")
            rows.append(row)
    require(isinstance(rows, list) and rows, f"{source} produced no result rows")
    for index, row in enumerate(rows):
        require(isinstance(row, dict), f"{source} row {index + 1} must be a JSON object")
    return rows


def run_candidate(command: str, timeout: float, cwd: str) -> tuple[str, str]:
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise Invalid(f"candidate exceeded {timeout:g}s", EXIT_CANDIDATE)
    except OSError as error:
        raise Invalid(f"candidate could not start: {error}", EXIT_CANDIDATE)
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip()[-2000:]
        raise Invalid(
            f"candidate exited {completed.returncode}" + (f": {detail}" if detail else ""),
            EXIT_CANDIDATE,
        )
    return completed.stdout, completed.stderr or ""


def read_rows(args: argparse.Namespace) -> list[dict]:
    if args.results and args.candidate:
        raise Invalid("use --results or --candidate, not both", EXIT_USAGE)
    if args.results:
        return load_rows(args.results)
    if args.candidate:
        stdout, stderr = run_candidate(args.candidate, args.timeout, args.cwd)
        if stderr.strip():
            print(stderr.strip(), file=sys.stderr)
        return parse_rows_text(stdout, source="candidate")
    raise Invalid("provide --results or --candidate", EXIT_USAGE)


def is_finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def assert_finite(value: object, path: str) -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        require(math.isfinite(value), f"{path}: non-finite number")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            assert_finite(item, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_finite(item, f"{path}[{index}]")


def deep_equal(expected: object, actual: object, tolerance: object = None) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if not math.isfinite(expected) or not math.isfinite(actual):
            return False
        if isinstance(tolerance, (int, float)) and not isinstance(tolerance, bool):
            return abs(expected - actual) <= tolerance
        return expected == actual
    if isinstance(expected, dict) and isinstance(actual, dict):
        if set(expected) != set(actual):
            return False
        return all(deep_equal(expected[key], actual[key], tolerance) for key in expected)
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return False
        return all(deep_equal(a, b, tolerance) for a, b in zip(expected, actual))
    return type(expected) is type(actual) and expected == actual


def nearest_rank_p95(values: list[float]) -> float:
    require(values, "cannot compute p95 without observations")
    ordered = sorted(float(value) for value in values)
    rank = math.ceil(0.95 * len(ordered))
    return ordered[max(rank, 1) - 1]


def mean(values: list[float]) -> float:
    require(values, "cannot compute a mean without observations")
    return sum(values) / len(values)


def format_number(value: float | int) -> str:
    if isinstance(value, int):
        return str(value)
    if value.is_integer():
        return str(int(value))
    return repr(float(value))


def sample_warnings(manifest: dict) -> list[str]:
    if manifest.get("sample") is True:
        return [
            "sample fixture: this is a labelled example, not project data. "
            "Replace the manifest and fixtures with real cases before trusting the score."
        ]
    return []


def cases(manifest: dict, key: str = "cases") -> list[dict]:
    require(isinstance(manifest, dict), "manifest must be a JSON object")
    rows = manifest.get(key)
    require(isinstance(rows, list) and rows, f"manifest.{key} must be a nonempty list")
    seen: set[str] = set()
    for index, row in enumerate(rows):
        require(isinstance(row, dict), f"{key}[{index}] must be an object")
        identifier = row.get("id")
        require(
            isinstance(identifier, str) and identifier.strip(),
            f"{key}[{index}].id must be a nonempty string",
        )
        require(identifier not in seen, f"duplicate id in manifest: {identifier}")
        seen.add(identifier)
    return rows


def _is_zero(value: object) -> bool:
    """True when the oracle's answer is genuinely zero/empty, including a zero leaf."""
    if isinstance(value, bool):
        return value is False
    if isinstance(value, (int, float)):
        return value == 0
    if isinstance(value, str):
        return value == ""
    if isinstance(value, list):
        return len(value) == 0 or any(_is_zero(item) for item in value)
    if isinstance(value, dict):
        return len(value) == 0 or any(_is_zero(item) for item in value.values())
    return False


def _type_mismatches(expected: object, actual: object, path: str) -> list[str]:
    """Return leaf paths whose JSON type differs from the oracle."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        problems: list[str] = []
        for key in expected:
            if key not in actual:
                problems.append(f"{path}.{key}: missing")
            else:
                problems.extend(_type_mismatches(expected[key], actual[key], f"{path}.{key}"))
        for key in actual:
            if key not in expected:
                problems.append(f"{path}.{key}: unexpected")
        return problems
    if isinstance(expected, list) and isinstance(actual, list):
        problems = []
        if len(expected) != len(actual):
            problems.append(f"{path}: expected {len(expected)} items, got {len(actual)}")
        for index, (left, right) in enumerate(zip(expected, actual)):
            problems.extend(_type_mismatches(left, right, f"{path}[{index}]"))
        return problems
    if type(expected) is not type(actual):
        return [f"{path}: expected {type(expected).__name__}, got {type(actual).__name__}"]
    return []


# ---------------------------------------------------------------------------
# correctness
# ---------------------------------------------------------------------------


def _correctness_score(manifest: dict, rows: list[dict], holdout: dict | None) -> dict:
    defined = cases(manifest)
    by_id = {case["id"]: case for case in defined}
    seen: set[str] = set()
    results: list[dict] = []
    for row in rows:
        identifier = row.get("case")
        require(isinstance(identifier, str) and identifier, "row.case must be a nonempty string")
        require(identifier in by_id, f"unknown case: {identifier}")
        require(identifier not in seen, f"duplicate case: {identifier}")
        seen.add(identifier)
        case = by_id[identifier]
        if "expected_error" in case:
            require(
                isinstance(case["expected_error"], str),
                f"{identifier}: expected_error must be a string",
            )
            require("error" in row, f"{identifier}: missing error")
            require(isinstance(row["error"], str), f"{identifier}: error must be a string")
            ok = row["error"] == case["expected_error"]
            reason = "" if ok else "error mismatch"
        else:
            require("expected" in case, f"{identifier}: case needs expected or expected_error")
            require("output" in row, f"{identifier}: missing output")
            assert_finite(row["output"], f"{identifier}.output")
            ok = deep_equal(case["expected"], row["output"], case.get("tolerance"))
            reason = "" if ok else "output mismatch"
        results.append({"id": identifier, "correct": ok, "reason": reason})
    missing = [identifier for identifier in by_id if identifier not in seen]
    require(not missing, f"missing cases: {', '.join(missing)}")
    correct = sum(1 for item in results if item["correct"])
    return {
        "score": correct,
        "metric": "cases_correct",
        "unit": "cases",
        "direction": "max",
        "cases_total": len(defined),
        "cases_correct": correct,
        "cases_wrong": len(defined) - correct,
        "cases": results,
        "warnings": sample_warnings(manifest),
    }


def _correctness_guards(
    manifest: dict, rows: list[dict], result: dict, holdout: dict | None
) -> dict[str, list[str]]:
    defined = cases(manifest)
    by_id = {case["id"]: case for case in defined}
    coverage: list[str] = []
    seen: set[str] = set()
    for row in rows:
        identifier = row.get("case")
        if identifier in seen:
            coverage.append(f"duplicate case: {identifier}")
        seen.add(identifier)
    for identifier in by_id:
        if identifier not in seen:
            coverage.append(f"missing case: {identifier}")
    required_tags = manifest.get("required_tags") or []
    if isinstance(required_tags, list):
        present = {case.get("tag") for case in defined}
        for tag in required_tags:
            if tag not in present:
                coverage.append(f"required tag has no case: {tag}")

    types: list[str] = []
    for row in rows:
        identifier = row.get("case")
        case = by_id.get(identifier)
        if case is None:
            continue
        if "expected_error" in case:
            if not isinstance(row.get("error"), str):
                types.append(f"{identifier}: error must be a string")
            continue
        expected = case.get("expected")
        actual = row.get("output")
        types.extend(_type_mismatches(expected, actual, identifier))

    zero: list[str] = []
    for entry in result["cases"]:
        case = by_id.get(entry["id"])
        if case and "expected" in case and _is_zero(case["expected"]) and not entry["correct"]:
            zero.append(f"{entry['id']}: genuinely zero-valued case is missing or wrong")

    errors: list[str] = []
    for case in defined:
        if "expected_error" not in case:
            continue
        entry = next((item for item in result["cases"] if item["id"] == case["id"]), None)
        if entry is None or not entry["correct"]:
            errors.append(f"{case['id']}: expected error path is missing or wrong")

    return {
        "coverage": coverage,
        "types": types,
        "zero": zero,
        "error_paths": errors,
    }


# ---------------------------------------------------------------------------
# latency-cost
# ---------------------------------------------------------------------------


def _latency_score(manifest: dict, rows: list[dict], holdout: dict | None) -> dict:
    defined = cases(manifest)
    workload = manifest.get("workload")
    require(isinstance(workload, dict), "manifest.workload must be an object")
    require(
        workload.get("requests") == len(defined),
        "workload.requests must equal the number of cases",
    )
    by_id = {case["id"]: case for case in defined}
    seen: set[str] = set()
    observations: list[float] = []
    results: list[dict] = []
    for row in rows:
        identifier = row.get("case")
        require(isinstance(identifier, str) and identifier, "row.case must be a nonempty string")
        require(identifier in by_id, f"unknown case: {identifier}")
        require(identifier not in seen, f"duplicate case: {identifier}")
        seen.add(identifier)
        require(row.get("correct") is True, f"{identifier}: correct must be true")
        require("useful_ms" in row, f"{identifier}: missing useful_ms")
        require(
            is_finite_number(row["useful_ms"]) and row["useful_ms"] >= 0,
            f"{identifier}: useful_ms must be finite and nonnegative",
        )
        require("output" in row, f"{identifier}: missing output")
        assert_finite(row["output"], f"{identifier}.output")
        observations.append(float(row["useful_ms"]))
        results.append({"id": identifier, "useful_ms": float(row["useful_ms"])})
    missing = [identifier for identifier in by_id if identifier not in seen]
    require(not missing, f"missing cases: {', '.join(missing)}")
    p95 = nearest_rank_p95(observations)
    return {
        "score": p95,
        "metric": "p95_useful_ms",
        "unit": "ms",
        "direction": "min",
        "cases_total": len(defined),
        "cases_correct": len(observations),
        "cases": results,
        "warnings": sample_warnings(manifest),
    }


def _latency_guards(
    manifest: dict, rows: list[dict], result: dict, holdout: dict | None
) -> dict[str, list[str]]:
    defined = cases(manifest)
    by_id = {case["id"]: case for case in defined}
    completeness: list[str] = []
    seen: set[str] = set()
    for row in rows:
        identifier = row.get("case")
        if identifier in seen:
            completeness.append(f"duplicate case: {identifier}")
        seen.add(identifier)
    for identifier in by_id:
        if identifier not in seen:
            completeness.append(f"missing case: {identifier}")

    success: list[str] = []
    for row in rows:
        if row.get("correct") is not True:
            success.append(f"{row.get('case')}: correct is not true")

    equivalence: list[str] = []
    for row in rows:
        identifier = row.get("case")
        case = by_id.get(identifier)
        if case is None:
            continue
        if "output" not in row:
            equivalence.append(f"{identifier}: missing output")
        elif not deep_equal(case.get("expected"), row["output"], case.get("tolerance")):
            equivalence.append(f"{identifier}: output does not match the expected value")

    workload = manifest.get("workload") or {}
    load: list[str] = []
    if workload.get("requests") != len(defined):
        load.append("workload.requests does not match the case count")
    if not isinstance(workload.get("cache"), str) or not workload.get("cache"):
        load.append("workload.cache must name the cache condition")

    return {
        "completeness": completeness,
        "success": success,
        "equivalence": equivalence,
        "load": load,
    }


# ---------------------------------------------------------------------------
# retrieval
# ---------------------------------------------------------------------------


def _retrieval_score(manifest: dict, rows: list[dict], holdout: dict | None) -> dict:
    queries = cases(manifest, "queries")
    documents = manifest.get("documents")
    require(isinstance(documents, dict) and documents, "manifest.documents must be a nonempty object")
    project = manifest.get("project")
    require(isinstance(project, str) and project, "manifest.project must be a nonempty string")
    k = manifest.get("k", 10)
    require(isinstance(k, int) and k > 0, "manifest.k must be a positive integer")
    for query in queries:
        require(
            isinstance(query.get("relevant"), list) and query["relevant"],
            f"{query['id']}: relevant must be a nonempty list",
        )
        require(
            all(isinstance(item, str) for item in query["relevant"]),
            f"{query['id']}: relevant must contain strings",
        )
        require(
            isinstance(query.get("hard_negatives", []), list),
            f"{query['id']}: hard_negatives must be a list",
        )
        require(
            isinstance(query.get("company"), str) and query["company"],
            f"{query['id']}: company must be a nonempty string",
        )
    for document_id, document in documents.items():
        require(isinstance(document, dict), f"document {document_id} must be an object")
        require(
            isinstance(document.get("project"), str) and document["project"],
            f"document {document_id}: project must be a nonempty string",
        )
        require(
            isinstance(document.get("company"), str) and document["company"],
            f"document {document_id}: company must be a nonempty string",
        )
    by_id = {query["id"]: query for query in queries}
    seen: set[str] = set()
    results: list[dict] = []
    for row in rows:
        identifier = row.get("query")
        require(isinstance(identifier, str) and identifier, "row.query must be a nonempty string")
        require(identifier in by_id, f"unknown query: {identifier}")
        require(identifier not in seen, f"duplicate query: {identifier}")
        seen.add(identifier)
        ranked = row.get("docs")
        require(isinstance(ranked, list), f"{identifier}: docs must be a list")
        require(len(ranked) <= k, f"{identifier}: more than k={k} documents")
        require(len(set(ranked)) == len(ranked), f"{identifier}: duplicate documents in ranked list")
        for document_id in ranked:
            require(
                isinstance(document_id, str) and document_id in documents,
                f"{identifier}: unknown document {document_id}",
            )
        require(
            "latency_ms" in row and is_finite_number(row["latency_ms"]) and row["latency_ms"] >= 0,
            f"{identifier}: latency_ms must be finite and nonnegative",
        )
        query = by_id[identifier]
        relevant = set(query["relevant"])
        rank = next((index for index, doc in enumerate(ranked, 1) if doc in relevant), None)
        rr = 0.0 if rank is None else 1.0 / rank
        wrong_company = any(
            documents[doc]["company"] != query["company"] for doc in ranked
        )
        right_company_wrong_source = (
            rank is None
            and any(documents[doc]["company"] == query["company"] for doc in ranked)
        )
        results.append(
            {
                "id": identifier,
                "rr": rr,
                "rank": rank,
                "wrong_company": wrong_company,
                "right_company_wrong_source": right_company_wrong_source,
            }
        )
    missing = [identifier for identifier in by_id if identifier not in seen]
    require(not missing, f"missing queries: {', '.join(missing)}")
    mrr = round(mean([item["rr"] for item in results]), 6)
    return {
        "score": mrr,
        "metric": "mrr",
        "unit": "mrr",
        "direction": "max",
        "queries_total": len(queries),
        "queries_missed": sum(1 for item in results if item["rank"] is None),
        "queries_wrong_company": sum(1 for item in results if item["wrong_company"]),
        "queries_right_company_wrong_source": sum(
            1 for item in results if item["right_company_wrong_source"]
        ),
        "queries": results,
        "warnings": sample_warnings(manifest),
    }


def _retrieval_guards(
    manifest: dict, rows: list[dict], result: dict, holdout: dict | None
) -> dict[str, list[str]]:
    queries = cases(manifest, "queries")
    documents = manifest.get("documents") or {}
    by_id = {query["id"]: query for query in queries}
    completeness: list[str] = []
    seen: set[str] = set()
    for row in rows:
        identifier = row.get("query")
        if identifier in seen:
            completeness.append(f"duplicate query: {identifier}")
        seen.add(identifier)
    for identifier in by_id:
        if identifier not in seen:
            completeness.append(f"missing query: {identifier}")

    isolation: list[str] = []
    for row in rows:
        query = by_id.get(row.get("query"))
        if query is None:
            continue
        for document_id in row.get("docs", []):
            document = documents.get(document_id)
            if document and document.get("project") != manifest.get("project"):
                isolation.append(
                    f"{query['id']}: document {document_id} belongs to project {document.get('project')}"
                )

    attribution: list[str] = []
    for row in rows:
        query = by_id.get(row.get("query"))
        if query is None:
            continue
        for document_id in row.get("docs", []):
            document = documents.get(document_id)
            if document and document.get("company") != query.get("company"):
                attribution.append(
                    f"{query['id']}: document {document_id} belongs to {document.get('company')}"
                )

    budget = manifest.get("latency_budget_ms")
    latency: list[str] = []
    if is_finite_number(budget):
        for row in rows:
            if is_finite_number(row.get("latency_ms")) and row["latency_ms"] > budget:
                latency.append(
                    f"{row.get('query')}: latency {row['latency_ms']}ms exceeds {budget}ms"
                )

    judgments: list[str] = []
    for query in queries:
        relevant = set(query.get("relevant", []))
        negatives = set(query.get("hard_negatives", []))
        overlap = relevant & negatives
        if overlap:
            judgments.append(f"{query['id']}: hard negatives also judged relevant: {sorted(overlap)}")

    return {
        "completeness": completeness,
        "isolation": isolation,
        "attribution": attribution,
        "latency": latency,
        "judgments": judgments,
    }


# ---------------------------------------------------------------------------
# agent-outcomes
# ---------------------------------------------------------------------------


def _agent_score(manifest: dict, rows: list[dict], holdout: dict | None) -> dict:
    defined = cases(manifest, "tasks")
    trials = manifest.get("trials", 1)
    require(isinstance(trials, int) and trials >= 1, "manifest.trials must be a positive integer")
    by_id = {task["id"]: task for task in defined}
    for task in defined:
        expect = task.get("expect")
        require(isinstance(expect, dict), f"{task['id']}: expect must be an object")
        require(isinstance(expect.get("state", {}), dict), f"{task['id']}: expect.state must be an object")
        require(isinstance(expect.get("files", []), list), f"{task['id']}: expect.files must be a list")
        require(isinstance(expect.get("contains", []), list), f"{task['id']}: expect.contains must be a list")
        require(
            isinstance(expect.get("forbidden_effects", []), list),
            f"{task['id']}: expect.forbidden_effects must be a list",
        )
    seen: set[tuple[str, int]] = set()
    rows_by_task: dict[str, list[dict]] = {}
    for row in rows:
        identifier = row.get("task")
        require(isinstance(identifier, str) and identifier, "row.task must be a nonempty string")
        require(identifier in by_id, f"unknown task: {identifier}")
        trial = row.get("trial")
        require(
            isinstance(trial, int) and not isinstance(trial, bool) and 1 <= trial <= trials,
            f"{identifier}: trial must be an integer in 1..{trials}",
        )
        key = (identifier, trial)
        require(key not in seen, f"duplicate task/trial: {identifier}/{trial}")
        seen.add(key)
        require(isinstance(row.get("claimed"), bool), f"{identifier}: claimed must be a boolean")
        require(isinstance(row.get("state"), dict), f"{identifier}: state must be an object")
        require(isinstance(row.get("artifact"), dict), f"{identifier}: artifact must be an object")
        require(
            isinstance(row["artifact"].get("files", []), list),
            f"{identifier}: artifact.files must be a list",
        )
        require(
            isinstance(row["artifact"].get("content", ""), str),
            f"{identifier}: artifact.content must be a string",
        )
        require(isinstance(row.get("effects", []), list), f"{identifier}: effects must be a list")
        require(
            "cost_usd" in row and is_finite_number(row["cost_usd"]) and row["cost_usd"] >= 0,
            f"{identifier}: cost_usd must be finite and nonnegative",
        )
        rows_by_task.setdefault(identifier, []).append(row)
    for task in defined:
        require(
            len(rows_by_task.get(task["id"], [])) == trials,
            f"{task['id']}: expected {trials} trials, got {len(rows_by_task.get(task['id'], []))}",
        )
    results: list[dict] = []
    for task in defined:
        identifier = task["id"]
        expect = task["expect"]
        failures: list[str] = []
        for row in rows_by_task[identifier]:
            if not row.get("claimed"):
                failures.append(f"trial {row['trial']}: not claimed")
            for key, value in expect.get("state", {}).items():
                if row["state"].get(key) != value:
                    failures.append(f"trial {row['trial']}: state.{key} != {value!r}")
            files = row["artifact"].get("files", [])
            for name in expect.get("files", []):
                if name not in files:
                    failures.append(f"trial {row['trial']}: artifact missing {name}")
            content = row["artifact"].get("content", "")
            for text in expect.get("contains", []):
                if text not in content:
                    failures.append(f"trial {row['trial']}: artifact does not contain {text!r}")
        results.append({"id": identifier, "passed": not failures, "failures": failures})
    completed = sum(1 for item in results if item["passed"])
    return {
        "score": completed,
        "metric": "tasks_completed",
        "unit": "tasks",
        "direction": "max",
        "tasks_total": len(defined),
        "tasks_completed": completed,
        "tasks_failed": len(defined) - completed,
        "trials": trials,
        "tasks": results,
        "warnings": sample_warnings(manifest),
    }


def _agent_guards(
    manifest: dict, rows: list[dict], result: dict, holdout: dict | None
) -> dict[str, list[str]]:
    defined = cases(manifest, "tasks")
    by_id = {task["id"]: task for task in defined}
    trials = manifest.get("trials", 1)
    completeness: list[str] = []
    counts: dict[str, int] = {}
    for row in rows:
        identifier = row.get("task")
        counts[identifier] = counts.get(identifier, 0) + 1
    for task in defined:
        if counts.get(task["id"], 0) != trials:
            completeness.append(
                f"{task['id']}: expected {trials} trials, got {counts.get(task['id'], 0)}"
            )

    evidence: list[str] = []
    for row in rows:
        identifier = row.get("task")
        if row.get("claimed") and not row.get("artifact", {}).get("files"):
            evidence.append(f"{identifier}: claimed without an artifact file")

    side_effects: list[str] = []
    for row in rows:
        task = by_id.get(row.get("task"))
        if task is None:
            continue
        forbidden = set(task.get("expect", {}).get("forbidden_effects", []))
        for effect in row.get("effects", []):
            if effect in forbidden:
                side_effects.append(f"{task['id']}: forbidden effect {effect}")

    cost: list[str] = []
    for row in rows:
        if not is_finite_number(row.get("cost_usd")):
            cost.append(f"{row.get('task')}: cost_usd is not finite")

    return {
        "completeness": completeness,
        "evidence": evidence,
        "no_side_effects": side_effects,
        "cost": cost,
    }


# ---------------------------------------------------------------------------
# tuning
# ---------------------------------------------------------------------------


def _validate_params(params: dict, space: dict, label: str) -> None:
    require(isinstance(params, dict), f"{label}: params must be an object")
    for key, spec in space.items():
        require(key in params, f"{label}: missing parameter {key}")
        require(isinstance(spec, dict), f"space.{key} must be an object")
        value = params[key]
        kind = spec.get("type")
        if kind == "int":
            require(
                isinstance(value, int) and not isinstance(value, bool),
                f"{label}: {key} must be an integer",
            )
        elif kind == "float":
            require(is_finite_number(value), f"{label}: {key} must be a finite number")
        elif kind == "enum":
            require(
                value in spec.get("values", []),
                f"{label}: {key} must be one of {spec.get('values')}",
            )
        else:
            raise Invalid(f"space.{key}: unknown type {kind!r}")
        if "min" in spec:
            require(value >= spec["min"], f"{label}: {key} below minimum {spec['min']}")
        if "max" in spec:
            require(value <= spec["max"], f"{label}: {key} above maximum {spec['max']}")
    for key in params:
        require(key in space, f"{label}: unknown parameter {key}")


def _tuning_trials(manifest: dict, rows: list[dict]) -> tuple[dict, list[dict], dict, int, dict]:
    """Validate trial rows. Returns (space, trials, selected, evaluations, selected_trial)."""
    space = manifest.get("space")
    require(isinstance(space, dict) and space, "manifest.space must be a nonempty object")
    allowance = manifest.get("allowance")
    require(
        isinstance(allowance, int) and not isinstance(allowance, bool) and allowance > 0,
        "manifest.allowance must be a positive integer",
    )
    validation = manifest.get("validation_instances")
    require(isinstance(validation, list) and validation, "manifest.validation_instances must be a nonempty list")
    trials: list[dict] = []
    selected: dict | None = None
    seen: set[str] = set()
    for row in rows:
        if "selected" in row:
            require(selected is None, "only one selected row is allowed")
            selected = row
            continue
        require("trial" in row, "each row needs trial or selected")
        params = row.get("params")
        _validate_params(params, space, f"trial {row.get('trial')}")
        require(
            "validation" in row and is_finite_number(row["validation"]),
            f"trial {row.get('trial')}: validation must be finite",
        )
        require(
            isinstance(row.get("evaluations"), int)
            and not isinstance(row.get("evaluations"), bool)
            and row["evaluations"] >= 1,
            f"trial {row.get('trial')}: evaluations must be a positive integer",
        )
        key = json.dumps(params, sort_keys=True, default=str)
        require(key not in seen, f"trial {row.get('trial')}: duplicate params {key}")
        seen.add(key)
        trials.append(row)
    require(trials, "no trials")
    require(selected is not None, "missing selected row")
    total = sum(trial["evaluations"] for trial in trials)
    require(total <= allowance, f"evaluations {total} exceed allowance {allowance}")
    _validate_params(selected.get("params"), space, "selected")
    match = next((trial for trial in trials if trial["params"] == selected["params"]), None)
    require(match is not None, "selected params do not match any trial")
    return space, trials, selected, total, match


def _tuning_score(manifest: dict, rows: list[dict], holdout: dict | None = None) -> dict:
    """Visible path: score the selected candidate on validation only.

    The private holdout is never required or read here. Passing a holdout takes
    the once-only final read instead, which is the only path that touches it.
    """
    if holdout is not None:
        return _tuning_final(manifest, rows, holdout)
    space, trials, selected, total, match = _tuning_trials(manifest, rows)
    objective = manifest.get("objective", "min")
    require(objective in ("min", "max"), "manifest.objective must be min or max")
    best = (
        min(trials, key=lambda trial: trial["validation"])
        if objective == "min"
        else max(trials, key=lambda trial: trial["validation"])
    )
    base = {
        "trials_total": len(trials),
        "evaluations_total": total,
        "allowance": manifest["allowance"],
        "selected_validation": float(match["validation"]),
        "selected_is_best": match is best,
        "unit": manifest.get("unit", "objective"),
        "warnings": sample_warnings(manifest),
    }
    return {
        "score": round(float(match["validation"]), 6),
        "metric": "validation_objective",
        "direction": objective,
        "holdout": None,
        **base,
    }


def _tuning_final(manifest: dict, rows: list[dict], holdout: dict) -> dict:
    """Private final read: the selected candidate's holdout mean. Run once."""
    _space, trials, selected, total, match = _tuning_trials(manifest, rows)
    objective = manifest.get("objective", "min")
    require(objective in ("min", "max"), "manifest.objective must be min or max")
    holdout_ids = holdout.get("holdout")
    require(isinstance(holdout_ids, list) and holdout_ids, "holdout.holdout must be a nonempty list")
    validation = manifest.get("validation_instances") or []
    require(
        not (set(validation) & set(holdout_ids)),
        "validation and holdout instances must be disjoint",
    )
    results = selected.get("holdout")
    require(isinstance(results, dict), "selected row needs holdout results for the final read")
    require(
        set(results) == set(holdout_ids),
        "holdout results must cover exactly the holdout instances",
    )
    for identifier, value in results.items():
        require(is_finite_number(value), f"holdout {identifier}: value must be finite")
    best = (
        min(trials, key=lambda trial: trial["validation"])
        if objective == "min"
        else max(trials, key=lambda trial: trial["validation"])
    )
    return {
        "score": round(mean([float(value) for value in results.values()]), 6),
        "metric": "holdout_objective",
        "direction": objective,
        "trials_total": len(trials),
        "evaluations_total": total,
        "allowance": manifest["allowance"],
        "selected_validation": float(match["validation"]),
        "selected_is_best": match is best,
        "unit": manifest.get("unit", "objective"),
        "holdout": {identifier: float(value) for identifier, value in results.items()},
        "warnings": sample_warnings(manifest),
    }


def _tuning_guards(
    manifest: dict, rows: list[dict], result: dict, holdout: dict | None = None
) -> dict[str, list[str]]:
    space = manifest.get("space") or {}
    allowance = manifest.get("allowance")
    bounds: list[str] = []
    trials: list[dict] = []
    selected: dict | None = None
    seen: set[str] = set()
    for row in rows:
        if "selected" in row:
            selected = row
            continue
        trials.append(row)
    for trial in trials:
        try:
            _validate_params(trial.get("params"), space, f"trial {trial.get('trial')}")
        except Invalid as error:
            bounds.append(str(error))
            continue
        key = json.dumps(trial.get("params"), sort_keys=True, default=str)
        if key in seen:
            bounds.append(f"trial {trial.get('trial')}: duplicate params {key}")
        seen.add(key)
    if selected is not None:
        try:
            _validate_params(selected.get("params"), space, "selected")
        except Invalid as error:
            bounds.append(str(error))

    budget: list[str] = []
    if isinstance(allowance, int):
        total = sum(
            trial.get("evaluations", 0)
            for trial in trials
            if isinstance(trial.get("evaluations"), int)
        )
        if total > allowance:
            budget.append(f"evaluations {total} exceed allowance {allowance}")

    leakage: list[str] = []
    for trial in trials:
        if "holdout" in trial:
            leakage.append(f"trial {trial.get('trial')}: holdout results on a trial row")

    selection: list[str] = []
    if selected is None:
        selection.append("missing selected row")
    elif trials:
        objective = manifest.get("objective", "min")
        values = [trial.get("validation") for trial in trials]
        if all(is_finite_number(value) for value in values):
            best = min(values) if objective == "min" else max(values)
            if result.get("selected_validation") != best:
                selection.append(
                    f"selected validation {result.get('selected_validation')} is not the best {best}"
                )

    disjoint: list[str] = []
    if holdout is not None:
        validation = manifest.get("validation_instances") or []
        holdout_ids = holdout.get("holdout") or []
        overlap = set(validation) & set(holdout_ids)
        if overlap:
            disjoint.append(f"validation and holdout overlap: {sorted(overlap)}")

    return {
        "bounds": bounds,
        "allowance": budget,
        "no_leakage": leakage,
        "selection": selection,
        "disjoint": disjoint,
    }


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------


SCORERS = {
    "correctness": _correctness_score,
    "latency-cost": _latency_score,
    "retrieval": _retrieval_score,
    "agent-outcomes": _agent_score,
    "tuning": _tuning_score,
}

GUARDS = {
    "correctness": _correctness_guards,
    "latency-cost": _latency_guards,
    "retrieval": _retrieval_guards,
    "agent-outcomes": _agent_guards,
    "tuning": _tuning_guards,
}


def score(kit: str, manifest: dict, rows: list[dict], holdout: dict | None = None) -> dict:
    require(kit in SCORERS, f"unknown kit: {kit}", EXIT_USAGE)
    return SCORERS[kit](manifest, rows, holdout)


def guard_failures(
    kit: str, manifest: dict, rows: list[dict], result: dict, holdout: dict | None = None
) -> dict[str, list[str]]:
    require(kit in GUARDS, f"unknown kit: {kit}", EXIT_USAGE)
    return GUARDS[kit](manifest, rows, result, holdout)


def _require_disjoint(kit: str, manifest: dict, holdout: dict) -> None:
    if kit == "tuning":
        return
    key = "queries" if kit == "retrieval" else "tasks" if kit == "agent-outcomes" else "cases"
    main_ids = {row["id"] for row in cases(manifest, key)}
    holdout_ids = {row["id"] for row in cases(holdout, key)}
    overlap = main_ids & holdout_ids
    require(not overlap, f"holdout overlaps the manifest: {sorted(overlap)}")


def score_main(kit: str, argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=f"Score a {kit} candidate against a manifest. Prints one number as the last stdout line."
    )
    parser.add_argument("--manifest", required=True, help="kit manifest JSON (real project data or a labelled sample)")
    parser.add_argument("--candidate", help="command that prints JSONL or a JSON array of result rows")
    parser.add_argument("--results", help="file containing JSONL or a JSON array of result rows")
    parser.add_argument("--holdout", help="separate holdout manifest; must be disjoint from --manifest")
    parser.add_argument("--guard", help="run one guard instead of scoring")
    parser.add_argument("--json", action="store_true", help="print structured JSON instead of a bare score")
    parser.add_argument("--timeout", type=float, default=120.0, help="candidate timeout in seconds")
    parser.add_argument("--cwd", default=".", help="working directory for the candidate")
    args = parser.parse_args(argv)

    try:
        manifest = load_json(args.manifest)
        require(isinstance(manifest, dict), "manifest must be a JSON object")
        holdout = None
        if args.holdout:
            holdout = load_json(args.holdout)
            require(isinstance(holdout, dict), "holdout manifest must be a JSON object")
        if kit == "tuning":
            score_manifest = manifest
            score_holdout = holdout  # None scores validation only; a holdout takes the final read
        else:
            if holdout is not None:
                _require_disjoint(kit, manifest, holdout)
                score_manifest = holdout
                score_holdout = None
            else:
                score_manifest = manifest
                score_holdout = None
        rows = read_rows(args)
        result = score(kit, score_manifest, rows, score_holdout)
        guards = guard_failures(kit, score_manifest, rows, result, score_holdout)
        if args.guard:
            require(args.guard in guards, f"unknown guard: {args.guard}; choose from {', '.join(guards)}", EXIT_USAGE)
            failures = guards[args.guard]
            payload = {
                "ok": not failures,
                "kit": kit,
                "guard": args.guard,
                "failures": failures,
                "score": result["score"],
            }
            if args.json:
                print(json.dumps(payload, indent=2, default=str))
            elif failures:
                print(f"guard {args.guard} failed: {'; '.join(failures)}", file=sys.stderr)
            return EXIT_OK if not failures else EXIT_GUARD_FAIL
        payload = {
            "ok": True,
            "kit": kit,
            "valid": True,
            "sample": bool(manifest.get("sample")),
            "guards": {name: not failures for name, failures in guards.items()},
            "guard_failures": {name: failures for name, failures in guards.items() if failures},
            **result,
        }
        if args.json:
            print(json.dumps(payload, indent=2, default=str))
            return EXIT_OK
        for warning in result.get("warnings", []):
            print(f"warning: {warning}", file=sys.stderr)
        print(
            f"{kit}: {format_number(result['score'])} {result['unit']} "
            f"({result['direction']}); {result['metric']}",
            file=sys.stderr,
        )
        print(format_number(result["score"]))
        return EXIT_OK
    except Invalid as error:
        payload = {"ok": False, "kit": kit, "valid": False, "error": str(error), "code": error.code}
        if args.json:
            print(json.dumps(payload, indent=2, default=str))
        else:
            print(f"{kit}: invalid: {error}", file=sys.stderr)
        return error.code
    except KeyboardInterrupt:
        return EXIT_CANDIDATE


if __name__ == "__main__":
    print("This module is the shared kit core. Run a kit's score.py or preflight.py.", file=sys.stderr)
    raise SystemExit(EXIT_USAGE)
