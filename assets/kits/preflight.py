#!/usr/bin/env python3
"""Preflight for the five Hill Climb starter kits.

The packaged kit is a labelled example. A real project supplies its own
``--data`` directory containing ``kit.json`` plus its manifest, baseline and
known-bad fixtures. Project paths in that kit.json are relative to the data
directory. The packaged kit is used only when no data directory is given, or
when ``--allow-sample`` explicitly accepts the labelled example.

Exit codes
----------
0  kit is usable; baseline, guards and known-bad controls behaved as declared
2  kit metadata or a fixture is invalid
3  baseline score or a baseline guard did not match the declaration
4  a known-bad control was not caught as declared
5  repeated runs exceeded the declared noise limit
6  a candidate command failed to run
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

sys.dont_write_bytecode = True

KIT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(KIT_ROOT))

import kitcore  # noqa: E402

EXIT_OK = 0
EXIT_INVALID = 2
EXIT_BASELINE = 3
EXIT_KNOWN_BAD = 4
EXIT_NOISE = 5
EXIT_CANDIDATE = 6
EXIT_USAGE = 7


def kit_ids() -> list[str]:
    return sorted(
        path.name for path in KIT_ROOT.iterdir() if (path / "kit.json").is_file()
    )


def _merge_kit(packaged: dict, project: dict) -> dict:
    kit = dict(packaged)
    for key, value in project.items():
        if key == "data" and isinstance(value, dict):
            kit["data"] = {**packaged.get("data", {}), **value}
        else:
            kit[key] = value
    return kit


def load_kit(kit_id: str, data_dir: str | None = None, allow_sample: bool = False) -> dict:
    kit_dir = KIT_ROOT / kit_id
    kitcore.require(kit_dir.is_dir(), f"unknown kit {kit_id!r}; choose from {', '.join(kit_ids())}", EXIT_INVALID)
    packaged = kitcore.load_json(kit_dir / "kit.json")
    kitcore.require(isinstance(packaged, dict), f"{kit_dir}/kit.json must be an object", EXIT_INVALID)
    kit = dict(packaged)
    kit["_kit_dir"] = kit_dir
    kit["_fixture_base"] = kit_dir
    kit["_manifest_base"] = kit_dir
    kit["_project"] = False

    if data_dir:
        base = Path(data_dir).resolve()
        kitcore.require(base.is_dir(), f"--data {base} is not a directory", EXIT_INVALID)
        kit["_manifest_base"] = base
        project_path = base / "kit.json"
        if project_path.is_file():
            project = kitcore.load_json(project_path)
            kitcore.require(isinstance(project, dict), f"{project_path} must be an object", EXIT_INVALID)
            kitcore.require(project.get("id", kit_id) == kit_id, f"{project_path} id must be {kit_id}", EXIT_INVALID)
            kitcore.require(
                isinstance(project.get("baseline"), dict) and project["baseline"].get("fixture"),
                f"{project_path} must declare its own baseline.fixture; packaged controls are not valid for real data",
                EXIT_INVALID,
            )
            kitcore.require(
                isinstance(project.get("knownBad"), list) and project["knownBad"],
                f"{project_path} must declare its own knownBad controls; packaged controls are not valid for real data",
                EXIT_INVALID,
            )
            kit = _merge_kit(packaged, project)
            kit["_kit_dir"] = kit_dir
            kit["_fixture_base"] = base
            kit["_manifest_base"] = base
            kit["_project"] = True
            kitcore.require(
                kit.get("data", {}).get("sample") is False,
                f"{project_path} must set data.sample to false for a project kit",
                EXIT_INVALID,
            )
            kitcore.require(
                isinstance(kit.get("baseline"), dict) and kit["baseline"].get("fixture"),
                f"{project_path} must define baseline.fixture",
                EXIT_INVALID,
            )
            controls = kit.get("knownBad")
            kitcore.require(
                isinstance(controls, list) and controls,
                f"{project_path} must define project-specific knownBad controls",
                EXIT_INVALID,
            )
            for control in controls:
                kitcore.require(
                    isinstance(control, dict) and control.get("fixture"),
                    f"{project_path} knownBad entries need a fixture",
                    EXIT_INVALID,
                )
                kitcore.require(
                    control.get("expect") in ("worse", "rejected", "guard_fail"),
                    f"{project_path} knownBad expect must be worse, rejected or guard_fail",
                    EXIT_INVALID,
                )
        elif not allow_sample:
            raise kitcore.Invalid(
                f"--data {base} has no kit.json. Add project baseline and knownBad controls there, "
                "or pass --allow-sample to use the labelled packaged example.",
                EXIT_INVALID,
            )
        else:
            kit["_manifest_base"] = kit_dir
            kit["_fixture_base"] = kit_dir

    for relative in [kit["baseline"].get("fixture")] + [c.get("fixture") for c in kit.get("knownBad", [])]:
        if relative:
            path = fixture_path(kit, relative)
            kitcore.require(path.is_file(), f"missing fixture {path}", EXIT_INVALID)

    for field in ("id", "name", "title", "metric", "direction", "check", "guards", "data", "baseline", "knownBad"):
        kitcore.require(field in kit, f"{kit_dir}/kit.json is missing {field}", EXIT_INVALID)
    kitcore.require(kit["data"].get("manifest"), f"{kit_dir}/kit.json data.manifest is required", EXIT_INVALID)
    return kit


def manifest_path(kit: dict) -> Path:
    return (kit["_manifest_base"] / kit["data"]["manifest"]).resolve()


def holdout_path(kit: dict, explicit: str | None) -> Path | None:
    if explicit:
        return Path(explicit).resolve()
    if kit["data"].get("holdout"):
        candidate = (kit["_manifest_base"] / kit["data"]["holdout"]).resolve()
        if candidate.is_file():
            return candidate
    return None


def fixture_path(kit: dict, relative: str) -> Path:
    return (kit["_fixture_base"] / relative).resolve()


def substitute(
    template: str,
    kit: dict,
    manifest: Path,
    candidate: str | None,
    placeholder: str,
    holdout: Path | None = None,
) -> str:
    value = placeholder if candidate is None else shlex.quote(candidate)
    text = template.replace("{kit}", str(kit["_kit_dir"]))
    text = text.replace("{manifest}", shlex.quote(str(manifest)))
    text = text.replace("{holdout}", shlex.quote(str(holdout)) if holdout else "<holdout>")
    text = text.replace("{candidate}", value)
    return text


def commands_for(kit: dict, args: argparse.Namespace) -> dict:
    manifest = manifest_path(kit)
    holdout = holdout_path(kit, args.holdout)
    score = substitute(kit["check"], kit, manifest, args.candidate, "<candidate>")
    guards = {
        name: substitute(kit["check"], kit, manifest, args.candidate, "<candidate>") + f" --guard {shlex.quote(name)}"
        for name in kit["guards"]
    }
    all_guards = score + " --all-guards"
    holdout_command = None
    if kit.get("holdout") and holdout is not None:
        holdout_command = substitute(
            kit["holdout"], kit, manifest, getattr(args, "holdout_candidate", None), "<holdout candidate>", holdout
        )
    climb = getattr(args, "climb", None) or str((kit["_kit_dir"] / ".." / ".." / "engine" / "climb.py").resolve())
    init_command = " ".join(
        [
            "python3",
            str((kit["_kit_dir"] / ".." / "preflight.py").resolve()),
            "commands",
            "--kit",
            kit["id"],
            "--data",
            str(kit["_manifest_base"]),
        ]
    )
    # The engine init command is assembled from the resolved kit, not from a template.
    engine_init = [
        "python3",
        climb,
        "init",
        kit["name"],
        "--goal",
        kit["goal"],
        "--check",
        score,
        "--direction",
        kit["direction"],
        "--runs",
        str(kit.get("repeats", {}).get("runs", 2)),
        "--min-gain",
        str(kit.get("min_gain", 0)),
        "--timeout",
        str(kit.get("timeout", 120)),
        "--after",
        kit.get("after", "stop"),
    ]
    engine_init += ["--guard", all_guards]
    if holdout_command:
        engine_init += ["--holdout", holdout_command]
        if kit.get("holdoutOnce"):
            engine_init.append("--holdout-once")
    final_command = None
    if kit.get("finalBaseline") and kit.get("holdout") and holdout is not None:
        final_command = substitute(
            kit["holdout"], kit, manifest, getattr(args, "holdout_candidate", None), "<holdout candidate>", holdout
        )
    return {
        "manifest": str(manifest),
        "holdout": str(holdout) if holdout else None,
        "candidate": args.candidate,
        "holdoutCandidate": getattr(args, "holdout_candidate", None),
        "finalCommand": final_command,
        "score": score,
        "guards": guards,
        "allGuards": all_guards,
        "holdoutOnce": bool(kit.get("holdoutOnce")),
        "holdoutRuns": int(kit.get("holdoutRuns", 1)),
        "holdoutCommand": holdout_command,
        "init": shlex.join(engine_init),
        "initCommand": init_command,
    }


def rows_for(results: Path | None, candidate: str | None, timeout: float, cwd: str) -> list[dict]:
    if candidate is None:
        kitcore.require(results is not None, "pass --results or --candidate", EXIT_USAGE)
        return kitcore.load_rows(results)
    stdout, stderr = kitcore.run_candidate(candidate, timeout, cwd)
    if stderr.strip():
        print(stderr.rstrip(), file=sys.stderr)
    return kitcore.parse_rows_text(stdout, source="candidate")


def score_rows(kit: dict, manifest: Path, rows: list[dict]) -> dict:
    """Visible scoring. The holdout is never passed here."""
    main = kitcore.load_json(manifest)
    return kitcore.score(kit["id"], main, rows, None)


def guard_rows(kit: dict, manifest: Path, rows: list[dict], holdout_ids: dict | None = None) -> dict:
    """Visible guards. ``holdout_ids`` carries only instance ids for the disjoint check."""
    main = kitcore.load_json(manifest)
    result = kitcore.score(kit["id"], main, rows, None)
    return kitcore.guard_failures(kit["id"], main, rows, result, holdout_ids)


def holdout_ids_for(kit: dict, holdout: Path | None) -> dict | None:
    """Read only the holdout instance ids, never its metrics."""
    if holdout is None or not holdout.is_file():
        return None
    document = kitcore.load_json(holdout)
    ids = document.get("holdout") if isinstance(document, dict) else None
    return {"holdout": ids} if isinstance(ids, list) else None


def numbers_equal(left: float, right: float) -> bool:
    return abs(float(left) - float(right)) <= max(1e-9, abs(float(right)) * 1e-9)


def is_worse(actual: float, baseline: float, direction: str) -> bool:
    return actual > baseline if direction == "min" else actual < baseline


def run_preflight(kit: dict, args: argparse.Namespace) -> dict:
    manifest = manifest_path(kit)
    holdout = holdout_path(kit, args.holdout)
    payload: dict = {
        "ok": False,
        "project": kit["_project"],
        "data": str(kit["_manifest_base"]),
        "manifest": str(manifest),
        "holdout": str(holdout) if holdout else None,
        "baseline": None,
        "knownBad": [],
        "repeats": None,
        "commands": commands_for(kit, args),
        "errors": [],
    }

    try:
        manifest_doc = kitcore.load_json(manifest)
        kitcore.require(isinstance(manifest_doc, dict), "manifest must be a JSON object", EXIT_INVALID)
        baseline_fixture = fixture_path(kit, kit["baseline"]["fixture"])
        rows = rows_for(baseline_fixture, args.candidate, args.timeout, args.cwd)
        result = score_rows(kit, manifest, rows)
        guards = guard_rows(kit, manifest, rows, holdout_ids_for(kit, holdout))
    except kitcore.Invalid as error:
        payload["errors"].append(str(error))
        payload["code"] = error.code
        return payload

    payload["baseline"] = {
        "score": result["score"],
        "expected": kit["baseline"].get("expected"),
        "valid": True,
        "guards": {name: not failures for name, failures in guards.items()},
        "guardFailures": {name: failures for name, failures in guards.items() if failures},
        "sample": bool(manifest_doc.get("sample")),
    }
    failed_guards = {name: failures for name, failures in guards.items() if failures}
    if failed_guards:
        payload["errors"].append("baseline guards failed: " + json.dumps(failed_guards))
        payload["code"] = EXIT_BASELINE
        return payload
    if args.candidate is None and "expected" in kit["baseline"]:
        if not numbers_equal(result["score"], kit["baseline"]["expected"]):
            payload["errors"].append(
                f"baseline score {result['score']} does not match declared {kit['baseline']['expected']}"
            )
            payload["code"] = EXIT_BASELINE
            return payload

    for control in kit["knownBad"]:
        entry = {
            "id": control.get("id"),
            "expect": control.get("expect"),
            "guard": control.get("guard"),
            "ok": False,
        }
        try:
            control_rows = kitcore.load_rows(fixture_path(kit, control["fixture"]))
            control_result = score_rows(kit, manifest, control_rows)
            control_guards = guard_rows(kit, manifest, control_rows, holdout_ids_for(kit, holdout))
        except kitcore.Invalid as error:
            entry["actual"] = "rejected"
            entry["error"] = str(error)
            entry["ok"] = control.get("expect") == "rejected"
            payload["knownBad"].append(entry)
            continue
        entry["actual"] = "valid"
        entry["score"] = control_result["score"]
        if control.get("expect") == "worse":
            entry["ok"] = is_worse(control_result["score"], result["score"], kit["direction"])
        elif control.get("expect") == "valid":
            entry["ok"] = True
        elif control.get("expect") == "guard_fail":
            guard_name = control.get("guard")
            entry["ok"] = bool(guard_name and control_guards.get(guard_name))
        payload["knownBad"].append(entry)

    if not all(entry["ok"] for entry in payload["knownBad"]):
        payload["errors"].append("one or more known-bad controls were not caught")
        payload["code"] = EXIT_KNOWN_BAD
        return payload

    repeats = kit.get("repeats", {})
    runs = args.repeats if args.repeats is not None else repeats.get("runs", 2)
    repeat_runs = max(1, runs)
    scores: list[float] = []
    if args.candidate is not None:
        scores.append(result["score"])
        extra_runs = max(0, repeat_runs - 1)
    else:
        extra_runs = repeat_runs
    for _ in range(extra_runs):
        try:
            repeat_rows = rows_for(baseline_fixture, args.candidate, args.timeout, args.cwd)
            scores.append(score_rows(kit, manifest, repeat_rows)["score"])
        except kitcore.Invalid as error:
            payload["errors"].append(f"repeat run failed: {error}")
            payload["code"] = error.code
            return payload
    spread = max(scores) - min(scores)
    limit = args.max_spread if args.max_spread is not None else repeats.get("maxSpread")
    payload["repeats"] = {
        "runs": len(scores),
        "scores": scores,
        "spread": spread,
        "maxSpread": limit,
    }
    if limit is not None and spread > limit:
        payload["errors"].append(f"repeat spread {spread} exceeds {limit}")
        payload["code"] = EXIT_NOISE
        return payload

    payload["ok"] = True
    payload["code"] = EXIT_OK
    return payload


def run_final(kit: dict, args: argparse.Namespace) -> dict:
    """The once-only private final read. It is the only path that reads holdout metrics."""
    manifest = manifest_path(kit)
    holdout = holdout_path(kit, args.holdout)
    payload: dict = {
        "ok": False,
        "project": kit["_project"],
        "data": str(kit["_manifest_base"]),
        "manifest": str(manifest),
        "holdout": str(holdout) if holdout else None,
        "final": None,
        "controls": [],
        "errors": [],
    }
    try:
        kitcore.require(isinstance(kit.get("finalBaseline"), dict), "kit declares no finalBaseline", EXIT_INVALID)
        kitcore.require(holdout is not None and holdout.is_file(), "the final read needs a holdout manifest", EXIT_INVALID)
        manifest_doc = kitcore.load_json(manifest)
        holdout_doc = kitcore.load_json(holdout)
        results = Path(args.results) if args.results else fixture_path(kit, kit["finalBaseline"]["fixture"])
        rows = rows_for(results, args.candidate, args.timeout, args.cwd)
        result = kitcore.score(kit["id"], manifest_doc, rows, holdout_doc)
        guards = kitcore.guard_failures(kit["id"], manifest_doc, rows, result, holdout_doc)
    except kitcore.Invalid as error:
        payload["errors"].append(str(error))
        payload["code"] = error.code
        return payload

    failed_guards = {name: failures for name, failures in guards.items() if failures}
    payload["final"] = {
        "score": result["score"],
        "metric": result["metric"],
        "unit": result.get("unit"),
        "expected": kit["finalBaseline"].get("expected"),
        "holdout": result.get("holdout"),
        "guards": {name: not failures for name, failures in guards.items()},
        "guardFailures": failed_guards,
    }
    if failed_guards:
        payload["errors"].append("final guards failed: " + json.dumps(failed_guards))
        payload["code"] = EXIT_BASELINE
        return payload
    if "expected" in kit["finalBaseline"] and not numbers_equal(result["score"], kit["finalBaseline"]["expected"]):
        payload["errors"].append(
            f"final score {result['score']} does not match declared {kit['finalBaseline']['expected']}"
        )
        payload["code"] = EXIT_BASELINE
        return payload

    for control in kit.get("finalControls", []):
        entry = {"id": control.get("id"), "expect": control.get("expect"), "ok": False}
        try:
            control_rows = kitcore.load_rows(fixture_path(kit, control["fixture"]))
            control_result = kitcore.score(kit["id"], manifest_doc, control_rows, holdout_doc)
            control_guards = kitcore.guard_failures(kit["id"], manifest_doc, control_rows, control_result, holdout_doc)
            entry["actual"] = "valid"
            if control.get("expect") == "guard_fail":
                guard_name = control.get("guard")
                entry["ok"] = bool(guard_name and control_guards.get(guard_name))
        except kitcore.Invalid as error:
            entry["actual"] = "rejected"
            entry["error"] = str(error)
            entry["ok"] = control.get("expect") == "rejected"
        payload["controls"].append(entry)

    if not all(entry["ok"] for entry in payload["controls"]):
        payload["errors"].append("one or more final controls were not caught")
        payload["code"] = EXIT_KNOWN_BAD
        return payload

    payload["ok"] = True
    payload["code"] = EXIT_OK
    return payload


def print_human(payload: dict) -> None:
    if not payload["ok"]:
        print(f"FAIL {payload.get('data', '')}", file=sys.stderr)
        for error in payload.get("errors", []):
            print(f"  - {error}", file=sys.stderr)
        return
    baseline = payload["baseline"]
    print(f"OK {payload['data']} ({'project' if payload['project'] else 'sample'})")
    print(f"  baseline: {baseline['score']} (declared {baseline.get('expected')})")
    print(f"  guards: {', '.join(baseline['guards'])}")
    print(f"  known-bad: {len(payload['knownBad'])} caught")
    print(f"  repeats: {payload['repeats']['runs']} runs, spread {payload['repeats']['spread']}")
    print(f"  score: {payload['commands']['score']}")
    if payload["commands"].get("holdoutCommand"):
        print(f"  holdout: {payload['commands']['holdoutCommand']}")
    print(f"  init: {payload['commands']['init']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Preflight and command builder for Hill Climb starter kits.")
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list", help="list the five starter kits")
    listing.add_argument("--json", action="store_true")

    commands = sub.add_parser("commands", help="emit score, guard, holdout and init commands")
    commands.add_argument("--kit", required=True, choices=kit_ids())
    commands.add_argument("--data", help="project data directory containing kit.json and fixtures")
    commands.add_argument("--candidate", help="project command that prints validation JSON rows")
    commands.add_argument("--holdout-candidate", help="separate command for the held-out split")
    commands.add_argument("--holdout", help="explicit holdout manifest path")
    commands.add_argument("--allow-sample", action="store_true", help="allow the labelled packaged example")
    commands.add_argument("--climb", help="path to climb.py; defaults to the engine beside the installed kits")
    commands.add_argument("--json", action="store_true")

    preflight = sub.add_parser("preflight", help="run baseline, guards, known-bad controls and repeats")
    preflight.add_argument("--kit", required=True, choices=kit_ids())
    preflight.add_argument("--data", help="project data directory containing kit.json and fixtures")
    preflight.add_argument("--candidate", help="project command that prints validation JSON rows")
    preflight.add_argument("--holdout", help="explicit holdout manifest path (never scored by preflight)")
    preflight.add_argument("--holdout-candidate", help="separate command for the held-out split; never run by preflight")
    preflight.add_argument("--allow-sample", action="store_true", help="allow the labelled packaged example")
    preflight.add_argument("--climb", help="path to climb.py; defaults to the engine beside the installed kits")
    preflight.add_argument("--repeats", type=int, help="override the kit's repeat count")
    preflight.add_argument("--max-spread", type=float, help="override the kit's maximum repeat spread")
    preflight.add_argument("--timeout", type=float, default=120.0, help="candidate timeout in seconds")
    preflight.add_argument("--cwd", default=".", help="candidate working directory")
    preflight.add_argument("--json", action="store_true")

    final = sub.add_parser("final", help="run the once-only private final read on the holdout")
    final.add_argument("--kit", required=True, choices=kit_ids())
    final.add_argument("--data", help="project data directory containing kit.json and fixtures")
    final.add_argument("--candidate", help="command that prints the final rows")
    final.add_argument("--results", help="file holding the final rows")
    final.add_argument("--holdout", help="explicit holdout manifest path")
    final.add_argument("--allow-sample", action="store_true", help="allow the labelled packaged sample")
    final.add_argument("--timeout", type=float, default=300.0, help="candidate timeout in seconds")
    final.add_argument("--cwd", default=".", help="candidate working directory")
    final.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "list":
        kits = []
        for kit_id in kit_ids():
            kit = load_kit(kit_id)
            kits.append(
                {
                    "id": kit["id"],
                    "title": kit["title"],
                    "metric": kit["metric"],
                    "unit": kit.get("unit"),
                    "direction": kit["direction"],
                    "scoreMode": kit.get("scoreMode"),
                    "guards": kit["guards"],
                    "sample": kit["data"].get("sample", True),
                }
            )
        if args.json:
            print(json.dumps(kits, indent=2))
        else:
            for kit in kits:
                print(f"{kit['id']:<16} {kit['metric']:<20} {kit['direction']:<4} {kit['title']}")
        return EXIT_OK

    try:
        kit = load_kit(args.kit, args.data, args.allow_sample)
        if args.command == "commands":
            payload = commands_for(kit, args)
            if args.json:
                print(json.dumps(payload, indent=2))
            else:
                print(f"score: {payload['score']}")
                for name, command in payload["guards"].items():
                    print(f"guard {name}: {command}")
                if payload["holdoutCommand"]:
                    print(f"holdout: {payload['holdoutCommand']}")
                print(f"init: {payload['init']}")
            return EXIT_OK
        if args.command == "final":
            payload = run_final(kit, args)
            if args.json:
                print(json.dumps(payload, indent=2))
            elif payload["ok"]:
                print(f"OK final {payload['data']}: {payload['final']['score']} ({payload['final']['metric']})")
            else:
                print_human(payload)
            return payload["code"]
        payload = run_preflight(kit, args)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print_human(payload)
        return payload["code"]
    except kitcore.Invalid as error:
        if getattr(args, "json", False):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "code": error.code,
                        "project": bool(args.data),
                        "data": args.data,
                        "errors": [str(error)],
                    },
                    indent=2,
                )
            )
        print(str(error), file=sys.stderr)
        return error.code


if __name__ == "__main__":
    raise SystemExit(main())
