<!--
Adapted from Desiderata-Labs/hillclimb-skills — climbing.md (MIT License: see LICENSE-mit).
Updated for local Antigravity plugin MCP tools, CLI commands, and repo climb engine.
-->

# Climbing a tree

> The outer loop in depth: pick the highest-priority unproven outcome, claim it, read its briefs, do the work, prove it with evidence, report the supported status, and keep the local mirror in sync.

## The loop

1. **Pick.** Call `hillclimb_next_outcomes` (or `hillclimb tree --project <id>`) and take the top item in `next`.
2. **Claim.** Call `hillclimb_claim` (`claim_outcome`) with your session/thread id so parallel agents skip it.
3. **Read.** Call `hillclimb_outcome` and read the story, every criterion, recent evidence, any latest plan, open questions, and the brief of every ancestor goal (`ancestors`). The root brief is the charter and carries the non-negotiables.
4. **Plan, when it's more than a small change.** Call `hillclimb_plan_write` (`write_plan` / `revise_plan`) on the outcome, and answer any questions via `hillclimb_comment` (`answer`). See [plans](plans.md) and [comments](comments.md).
5. **Work.** Do the work wherever it lives (code, tests, docs, configs), scoped to the outcome. For measurable iterative improvement, run a locked `climb.py` inner loop (see below and `SKILL.md`).
6. **Check every criterion for real.** Run the tests, exercise the app, inspect real output. Reading code isn't checking.
7. **Record.** Call `hillclimb_add_evidence` (`add_evidence`) for what you observed against the outcome version you checked, then `hillclimb_set_status` (`verified` citing `evidenceIds`, or `broken` with `denies` text). For UI/DB-dispatched climbs, reconcile and verify the receipt with `hillclimb_search_summit`.
8. **Release and clear inbox.** Call `hillclimb_release` (`release_outcome`) if you stop without finishing, and check `hillclimb_inbox` before wrapping up.

## What `hillclimb_next_outcomes` returns

Outcomes are ordered by tree rank (`rank`, ascending; ties ordered consistently). Each outcome carries a derived `signal`:

| signal | meaning | what to do |
| --- | --- | --- |
| `unverified` | Nobody has proven it yet at the current version. | Implement what's missing, verify every criterion, add `confirms` evidence. |
| `broken` | `denies` evidence arrived at the current version after confirmation (or `hillclimb_set_status` marked it `broken`). | Investigate and fix what failed, then verify every criterion and add new `confirms` evidence. |
| `stale` | Its story or criteria changed in meaning after it was verified (`version` incremented). | Re-check every criterion against the new version and add fresh `confirms` evidence. |
| `recheck` | It is verified, has a `recheckDays` interval, and its newest `confirms` evidence for the current version is older than that interval. It still counts as verified meanwhile. | Re-check each criterion and add fresh `confirms` evidence (clears the recheck timer), or add `denies` if it broke. |

Excluded from `next`:
- Outcomes currently `verified` (and not due for `recheck`).
- Outcomes blocked on unfinished dependencies (`blockedBy` lists the blocking keys).
- Outcomes currently held by an active claim lease (`claim`).

## Claims

A claim (`hillclimb_claim` / `claim_outcome`) takes a time-boxed lease on an outcome (`hours`, 1–168, default 4) tied to `threadId` (defaults to the current session actor in MCP).

- Call `hillclimb_claim` again before expiry to renew a lease.
- Always call `hillclimb_release` (`release_outcome`) if you stop early so another session can pick the outcome up.
- On a parallel rewrite track, pass `track` or track context consistently; live (`main`) claims and track work are tracked separately.

## Reading before you work

`hillclimb_outcome` returns:
- the contract (`title`, `story`, `criteria`, `dependsOn`, `rank`, `recheckDays`, `version`);
- derived `signal`, `blockedBy`, and active `claim`;
- `goalChain` (ancestor goal briefs from root charter down);
- `pendingChange` (any unapproved `propose_change` waiting in Inbox);
- latest `plan` (and `planVersions`), paged `evidence`, and paged `comments`.

If the contract looks wrong, ambiguous, or impossible, don't bend your work to match it and don't edit it to make a broken check pass. File a proposal with `hillclimb_propose_change` explaining plainly what changes and why; a human reviews and approves or rejects it in the UI Inbox (`hillclimb_open(page="inbox")`).

## Proving it and verifying in production

Evidence is append-only (`hillclimb_add_evidence`):
- Scope each piece to the criterion IDs you actually checked (`criterionIds`), or pass `[]` only for outcome-wide `note` observations (never claim criterion proof you didn't run).
- Include exact commands, observed counts/output, build/commit references, and links in `text` and `source`.
- Use `kind`: `confirms` (it holds), `denies` (it fails), or `note` (context, diagnosis, or measurement).
- If the change ships to a deployed environment, verify it there after deploy and add production evidence (`source` naming the URL/build). Local tests alone don't prove a live deployment.

To record status (`hillclimb_set_status`):
- `status: "verified"` requires `evidenceIds` of `confirms` records at the outcome's current `version` and `track` covering every criterion, and only succeeds when the derived signal is already `verified` or `recheck`.
- `status: "broken"` requires `text` describing the failure and writes a `denies` record.

## Searching a local mirror (`.hillclimb/`)

`hillclimb_sync` (or `hillclimb sync --project <id> --dir <repo>`) writes a read-only markdown/JSON snapshot to `.hillclimb/`:
- `INDEX.md`, `tree.json`, `goals/`, `outcomes/`, `plans/`
- Search across the tree with `rg <words> .hillclimb/` instead of making many sequential tool calls.
- **Never edit `.hillclimb/` directly** — it is a generated projection. Always re-read live via `hillclimb_outcome` or `hillclimb_tree` before acting.

## Dependencies (`dependsOn`)

An outcome can list prerequisite outcome keys in `dependsOn` (set in `create_outcome` or `propose_change`):
- While any dependency is not `verified` / `recheck`, the dependent outcome is listed in `blockedBy` and stays out of `next`.
- A dependency inherits higher urgency when a high-priority outcome depends on it (`effectiveRank`).
- Cycles are rejected. If you discover a missing dependency mid-work, propose it via `hillclimb_propose_change` and work on the prerequisite first if unblocked.

## When you're blocked

- If a product or policy decision is needed from a person, ask with `hillclimb_comment` (passing `options` so it lands in the UI Inbox) and tell the user in chat.
- Release your claim (`hillclimb_release`) if nothing can move forward while waiting, and pick the next unblocked outcome.
- Never mark an outcome `verified` with caveats.

---

## Sample inner-loop climb card and report

### Sample Climb Card (`build-speed`)

Send as Markdown (not inside a fenced code block) when asking the user to approve a new `climb.py` rig:

> ### Climb card: `build-speed`
> **Goal:** cold build of the app 2x faster, same output
>
> | Score | Now | Bar |
> | --- | --- | --- |
> | Median build seconds, lower is better | **47.0s** | **23.5s** (2x) |
>
> | Setting | Recommended | Default | Why |
> | --- | --- | --- | --- |
> | Check | `./scripts/bench-build.sh` | none | Builds from clean, prints seconds |
> | Kit | new | none | No saved kit fits |
> | Runs per score | **3** | 1 | Score drifts 1.2s between runs |
> | Paired | **yes** | no | Shared machine, so old and new run in turns |
> | Min gain | **3%** | 0 | Above the drift, so luck can't win |
> | Guards | `npm test`, `npm run typecheck` | none | Faster must still be correct |
> | Holdout | 3 of the 12 sample apps | none | Catches overfitting |
> | Locked | `scripts/bench-build.sh`, `test/`, `samples/` | none | So no step can edit the check |
> | Timeout | 1800s | 1800s | |
> | Budget | no limit | no limit | About 2 min a step, so 40 steps is about 1.5 hours |
> | After the bar | **stop** | stop | |
> | Branch | `climb/build-speed` | `climb/<name>` | One commit per kept step |
>
> **Needs your answer:** none
>
> Reply **go** to start, or change a line, like "runs 5".

```sh
python3 "$CLIMB" init build-speed --goal "cold build 2x faster" \
  --check ./scripts/bench-build.sh --direction min --target 2x --after stop \
  --runs 3 --paired --min-gain 3% --guard "npm test" --guard "npm run typecheck" \
  --holdout ./scripts/bench-holdout.sh --lock scripts --lock test \
  --lock .hill-climb/build-speed/holdout
```

### Sample Final Report (`build-speed`)

> ### Climb `build-speed`: bar reached
> **47.1s → 18.7s**, 2.5x faster (bar 23.5s, reached at step 41)
>
> | | |
> | --- | --- |
> | Holdout | 51.0s → 20.2s, moved with the score |
> | Steps | 19 kept of 52 |
> | Safety | Guards passed on every kept step. Full suite and final review clean |
> | Time | 1h 50m, about 2 min a step |
> | Branch | `climb/build-speed`, 19 commits |
>
> **What worked**
> - Incremental type cache: −12s
> - Parallel emit: −9s
>
> **Tried and undone** (never landed)
> - swc swap: broke 3 guards
>
> **Your move**
> - Review: `git log --oneline 1a2b3c4..climb/build-speed`
> - Next climb: cache `node_modules` in the bench (check 2 min → about 35s)
