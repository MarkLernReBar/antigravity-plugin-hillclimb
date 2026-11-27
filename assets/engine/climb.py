#!/usr/bin/env python3
"""Keep score for a hill climb.

The agent edits code. This script runs the check, decides keep or undo,
commits kept steps, and writes the log. The model never grades itself.
"""

import argparse
import fcntl
import hashlib
import io
import json
import math
import os
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tarfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
NUMBER = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")
BARS = "▁▂▃▄▅▆▇█"
STALL = 3
PLATEAU = 5
BUNDLED_DIFF_LINES = 150
NOTES_STALE_STEPS = 3
HOLDOUT_CHECKPOINT_KEPT = 3
FILE_LIMIT = 512_000
KIT_LIMIT = 2_000_000
COMMIT_LIMIT = 10_000_000
STATE_WARN = 200_000_000
KIT_KEYS = ("name", "goal", "check", "probe", "direction", "guards", "holdout", "holdout_every", "lock", "runs", "paired", "min_gain", "timeout", "after", "max_steps", "max_hours", "hard", "repos", "score", "baseline", "score_mode", "holdout_once")
LEGACY_SCORE_MODE = "failure-count"
SCORE_MODES = ("numeric", LEGACY_SCORE_MODE)
SLOW_STEP = 120
MORE = "Stop and report. If the user gives more, run: climb.py budget --hours N, --steps N, or --off"

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_PGS = set()


class Fail(Exception):
    pass


class Interrupted(BaseException):
    def __init__(self, signum):
        super().__init__(f"interrupted by signal {signum}")
        self.signum = signum


def _kill_pg(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def kill_active_pgs():
    with _ACTIVE_LOCK:
        pids = list(_ACTIVE_PGS)
    for pid in pids:
        _kill_pg(pid)


def git(*args, check=True, cwd=None):
    result = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd)
    if check and result.returncode:
        raise Fail(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def repo():
    return Path(git("rev-parse", "--show-toplevel"))


def climbs_dir():
    return repo() / ".hill-climb"


def checkouts(card):
    return [repo(), *(Path(extra["path"]) for extra in card.get("repos", []))]


def resolve(name):
    if name:
        folder = climbs_dir() / name
        if not (folder / "card.json").is_file():
            raise Fail(f"No climb named {name!r}. Run: climb.py list")
        return folder
    found = sorted(path.parent for path in climbs_dir().glob("*/card.json"))
    if len(found) == 1:
        return found[0]
    if len(found) > 1:
        branch = git("branch", "--show-current", check=False)
        if branch:
            if branch.startswith("climb/"):
                candidate = climbs_dir() / branch[len("climb/"):]
                if (candidate / "card.json").is_file():
                    return candidate
            matching = []
            for folder in found:
                try:
                    card = json.loads((folder / "card.json").read_text())
                    if card.get("branch") == branch:
                        matching.append(folder)
                except (OSError, json.JSONDecodeError):
                    pass
            if len(matching) == 1:
                return matching[0]
        names = ", ".join(folder.name for folder in found)
        raise Fail(f"Name the climb ({names}). Run: climb.py list")
    raise Fail("No climb yet. Run: climb.py init")


def score_mode(card):
    """A card saved before --score-mode existed keeps the old reading: an absent summary is 0."""
    mode = card.get("score_mode") or LEGACY_SCORE_MODE
    if mode not in SCORE_MODES:
        raise Fail(f"The card says score mode {mode!r}, which this climb.py does not know. Use one of: {', '.join(SCORE_MODES)}")
    return mode


def load(folder):
    card = json.loads((folder / "card.json").read_text())
    if isinstance(card["check"], str):
        card["check"] = [card["check"]]
    card["score"] = card.get("score") or []
    score_mode(card)
    return card


def save(folder, card):
    (folder / "card.json").write_text(json.dumps(card, indent=2) + "\n")


def append(folder, row):
    row = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), **row}
    with (folder / "log.jsonl").open("a") as handle:
        handle.write(json.dumps(row) + "\n")
    return row


def rows(folder):
    path = folder / "log.jsonl"
    if not path.exists():
        return []
    items = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as error:
            raise Fail(f"Corrupt JSON in {path} at line {lineno}: {error.msg}") from None
        if not isinstance(item, dict):
            raise Fail(f"Corrupt log entry in {path} at line {lineno}: expected JSON object")
        items.append(item)
    return items


def tail(text, lines=15):
    return "\n".join(text.strip().splitlines()[-lines:])


_ERROR_SIGNAL_RE = re.compile(
    r"\b(?:INFRA_INVALID|INTEGRITY_FAIL|OVERALL_FLOOR_FAIL|ERROR|FAIL(?:ED)?|EXCEPTION|TRACEBACK|ASSERTIONERROR|TIMEOUT|TIMED\s+OUT|INVALID)\b",
    re.IGNORECASE,
)


def _clean_lines(text):
    clean = ANSI.sub("", text or "")
    out = []
    for line in clean.splitlines():
        part = line.rstrip("\r").split("\r")[-1].strip()
        if part:
            out.append(part)
    return out


def _pick_reason_line(stdout, stderr):
    """Pick the highest-signal error line (preferring structured stdout diagnostics over noisy stderr logs)."""
    out_lines = _clean_lines(stdout)
    err_lines = _clean_lines(stderr)
    for bucket in (out_lines, err_lines):
        for line in reversed(bucket):
            if NUMBER.fullmatch(line):
                continue
            if _ERROR_SIGNAL_RE.search(line):
                return line[:160]
    for line in reversed(out_lines):
        if not NUMBER.fullmatch(line):
            return line[:160]
    for line in reversed(err_lines):
        if not NUMBER.fullmatch(line):
            return line[:160]
    return ""


def failure_excerpt(result, lines=12):
    out_tail = tail(ANSI.sub("", result.stdout or ""), lines)
    err_tail = tail(ANSI.sub("", result.stderr or ""), lines)
    if out_tail and err_tail:
        return f"[stderr]\n{err_tail}\n[stdout]\n{out_tail}"
    return out_tail or err_tail


def _decode_pipe(data):
    if not data:
        return ""
    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
    return text.replace("\r\n", "\n")


def _run(command, timeout, env=None):
    run_env = None
    if env is not None:
        run_env = os.environ.copy()
        for key, value in env.items():
            if value is None:
                run_env.pop(key, None)
            else:
                run_env[key] = value
    process = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True, env=run_env,
    )
    with _ACTIVE_LOCK:
        _ACTIVE_PGS.add(process.pid)
    try:
        try:
            raw_out, raw_err = process.communicate(timeout=timeout)
            stdout, stderr = _decode_pipe(raw_out), _decode_pipe(raw_err)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr), stdout, stderr
        except subprocess.TimeoutExpired:
            _kill_pg(process.pid)
            try:
                raw_out, raw_err = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                raw_out, raw_err = b"", b""
            return None, _decode_pipe(raw_out), _decode_pipe(raw_err)
    except BaseException:
        _kill_pg(process.pid)
        try:
            process.communicate(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            pass
        raise
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE_PGS.discard(process.pid)


def run(command, timeout, env=None):
    return _run(command, timeout, env=env)[0]


def _together(commands, timeout, env=None):
    with ThreadPoolExecutor() as pool:
        try:
            return list(pool.map(lambda command: _run(command, timeout, env=env), commands))
        except BaseException:
            kill_active_pgs()
            raise


def together(commands, timeout, env=None):
    return [result for result, _, _ in _together(commands, timeout, env=env)]


def read_score(result, pattern, mode=LEGACY_SCORE_MODE):
    """Read one observation. numeric needs a real, finite number; failure-count may read an absent summary as 0."""
    numeric = mode == "numeric"
    text = ANSI.sub("", result.stdout + result.stderr)
    if numeric and result.returncode:
        reason = _pick_reason_line(result.stdout, result.stderr)
        headline = f"check exited {result.returncode}: {reason}" if reason else f"check exited {result.returncode}"
        raise Fail(f"{headline} (cannot win under --score-mode numeric)\n{failure_excerpt(result)}")
    if pattern:
        raw_lines = [line.rstrip("\r").split("\r")[-1] for line in text.split("\n")]
        lines = [line for line in raw_lines if re.search(pattern, line)]
        if lines:
            found = [group for match in re.finditer(pattern, lines[-1])
                     for group in (match.groups() if match.re.groups else [match.group()]) if group is not None]
            if not found:
                raise Fail(f"--score matched {lines[-1].strip()!r} but captured no value")
            values = [value.replace(",", "") for value in found]
            if not all(NUMBER.fullmatch(value) for value in values):
                raise Fail(f"--score matched {found!r} in {lines[-1].strip()!r}, which is not a number")
            numbers = [float(value) for value in values]
            if numeric:
                bad = [value for value, scored in zip(values, numbers) if not math.isfinite(scored)]
                if bad:
                    raise Fail(f"--score matched {bad[0]!r} in {lines[-1].strip()!r}, which is not a finite number")
            total = sum(numbers)
            return total if math.isfinite(total) else None
        if not result.returncode:
            if numeric:
                raise Fail(
                    f"check exited 0 and printed nothing that matches --score. Under --score-mode numeric a "
                    f"missing measurement is a failed run, not 0. Print the measurement, or use "
                    f"--score-mode failure-count for a count of failures.\n{failure_excerpt(result)}"
                )
            return 0.0
        reason = _pick_reason_line(result.stdout, result.stderr)
        headline = f"check exited {result.returncode} (no --score match): {reason}" if reason else f"check exited {result.returncode} and printed nothing that matches --score"
        raise Fail(f"{headline}\n{failure_excerpt(result)}")
    if result.returncode:
        reason = _pick_reason_line(result.stdout, result.stderr)
        headline = f"check exited {result.returncode}: {reason}" if reason else f"check exited {result.returncode}"
        raise Fail(f"{headline}\n{failure_excerpt(result)}")
    raw_out = ANSI.sub("", result.stdout)
    lines = [
        part
        for line in raw_out.split("\n")
        for part in [line.rstrip("\r").split("\r")[-1].strip()]
        if part
    ]
    if not lines or not NUMBER.fullmatch(lines[-1]):
        raise Fail(f"the last line of check output must be the score\n{failure_excerpt(result)}")
    score = float(lines[-1])
    if not math.isfinite(score):
        raise Fail(f"the last line of check output is not a finite number: {lines[-1]!r}")
    return score


def measure(checks, runs, timeout, output=None, patterns=None, mode=LEGACY_SCORE_MODE, env=None):
    patterns = patterns or [None]
    if len(patterns) not in (1, len(checks)):
        raise Fail(f"Give one --score for all checks, or one per check: {len(patterns)} for {len(checks)} checks.")
    patterns = patterns * len(checks) if len(patterns) == 1 else patterns
    scores, seconds = [], []
    for attempt in range(runs + (runs > 1)):
        start = time.monotonic()
        outcomes = _together(checks, timeout, env=env)
        seconds.append(time.monotonic() - start)
        results = [result for result, _, _ in outcomes]
        if output:
            chunks = []
            for command, (result, out, err) in zip(checks, outcomes):
                if result is not None:
                    chunks.append(f"$ {command}\n{result.stdout}{result.stderr}")
                else:
                    chunks.append(f"$ {command}\n[timed out after {timeout}s]\n{out}{err}")
            output.write_text("\n".join(chunks))
        if None in results:
            raise Fail(f"check timed out after {timeout}s: {checks[results.index(None)]}")
        values = [read_score(result, pattern, mode) for result, pattern in zip(results, patterns)]
        if any(value is None for value in values):
            raise Fail("the check score is not a finite number")
        score = sum(values)
        if not math.isfinite(score):
            raise Fail(f"the checks add up to {score!r}, which is not a finite number")
        if runs > 1 and attempt == 0:
            seconds.pop()
            continue
        scores.append(score)
    return statistics.median(scores), max(scores) - min(scores), sum(seconds) / len(seconds)


def switch_trees(trees):
    for path, tree in trees.items():
        git("clean", "-fdq", cwd=path)
        git("read-tree", "-u", "--reset", tree, cwd=path)


def paired(folder, card, cache_env=None):
    if card["best"]["score"] == 0:
        raise Fail("--paired needs a score that is never 0")
    trees = {}
    for path in checkouts(card):
        git("add", "-A", cwd=path)
        trees[str(path)] = git("write-tree", cwd=path)
    pending = folder / "pending-tree"
    pending.write_text(json.dumps(trees) + "\n")
    base_log = folder / "last-base.txt"
    no_cache_env = {"HILLCLIMB_CACHE_FILE": None, "HILLCLIMB_CACHE_TOKEN": None}
    base, new, seconds = [], [], []
    try:
        for turn in range(card["runs"] + card["runs"] % 2):
            order = [(trees, new), (dict.fromkeys(trees, "HEAD"), base)]
            for side, scores in order if turn % 2 == 0 else order[::-1]:
                switch_trees(side)
                log_target = folder / "last.txt" if side is trees else base_log
                step_env = cache_env if side is trees else no_cache_env
                try:
                    score, _, took = measure(card["check"], 1, card["timeout"], log_target, card["score"], score_mode(card), env=step_env)
                except Fail:
                    if side is not trees and base_log.exists():
                        shutil.copyfile(base_log, folder / "last.txt")
                    raise
                if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
                    raise Fail("the check changed a locked file")
                scores.append(score)
                seconds.append(took)
        switch_trees(trees)
        for path in trees:
            git("reset", "-q", cwd=path)
        pending.unlink(missing_ok=True)
    except BaseException as exc:
        if not isinstance(exc, Fail):
            kill_active_pgs()
            try:
                switch_trees(trees)
                for path in trees:
                    git("reset", "-q", cwd=path)
                pending.unlink(missing_ok=True)
            except BaseException:
                pass
        raise
    finally:
        base_log.unlink(missing_ok=True)
    new, base = statistics.median(new), statistics.median(base)
    if base == 0 or card["best"]["score"] == 0:
        raise Fail("--paired needs a score that is never 0")
    return card["best"]["score"] * new / base, [base, new], sum(seconds) / len(seconds)


def failing_guards(guards, timeout, env=None):
    for command in guards:
        result, out, err = _run(command, timeout, env=env)
        if result is None:
            snippet = tail(out + err)
            return command, f"timed out after {timeout}s" + (f"\n{snippet}" if snippet else "")
        if result.returncode:
            return command, tail(result.stdout + result.stderr)
    return None


def ignored(files, folder):
    if not files:
        return set()
    found = subprocess.run(["git", "check-ignore", "--stdin"], input="\n".join(map(str, files)), cwd=folder,
                           capture_output=True, text=True).stdout
    return set(found.splitlines())


def fingerprint(paths):
    digest = hashlib.sha256()
    root = repo()
    for name in paths:
        target = root / name
        if not target.exists():
            raise Fail(f"Locked path does not exist: {name}")
        if target.is_file():
            files = [target]
            skip = set() if ".hill-climb" in target.parts else ignored(files, target.parent)
        else:
            prune = {".git", "__pycache__"}
            check_ignore = ".hill-climb" not in target.parts
            if check_ignore:
                prune.add(".hill-climb")
            files = []
            for dirpath, dirnames, filenames in os.walk(target):
                kept = [d for d in sorted(dirnames) if d not in prune]
                if check_ignore and kept:
                    dir_paths = [f"{os.path.join(dirpath, d)}/" for d in kept]
                    bad_dirs = ignored(dir_paths, target)
                    kept = [d for d, dp in zip(kept, dir_paths) if dp not in bad_dirs]
                dirnames[:] = kept
                for fname in sorted(filenames):
                    candidate = Path(dirpath) / fname
                    if candidate.is_file():
                        files.append(candidate)
            files.sort()
            skip = set() if not check_ignore else ignored(files, target)
        for path in files:
            if str(path) in skip:
                continue
            digest.update(os.path.relpath(path, root).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def threshold(min_gain, score):
    text = str(min_gain)
    percent = text.endswith("%")
    try:
        minimum = float(text[:-1] if percent else text)
    except ValueError:
        raise Fail("--min-gain must be a finite, nonnegative number or percent") from None
    if not math.isfinite(minimum) or minimum < 0:
        raise Fail("--min-gain must be a finite, nonnegative number or percent")
    return abs(score) * (minimum / 100) if percent else minimum


def better(card, new, old):
    gain = threshold(card["min_gain"], old)
    return new > old + gain if card["direction"] == "max" else new < old - gain


def reached(card, score):
    target = card["target"]
    if target is None:
        return False
    return score >= target if card["direction"] == "max" else score <= target


def bar(text, baseline, direction):
    if text is None:
        return None
    if text.endswith("x"):
        factor = float(text[:-1])
        if factor <= 1:
            raise Fail("A bar like 2x needs a factor above 1.")
        return baseline / factor if direction == "min" else baseline * factor
    return float(text)


def outside(paths, allowed):
    def inside(path, lock):
        norm = lock.rstrip("/")
        if norm == ".":
            return path != ".." and not path.startswith("../")
        return path == norm or path.startswith(norm + "/")
    return [path for path in paths if not any(inside(path, lock) for lock in allowed)]


def number(value):
    return f"{value:.6g}"


def interrupted(folder):
    trees = json.loads((folder / "pending-tree").read_text())
    restore = " && ".join(
        f"{shlex.join(['git', '-C', path, 'read-tree', '-u', '--reset', tree])} && "
        f"{shlex.join(['git', '-C', path, 'reset', '-q'])}"
        for path, tree in trees.items()
    )
    return (f"A paired step was cut off and the tree may hold the old code. Restore the edit with: "
            f"{restore} && {shlex.join(['rm', str(folder / 'pending-tree')])}")


def gaining(steps):
    kept = [row for row in steps if row["result"] == "kept" and row.get("gain", True)]
    if not kept:
        return False
    at = time.mktime(time.strptime(kept[-1]["time"], "%Y-%m-%d %H:%M:%S"))
    return time.time() - at < 3600 and len(steps) - kept[-1]["step"] < PLATEAU


def hours(card):
    return (time.time() - card["started"]) / 3600 if card.get("started") else 0


def changed_files(roots):
    root = repo()
    return sorted({
        os.path.relpath(path / name, root)
        for path in roots
        for name in git("diff", "--name-only", "HEAD", cwd=path).splitlines()
        + git("ls-files", "--others", "--exclude-standard", cwd=path).splitlines()
    })


def too_big(paths):
    return [path for path in paths if os.path.isfile(path) and os.path.getsize(path) > COMMIT_LIMIT]


def folder_size(folder):
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file() and not path.is_symlink())


def dirty(roots):
    return any(git("status", "--porcelain", cwd=path) for path in roots)


def undo(card):
    for path in checkouts(card):
        git("reset", "--hard", "-q", "HEAD", cwd=path)
        git("clean", "-fdq", cwd=path)


def commit(roots, message):
    done = []
    try:
        for path in roots:
            if git("status", "--porcelain", cwd=path):
                head = git("rev-parse", "HEAD", cwd=path)
                git("add", "-A", cwd=path)
                git("commit", "-q", "--no-verify", "-m", message, cwd=path)
                done.append((path, head))
    except Fail:
        for path, head in done:
            git("reset", "--soft", "-q", head, cwd=path)
        raise


def keep_output(folder):
    if (folder / "last.txt").exists():
        shutil.copyfile(folder / "last.txt", folder / "best.txt")


def exclude_state(path=None):
    exclude = Path(git("rev-parse", "--git-path", "info/exclude", cwd=path))
    if not exclude.is_absolute():
        exclude = Path(path or repo()) / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text() if exclude.exists() else ""
    if "/.hill-climb/" not in text.splitlines():
        exclude.write_text(text + ("" if text.endswith("\n") or not text else "\n") + "/.hill-climb/\n")


def hold_lock():
    handle = open(git("rev-parse", "--git-path", "hill-climb.lock"), "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Fail("Another climb.py command is still running in this checkout. Wait for it to finish. "
                   "A command you interrupted can still be running.")
    return handle


def kits_dir():
    return Path(os.environ.get("HILL_CLIMB_HOME") or Path.home() / ".hill-climb") / "kits"


def repo_key():
    url = git("remote", "get-url", "origin", check=False)
    name = url.rstrip("/").split("/")[-1].split(":")[-1].removesuffix(".git") if url else ""
    return name or repo().name


def save_kit(folder, card):
    root = repo()
    inside = [lock for lock in card["lock"] if not lock.startswith("..")]
    names = git("ls-files", "--", *inside).splitlines() if inside else []
    names += [str(path.relative_to(root)) for path in sorted(folder.rglob("*"))
              if path.name not in ("card.json", "log.jsonl", "last.txt", "best.txt", "pending-tree", "running.json")
              and "data" not in path.relative_to(folder).parts[:1]]
    files = [name for name in dict.fromkeys(names) if (root / name).is_file() and (root / name).stat().st_size <= FILE_LIMIT]
    meta = {key: card.get(key) for key in KIT_KEYS}
    meta["repos"] = [{"path": os.path.relpath(extra["path"], root)} for extra in card.get("repos", [])]
    meta.update(repo=repo_key(), target=card.get("target_text"), best=card["best"]["score"], files=files, saved=time.strftime("%Y-%m-%d %H:%M"))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        data = json.dumps(meta, indent=2).encode()
        info = tarfile.TarInfo("kit.json")
        info.size, info.mtime = len(data), time.time()
        tar.addfile(info, io.BytesIO(data))
        for name in files:
            tar.add(root / name, arcname=f"files/{name}")
    size = len(buffer.getvalue())
    if size > KIT_LIMIT:
        return f"Kit not saved: {size // 1000} KB is over {KIT_LIMIT // 1000} KB. Keep big data out of the locked paths."
    target = kits_dir() / meta["repo"] / f"{card['name']}.tar.gz"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(buffer.getvalue())
    except OSError as error:
        return f"Kit not saved: {error}"
    return f"Saved kit {meta['repo']}/{card['name']}: {len(files)} files, {max(1, size // 1000)} KB."


def read_kit(path):
    with tarfile.open(path) as tar:
        meta = json.load(tar.extractfile("kit.json"))
        files = {}
        for member in tar.getmembers():
            if member.name == "kit.json":
                continue
            name = member.name.removeprefix("files/")
            if not member.isfile() or name == member.name or Path(name).is_absolute() or ".." in Path(name).parts:
                raise Fail(f"Kit {path.name} has an unsafe entry: {member.name}")
            files[name] = (tar.extractfile(member).read(), member.mode & 0o777)
    return meta, files


def find_kit(spec):
    if "/" in spec:
        found = [kits_dir() / f"{spec}.tar.gz"]
    else:
        here = kits_dir() / repo_key() / f"{spec}.tar.gz"
        found = [here] if here.is_file() else sorted(kits_dir().glob(f"*/{spec}.tar.gz"))
    found = [path for path in found if path.is_file()]
    if len(found) != 1:
        raise Fail(f"Name one kit as repo/name. Run: climb.py kits" if found else f"No kit named {spec!r}. Run: climb.py kits")
    return found[0]


def init_command(meta):
    words = ["python3", os.path.abspath(__file__), "init", meta["name"], "--goal", meta["goal"], "--direction", meta["direction"]]
    for check in [meta["check"]] if isinstance(meta["check"], str) else meta["check"]:
        words += ["--check", check]
    for guard in meta["guards"]:
        words += ["--guard", guard]
    for extra in meta.get("repos") or []:
        words += ["--repo", extra["path"]]
    for pattern in meta.get("score") or []:
        words += ["--score", pattern]
    words += ["--score-mode", meta.get("score_mode") or LEGACY_SCORE_MODE]
    for flag, key in (("--target", "target"), ("--probe", "probe"), ("--holdout", "holdout"), ("--holdout-every", "holdout_every"), ("--max-steps", "max_steps"), ("--max-hours", "max_hours")):
        if meta.get(key) is not None:
            words += [flag, str(meta[key])]
    words += ["--after", meta["after"], "--runs", str(meta["runs"]), "--min-gain", str(meta["min_gain"]), "--timeout", str(meta["timeout"])]
    for flag in ("paired", "hard", "holdout_once"):
        if meta.get(flag):
            words.append(f"--{flag.replace('_', '-')}")
    for lock in meta["lock"]:
        words += ["--lock", lock]
    return shlex.join(words)


def _cache_env(folder, token):
    return {
        "HILLCLIMB_CACHE_FILE": str(folder / "candidate-cache.json"),
        "HILLCLIMB_CACHE_TOKEN": token,
    }


def _set_running(folder, kind, *, phase=None, step=None, idea=None, started_at=None):
    """Write live running.json heartbeat so the UI shows what climb.py is doing in real time."""
    payload = {
        "kind": kind,
        "phase": phase or kind,
        "step": step,
        "idea": (idea or "")[:240] or None,
        "started_at": started_at if started_at is not None else time.time(),
        "pid": os.getpid(),
    }
    try:
        (folder / "running.json").write_text(json.dumps(payload) + "\n")
    except OSError:
        pass
    return payload["started_at"]


def _clear_running(folder):
    try:
        (folder / "running.json").unlink(missing_ok=True)
    except OSError:
        pass


def run_holdout(folder, card, reason):
    if not card["holdout"]:
        return None
    no_cache = {"HILLCLIMB_CACHE_FILE": None, "HILLCLIMB_CACHE_TOKEN": None}
    score, _, _ = measure([card["holdout"]], 1, card["timeout"], None, None, score_mode(card), env=no_cache)
    append(folder, {"kind": "holdout", "score": score, "visible": card["best"]["score"], "why": reason})
    return score


def cmd_init(args):
    if args.runs < 1:
        raise Fail("--runs must be at least 1")
    if args.holdout_every is not None:
        if args.holdout_every < 1:
            raise Fail("--holdout-every must be at least 1")
        if not args.holdout:
            raise Fail("--holdout-every requires --holdout")
        if args.holdout_once:
            raise Fail("--holdout-every cannot be combined with --holdout-once")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", args.name):
        raise Fail("Use a short lowercase name with dashes, like build-speed.")
    folder = climbs_dir() / args.name
    if (folder / "card.json").exists():
        raise Fail(f"Climb {args.name!r} already exists. Resume it with: climb.py status {args.name}")
    exclude_state()
    threshold(args.min_gain, 1)
    mode = args.score_mode or "numeric"
    lock = [os.path.relpath(os.path.abspath(path), repo()) for path in args.lock or []]
    roots = [repo()]
    for path in args.repo or []:
        top = Path(git("rev-parse", "--show-toplevel", cwd=path))
        if top in roots:
            raise Fail(f"--repo {path} is already part of this climb.")
        roots.append(top)
    if not args.here:
        for path in roots:
            probe = subprocess.run(
                ["git", "show-ref", "--verify", "--quiet", f"refs/heads/climb/{args.name}"],
                cwd=path,
            )
            if probe.returncode == 0:
                raise Fail(f"Branch 'climb/{args.name}' already exists in {path}. Pick another name or delete the old branch.")
    changed = changed_files(roots)
    stray = outside(changed, lock)
    if stray:
        raise Fail(
            "Commit or set aside changes outside the locked check files first: "
            + ", ".join(stray[:5])
        )
    folder.mkdir(parents=True, exist_ok=True)
    cache_path = folder / "candidate-cache.json"
    cache_env = _cache_env(folder, uuid.uuid4().hex)
    try:
        score, spread, seconds = measure(args.check, args.runs, args.timeout, folder / "best.txt", args.score, mode, env=cache_env)
        if args.paired and score == 0:
            raise Fail("--paired needs a score that is never 0")
        target = bar(args.target, score, args.direction)
        failed = failing_guards(args.guard or [], args.timeout, env=cache_env)
        if failed:
            raise Fail(f"A guard already fails before the climb starts: {failed[0]}\n{failed[1]}")
    finally:
        cache_path.unlink(missing_ok=True)
    changed = changed_files(roots)
    big = too_big(changed)
    if big:
        raise Fail(f"A file is over {COMMIT_LIMIT // 1_000_000} MB and would be committed: {big[0]}. "
                   f"Move big data under .hill-climb/{args.name}/data/.")
    locked = fingerprint(lock) if lock else None
    bases = [git("branch", "--show-current", cwd=path) for path in roots]
    if not args.here:
        for path in roots:
            git("switch", "-q", "-c", f"climb/{args.name}", cwd=path)
    commit(roots, f"climb({args.name}): add the check")
    base = bases[0]
    card = {
        "name": args.name,
        "goal": args.goal,
        "check": args.check,
        "probe": args.probe,
        "score": args.score or [],
        "score_mode": mode,
        "direction": args.direction,
        "guards": args.guard or [],
        "target": target,
        "target_text": args.target,
        "after": args.after,
        "runs": args.runs,
        "min_gain": args.min_gain,
        "timeout": args.timeout,
        "holdout": args.holdout,
        "holdout_once": bool(args.holdout_once),
        "holdout_every": args.holdout_every,
        "lock": lock,
        "fingerprint": locked,
        "max_steps": args.max_steps,
        "paired": args.paired,
        "max_hours": args.max_hours,
        "hard": args.hard,
        "started": time.time(),
        "base": base,
        "branch": git("branch", "--show-current"),
        "start_commit": git("rev-parse", "HEAD"),
        "repos": [{"path": str(path), "base": bases[index + 1], "branch": git("branch", "--show-current", cwd=path),
                   "start_commit": git("rev-parse", "HEAD", cwd=path)} for index, path in enumerate(roots[1:])],
    }
    for path in roots[1:]:
        exclude_state(path)
        (path / ".hill-climb").mkdir(exist_ok=True)
        (path / ".hill-climb" / "home").write_text(f"{repo()}\n")
    card["baseline"] = score
    card["best"] = {"score": score, "commit": card["start_commit"], "step": 0}
    save(folder, card)
    notes_path = folder / "notes.md"
    if not notes_path.exists():
        notes_path.write_text(
            f"# {args.name} notes\n\nGoal: {args.goal}\n\n"
            "## Remaining Misses (Pareto)\n"
            "| Failure bucket | Count | Max gain | Status |\n"
            "| --- | --- | --- | --- |\n"
            "| (profile misses before step 1) | - | - | untouched |\n\n"
            "## What Worked (Kept)\n"
            "- (none yet)\n\n"
            "## Dead Ends (Do Not Retry Unchanged)\n"
            "- (none yet)\n\n"
            "## Next Highest-Leverage Bucket\n"
            "- (fill after profiling baseline)\n"
        )
    append(folder, {"kind": "baseline", "score": score, "spread": spread, "seconds": round(seconds, 2)})
    holdout = None
    holdout_error = None
    if card["holdout"] and not card["holdout_once"]:
        try:
            holdout = run_holdout(folder, card, "baseline")
        except Fail as error:
            holdout_error = str(error).splitlines()[0]
    also = f" in {len(roots)} repos" if len(roots) > 1 else ""
    print(f"Climb {args.name} started on {card['branch']}{also}. Check output: {folder / 'best.txt'}")
    print(save_kit(folder, card))
    print(f"Baseline {number(score)} ({args.direction}), check takes {seconds:.1f}s.")
    if holdout is not None:
        print(f"Holdout baseline {number(holdout)}.")
    elif holdout_error is not None:
        print(f"Warning: holdout baseline failed ({holdout_error}). Dev baseline is saved.")
        print(f"Do not inspect holdout files; record the blind baseline first with: climb.py holdout {args.name} --why baseline")
    step_seconds = seconds * (2 * (args.runs + args.runs % 2) if args.paired else args.runs + (args.runs > 1))
    if step_seconds > SLOW_STEP:
        print(
            f"Warning: each step will take about {step_seconds / 60:.0f} min to score. Aim for under "
            f"{SLOW_STEP // 60} min: count the work instead of timing it, or score a sample, and move "
            f"the slow measure to --holdout. See 'Fast checks' in references/checks.md."
        )
    if args.runs > 1 and spread > threshold(args.min_gain, score):
        percent = 100 * spread / abs(score) if score else 0
        print(
            f"Warning: the score moved {number(spread)} ({percent:.1f}%) between runs with no code change. "
            f"Set --min-gain above that, or a lucky run will count as a win. A percent like "
            f"--min-gain {max(1, round(percent * 1.5))}% keeps working as the score shrinks. "
            f"If the machine's load changes the score, add --paired."
        )
    if not args.guard:
        crash = mode == "failure-count" and args.score and args.direction == "min"
        risk = ("A crash that stops the tests can print fewer failures and win." if crash
                else "A kept step can break anything the check does not measure.")
        print(f"Warning: no guard. {risk} Add --guard with the tests that pass today, or a build or typecheck.")
    if target is not None:
        print(f"Bar {number(target)}, then {args.after}.")
    if target is not None and reached(card, score):
        print("Warning: the baseline already meets the bar. Pick a harder bar.")


def cmd_try(args):
    folder = resolve(args.name)
    card = load(folder)
    roots = checkouts(card)
    for path, branch in zip(roots, [card["branch"], *(extra["branch"] for extra in card.get("repos", []))]):
        if git("branch", "--show-current", cwd=path) != branch:
            raise Fail(f"Switch {path} to {branch} first.")
    log_before = rows(folder)
    steps = [row for row in log_before if row["kind"] == "step"]
    over = []
    if card["max_steps"] and len(steps) >= card["max_steps"]:
        over.append(f"{len(steps)} of {card['max_steps']} steps")
    if card.get("max_hours") and hours(card) >= card["max_hours"]:
        over.append(f"{hours(card):.1f} of {number(card['max_hours'])} hours")
    if over and (card.get("hard") or not gaining(steps)):
        why = "" if card.get("hard") else f" and no gain in the last hour or {PLATEAU} steps"
        raise Fail(f"Budget used: {' and '.join(over)}{why}. {MORE}")
    if over:
        print(f"Past the limit ({' and '.join(over)}), but still gaining, so the climb goes on.")
    if (folder / "pending-tree").exists():
        raise Fail(interrupted(folder))
    if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
        raise Fail(
            "Locked files changed. Undo those edits, or if the check itself is wrong, "
            "run: climb.py relock --why '<reason>'"
        )
    if not dirty(roots):
        raise Fail("No change to try. Edit the code first.")
    files_changed, diff_lines = diff_stats(roots)
    step = len(steps) + 1
    best = card["best"]["score"]
    row = {"kind": "step", "step": step, "idea": args.idea}
    if files_changed:
        row["files"] = files_changed
    if diff_lines > 0:
        row["diff_lines"] = diff_lines
    cache_path = folder / "candidate-cache.json"
    cache_env = _cache_env(folder, uuid.uuid4().hex)
    timed_prior = [r["seconds"] for r in log_before if isinstance(r.get("seconds"), (int, float))]
    avg_check_sec = (sum(timed_prior) / len(timed_prior)) if timed_prior else 0.0
    run_guards_first = bool(card["guards"]) and not getattr(args, "no_guards_first", False) and (
        getattr(args, "guards_first", False) or avg_check_sec >= 60.0
    )
    probe_cmd = getattr(args, "probe", None) or (None if getattr(args, "no_probe", False) else card.get("probe"))
    guards_passed_pre = False
    started_at = _set_running(folder, "try", phase="guards" if run_guards_first else ("probe" if probe_cmd else "check"), step=step, idea=args.idea)
    try:
        if run_guards_first:
            failed = failing_guards(card["guards"], card["timeout"], env=cache_env)
            if failed:
                undo(card)
                logged = append(folder, {**row, "result": "undone", "why": f"guard failed (pre-check): {failed[0]}"})
                print(
                    f"step {step} undone  (pre-check guard failed: {failed[0]})\n"
                    f"{failed[1]}\nUndone before running slow check."
                )
                for warning in stall_and_notes_warnings(folder, card, steps + [logged]):
                    print(warning)
                return
            guards_passed_pre = True
        if probe_cmd:
            _set_running(folder, "try", phase="probe", step=step, idea=args.idea, started_at=started_at)
            probe_res, probe_out, probe_err = _run(probe_cmd, card["timeout"], env=cache_env)
            if probe_res is None or probe_res.returncode:
                undo(card)
                detail = (
                    f"timed out after {card['timeout']}s\n{tail(probe_out + probe_err)}"
                    if probe_res is None
                    else failure_excerpt(probe_res)
                )
                logged = append(folder, {**row, "result": "undone", "why": f"probe failed (pre-check): {probe_cmd}"})
                print(
                    f"step {step} undone  (pre-check probe failed: {probe_cmd})\n"
                    f"{detail}\nUndone before running full check."
                )
                for warning in stall_and_notes_warnings(folder, card, steps + [logged]):
                    print(warning)
                return
        _set_running(folder, "try", phase="check", step=step, idea=args.idea, started_at=started_at)
        try:
            if card.get("paired"):
                score, row["pair"], seconds = paired(folder, card, cache_env=cache_env)
            else:
                score, _, seconds = measure(card["check"], card["runs"], card["timeout"], folder / "last.txt", card["score"], score_mode(card), env=cache_env)
        except Fail as error:
            undo(card)
            (folder / "pending-tree").unlink(missing_ok=True)
            lines = [ln.strip() for ln in str(error).splitlines() if ln.strip()]
            if not lines:
                why = "check failed"
            elif len(lines) == 1 or ": " in lines[0]:
                why = lines[0][:180]
            else:
                why = f"{lines[0]}: {lines[-1][:140]}"[:180]
            logged = append(folder, {**row, "result": "broke", "why": why})
            print(f"step {step} broke   {args.idea}\n{error}\nUndone. Full output: {folder / 'last.txt'}")
            for warning in stall_and_notes_warnings(folder, card, steps + [logged]):
                print(warning)
            return
        row.update(score=score, seconds=round(seconds, 2))
        held = score >= best if card["direction"] == "max" else score <= best
        strictly_better = score > best if card["direction"] == "max" else score < best
        if not (better(card, score, best) or args.fix and held):
            delta_block, delta_summary = diff_check_outputs(folder / "best.txt", folder / "last.txt", card["direction"])
            if delta_summary:
                row["delta_summary"] = delta_summary
            undo(card)
            if args.fix:
                reason = "score got worse"
            elif strictly_better:
                delta = abs(score - best)
                need = threshold(card["min_gain"], best)
                reason = f"below min_gain (+{number(delta)} < {number(need)} — improved slightly; check run variance)"
            else:
                reason = "no gain"
            logged = append(folder, {**row, "result": "undone", "why": reason})
            extra = f"  [{reason}]" if strictly_better and not args.fix else ""
            print(f"step {step} undone  {number(score)} (best {number(best)})  {args.idea}{extra}\nOutput: {folder / 'last.txt'}")
            if delta_block:
                print(delta_block)
            if diff_lines >= BUNDLED_DIFF_LINES and (step - card["best"]["step"]) >= 2:
                print(
                    f"BUNDLED DIFF WARNING: undone step touched {diff_lines} lines across {len(files_changed)} file(s). "
                    "During a stall, isolate 1 causal edit and verify it flips >=1 missed case in a fast --probe before running full eval."
                )
            for warning in stall_and_notes_warnings(folder, card, steps + [logged]):
                print(warning)
            return
        if not guards_passed_pre:
            _set_running(folder, "try", phase="guards", step=step, idea=args.idea, started_at=started_at)
            failed = failing_guards(card["guards"], card["timeout"], env=cache_env)
            if failed:
                undo(card)
                append(folder, {**row, "result": "undone", "why": f"guard failed: {failed[0]}"})
                print(f"step {step} undone  {number(score)} but guard failed: {failed[0]}\n{failed[1]}")
                return
    finally:
        cache_path.unlink(missing_ok=True)
        _clear_running(folder)
    try:
        moved = card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]
    except Fail:
        moved = True
    if moved:
        undo(card)
        append(folder, {**row, "result": "broke", "why": "the check or a guard changed a locked file"})
        print(f"step {step} broke   {args.idea}\nThe check or a guard changed a locked file.\nUndone.")
        return
    big = too_big(changed_files(roots))
    if big:
        undo(card)
        append(folder, {**row, "result": "broke", "why": f"would commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}"})
        print(f"step {step} broke   {args.idea}\nWould commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}\n"
              f"Write big output under .hill-climb/{card['name']}/data/.\nUndone.")
        return
    commit(roots, f"climb({card['name']}): step {step} {args.idea}\n\nscore {number(score)}, was {number(best)}")
    keep_output(folder)
    card["best"] = {"score": score, "commit": git("rev-parse", "HEAD"), "step": step}
    save(folder, card)
    append(folder, {**row, "result": "kept", "gain": better(card, score, best)})
    print(f"step {step} kept    {number(score)} (was {number(best)}, start {number(card['baseline'])})  {args.idea}")
    if reached(card, score):
        if card.get("holdout") and not card.get("holdout_once"):
            _set_running(folder, "holdout", phase="holdout", step=step, idea="bar reached holdout check")
        try:
            holdout = None if card.get("holdout_once") else run_holdout(folder, card, "bar reached")
        finally:
            _clear_running(folder)
        print(f"BAR REACHED: {number(score)} meets {number(card['target'])}. The card says: {card['after']}.")
        if holdout is not None:
            print(f"Holdout now {number(holdout)}. Compare it with the holdout baseline before you claim a win.")
            warn = holdout_transfer_warning(card, [r for r in rows(folder) if r["kind"] == "holdout"])
            if warn:
                print(warn)
        print(f"Pre-ship audit: run `climb.py audit {card['name']}` and a fresh-context Adversarial Win Audit before confirming criteria or merging.")
    elif card.get("holdout") and not card.get("holdout_once"):
        log_now = rows(folder)
        since_h = kept_since_holdout(log_now)
        every = card.get("holdout_every")
        if every and since_h >= every:
            _set_running(folder, "holdout", phase="holdout", step=step, idea=f"checkpoint step {step}")
            try:
                h_score = run_holdout(folder, card, f"checkpoint step {step}")
                holdouts_now = [r for r in rows(folder) if r["kind"] == "holdout"]
                if len(holdouts_now) >= 2:
                    h0 = holdouts_now[0]["score"]
                    print(
                        f"Holdout checkpoint: {number(h0)} -> {number(h_score)} ({_signed_delta(h_score - h0)}), "
                        f"visible {number(card['baseline'])} -> {number(score)} ({_signed_delta(score - card['baseline'])})."
                    )
                    warn = holdout_transfer_warning(card, holdouts_now)
                    if warn:
                        print(warn)
                else:
                    print(f"Holdout checkpoint: {number(h_score)} (visible {number(score)}).")
            except Fail as error:
                print(f"Warning: automatic holdout checkpoint failed ({str(error).splitlines()[0]}). Kept step stands.")
            finally:
                _clear_running(folder)
        else:
            cp_warn = holdout_checkpoint_warning(card, log_now)
            if cp_warn:
                print(cp_warn)


_EXCUSE_CLAIM_RE = re.compile(
    r"\b(?:ceiling|impossible|cannot\s+be|physically|unsolvable|maxed\s+out|hard\s+limit|structural\s+limit|"
    r"requires?\s+(?:a\s+)?(?:paid|new|secondary|external|third[- ]party)|api\s+key|provider\s+key|buy\s+a|vendor)\b",
    re.IGNORECASE,
)


def _signed_delta(delta):
    sign = "+" if delta >= 0 else "-"
    return f"{sign}{number(abs(delta))}"


def kept_since_holdout(log):
    """Count kept steps since the last holdout run (or since start if no holdout run yet)."""
    last_h_idx = -1
    for idx, row in enumerate(log):
        if row.get("kind") == "holdout":
            last_h_idx = idx
    return sum(
        1 for row in log[last_h_idx + 1:]
        if row.get("kind") == "step" and row.get("result") == "kept"
    )


def holdout_checkpoint_warning(card, log):
    """Warn when a climb with holdout has accumulated kept steps without a mid-climb transfer check."""
    if not card.get("holdout") or card.get("holdout_once"):
        return None
    if card.get("target") is not None and reached(card, card["best"]["score"]):
        return None
    since_h = kept_since_holdout(log)
    cadence = card.get("holdout_every") or HOLDOUT_CHECKPOINT_KEPT
    if since_h < cadence:
        return None
    return (
        f"HOLDOUT CHECKPOINT DUE: {since_h} kept step(s) since the last blind holdout check. "
        f"Run: climb.py holdout {card['name']} --why checkpoint  "
        "(verifies visible gains actually transfer to unseen cases before investing more steps)."
    )


_GENERIC_METRIC_WORDS = frozenset({
    "score", "total", "overall", "mean", "median", "average", "count", "passed", "failed",
    "valid", "error", "errors", "metric", "metrics", "output", "result", "results", "status",
    "latency", "memory", "speed", "email", "emails", "phone", "title", "fields", "tier",
    "verdict", "verified", "sample", "cases", "floor", "checks", "guards", "recall", "precision",
    "accuracy", "throughput", "duration", "runtime", "tokens", "bytes", "queries", "requests",
    "summary", "baseline", "target", "ratio", "delta", "spread", "integrity", "deliverable",
    "legacy", "ship", "gate", "pillar", "pillars", "cassette", "saved", "missing",
})
_TEST_FILE_RE = re.compile(r"(?:^|/)(?:tests?|specs?|fixtures?|__tests__)/|(?:_test|\.test|\.spec)\.", re.I)
_QUOTED_LITERAL_RE = re.compile(r"""(['"])([^'"\\\n]{5,80})\1""")


_SUMMARY_BAR_LINE_RE = re.compile(r"\[(?:PASS|FAIL|OK|WARN|SKIP)\]|\(bar\s*[<>]=?|===", re.I)


def _extract_case_identifiers(best_text):
    """Extract non-generic benchmark case identifiers from best.txt (format-agnostic)."""
    filtered_lines = [
        ln for ln in (best_text or "").splitlines()
        if not _SUMMARY_BAR_LINE_RE.search(ln)
    ]
    metrics, _ = _extract_case_metrics("\n".join(filtered_lines))
    idents = set()
    for key in metrics:
        base = key.split(".", 1)[0]
        low = base.lower()
        if len(low) < 5 or low in _GENERIC_METRIC_WORDS or low in _NOISE_METRIC_KEYS or low in _TABULAR_SKIP_KEYS:
            continue
        idents.add(base)
    return sorted(idents)


def _preexisting_in_prod(ident, start_commit, locked):
    """Return True if ident already appeared in non-locked, non-test files at start_commit."""
    out = git("grep", "-I", "-i", "-F", "-l", "--", ident, start_commit, check=False)
    if not out:
        return False
    prefix = f"{start_commit}:"
    for raw in out.splitlines():
        path = raw[len(prefix):] if raw.startswith(prefix) else raw
        if not path or path.startswith(".hill-climb/") or _TEST_FILE_RE.search(path):
            continue
        if locked and not outside([path], locked):
            continue
        return True
    return False


def scan_case_id_leaks(card, folder):
    """Scan added string literals in non-locked, non-test code diff for benchmark case IDs from best.txt."""
    best_path = folder / "best.txt"
    start_commit = card.get("start_commit")
    if not best_path.exists() or not start_commit:
        return []
    try:
        idents = _extract_case_identifiers(best_path.read_text(errors="replace")[:FILE_LIMIT])
    except OSError:
        return []
    if not idents:
        return []
    patterns = [(ident, re.compile(rf"(?<![a-z0-9]){re.escape(ident.lower())}(?![a-z0-9])")) for ident in idents]
    diff_text = git("diff", "-U0", f"{start_commit}..HEAD", check=False)
    if not diff_text:
        return []
    locked = card.get("lock") or []
    preexisting_cache = {}
    hits = []
    seen = set()
    cur_file = ""
    skip_file = True
    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            cur_file = line[6:]
            is_locked = bool(locked) and not outside([cur_file], locked)
            skip_file = is_locked or bool(_TEST_FILE_RE.search(cur_file)) or cur_file.startswith(".hill-climb/")
        elif not skip_file and line.startswith("+") and not line.startswith("+++"):
            for _, lit in _QUOTED_LITERAL_RE.findall(line):
                lit_low = lit.lower()
                for ident, pat in patterns:
                    if pat.search(lit_low):
                        key = (cur_file, ident.lower())
                        if key in seen:
                            continue
                        if ident.lower() not in preexisting_cache:
                            preexisting_cache[ident.lower()] = _preexisting_in_prod(ident, start_commit, locked)
                        if preexisting_cache[ident.lower()]:
                            continue
                        seen.add(key)
                        hits.append({"file": cur_file, "identifier": ident, "literal": lit[:80]})
                        if len(hits) >= 20:
                            return hits
    return hits


def holdout_transfer_warning(card, holdouts):
    """Return an overfit warning when visible score improved but holdout stayed flat or regressed."""
    if len(holdouts) < 2:
        return None
    baseline = card["baseline"]
    best = card["best"]["score"]
    direction = card["direction"]
    dev_gain = (best - baseline) if direction == "max" else (baseline - best)
    if dev_gain <= 1e-9:
        return None
    h0 = holdouts[0]["score"]
    h1 = holdouts[-1]["score"]
    h_gain = (h1 - h0) if direction == "max" else (h0 - h1)
    if h_gain > 1e-9:
        return None
    status = "regressed" if h_gain < -1e-9 else "stayed flat (zero transfer)"
    dev_delta = _signed_delta(best - baseline)
    h_delta = _signed_delta(h1 - h0)
    return (
        f"OVERFIT WARNING: visible improved {number(baseline)} -> {number(best)} ({dev_delta}) "
        f"while holdout {status} {number(h0)} -> {number(h1)} ({h_delta}). "
        f"Investigate why gains did not transfer before confirming holdout criteria or merging."
    )


def spark(values, direction):
    if len(values) < 2:
        return ""
    low, high = min(values), max(values)
    span = (high - low) or 1
    levels = [(value - low) / span for value in values]
    if direction == "min":
        levels = [1 - level for level in levels]
    return "".join(BARS[round(level * (len(BARS) - 1))] for level in levels)


def branch_behind_base(card):
    """Return how many commits the climb branch is behind its base branch (0 if up to date or unknown)."""
    branch = card.get("branch")
    base = card.get("base")
    if not branch or not base or branch == base:
        return 0
    out = git("rev-list", "--count", f"{branch}..{base}", check=False)
    try:
        return max(0, int(out))
    except ValueError:
        return 0


_THRASH_STOP_WORDS = frozenset({
    "step", "with", "from", "that", "this", "into", "only", "when", "after", "more", "less",
    "make", "using", "based", "check", "score", "expect", "expected", "improve", "improved",
    "increase", "reduce", "update", "updated", "change", "changed", "still", "also", "then",
    "than", "over", "under", "allow", "handle", "handling", "support", "avoid", "prevent",
    "better", "attempt", "retry", "fixed", "added", "keep", "kept", "pure", "case", "cases",
    "edit", "code", "file", "files", "test", "tests",
})
_NOISE_METRIC_KEYS = frozenset({
    "time", "sec", "secs", "seconds", "ms", "elapsed", "pid", "port", "saved", "live",
    "missing", "errors", "sample", "cases", "valid", "floor", "seed", "step", "w", "se",
    "ci", "bar", "target", "version", "http", "code", "status", "excluded_infra_invalid",
    "infra_invalid",
})
_TABULAR_SKIP_KEYS = frozenset({
    "total", "overall", "mean", "average", "avg", "median", "summary", "score", "valid",
    "ship", "integrity", "cassette", "check", "bar", "target", "baseline", "best", "step",
    "time", "elapsed",
})
_LOG_LINE_RE = re.compile(r"^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|(?:INFO|DEBUG|WARNING|ERROR|TRACE)\b|\$\s)")
_KV_METRIC_RE = re.compile(r"(?<![A-Za-z0-9_./-])([A-Za-z][A-Za-z0-9_.-]{1,39})=([-+]?(?:\d+\.\d+|\d+))(?![A-Za-z0-9_.-])")
_TABULAR_ROW_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_.-]{2,47})(?:\s*[:|]\s*|\s{2,})([-+]?(?:\d+\.\d+|\d+))(?:\s*(?:%|\(\d+/\d+\)|ms|s))?(?:\s|$)")
_LEADING_ID_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_.-]{2,47})\s+")
_STARTER_NOTES_MARKERS = (
    "(profile misses before step 1)",
    "Record what worked, dead ends, and blockers every ~5 steps.",
)


def diff_stats(roots):
    """Return (relative_files[:10], total_changed_lines) for uncommitted edits across roots."""
    root = repo()
    files = changed_files(roots)
    total = 0
    for path in roots:
        numstat = git("diff", "--numstat", "HEAD", cwd=path, check=False)
        for line in numstat.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            added, removed = parts[0], parts[1]
            total += (int(added) if added.isdigit() else 1) + (int(removed) if removed.isdigit() else 1)
        for name in git("ls-files", "--others", "--exclude-standard", cwd=path, check=False).splitlines():
            target = path / name
            try:
                if target.is_file() and target.stat().st_size <= FILE_LIMIT:
                    total += len(target.read_text(errors="replace").splitlines())
            except OSError:
                pass
    return files[:10], total


def _idea_tokens(text):
    tokens = set()
    for word in re.findall(r"[a-z][a-z0-9]{3,}", (text or "").lower()):
        if word in _THRASH_STOP_WORDS or re.fullmatch(r"step\d*", word):
            continue
        tokens.add(word)
    return tokens


def _extract_case_metrics(text):
    """Extract format-agnostic metric/case key -> float mappings and non-log metric lines."""
    clean = ANSI.sub("", text or "")
    raw_kv = []
    tabular = {}
    metric_lines = []
    for raw_line in clean.splitlines():
        line = raw_line.rstrip("\r").split("\r")[-1]
        stripped = line.strip()
        if not stripped or _LOG_LINE_RE.match(stripped) or NUMBER.fullmatch(stripped):
            continue
        metric_lines.append(stripped)
        lead_match = _LEADING_ID_RE.match(line)
        lead_id = lead_match.group(1) if lead_match else None
        kvs = list(_KV_METRIC_RE.finditer(stripped))
        if kvs:
            for m in kvs:
                k, v_str = m.group(1), m.group(2)
                if k.lower() in _NOISE_METRIC_KEYS:
                    continue
                try:
                    raw_kv.append((k, lead_id, float(v_str)))
                except ValueError:
                    pass
        else:
            tm = _TABULAR_ROW_RE.match(line)
            if tm:
                k, v_str = tm.group(1), tm.group(2)
                if k.lower() not in _TABULAR_SKIP_KEYS and k.lower() not in _NOISE_METRIC_KEYS:
                    try:
                        tabular[k] = float(v_str)
                    except ValueError:
                        pass
    key_counts = {}
    for k, _, _ in raw_kv:
        key_counts[k] = key_counts.get(k, 0) + 1
    metrics = dict(tabular)
    for k, lead_id, val in raw_kv:
        if key_counts[k] > 1 and lead_id and lead_id.lower() not in _TABULAR_SKIP_KEYS and lead_id != k:
            metrics[f"{lead_id}.{k}"] = val
        else:
            metrics[k] = val
    return metrics, metric_lines


def diff_check_outputs(best_path, last_path, direction):
    """Compare best.txt and last.txt to expose per-case deltas, cancel-outs, or non-triggering edits."""
    try:
        if not best_path.exists() or not last_path.exists():
            return None, None
        best_text = best_path.read_text(errors="replace")[:FILE_LIMIT]
        last_text = last_path.read_text(errors="replace")[:FILE_LIMIT]
    except OSError:
        return None, None
    best_m, best_lines = _extract_case_metrics(best_text)
    last_m, last_lines = _extract_case_metrics(last_text)
    shared = [k for k in best_m if k in last_m]
    changed = []
    for k in shared:
        delta = last_m[k] - best_m[k]
        if abs(delta) > 1e-9:
            changed.append((k, best_m[k], last_m[k], delta))
    if changed:
        changed.sort(key=lambda item: (-abs(item[3]), item[0]))
        improved = [c for c in changed if (c[3] > 0 if direction == "max" else c[3] < 0)]
        regressed = [c for c in changed if (c[3] < 0 if direction == "max" else c[3] > 0)]
        parts = [f"{k} {number(old)} -> {number(new)} ({_signed_delta(d)})" for k, old, new, d in changed[:6]]
        more = f" (+{len(changed) - 6} more)" if len(changed) > 6 else ""
        summary = ", ".join(parts[:4])
        if improved and regressed:
            block = (
                f"CANCEL-OUT / TRADE-OFF: {', '.join(parts)}{more}\n"
                "  Some cases improved while others regressed/jittered — inspect regressions or run with --runs 2 / --paired."
            )
            return block, f"cancel-out: {summary}"
        return f"Case deltas: {', '.join(parts)}{more}", summary
    if len(shared) >= 2 or (best_lines and best_lines == last_lines):
        return (
            "ZERO-CASE-CHANGE: check output metrics were identical to best — your edit likely did not execute on any missed case. "
            "Prove it flips >=1 missed case in a fast targeted probe (--probe) before retrying.",
            "zero-case-change",
        )
    return None, None


def detect_thrash(steps, best_step):
    """Detect >=STALL consecutive undone/broke steps repeating the same hypothesis keywords or narrow file set."""
    tail_steps = [r for r in steps if r.get("step", 0) > best_step and r.get("result") != "kept"]
    if len(tail_steps) < STALL:
        return None
    recent = tail_steps[-STALL:]
    toks = [_idea_tokens(r.get("idea", "")) for r in recent]
    common_all = toks[0] & toks[1] & toks[2]
    def _jacc(a, b):
        union = a | b
        return (len(a & b) / len(union)) if union else 0.0
    j01, j12 = _jacc(toks[0], toks[1]), _jacc(toks[1], toks[2])
    file_sets = [frozenset(r.get("files") or []) for r in recent]
    same_files = all(file_sets) and len(set(file_sets)) == 1
    union_all = toks[0] | toks[1] | toks[2]
    freq2 = sorted(t for t in union_all if sum(t in s for s in toks) >= 2)
    if len(common_all) >= 2 or (j01 >= 0.30 and j12 >= 0.30) or (same_files and len(freq2) >= 1):
        terms = sorted(common_all) if common_all else freq2[:4]
        label = ", ".join(terms[:4]) if terms else ", ".join(sorted(file_sets[0])[:3])
        return {
            "streak": len(tail_steps),
            "terms": terms[:4],
            "same_files": same_files,
            "message": (
                f"THRASH DETECTED: last {STALL} undone steps repeat the same approach ({label}). "
                "STOP tweaking this hypothesis — log it under Dead Ends in notes.md, switch to the largest untouched "
                "failure bucket (or check for pending contract relock), or fan out 2-3 parallel orthogonal subagents."
            ),
        }
    return None


def notes_staleness(folder, steps):
    """Return how many steps have elapsed since notes.md was meaningfully updated."""
    if not steps:
        return 0
    notes_path = folder / "notes.md"
    if not notes_path.exists():
        return len(steps)
    try:
        mtime = int(notes_path.stat().st_mtime)
        text = notes_path.read_text(errors="replace")
    except OSError:
        return 0
    stale = 0
    for row in steps:
        t_str = row.get("time")
        if not t_str:
            continue
        try:
            ts = int(time.mktime(time.strptime(t_str, "%Y-%m-%d %H:%M:%S")))
        except ValueError:
            continue
        if ts > mtime:
            stale += 1
    if len(steps) >= NOTES_STALE_STEPS and any(marker in text for marker in _STARTER_NOTES_MARKERS):
        stale = max(stale, len(steps))
    return stale


def stall_and_notes_warnings(folder, card, steps):
    """Return actionable thrash, stall, and stale-notes warnings."""
    out = []
    if not reached(card, card["best"]["score"]):
        since = len(steps) - card["best"]["step"]
        thrash = detect_thrash(steps, card["best"]["step"])
        if thrash:
            out.append(thrash["message"])
        elif STALL <= since < PLATEAU:
            out.append(
                f"STALL: {since} steps without gain. Update notes.md Pareto table, pivot to the largest untouched "
                "failure bucket (or check for pending contract relock), or fan out 2-3 parallel orthogonal subagents."
            )
    stale_steps = notes_staleness(folder, steps)
    if stale_steps >= NOTES_STALE_STEPS:
        out.append(
            f"Notes warning: notes.md has not been updated in {stale_steps} step(s) — refresh Remaining Misses "
            "(Pareto) and Dead Ends so context compaction never resets progress."
        )
    return out


def cmd_status(args):
    folder = resolve(args.name)
    card = load(folder)
    log = rows(folder)
    steps = [row for row in log if row["kind"] == "step"]
    kept = [row for row in steps if row["result"] == "kept"]
    trail = [card["baseline"]] + [row["score"] for row in kept]
    since = len(steps) - card["best"]["step"]
    reviews = [row for row in log if row["kind"] == "review"]
    last_review = reviews[-1]["step"] if reviews else None
    stuck = len(reviews) >= 2 and reviews[-2]["step"] >= card["best"]["step"]
    timed = [row["seconds"] for row in log if "seconds" in row]
    print(f"Climb {card['name']} on {card['branch']}: {card['goal']}")
    print(f"Score {number(card['baseline'])} -> {number(card['best']['score'])} ({card['direction']})  {spark(trail, card['direction'])}")
    goal = "none" if card["target"] is None else f"{number(card['target'])}, then {card['after']}"
    budget = f" of {card['max_steps']}" if card["max_steps"] else ""
    print(f"Bar {goal}. Steps {len(steps)}{budget}, kept {len(kept)}, {since} since the last gain.")
    limit = f" of {number(card['max_hours'])}" if card.get("max_hours") else ""
    pace = f", about {60 * hours(card) / len(steps):.1f} min a step" if steps else ""
    print(f"Time {hours(card):.1f}{limit} hours{pace}.")
    if timed:
        print(f"Check takes {sum(timed) / len(timed):.1f}s on average.")
    behind = branch_behind_base(card)
    if behind > 0:
        print(
            f"Branch warning: {card['branch']} is {behind} commit{'s' if behind != 1 else ''} behind "
            f"{card['base']} — merge or rebase {card['base']} before landing."
        )
    for row in log:
        if row["kind"] == "raise":
            print(f"Raised {row['why']}")
    holdouts = [row for row in log if row["kind"] == "holdout"]
    if holdouts:
        print("Holdout " + ", ".join(f"{number(row['score'])} ({row['why']})" for row in holdouts))
        warn = holdout_transfer_warning(card, holdouts)
        if warn:
            print(warn)
        cp_warn = holdout_checkpoint_warning(card, log)
        if cp_warn:
            print(cp_warn)
    elif card.get("holdout") and not card.get("holdout_once"):
        print(f"Holdout baseline missing — do not inspect holdout files; run: climb.py holdout {card['name']} --why baseline")
    for row in log[-args.last:]:
        if row["kind"] == "step":
            score = number(row["score"]) if "score" in row else "-"
            note = "" if row["result"] == "kept" else f"  [{row['why']}]"
            print(f"  {row['step']:>4} {row['result']:<6} {score:>10}  {row['idea']}{note}")
        elif row["kind"] != "holdout":
            print(f"  ---- {row['kind']}: {row.get('why', number(row.get('score', 0)))}")
    if (folder / "pending-tree").exists():
        print(interrupted(folder))
    if (folder / "notes.md").exists():
        print("Notes:\n" + tail((folder / "notes.md").read_text(), 40))
    for warning in stall_and_notes_warnings(folder, card, steps):
        print(warning)
    size = folder_size(climbs_dir())
    if size > STATE_WARN:
        print(f"STORAGE: .hill-climb holds {size // 1_000_000} MB. Shrink or delete .hill-climb/{card['name']}/data/.")
    if card["target"] is not None and reached(card, card["best"]["score"]):
        print(f"BAR REACHED. {'Check the holdout, then ' if card['holdout'] else 'Then '}{card['after']}.")
    elif stuck:
        print("STUCK: two blocker reviews with no gain between them. Stop and report.")
    elif since >= PLATEAU and (last_review is None or len(steps) - last_review >= PLATEAU):
        print(f"PLATEAU: {since} steps with no gain. Do a blocker review, then log it with: climb.py review")


def cmd_holdout(args):
    folder = resolve(args.name)
    card = load(folder)
    if not card["holdout"]:
        raise Fail("This climb has no holdout check.")
    if card.get("holdout_once") and any(row.get("kind") == "holdout" for row in rows(folder)):
        raise Fail("Holdout was already read once for this --holdout-once climb.")
    _set_running(folder, "holdout", phase="holdout", idea=args.why)
    try:
        score = run_holdout(folder, card, args.why)
    finally:
        _clear_running(folder)
    holdouts = [row for row in rows(folder) if row["kind"] == "holdout"]
    if len(holdouts) >= 2:
        h0 = holdouts[0]["score"]
        print(
            f"Holdout {number(h0)} -> {number(score)} ({_signed_delta(score - h0)}), "
            f"visible {number(card['baseline'])} -> {number(card['best']['score'])} ({_signed_delta(card['best']['score'] - card['baseline'])})."
        )
        warn = holdout_transfer_warning(card, holdouts)
        if warn:
            print(warn)
    else:
        print(f"Holdout {number(score)}, visible best {number(card['best']['score'])}.")


def cmd_raise(args):
    folder = resolve(args.name)
    card = load(folder)
    if not reached(card, card["best"]["score"]):
        raise Fail("Reach the current bar before you raise it.")
    old = card["target"]
    card["target"] = bar(args.target, card["best"]["score"], card["direction"])
    if reached(card, card["best"]["score"]):
        raise Fail("The new bar is already met. Pick a harder one.")
    save(folder, card)
    append(folder, {"kind": "raise", "why": f"bar {number(old)} -> {number(card['target'])}: {args.why}"})
    print(f"Bar raised to {number(card['target'])}.")


def cmd_relock(args):
    folder = resolve(args.name)
    card = load(folder)
    if not card["lock"]:
        raise Fail("This climb locks no files.")
    roots = checkouts(card)
    stray = outside(changed_files(roots), card["lock"])
    if stray:
        raise Fail("Relock changes only the locked check files. Undo or try these first: " + ", ".join(stray[:5]))
    relocked_files, relock_lines = diff_stats(roots)
    prev_score = card["best"]["score"]
    cache_path = folder / "candidate-cache.json"
    guard_env = _cache_env(folder, uuid.uuid4().hex)
    measure_env = _cache_env(folder, uuid.uuid4().hex)
    _set_running(folder, "relock", phase="guards", idea=args.why)
    try:
        failed = failing_guards(card["guards"], card["timeout"], env=guard_env)
        if failed:
            raise Fail(f"A guard fails with the changed check: {failed[0]}\n{failed[1]}")
        commit(roots, f"climb({card['name']}): fix the check\n\n{args.why}")
        _set_running(folder, "relock", phase="check", idea=args.why)
        score, _, _ = measure(card["check"], card["runs"], card["timeout"], folder / "best.txt", card["score"], score_mode(card), env=measure_env)
    finally:
        cache_path.unlink(missing_ok=True)
        _clear_running(folder)
    new_head = git("rev-parse", "HEAD")
    card["fingerprint"] = fingerprint(card["lock"])
    card["best"] = {"score": score, "commit": new_head, "step": len([r for r in rows(folder) if r["kind"] == "step"])}
    save(folder, card)
    entry = {"kind": "relock", "why": args.why, "score": score, "prev_score": prev_score, "commit": new_head}
    if relocked_files:
        entry["files"] = relocked_files
    if relock_lines > 0:
        entry["diff_lines"] = relock_lines
    append(folder, entry)
    print(
        f"Check relocked. New best {number(score)} (was {number(prev_score)}) measured with the changed check "
        f"({len(relocked_files)} locked file(s), {relock_lines} changed line(s))."
    )
    print(
        "Relock Anti-Goodhart Checklist:\n"
        "  1. Every contract qualifier ('only when X', 'clearly labeled as Y') is enforced in the locked check, export, and selftest.\n"
        "  2. Primary vs. fallback/secondary paths are printed separately so shortcuts cannot mask primary regressions.\n"
        f"  3. Run `climb.py audit {card['name']}` and a fresh-context Adversarial Win Audit before claiming the bar."
    )
    print(save_kit(folder, card))


def cmd_check_noise(args):
    folder = resolve(args.name)
    card = load(folder)
    if args.runs < 2:
        raise Fail("--runs must be at least 2 to measure noise")
    if dirty(checkouts(card)):
        raise Fail("Commit or undo uncommitted edits first so noise is measured on clean HEAD.")
    scores = []
    durations = []
    metric_maps = []
    cache_path = folder / "candidate-cache.json"
    tmp_out = folder / "noise-last.txt"
    try:
        for idx in range(args.runs):
            env = _cache_env(folder, uuid.uuid4().hex)
            score, _, sec = measure(card["check"], 1, card["timeout"], tmp_out, card["score"], score_mode(card), env=env)
            scores.append(score)
            durations.append(sec)
            try:
                m, _ = _extract_case_metrics(tmp_out.read_text(errors="replace")[:FILE_LIMIT])
            except OSError:
                m = {}
            metric_maps.append(m)
    finally:
        cache_path.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)
    low, high = min(scores), max(scores)
    spread = high - low
    stdev = statistics.stdev(scores) if len(scores) >= 2 else 0.0
    need = threshold(card["min_gain"], card["best"]["score"])
    jitter_keys = []
    if metric_maps:
        base_m = metric_maps[0]
        for k, v0 in base_m.items():
            vals = [m[k] for m in metric_maps if k in m]
            if len(vals) >= 2 and (max(vals) - min(vals)) > 1e-9:
                jitter_keys.append((k, max(vals) - min(vals)))
        jitter_keys.sort(key=lambda item: (-item[1], item[0]))
    runs_str = ", ".join(number(s) for s in scores)
    print(f"Noise check for {card['name']} ({args.runs} identical runs on clean HEAD): [{runs_str}]")
    print(f"Spread {number(spread)} (stdev {number(stdev)}), avg {sum(durations) / len(durations):.1f}s, current min_gain {number(need)}, card runs={card['runs']}.")
    if jitter_keys:
        j_str = ", ".join(f"{k} (±{number(sp)})" for k, sp in jitter_keys[:6])
        print(f"Jittering sub-metrics: {j_str}")
    if spread <= 1e-9 and not jitter_keys:
        print("DETERMINISTIC: 0 spread across identical-code runs.")
    elif spread >= need or (spread > 1e-9 and card["runs"] == 1):
        rec_gain = max(spread * 1.5, need)
        print(
            f"NOISE WARNING: check spread ({number(spread)}) is >= min_gain ({number(need)}) or non-zero at runs=1. "
            f"Freeze/cache nondeterministic calls, raise --min-gain above {number(rec_gain)}, or use --runs 3 / --paired."
        )
    else:
        print(f"ACCEPTABLE NOISE: spread ({number(spread)}) is below min_gain ({number(need)}), though sub-metrics shifted.")


def cmd_audit(args):
    folder = resolve(args.name)
    card = load(folder)
    log = rows(folder)
    steps = [row for row in log if row["kind"] == "step"]
    kept = [row for row in steps if row["result"] == "kept"]
    relocks = [row for row in log if row["kind"] == "relock"]
    holdouts = [row for row in log if row["kind"] == "holdout"]
    leaks = scan_case_id_leaks(card, folder)
    behind = branch_behind_base(card)
    stale_notes = notes_staleness(folder, steps)
    since_h = kept_since_holdout(log)
    overfit_warn = holdout_transfer_warning(card, holdouts)
    cp_warn = holdout_checkpoint_warning(card, log)
    thrash = detect_thrash(steps, card["best"]["step"])
    cancel_outs = sum(1 for r in steps if str(r.get("delta_summary") or "").startswith("cancel-out:"))
    zero_changes = sum(1 for r in steps if r.get("delta_summary") == "zero-case-change")
    start_commit = card.get("start_commit")
    diff_stat = git("diff", "--stat", f"{start_commit}..HEAD", check=False) if start_commit else ""

    dev_delta = card["best"]["score"] - card["baseline"]
    dev_gain = dev_delta if card["direction"] == "max" else -dev_delta
    h_delta = (holdouts[-1]["score"] - holdouts[0]["score"]) if len(holdouts) >= 2 else None
    h_gain = (h_delta if card["direction"] == "max" else -h_delta) if h_delta is not None else None
    win_dev_gain = dev_gain
    if len(holdouts) >= 2:
        v0 = holdouts[0].get("visible")
        v1 = holdouts[-1].get("visible")
        if isinstance(v0, (int, float)) and isinstance(v1, (int, float)) and abs(v1 - v0) > 1e-9:
            win_dev_gain = (v1 - v0) if card["direction"] == "max" else (v0 - v1)
    transfer_ratio = round(h_gain / win_dev_gain, 3) if (h_gain is not None and win_dev_gain > 1e-9) else None

    findings = []
    if leaks:
        findings.append(f"CASE-ID LEAK WARNING: {len(leaks)} benchmark identifier(s) found in added production string literals.")
    if overfit_warn:
        findings.append(overfit_warn)
    if cp_warn:
        findings.append(cp_warn)
    if card.get("holdout") and not holdouts and not card.get("holdout_once"):
        findings.append(f"Holdout baseline missing — run: climb.py holdout {card['name']} --why baseline")
    if relocks:
        findings.append(
            f"Relock audit needed: locked check files were modified {len(relocks)} time(s) — verify every contract qualifier "
            "and primary-vs-fallback reporting is enforced."
        )
    if behind > 0:
        findings.append(f"Branch warning: {card['branch']} is {behind} commit(s) behind {card['base']}.")
    if stale_notes >= NOTES_STALE_STEPS:
        findings.append(f"Notes warning: notes.md has not been updated in {stale_notes} step(s).")
    if thrash:
        findings.append(thrash["message"])

    report = {
        "name": card["name"],
        "branch": card.get("branch"),
        "base": card.get("base"),
        "baseline": card["baseline"],
        "best": card["best"]["score"],
        "target": card.get("target"),
        "direction": card["direction"],
        "steps": len(steps),
        "kept": len(kept),
        "relocks": [
            {
                "time": r.get("time"),
                "why": r.get("why"),
                "prev_score": r.get("prev_score"),
                "score": r.get("score"),
                "files": r.get("files") or [],
                "diff_lines": r.get("diff_lines"),
                "commit": r.get("commit"),
            }
            for r in relocks
        ],
        "holdouts": [{"score": h.get("score"), "why": h.get("why")} for h in holdouts],
        "kept_since_holdout": since_h,
        "transfer_ratio": transfer_ratio,
        "case_id_leaks": leaks,
        "cancel_out_steps": cancel_outs,
        "zero_case_change_steps": zero_changes,
        "behind_base": behind,
        "notes_stale_steps": stale_notes,
        "findings": findings,
        "clean": len(findings) == 0,
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Audit {card['name']} on {card.get('branch')} ({number(card['baseline'])} -> {number(card['best']['score'])}, {len(kept)}/{len(steps)} kept)")
        if holdouts:
            tr_text = f", transfer_ratio={transfer_ratio:.2f}" if transfer_ratio is not None else ""
            h_text = ", ".join(f"{number(h['score'])} ({h['why']})" for h in holdouts)
            print(f"Holdout: {h_text} | kept_since_holdout={since_h}{tr_text}")
        elif card.get("holdout"):
            print(f"Holdout: configured, 0 runs recorded | kept_since_holdout={since_h}")
        else:
            print("Holdout: none configured (visible-only)")
        print(f"Relocks: {len(relocks)} | Case-ID leak hits: {len(leaks)} | Cancel-outs: {cancel_outs} | Zero-case-change: {zero_changes} | Behind base: {behind}")
        for r in relocks:
            files_s = ", ".join(r.get("files") or []) or "(files not recorded)"
            print(f"  relock: {r.get('why')} [{files_s}]")
        for hit in leaks[:10]:
            print(f"  LEAK: {hit['file']} matched case id {hit['identifier']!r} in {hit['literal']!r}")
        if diff_stat:
            last_stat = diff_stat.splitlines()[-1].strip()
            print(f"Diff vs start: {last_stat}")
        if findings:
            print(f"AUDIT WARNINGS ({len(findings)}):")
            for f in findings:
                print(f"  - {f}")
        else:
            print("AUDIT CLEAN: no automated integrity, leak, overfit, or hygiene warnings.")
        print("Next: run a fresh-context Adversarial Win Audit (read-only research subagent) against every outcome criterion before confirming or merging.")
    if args.strict and (leaks or overfit_warn):
        raise Fail("Strict audit failed: resolve case-ID leaks or overfit warnings before shipping.")


def cmd_budget(args):
    folder = resolve(args.name)
    card = load(folder)
    if args.off:
        card["max_hours"] = card["max_steps"] = None
    if args.hours:
        card["max_hours"] = round(hours(card) + args.hours, 2)
    if args.steps:
        card["max_steps"] = len([row for row in rows(folder) if row["kind"] == "step"]) + args.steps
    save(folder, card)
    limits = [f"{number(card['max_hours'])} hours" if card.get("max_hours") else "",
              f"{card['max_steps']} steps" if card["max_steps"] else ""]
    text = " and ".join(item for item in limits if item) or "no limit"
    append(folder, {"kind": "budget", "why": text})
    print(f"Budget now {text}.")


def cmd_review(args):
    folder = resolve(args.name)
    card = load(folder)
    log = rows(folder)
    steps = [row for row in log if row["kind"] == "step"]
    reviews = [row for row in log if row["kind"] == "review"]
    since = len(steps) - card["best"]["step"]
    last_review = reviews[-1]["step"] if reviews else None
    since_review = len(steps) - last_review if last_review is not None else len(steps)
    skeptic = (args.skeptic or "").strip()

    if not args.force and (since < PLATEAU or (last_review is not None and since_review < PLATEAU)):
        raise Fail(
            f"Too early for a blocker review: {since} step(s) since last gain "
            f"(plateau requires {PLATEAU} steps without gain). Keep climbing from first principles, "
            f"or if a human asked to stop early, pass --force --skeptic \"<fresh-context audit findings>\"."
        )

    if _EXCUSE_CLAIM_RE.search(args.found) and len(skeptic) < 20:
        raise Fail(
            "Cannot declare a ceiling, impossibility, or external/vendor blocker without an independent "
            "first-principles audit. Spawn a fresh-context skeptic subagent (ignoring prior notes.md) to inspect "
            "raw inputs/queries, raw uncached upstream responses, and official docs on >=3 missed cases, "
            "then re-run with --skeptic \"<concrete raw-evidence disproof summary>\"."
        )

    if args.skeptic is not None and len(skeptic) < 20:
        raise Fail("--skeptic must summarize concrete raw-evidence checks (at least 20 chars).")

    entry = {"kind": "review", "step": len(steps), "why": args.found}
    if skeptic:
        entry["skeptic"] = skeptic
    append(folder, entry)
    print(f"Review logged after step {len(steps)}. Climb at least {PLATEAU} more steps before the next one.")
    if card["target"] is not None and not reached(card, card["best"]["score"]):
        print(
            f"Bar not reached ({number(card['best']['score'])} vs {number(card['target'])}). "
            "Humans own abandoning --target: do NOT merge, deploy, or close below the bar without posting an "
            "inline hillclimb_comment(options=[...]) decision card and waiting for human approval."
        )


def cmd_drop(args):
    folder = resolve(args.name)
    card = load(folder)
    if dirty(checkouts(card)):
        raise Fail("Commit or undo the current edit first.")
    if card["branch"] == card["base"]:
        raise Fail("This climb ran on its own base branch, so there is nothing to switch back to. Remove its card by hand.")
    stamp = time.strftime("%Y%m%d%H%M%S")
    kept = f"{card['branch']}-dropped-{stamp}"
    root = repo()
    restored = []
    for path, branch, base in [(root, card["branch"], card["base"])] + [
            (Path(extra["path"]), extra["branch"], extra["base"]) for extra in card.get("repos", [])]:
        if branch == base:
            continue
        old = f"{branch}-dropped-{stamp}"
        git("switch", "-q", base, cwd=path)
        git("branch", "-m", branch, old, cwd=path)
        mine = [os.path.relpath(root / lock, path) for lock in card["lock"]]
        mine = [lock for lock in mine if not lock.startswith("..") and git("ls-tree", "-r", "--name-only", old, "--", lock, cwd=path)]
        if mine:
            git("checkout", old, "--", *mine, cwd=path)
            git("reset", "-q", "--", *mine, cwd=path)
            restored += [os.path.relpath(path / lock, root) for lock in mine]
    for name in ("card.json", "log.jsonl"):
        (folder / name).unlink(missing_ok=True)
    print(f"Dropped {card['name']}. Back on {card['base']}. The old climb is on branch {kept}.")
    if restored:
        print("The check files are back in the tree, uncommitted, ready for a new init: " + ", ".join(restored))


def cmd_save(args):
    folder = resolve(args.name)
    print(save_kit(folder, load(folder)))


def cmd_kits(args):
    here = repo_key()
    found = []
    for path in kits_dir().glob("*/*.tar.gz"):
        with tarfile.open(path) as tar:
            meta = json.load(tar.extractfile("kit.json"))
        meta["check"] = " ; ".join([meta["check"]] if isinstance(meta["check"], str) else meta["check"])
        text = f"{meta['repo']} {meta['name']} {meta['goal']} {meta['check']}".lower()
        if all(word in text for word in args.words.lower().split()):
            found.append((meta["repo"] != here, -path.stat().st_mtime, str(path), meta))
    if not found:
        print("No saved kits match." if args.words else "No saved kits yet. init saves one.")
    for _, _, _, meta in sorted(found, key=lambda item: item[:3]):
        print(f"{meta['repo']}/{meta['name']:<24} {number(meta['baseline'])} -> {number(meta['best'])}  {meta['goal']}")
        print(f"    check: {meta['check']}  saved {meta['saved']}")


def cmd_reuse(args):
    path = find_kit(args.kit)
    meta, files = read_kit(path)
    root = repo()
    linked = [name for name in files if any((root / part).is_symlink() for part in [*Path(name).parents][:-1] + [Path(name)])]
    if linked:
        raise Fail("These kit paths go through a symlink. Remove it first: " + ", ".join(linked[:5]))
    clashes = [name for name, (data, _) in files.items() if (root / name).exists() and (root / name).read_bytes() != data]
    if clashes:
        raise Fail("These files exist and differ. Move them first: " + ", ".join(clashes[:5]))
    exclude_state()
    for name, (data, mode) in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode)
    print(f"Restored {len(files)} files from {meta['repo']}/{meta['name']}, saved {meta['saved']}.")
    print(f"Goal then: {meta['goal']}. Result: {number(meta['baseline'])} -> {number(meta['best'])}.")
    print("Edit what differs for this goal, then start with:")
    print(init_command(meta))


def cmd_list(args):
    for path in sorted(climbs_dir().glob("*/card.json")):
        card = json.loads(path.read_text())
        print(f"{card['name']:<20} {card['branch']:<28} {number(card['baseline'])} -> {number(card['best']['score'])}  {card['goal']}")


def parse(argv):
    parser = argparse.ArgumentParser(prog="climb.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="write the card, measure the baseline, start the branch")
    init.add_argument("name")
    init.add_argument("--goal", required=True)
    init.add_argument("--check", action="append", required=True,
                      help="command that prints the score (repeatable: they run at once and their scores add)")
    init.add_argument("--probe", help="optional fast (<15s) pre-check command on missed cases that runs before slow full checks on every try")
    init.add_argument("--score", action="append",
                      help="regex for the score in the check output, like '(\\d+) failed'; one for all checks or one per check; the matches on the last matching line add up; a missing match fails the run under numeric and reads as 0 under failure-count")
    init.add_argument("--score-mode", choices=list(SCORE_MODES), default=None,
                      help="numeric (the default for a new climb): a missing match, a nonzero exit, or a non-finite "
                           "number is a failed run and cannot win; failure-count: a successful run with no match counts 0 "
                           "failures, which suits a pytest-style count")
    init.add_argument("--repo", action="append", help="another git checkout the climb edits (repeatable)")
    init.add_argument("--direction", choices=["max", "min"], required=True)
    init.add_argument("--guard", action="append", help="command that must exit 0 (repeatable)")
    init.add_argument("--target", help="the bar that means done, a number or a factor like 2x")
    init.add_argument("--after", choices=["stop", "raise"], default="stop", help="what to do at the bar")
    init.add_argument("--runs", type=int, default=1, help="runs per score, median wins, plus one warm-up run")
    init.add_argument("--min-gain", default="0", help="smallest change that counts, a number or a percent like 2%%")
    init.add_argument("--timeout", type=int, default=1800, help="seconds per check run")
    init.add_argument("--holdout", help="check on cases the climber never sees")
    init.add_argument("--holdout-once", action="store_true",
                      help="skip automatic holdout runs on init/try and allow one post-selection holdout read")
    init.add_argument("--holdout-every", type=int,
                      help="auto-run blind holdout checkpoint every N kept steps to catch overfitting mid-climb")
    init.add_argument("--lock", action="append", help="file or folder the climber may not edit")
    init.add_argument("--max-steps", type=int, help="soft limit: past it, steps go on while they still gain")
    init.add_argument("--max-hours", type=float, help="soft limit in hours since init, like --max-steps")
    init.add_argument("--hard", action="store_true", help="stop exactly at --max-steps and --max-hours")
    init.add_argument("--paired", action="store_true",
                      help="score each step against the best commit in alternating runs, for checks the machine's load moves")
    init.add_argument("--here", action="store_true", help="climb on the current branch")

    attempt = sub.add_parser("try", help="score the current edit, keep it or undo it")
    attempt.add_argument("idea")
    attempt.add_argument("--fix", action="store_true", help="keep a fix that holds the score, for a break the guards missed")
    attempt.add_argument("--name")
    attempt.add_argument("--guards-first", action="store_true", help="run guards before check so broken edits fail fast (automatic when avg check >= 60s)")
    attempt.add_argument("--no-guards-first", action="store_true", help="always run check before guards even on slow checks")
    attempt.add_argument("--probe", help="fast (<15s) pre-check command proving the edit triggers on missed case(s) before running full check")
    attempt.add_argument("--no-probe", action="store_true", help="skip the card-level --probe command for this try")

    status = sub.add_parser("status", help="where the climb stands")
    status.add_argument("name", nargs="?")
    status.add_argument("--last", type=int, default=10)

    holdout = sub.add_parser("holdout", help="run the holdout check now")
    holdout.add_argument("name", nargs="?")
    holdout.add_argument("--why", default="milestone")

    bump = sub.add_parser("raise", help="set a harder bar after reaching this one")
    bump.add_argument("target", help="a number or a factor like 2x over the current best")
    bump.add_argument("--why", required=True)
    bump.add_argument("--name")

    relock = sub.add_parser("relock", help="accept a fixed check and measure again")
    relock.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    relock.add_argument("--why", required=True)
    relock.add_argument("--name")

    budget = sub.add_parser("budget", help="give more hours or steps, or remove the limits")
    budget.add_argument("--hours", type=float, help="hours from now")
    budget.add_argument("--steps", type=int, help="steps from now")
    budget.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    budget.add_argument("--off", action="store_true", help="remove both limits")
    budget.add_argument("--name")

    review = sub.add_parser("review", help="log a blocker review and what it found")
    review.add_argument("found")
    review.add_argument("--name")
    review.add_argument("--skeptic", help="concrete raw-evidence summary from an independent fresh-context skeptic audit")
    review.add_argument("--force", action="store_true", help="allow logging a review before PLATEAU steps (only when human-directed)")

    drop = sub.add_parser("drop", help="abandon a climb, go back to the base branch, keep the old branch")
    drop.add_argument("name", nargs="?")

    listing = sub.add_parser("list", help="show every climb in this repo")

    keep = sub.add_parser("save", help="save the check, guards, and notes as a reusable kit")
    keep.add_argument("name", nargs="?")

    kits = sub.add_parser("kits", help="list saved kits from every repo, this repo first")
    kits.add_argument("words", nargs="?", default="", help="only kits whose name, goal, or check has these words")

    reuse = sub.add_parser("reuse", help="restore a kit's files and print its init command")
    reuse.add_argument("kit", help="name, or repo/name")

    noise = sub.add_parser("check-noise", help="measure empirical score spread and sub-metric jitter on clean HEAD")
    noise.add_argument("name", nargs="?")
    noise.add_argument("--runs", type=int, default=3, help="number of identical clean-HEAD runs (default 3)")

    audit = sub.add_parser("audit", help="pre-ship integrity audit: case-ID leak scan, relock ledger, holdout transfer, and hygiene")
    audit.add_argument("name", nargs="?")
    audit.add_argument("--json", action="store_true", help="print structured JSON audit report")
    audit.add_argument("--strict", action="store_true", help="exit non-zero on case-ID leaks or overfit warnings")
    return parser.parse_args(argv)


def _on_signal(signum, _frame):
    raise Interrupted(signum)


def main(argv=None):
    args = parse(argv)
    held = None
    prev_handlers = {}
    is_main = threading.current_thread() is threading.main_thread()
    try:
        if is_main:
            for sig in (signal.SIGINT, signal.SIGTERM):
                prev_handlers[sig] = signal.getsignal(sig)
                signal.signal(sig, _on_signal)
        try:
            os.chdir(repo())
            home = Path(".hill-climb/home")
            if args.command != "init" and home.is_file() and not list(climbs_dir().glob("*/card.json")):
                os.chdir(home.read_text().strip())
            held = None if args.command in ("status", "list", "kits", "audit") else hold_lock()
        except Fail as error:
            print(error, file=sys.stderr)
            return 1
        handlers = {
            "init": cmd_init, "try": cmd_try, "status": cmd_status, "holdout": cmd_holdout,
            "raise": cmd_raise, "relock": cmd_relock, "review": cmd_review, "budget": cmd_budget, "drop": cmd_drop, "list": cmd_list,
            "save": cmd_save, "kits": cmd_kits, "reuse": cmd_reuse, "check-noise": cmd_check_noise, "audit": cmd_audit,
        }
        try:
            handlers[args.command](args)
        except (Fail, ValueError) as error:
            print(error, file=sys.stderr)
            return 1
        return 0
    except Interrupted as error:
        kill_active_pgs()
        print(f"Interrupted (signal {error.signum}).", file=sys.stderr)
        return 128 + error.signum
    except KeyboardInterrupt:
        kill_active_pgs()
        print("Interrupted.", file=sys.stderr)
        return 130
    finally:
        if is_main:
            for sig, prev in prev_handlers.items():
                signal.signal(sig, prev)
        if held is not None:
            held.close()


if __name__ == "__main__":
    sys.exit(main())
