<!--
Adapted from Desiderata-Labs/hillclimb-skills — roadmaps.md (MIT License: see LICENSE-mit).
Updated to reflect local Hill Climb plugin actions (create_release) and UI Roadmap page.
-->

# Releases and roadmaps

> Group outcomes into dated releases across scenarios, compare readiness in the Roadmap view, and plan track promotions without changing tree priority.

## Local release model

The contract tree decides **what matters and in what order** (`rank`). Releases and scenarios decide **what ships together and when** without altering tree priority.

Each release (`Release` in `src/model.ts`) has:
- **`name`**: Release label (e.g. `"Beta onboarding"`).
- **`keys`**: Non-empty list of existing outcome keys included in the release.
- **`date`**: Target ship date (`YYYY-MM-DD`).
- **`scenario`**: Scenario name (e.g. `"Plan A"`, `"Conservative"`).

Readiness is derived dynamically from the outcomes' current signals (`verified`, `unverified`, `broken`, `stale`, `recheck`) — a release never claims more than the evidence supports.

## Creating and comparing releases

1. **Create a release (`create_release`)** via `hillclimb_act` or `hillclimb act`:
   ```json
   {
     "op": "create_release",
     "name": "Beta onboarding",
     "keys": ["HC-12", "HC-14"],
     "date": "2026-12-15",
     "scenario": "Plan A"
   }
   ```
   - Confirm scope choices with the user before grouping outcomes into a named release.
   - To model an alternative timeline or cut, create releases under another `scenario` name (e.g. `"Conservative"`).
2. **Inspect and compare in the UI**:
   - Call `hillclimb_open(page="roadmap")` (or click the **Roadmap** tab) to inspect release readiness across scenarios and manage track promotions.
   - Call `hillclimb_tree` to read existing `releases` and outcome signals programmatically.
