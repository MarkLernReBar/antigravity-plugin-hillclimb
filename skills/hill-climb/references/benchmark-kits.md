# Benchmark kits

Five reusable starter kits for the scored climb. Each kit is a manifest, a
scorer, a labelled sample fixture and a preflight CLI. They are installed
verbatim from `assets/kits/` to `.hill-climb/kits/`, so a project can measure
its own real data without inventing a scorer.

| Kit id | Scores | Direction |
| --- | --- | --- |
| `correctness` | expected cases correct against an independent oracle | max |
| `latency-cost` | nearest-rank p95 of useful milliseconds | min |
| `retrieval` | mean reciprocal rank over judged queries | max |
| `agent-outcomes` | tasks completed across repeated trials | max |
| `tuning` | validation objective of the selected candidate | min |

Standard library only. No model, network, or vendor client.

## What lands in `.hill-climb/kits/<id>/`

```
kit.json            kit metadata and controls (title, metric, guards, baseline, knownBad)
cases.json          the visible manifest
holdout.json        the held-out manifest, when the kit has one
score.py            the kit's scoring adapter
fixtures/           labelled sample rows and known-bad controls
```

Shared files sit beside the kit folders:

```
.hill-climb/kits/kitcore.py     scoring core and dispatch
.hill-climb/kits/preflight.py   preflight, commands builder and final read
```

## Command grammar

Run from the repository root. `KITS=.hill-climb/kits`.

```sh
# list the five kits
python3 "$KITS/preflight.py" list --json

# preflight: baseline, known-bad controls, repeat noise, exit code
python3 "$KITS/preflight.py" preflight --kit correctness --json

# real project data: kit.json plus fixtures under a project folder
python3 "$KITS/preflight.py" preflight --kit correctness --data .hill-climb/kits/correctness/data --json

# ready-to-use score, guard, holdout and init commands
python3 "$KITS/preflight.py" commands --kit correctness \
  --data .hill-climb/kits/correctness/data \
  --candidate "python3 tools/extract.py --split validation" \
  --holdout-candidate "python3 tools/extract.py --split holdout" --json

# the once-only private final read (tuning only)
python3 "$KITS/preflight.py" final --kit tuning --data <project folder> --json
```

`preflight` runs the baseline, every known-bad control, and the declared repeat
count. It prints the score on stdout and structured JSON on request. It never
runs the holdout candidate and never prints holdout metrics.

`commands` prints the exact argv for scoring, each guard, the holdout read and
the engine `init`. A candidate argument is passed through; the holdout
candidate stays separate so the visible split is never scored against private
answers.

Exit codes: `0` usable, `2` invalid kit or fixture, `3` baseline score or guard
mismatch, `4` a known-bad control was not caught, `5` repeat spread exceeded the
limit, `6` the candidate failed, `7` usage error.

## Kit metadata a UI can read

`kit.json` at the kit root. Fields:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `version` | identity |
| `title`, `summary` | display text |
| `metric`, `metricLabel`, `unit`, `scoreMode` | what the number means |
| `direction` | `max` or `min` |
| `targetGuidance` | how to set the bar |
| `check` | the scoring template (`{kit}`, `{manifest}`, `{candidate}`) |
| `holdout` | the private read template, when the kit has one |
| `guards`, `guardDetails` | guard names and what each keeps honest |
| `baseline` | `{fixture, expected}` for the visible path |
| `finalBaseline` | `{fixture, expected}` for the private final read (tuning) |
| `knownBad` | controls: `{id, fixture, expect, guard?}` |
| `finalControls` | controls for the private read (tuning) |
| `repeats` | `{runs, maxSpread, why}` |
| `data` | `{manifest, holdout, sample, label, resultFormat}` |
| `notes` | the discipline this kit encodes |

`expect` is `worse`, `rejected` or `guard_fail`. A sample kit sets
`data.sample: true`; a project kit sets it to `false`.

## Project data

A project folder carries its own `kit.json` beside its manifest and fixtures.
Project paths resolve relative to that folder. It must declare its own
`baseline`, `knownBad` and `repeats`; the packaged controls are examples and
never stand in for real data. `--data` without a project `kit.json` is an error
unless `--allow-sample` explicitly accepts the labelled sample.

## The tuning split

`tuning` has two paths, and only the second reads the holdout:

- **Visible:** `score.py --manifest cases.json --candidate ...` scores the
  selected candidate's validation objective. No holdout is required, read or
  printed.
- **Private final read:** `score.py --manifest cases.json --holdout holdout.json
  --candidate ...`, or `preflight.py final`, reads the holdout once after
  selection. Changing the holdout cannot change the visible score.

## Measured baselines

Packaged sample fixtures, as measured by `preflight.py preflight --kit <id>`:

| Kit | Baseline | Controls caught |
| --- | --- | --- |
| correctness | 5 cases | 6 |
| latency-cost | 29.0 ms | 7 |
| retrieval | 1.0 MRR | 9 |
| agent-outcomes | 3 tasks | 7 |
| tuning | 11.8 ms validation | 8 visible + 2 final |

The project fixtures under `tests/fixtures/project-<id>/` are separate real
instances with different ids and values. They prove the loader, not the sample
numbers.

## Tests

```sh
npx tsx --test tests/kits.test.ts
```

The suite covers the five kits, project-data preflight for all five, the
command grammar, the tuning split, noise handling, and the rejection cases
(missing, duplicate, nonfinite, incomplete, wrong, out-of-bounds, leakage).
