<!--
Adapted from Desiderata-Labs/hillclimb-skills — plans.md (MIT License: see LICENSE-mit).
Updated to reflect local Hill Climb plugin tools (hillclimb_plan_write, hillclimb_outcome, hillclimb_sync).
-->

# Plans

> Write down how you will implement an outcome before building it, and append versioned revisions as the design evolves.

## When to write a plan

Write a plan when the work is more than a small, obvious change: a new schema or migration, a multi-file refactor, a verifier design, or any approach trade-off a human or follow-up session will need to read. Plans live directly on the outcome (`key`) beside its criteria and evidence.

Plans are working implementation notes, not contract approvals:
- Writing or revising a plan never changes an outcome's `version`, `signal`, or `next` order.
- A plan never substitutes for `confirms` evidence.

## What a useful plan includes

- The chosen approach in 1–2 sentences.
- Scope (what changes and what stays untouched).
- Key data structures, interfaces, and invariants.
- Ordered implementation steps.
- Risks / rollback considerations.
- How each criterion (`ac1`, `ac2`, ...) will be checked for real.

## Writing and revising (`hillclimb_plan_write`)

Use **`hillclimb_plan_write`** (preferred) or `hillclimb_act` (`write_plan` / `revise_plan`):

- **First plan (`write_plan`):** `hillclimb_plan_write(key="HC-12", body="...")` writes plan version `1`.
- **Revising (`revise_plan`):** Plans are append-only full-text versions (`version` increments `1 -> 2 -> 3`).
  - Calling `hillclimb_plan_write(key="HC-12", body="...")` automatically selects `write_plan` if no plan exists yet, or `revise_plan` against the latest `version` (or pass `version` explicitly to guard against concurrent edits).
  - If using raw `hillclimb_act`, pass `{ "op": "write_plan", "key": "HC-12", "body": "..." }` or `{ "op": "revise_plan", "key": "HC-12", "version": 1, "body": "..." }`.

## Reading plans

- **`hillclimb_outcome(key="HC-12")`** returns the latest `plan` (bounded by `planChars`, default 4000) and `planVersions` count.
- **`hillclimb_sync`** exports latest plans into `.hillclimb/plans/` for fast local reading and `rg` search.
- **`hillclimb_open`** displays the full plan history in the Outcome Drawer **Plan** tab.
