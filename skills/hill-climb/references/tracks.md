<!--
Adapted from Desiderata-Labs/hillclimb-skills — tracks.md (MIT License: see LICENSE-mit).
Updated to reflect local Hill Climb plugin actions (create_track, promote_track) and track parameters.
-->

# Rewrites and tracks

> Prove a replacement (a rewrite, migration, or new backend) in parallel against the same outcome contracts as what is live on `main`, then promote verified outcomes when ready.

## When to use a track

A track isolates evidence and status for a replacement implementation against the **same** goals, outcomes, keys, and criteria as `main`. Every project starts with `"main"`.

Do not duplicate the tree into a separate `"rewrite"` goal — duplicated trees drift immediately. With a track, the contract stays shared and `main` remains untouched until cutover.

## Starting a track (`create_track`)

Create a track via `hillclimb_act` or `hillclimb act`:

```json
{
  "op": "create_track",
  "name": "v2-rewrite",
  "description": "Rust parser replacement proved in parallel against main contracts"
}
```

- `name` must match the key pattern (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$`, e.g. `v2-rewrite`).
- New tracks start `unverified` across outcomes without modifying `main` evidence or signals.

## Climbing on a track

Pass `track: "<name>"` to keep track reads, evidence, status, and dispatched runs isolated from `main`:

1. **Read queue & outcomes:** `hillclimb_tree(..., track="v2-rewrite")`, `hillclimb_next_outcomes(..., track="v2-rewrite")`, `hillclimb_outcome(..., track="v2-rewrite")`, `hillclimb_open(..., track="v2-rewrite")`.
2. **Record track evidence:** `hillclimb_add_evidence(..., track="v2-rewrite")` (or `hillclimb_ingest_junit(..., track="v2-rewrite")`). `main` evidence does not verify a track, and track evidence (`confirms` or `denies`) does not alter `main` signals until promotion.
3. **Set status / dispatch runs:** `hillclimb_set_status(..., track="v2-rewrite")` and `hillclimb_search_start(..., track="v2-rewrite")` / `hillclimb_search_status(..., track="v2-rewrite")` / `hillclimb_search_summit(..., track="v2-rewrite")`.

## Promoting a track (`promote_track`)

`promote_track` (`{ "op": "promote_track", "name": "v2-rewrite", "keys": ["HC-12", "HC-14"] }`) promotes selected outcomes from the track onto `main`:
- **Human confirmation required:** `hillclimb_act` and `hillclimb act` refuse `promote_track` (`human_decision_required`).
- Open the Roadmap view via **`hillclimb_open(page="roadmap")`** so the user can select outcomes, preview the promotion impact, and confirm promotion in the UI dialog.
- After cutover, verify the promoted behavior in the live/production environment and record fresh `confirms` evidence on `main`.
