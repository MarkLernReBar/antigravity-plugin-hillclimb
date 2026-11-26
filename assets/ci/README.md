# CI evidence hook

`hillclimb-evidence.mjs` turns a test run into Hillclimb evidence, scoped to the
contract version and criteria each test names. It **never writes to a tree**: it
prints one `hillclimb act '<json>' --project <id>` per piece of evidence, so the
change goes through the same validation and approval path as an agent action.

## Tag a test with the outcome it proves

A test opts in by naming the outcome in its title. Nothing else about your suite
changes.

```
HC-12@3#ac1,ac2            proof for ac1 and ac2, pinned to contract v3
HC-12@3#ac1                both, one criterion
HC-12@3                    outcome-level observation: a note, never proof
HC-12#ac1                  no @version: skipped (see below)
HC-12                      no @version and no criteria: skipped
```

`@<version>` is what makes a run provable: it says which contract the test actually
ran against. Without it the hook cannot tell, so it records nothing. This is
deliberate — see [Versions](#versions-what-ci-proof-requires).

`HC` is the default key prefix. Set `HILLCLIMB_KEY_PREFIXES=HC,PAY` (comma or
space separated) when a tree uses more than one, so `UTF-8` or `SHA-256` in a test
name is never mistaken for a key.

## Grouping: proof is per criterion, never inferred

The hook groups by outcome and then by criterion, because a verdict belongs to the
tests that earned it. 200 tests across 5 outcomes stay a handful of records, but
the scope is exact:

| what ran | what is recorded |
| --- | --- |
| every tagged test for `ac1` passed | `confirms` scoped to `[ac1]` |
| any tagged test for `ac2` failed | `denies` scoped to `[ac2]`, with up to 20 failing names |
| `ac1` passed, `ac2` skipped | `confirms [ac1]` only; `ac2` is reported as skipped, never confirmed |
| `ac1` passed, `ac2` failed | `confirms [ac1]` **and** `denies [ac2]`: one criterion's failure cannot deny another |
| `ac1` passed and failed in the same run | `denies [ac1]` only: a criterion is confirmed only when none of its tagged tests failed |
| `ac1` passed and one `ac1` test skipped | `note [ac1]` marked **partial** ("not every tagged test for this criterion ran"), with the skipped test named in the body and the run summary |
| a tag names no criterion (`PAY-12@3`) | **`note`**, never `confirms`/`denies`: core reads an empty `criterionIds` on those as "all criteria", so an outcome-level observation must not be posted as proof |
| only skipped tests for a criterion, or for the outcome | no evidence at all; the skip is reported |
| a tag with no `@version` | skipped, and the reason names the version to add |

`denies` records come first, then notes, then confirms, so the bundle reads what
does not hold before what does. Each record pins the contract version it ran
against and carries a deterministic `receiptId` (the evidence id) in the action,
so a retried job posts one receipt instead of a second piece of proof.

A key that names no outcome is reported as skipped and does not fail the step.

## Versions: what CI proof requires

Evidence belongs to the contract version it was observed against. A tag with
`@3` promises the run happened against v3, and the hook refuses it when the
contract in hand says otherwise.

An unversioned tag has no such promise. Reading the version from the contract at
post time would attach the run to whatever the contract says *now* — which may be
several edits newer than the code under test — so the hook records nothing and
tells you to add `@<version>`.

There is one honest escape: `--contract-frozen-at <time>` says the contract was
frozen at that time, before the tests ran. The CLI checks the contract file's
modification time against it, so a contract fetched after the run is refused.

```bash
# fetch the contract before the tests, note the time, run the tests, then post
hillclimb tree --project "$HILLCLIMB_PROJECT_ID" --json > .hillclimb/tree.json
FROZEN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
npx vitest run --reporter=json --outputFile=test-results.json
node assets/ci/hillclimb-evidence.mjs ... --contract-frozen-at "$FROZEN_AT"
```

Prefer `@version` on the test name when you can: it travels with the test, and it
survives a build where the contract is fetched at a different moment. The freeze
flag exists for suites whose test names cannot be changed.

## Refusals (exit 2, nothing recorded)

| What happened | Why it is refused |
| --- | --- |
| A tag pins `@2` but the contract is v3 | That run proves the old contract. Recording it against v3 is the downgrade this hook exists to prevent. Re-run the test against the current contract, or drop `@version`. |
| A tag pins `@4` but the checkout's contract is v3 | The checkout is stale. Run `hillclimb sync --project <id>` and re-run. |
| A tag names `#ac9` and the outcome has no `ac9` | Silently narrowing or widening the evidence scope is lost attribution. The tag is wrong; fix it. |
| A test name names two outcome keys | One test proves one outcome. |
| `--contract-frozen-at` is in the future | A contract frozen after the tests proves nothing; the run and the flag disagree. |
| The contract file is newer than `--contract-frozen-at` | The contract was not frozen before the tests. Fetch it first, or add `@version` to the test names. |

A skip is not a pass: a criterion whose tagged tests were all skipped produces no
evidence and is reported; a criterion with some tests passing and some skipped is
recorded as a partial note; and an unspecified criterion is never inferred from a test
that names no criteria.

## Use it

```bash
# 1. get the contract the run is proving (spellings: tree snapshot or outcomes array)
hillclimb tree --project proj_abc123 --json > .hillclimb/tree.json

# 2. build evidence; --commands prints the act calls
node assets/ci/hillclimb-evidence.mjs \
  --report test-results.json --format json \
  --contract .hillclimb/tree.json \
  --source "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --project proj_abc123 --commands --out ci-evidence.json

# 3. run the printed commands in a thread that holds the tree
```

Formats: `junit`, `json` (Jest and vitest `--json` output), `text` (any runner
whose lines start with `✓`, `✕`, `PASSED`, `FAILED`, …), or `auto` (default,
by the report's first character).

### GitHub Actions

```yaml
      # Freeze the contract BEFORE the tests: evidence is pinned to the version it
      # ran against, and the hook checks the file is older than this moment.
      - name: Freeze the contract
        run: |
          hillclimb tree --project "$HILLCLIMB_PROJECT_ID" --json > .hillclimb/tree.json
          echo "HC_FROZEN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_ENV"

      - name: Test
        run: npx vitest run --reporter=default --reporter=json --outputFile=test-results.json

      - name: Hillclimb evidence
        if: always()                      # report failures too: a "denies" is evidence
        env:
          HILLCLIMB_KEY_PREFIXES: HC
        run: |
          node assets/ci/hillclimb-evidence.mjs \
            --report test-results.json --format json \
            --contract .hillclimb/tree.json --contract-frozen-at "$HC_FROZEN_AT" \
            --source "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            --project "$HILLCLIMB_PROJECT_ID" --commands --out ci-evidence.json
```

With `@<version>` on the test names, drop the freeze step and the
`--contract-frozen-at` argument: the tags already pin the version.

The act calls need a Hill Climb CLI/host environment that can reach the project; commit `ci-evidence.json`
as an artifact and let the thread that owns the tree apply them, or run the step
on a self-hosted runner that is already enrolled. Each call carries `receiptId`
(the evidence id), so applying a job's output twice does not double the proof.

## What this hook does not do

- It does not set an outcome's status. Status is a decision; CI only adds
  evidence (see `skills/hill-climb/references/evidence.md`).
- It does not read the tree over the network. The contract is a file you pass in,
  so a stale file is visible (and refused) rather than silently authoritative.
- It adds no dependencies: Node's `node:crypto`, `node:fs` and `node:path` only.
