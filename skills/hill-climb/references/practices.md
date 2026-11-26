<!--
Adapted from Desiderata-Labs/hillclimb-skills — practices.md (MIT License: see LICENSE-mit).
Updated to match local Hill Climb plugin MCP tools and data model.
-->

# Best practices

> Patterns that work in real trees: how to write the charter, phrase objectives and key results, size goals, handle KPIs and triage, migrate a backlog, and wire a repository so agents climb it every day.

These patterns come from trees that teams climb every day. Use them as defaults and change what doesn't fit.

## The charter (root brief)

Keep it to about 100 to 200 words, in three parts:

1. **Purpose and audience.** One paragraph on what the product does and who it serves.
2. **Non-negotiables.** Five to eight bullets that must hold for every piece of work, such as:
   - security and isolation rules;
   - "nothing turns green by assertion";
   - cost or simplicity constraints;
   - who has the final say.
3. **System of record.** One sentence saying this tree decides what gets built next, and in what order.

Agents read the charter before every outcome, so write each non-negotiable as a rule someone can check, not as an aspiration.

## Levels

A tree that works well usually looks like this:

```
Product / Repo (root, the charter)
└─ Objective        5–7, ranked by importance
   └─ Key result    2–5 per objective
      └─ Focus      optional, only where a key result gets crowded
         └─ outcomes
```

- **Objectives hold no outcomes directly.** Outcomes hang off key results, or off focus goals.
- **Split a key result into focus goals** once it holds more than about 15 to 20 outcomes. Most key results hold between 3 and 15.

## Phrase goals as what will be true

Objectives and key results are short, present-tense statements of a result. They aren't nouns, project names, or system names:

| instead of | write |
| --- | --- |
| "Billing" | "Customers are billed exactly for what they use" |
| "API v2" | "Every request is answered within its latency budget" |
| "Infra" | "Costs stay small as usage grows" |

Some templates that work for key results:
- "⟨Actor⟩ ⟨does⟩ ⟨thing⟩ without ⟨help/friction⟩"
- "Every ⟨unit of work⟩ ⟨meets⟩ ⟨its constraint⟩"
- "⟨Quality⟩ stays ⟨within bound⟩ as ⟨scale grows⟩"

Systems (the API, the apps, the CLI, the infrastructure, the models) belong **under** the objectives they serve, never as top-level buckets. If an objective needs several systems, give each its own key result or focus goal.

## Rank promises first

Put the objective that protects your invariants first: correctness, isolation, security, keeping data, and the product staying up. It's the one thing you can't trade away. Growth, adoption, and cost come after. When the order is right, an agent that only ever takes the top item still does the right thing.

## Briefs at every level

Give every objective and key result a brief of one to three sentences:
- what it has to prove;
- what to avoid claiming;
- any guardrail specific to that part of the tree.

Short briefs get read. Long ones get skimmed.

## Outcomes

- **One behavior per outcome.** Usually one to five criteria, each checkable on its own.
- **Write criteria a stranger could check.** Name the actor, the starting state, the action, and the observable result.

## KPIs and forward-looking outcomes

Some outcomes are measurements, such as "50 teams are active every week for four weeks running". Put the measurement window in the criteria. Until the window has passed, record what you know as `note` evidence (`hillclimb_add_evidence`) and leave the outcome `unverified` with a note saying what would prove it. Never verify a KPI early.

## Triage

When you import a backlog, some items won't fit anywhere yet. Put them under a **Triage** goal ranked last, with a brief saying it holds work waiting for review. Review it regularly:
- fold or move real behaviors into proper outcomes;
- drop or retire items that aren't lasting product behaviors.

A tree that ends in a growing triage pile is a tree people stop trusting.

## Migrating tickets

Tickets record work done, not behavior. When bringing in an issue tracker:

1. Write outcomes for the behavior the tickets add up to.
2. Attach each ticket as evidence on the outcome it touches:
   - shipped work **confirms**, with the ticket link;
   - an open bug **denies**, which puts the outcome back in next work;
   - context goes in as a **note**.
3. Skip chores and noise, and send anything ambiguous to triage.

Expect a migrated tree to start mostly `unverified`, with `broken` outcomes wherever open bugs exist. That's an accurate picture, and it's what agents climb.

## Wire the repository

Put the loop in the repository's `AGENTS.md` (or skill instructions) so every agent session climbs the same way:

```markdown
## Working on this repo
1. Call `hillclimb_next_outcomes` and pick the top item in `next`.
2. Call `hillclimb_claim`, then `hillclimb_outcome` and read every ancestor brief above it.
3. Work on a branch, scoped to that outcome.
4. Check each criterion for real (tests, the running app), call `hillclimb_add_evidence`
   with exact commands and output, then `hillclimb_set_status`.
5. Release with `hillclimb_release` if stopping early, and verify in production after deploy.
6. If an outcome looks wrong or missing, use `hillclimb_propose_change`; never edit one to make work pass.
```

Naming the outcome key in tests (`it('HC-12@3#ac1: …')`) links code, CI evidence, and the tree together. See [assets/ci/README.md](../../../assets/ci/README.md) and [evidence.md](evidence.md).

## Who does what

- **People** own the charter, objectives, key results, and outcome contracts. They confirm `approve_change`, `reject_change`, and `promote_track` in the Hill Climb UI (`hillclimb_open`).
- **Agents** pick the top unproven outcome, build, prove, and record evidence. They propose new or revised contracts (`hillclimb_propose_change`) and wait for human approval.

## Reading the tree's health

`hillclimb_tree` and `hillclimb_next_outcomes` report derived signals (`bySignal`) and tree coverage (also shown in the UI map/outline via `hillclimb_open`). In a healthy tree:
- verified coverage rises steadily from the top objective down;
- `broken` and `stale` outcomes are fixed before starting new `unverified` work;
- a goal's outcomes are all `verified` (or `recheck`).

When something important is `broken`, fix it or raise its `rank` rather than adding a duplicate goal next to it.
