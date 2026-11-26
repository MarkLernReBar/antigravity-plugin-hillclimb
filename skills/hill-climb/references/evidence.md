<!--
Adapted from Desiderata-Labs/hillclimb-skills — evidence.md (MIT License: see LICENSE-mit).
Updated for local Hill Climb plugin tools, receipts, and CI evidence hook.
-->

# Evidence, status and CI

> Record version-scoped, criterion-bound evidence, derive and confirm status honestly, verify receipts from dispatched runs, and integrate CI test results.

## Evidence

Evidence is an append-only observation about one outcome at a specific contract `version` and `track` (`"main"` by default).

Call **`hillclimb_add_evidence`** (or `hillclimb act` with `op: "add_evidence"`):

| field | what it holds |
| --- | --- |
| `key` | Outcome key (e.g. `HC-12`) |
| `version` | Contract version observed (defaults to current version in `hillclimb_add_evidence`; refused if it doesn't match) |
| `kind` | `confirms` (criterion holds), `denies` (criterion fails), or `note` (context, blocker, measurement) |
| `criterionIds` | Criterion IDs covered (e.g. `["ac1", "ac2"]`). Must exist on that version with no duplicates. Pass `[]` for outcome-level `note`s. |
| `text` | Exact commands, observed output, counts, and reproduction details |
| `source` | Where it came from (test command, CI run URL, deploy URL, or receipt source) |
| `track` | Track name (defaults to `"main"`) |

Good evidence lets someone else repeat your check without guessing:
- **Specific:** `"npm test -- tests/hillclimb.test.ts -> 4 passed"` beats `"tests pass"`.
- **Current:** Record against the exact contract `version` you checked; never attach old proof to a newer contract.
- **Honest:** Record `denies` whenever a check fails, even if you are about to fix it.
- **Scoped:** Cite only the `criterionIds` the check actually proved.

## Status and derived signals

Status in Hill Climb is derived from evidence and verified receipts, never asserted from prose alone:

- **`unverified`**: Not all current criteria have `confirms` evidence at the current `version` (and no active denial).
- **`verified`**: Every criterion at the current `version` is covered by `confirms` evidence and not denied.
- **`broken`**: A `denies` record arrived at the current `version` after confirmation, or `hillclimb_set_status(status="broken")` wrote one.
- **`stale`**: The contract `version` incremented (meaning changed via approved `propose_change`) after earlier evidence.
- **`recheck`**: The outcome is `verified`, has `recheckDays` set on its contract, and the newest `confirms` evidence at the current `version` is older than `recheckDays`. It stays `verified` until re-checked; adding fresh `confirms` evidence clears `recheck`.

Use **`hillclimb_set_status`** to explicitly log a status decision:
- **`status: "verified"`**: Refuses unless the outcome already derives `verified` or `recheck` and you pass `evidenceIds` of `confirms` records on the current `version` and `track` covering every criterion. Records a `note` linking those IDs.
- **`status: "broken"`**: Requires `text` explaining what failed (and optional `criterionIds`, defaulting to all criteria); records a `denies` entry.

## Dispatched climbs and verified receipts

When a climb or search worker is dispatched via the UI (**Dispatch to repo** / **Dispatch to search**) or `hillclimb_search_start`:
1. The plugin writes a binding marker and `.hill-climb/bridge/receipt.py` tied to the outcome `key`, `version`, `criterionIds`, and verifier `rig`.
2. When the run finishes, `receipt.py` executes the holdout/proof check and writes a signed receipt.
3. Call **`hillclimb_search_summit`** (or click **Reconcile** in the UI) to verify the receipt against the binding and confirm the persisted `confirms` evidence row in the ledger.

## CI evidence (`assets/ci/hillclimb-evidence.mjs`)

Automated test suites can feed criterion-scoped evidence into the contract tree without modifying the tree directly. See [assets/ci/README.md](../../../assets/ci/README.md) for full details.

1. Tag test names with `<PREFIX>-<key>@<version>#<criterionId>[,<criterionId>]` (e.g. `HC-12@3#ac1,ac2`). Default prefix is `HC`; set `HILLCLIMB_KEY_PREFIXES=HC,PAY` when needed.
2. Export the contract snapshot before tests run (`hillclimb tree --project <id> --json > .hillclimb/tree.json`). If tests cannot carry `@version`, pass `--contract-frozen-at <ISO>` captured before tests run.
3. Run the hook (`node assets/ci/hillclimb-evidence.mjs --report ... --contract .hillclimb/tree.json --source "$RUN_URL" --out ci-evidence.json`) or ingest directly via:
   - **MCP:** `hillclimb_ingest_junit` (from raw JUnit/JSON/text test report) or `hillclimb_post_test_evidence` (from `ci-evidence.json`), with `apply: false` for dry-run or `apply: true` to record.
   - **CLI:** `hillclimb ingest-junit --report ... --apply` or `hillclimb post-test-evidence --bundle ci-evidence.json --apply`.

Rules enforced by the CI hook:
- Proof is per criterion: passing `ac1` confirms `[ac1]`; failing `ac2` denies `[ac2]`; skipped tests never confirm (partial passes record a `note`; all-skipped records nothing).
- An outcome tag with no `#criteria` (`HC-12@3`) records a `note`, never `confirms`/`denies`.
- Version mismatch (older or newer than `.hillclimb/tree.json`) exits `2` and records nothing.
- Every record carries a deterministic `receiptId`, so re-ingesting a job never duplicates evidence.
