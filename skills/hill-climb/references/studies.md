# Studies: matched experiments at an equal budget

A **study** is one problem (or several) × named **experiments** × **N repeats** at
one per-search **budget**. An experiment is a set of config overrides — a search
policy (`climber`), a model, a tuning allowance — so "greedy or diverse?", "does
memory help?", "is the tuner worth it?" are the same study with different arms.

Native 0.8.2 owns execution, the store and the report:

```sh
hillclimb experiment run <spec>            # every experiment × repeat × problem
hillclimb experiment report <study> --json # per-arm n/mean/median/spread, paired gaps
```

This plugin adds the two reads a person or agent needs around those commands.
**Neither command runs a search, contacts a provider, or invokes a shell.** The
worker runs the printed `hillclimb …` commands in its own shell.

## Preview the plan before spending

```sh
hillclimb study-preview <spec> --dir <hillclimb folder> [--json]
```

`<spec>` is a YAML path or a name under `experiments/`; omitting it works when
the folder has exactly one spec.

The preview parses the spec and expands the **exact job matrix** the native
launcher would run: repeat-major, problems, experiments round-robin inside each
repeat. It then reports:

| Allocation field | Meaning |
|---|---|
| `experiments[].searches` | searches per arm (repeats × problems) |
| `allocation.equalBudget` | one per-search budget covers every arm |
| `allocation.matchedRepeats` | at least two independent repeats per arm |
| `allocation.candidateGenerations` | `--candidates N` × searches, and the source of that number |
| `allocation.verifierRepeats` | `--verifier-repeat N` × searches |
| `allocation.parameterTrials` | `--trial-allowance N` × searches |
| `allocation.paidModelCalls` | `0` when every arm uses a deterministic agent; otherwise `null` with the reason |
| `allocation.sequentialWallClockSeconds` | budget × searches (the sequential estimate) |
| `allocation.parallelWallClockSeconds` | budget × ceil(searches / `max_concurrent`) |

The `checks` array is the decision surface, not decoration:

| Check | Fails or warns when |
|---|---|
| `two-experiments` | the spec has fewer than two arms |
| `matched-budget` | no explicit budget, so arms inherit a run default instead of a declared allowance |
| `matched-repeats` | `repeats: 1`: one run cannot separate an effect from run noise |
| `noise-floor` | no `noise_floor`: a gap can only be judged against the spread across repeats |
| `verifier-stability` | the preview does not include verifier repeats |
| `candidate-allowance` | `--candidates` is missing, so generation cost is unsized |
| `paid-model` | an arm leaves a real coding agent in place; provider calls would be billed |

A `fail` is a reason not to spend yet; a `warn` is a known limitation. The
`commands` object prints the exact worker-local `--dry-run`, `run` and
`report --json` invocations, plus `hillclimb verify <problem> --repeat 5` to
measure the verifier noise floor.

`--json` prints one object with `schema: "hillclimb.study.preview.v1"`. Output is
bounded: a matrix too large for the CLI returns a `preview_too_large` error that
names the fix, rather than a truncated document.

## Read the result after the run

```sh
hillclimb study-report --dir <hillclimb folder> [--json]
hillclimb study-report --dir <hillclimb folder> --artifact report.json [--json]
```

Two sources, same typed result:

1. **`--artifact report.json`** imports the native artifact — the output of
   `hillclimb experiment report <study> --json`. This is canonical: the numbers
   are the engine's own summaries. The path must stay under `--dir`.
2. **no artifact** reconstructs the same summaries from the run store:
   `runs/<run>/run.yaml`, then each `searches/<search>/{search.yaml,status.json,journal.jsonl}`.
   Scores come from the selected candidate (`holdout_score` when present, else
   `val_score`); candidate and token counts come from the journal; accepted
   lineage supplies `minutes_to_best`; the spec supplies the noise floor and
   control.

The report reproduces the native fields (`study`, `problem_id`, `problem_key`,
`higher_is_better`, `noise_floor`, `experiments`, `comparisons`, `unfinished`),
then adds:

| Field | What it answers |
|---|---|
| `status` | `complete`, `inconclusive`, or `incomplete` |
| `matched.sameBudget` / `sameRepeats` | were the arms actually run on the same terms? |
| `matched.budgets` / `repeats` | the observed per-arm budget and repeat numbers |
| `arms[]` | per arm: runs, scored, failed, state counts, mean/median/spread, wins |
| `failures[]` | every search that did not finish, with its state and last error |
| `inconclusives[]` | every comparison whose gap is inside the noise threshold (or has no decision rule), with the reason |
| `actions[]` | what to do next, in order |
| `commands` | the native report command, the resume commands, and how to add repeats |

### Reading a verdict

A comparison is `better`, `worse`, `tie`, `within-noise`, or `unknown`. The gap
is paired by repeat against the control (the spec's first experiment unless
`--control` names another). It is judged against the larger of the declared
`noise_floor` and the spread across repeats:

- `within-noise`: the point estimate moved, but not by more than the arms'
  own run-to-run variation. This is **not a result**; add repeats.
- `unknown`: no scores, or neither a noise floor nor two repeats to measure a
  spread. Settle it with `hillclimb verify <problem> --repeat 5`.
- `incomplete`: at least one search failed or never finished. Resume or rerun
  it before trusting the winner.

The real toy study in this repository is a useful example: greedy scored 15.629
on both repeats (spread 0); diverse scored 16.095 and 8.423 (spread 7.67). The
paired gap was -3.37, inside the 7.67 repeat spread, so the report says
`within-noise`: not a result, and adding repeats is the next action — even
though one diverse run beat greedy. That is the distinction the report exists
to preserve.

## Boundaries and failure behaviour

- **Path containment.** Every read and listing is checked against the selected
  root (the workspace, or the `--dir` under it); a spec path or artifact outside
  it is refused with `path_outside_root`. A `spec:` inside `run.yaml` that
  escapes the root is ignored, never followed.
- **Custom StudyIO for tests.** Production reads use the local filesystem bound
  to `--dir`; standalone tests may inject a fake `StudyIO` explicitly.
- **Truncation.** A required metadata file read shorter than its declared size
  is an error (`file_truncated`), never a partial parse. A truncated journal is
  surfaced in `source.truncated`, forces `status: incomplete`, and adds an
  action; the report never quietly reports a partial run as complete.
- **Read errors.** A host read failure is reported with the path and reason
  (`read_failed`), not treated as "missing". Only a genuinely absent file is
  `null`.
- **Output limits.** JSON output over the CLI limit returns
  `report_too_large`/`preview_too_large` with the narrowing flag, instead of a
  truncated JSON document.

## Example

```sh
# Before spending: is this comparison even able to decide anything?
hillclimb study-preview self-study --dir ~/study --candidates 25 --verifier-repeat 3

# The worker runs the study in its own shell (the plugin does not).
cd ~/study && hillclimb experiment run experiments/self-study.yaml
cd ~/study && hillclimb experiment report self-study --json > self-study-report.json

# After: import the engine's own artifact.
hillclimb study-report --dir ~/study --artifact self-study-report.json
hillclimb study-report --dir ~/study --artifact self-study-report.json --json
```

A complete `--json` report is one object with
`schema: "hillclimb.study.report.v1"`; parse `status`, `summaries`,
`failures`, `inconclusives` and `actions` rather than the text table.