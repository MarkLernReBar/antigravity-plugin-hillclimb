<!--
Adapted from Desiderata-Labs/hillclimb-skills — shaping.md (MIT License: see LICENSE-mit).
Updated to match local Hill Climb plugin tools, schemas, and approval workflow.
-->

# Shaping a tree

> Design a tree people and agents can climb: goals and briefs, priority by rank, outcomes with checkable criteria, dependencies, proposals, and migrating existing work.

## What a good tree looks like

A tree captures a product's priorities so people and agents agree on what matters and when it is proven:
- **The root goal** is the product or repository. Its brief is the charter: who it serves and the non-negotiables that apply everywhere.
- **Top goals** are objectives, ranked by importance (`rank`, ascending). Rank by what matters most to users and the business, not by code modules.
- **Sub-goals** narrow down to key results or focus areas (`parentGoalKey`). Two or three levels of goals is usually enough.
- **Outcomes** sit at the leaves, each describing one checkable behavior.

## Priority (`rank`) and briefs

- **`rank`** orders siblings (non-negative integer, default `100`; smaller numbers rank higher). Equal ranks represent parallelizable work.
- **Briefs** (`brief` on `create_goal`) hold Markdown covering intent, non-goals, and guardrails (security, compatibility, performance floors). Agents read every ancestor goal brief above an outcome before working on it, so keep briefs short, specific, and factual.

## Outcomes (`create_outcome` / `propose_change`)

Create outcomes via `hillclimb_act` (`op: "create_outcome"`), or propose edits to existing outcomes via **`hillclimb_propose_change`** (`op: "propose_change"`):

- **`key`**: Stable identifier matching `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$` (e.g. `HC-12`, `PAY-03`).
- **`goalKey`**: Existing parent goal key.
- **`contract`**:
  - `title`: Present-tense behavior fact (e.g. `"Patients get a reminder the day before"`).
  - `story`: One sentence: `"As a <actor>, I want <behavior>, so that <harm avoided>."`
  - `criteria`: 1–5 (hard lint limit 7) Given/When/Then objects (`{ id, given, when, then }`), each with a stable ID like `ac1`.
  - `dependsOn`: Keys of prerequisite outcomes in the same tree. An outcome stays listed in `blockedBy` and out of `next` until every dependency is `verified`/`recheck`. See [climbing.md](climbing.md#dependencies-dependson).
  - `rank`: Sibling priority integer (default `100`).
  - `recheckDays`: Positive number of days for scheduled proof renewal (or `null` when proof does not age).

Avoid outcomes that only say `"build X"`. State what is observable when X works. Run `hillclimb_lint_tree` (and check [writing.md](writing.md)) before finalizing new goals or outcomes.

## Proposals and human approval

- **Humans own the contract.** Never edit an outcome to make broken code or checks pass.
- To change an existing outcome's `title`, `story`, `criteria`, `dependsOn`, `rank`, or `recheckDays`, call **`hillclimb_propose_change`** (with `key` and full `contract`). This creates a pending change without altering the active contract.
- Pending changes appear in **`hillclimb_inbox`** and in the UI **Inbox** (`hillclimb_open(page="inbox")`), where a human confirms `approve_change` or `reject_change`. Both `approve_change` and `reject_change` are refused in `hillclimb_act` and `hillclimb act`.
- When an approved change alters criteria or meaning, the outcome's `version` increments and any previously `verified` outcome becomes `stale` until re-checked against the new version.

## Research, blockers, and folding outcomes

- **Research questions:** Write the question as an outcome whose criteria define what constitutes a verified answer (e.g. a benchmarked report or decision threshold).
- **Blocked work:** If an outcome waits on another outcome, record it in `dependsOn` via `hillclimb_propose_change`. If blocked by an external factor or missing user decision, post a question with `hillclimb_comment` (with `options`) and leave a `note` via `hillclimb_add_evidence`.
- **Folding duplicate or bug outcomes:** If two outcomes overlap or a bug was filed as a separate outcome (`P1` / `P2` in [writing.md](writing.md)):
  1. Propose adding the missing criteria to the owning outcome via `hillclimb_propose_change`.
  2. Once approved, record active evidence onto the owning outcome via `hillclimb_add_evidence` at its current version.

## Migrating an existing backlog

Do not create one outcome per ticket. Instead:
1. Group tickets into the lasting user/system behaviors they add up to, and create outcomes for those behaviors.
2. Attach historical context as evidence (`hillclimb_add_evidence`): shipped fixes as `confirms` (against verified behavior), open bugs as `denies` (putting the outcome into `broken`), and background links as `note`.
3. See [evidence.md](evidence.md) and [practices.md](practices.md) for patterns and tree structure.
