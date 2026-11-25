# Hill Climb for Antigravity

**Honest, verifier-backed hill climbing for coding agents.**

Hill Climb is an [Antigravity](https://antigravity.google) plugin (MCP server + interactive MCP App UI + skill + rules + standalone CLI) that pairs two loops:

1. **Inner loop — Locked Repo Climbs (`climb.py`):** Define a locked scoring script, regression guards, and an unseen holdout check. Every candidate edit is measured and automatically committed only on genuine improvement (or reverted cleanly).
2. **Outer loop — Ranked Outcomes & Contracts:** Organize work into ranked Goals, Outcomes, and Given/When/Then criteria backed by verifier evidence, human-confirmed contract changes, release roadmaps, and live score charts.

Active climbs in your repository and Antigravity swarm worktrees are **automatically tracked into Outcomes by default** (with an on/off toggle in the **Climbs** tab), keeping live trajectories, claims, and verifier evidence in sync without manual bookkeeping.

---

## Features

- **Interactive MCP App UI (`hillclimb_open`)** — available in the Antigravity sidebar, side pane, and inline in chat:
  - **Outcomes:** Pan-and-zoom tree map, ranked outline, signal filters (`verified`, `unverified`, `broken`, `stale`, `recheck`), coverage bar, and 24h / 7d / 30d activity replay.
  - **Climbs:** Live view of `.hill-climb/` runs across the main checkout and linked Antigravity worktrees, with plain-English status banners, progress bars, kept-vs-discarded score charts, holdout scores, event timelines, and a default-on **Auto-track Outcomes** toggle.
  - **Outcome Drawer:** Full contract + criteria, ancestor goal briefs, field-by-field change proposal diffs, live score trajectory + candidate lineage DAG + MAP-Elites island grid, verifier evidence ledger (with copy-for-PR export), plans, and comment threads.
  - **Verifier Rig Editor:** Guided 5-kit configurator (`correctness`, `latency-cost`, `retrieval`, `agent-outcomes`, `tuning`), manual repo climb rigs, and optional evolutionary search (`hillclimb.sh`: `greedy`, `openevolve`, `gepa`, `random`/`optuna`) with 4-currency budget previews.
  - **Inbox, Roadmap & Flows:** Human-confirmed contract approvals, release readiness & scenario comparisons, track promotion previews, and criterion-linked HTML flows with pins.
- **28 Agent-Facing MCP Tools (`hillclimb_*`):** Repo climbs (`hillclimb_setup`, `hillclimb_status`, `hillclimb_card`, `hillclimb_list`, `hillclimb_log`), contract trees (`hillclimb_projects`, `hillclimb_tree`, `hillclimb_next_outcomes`, `hillclimb_outcome`, `hillclimb_act`, `hillclimb_propose_change`, `hillclimb_lint_tree`, `hillclimb_claim`, `hillclimb_release`, `hillclimb_plan_write`, `hillclimb_comment`, `hillclimb_inbox`, `hillclimb_add_evidence`, `hillclimb_set_status`, `hillclimb_sync`), verifier rigs & dispatch (`hillclimb_rig`, `hillclimb_search_start`, `hillclimb_search_status`, `hillclimb_search_summit`), CI JUnit evidence ingestion (`hillclimb_ingest_junit`, `hillclimb_post_test_evidence`), and equal-budget studies (`hillclimb_study_preview`, `hillclimb_study_report`).
- **22-Rule Contract Linter:** Catches vague, untestable, or circular outcome contracts before work begins.
- **Standalone CLI (`bin/hillclimb`):** Zero-dependency shell CLI for scripts and CI pipelines.
- **Skill & Always-On Rules (`skills/hill-climb/`, `rules/AGENTS.md`):** Methodology guides and guardrails enforcing locked checks, human contract ownership, and evidence-backed status.

---

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite`; unflagged on Node 24+)
- **Python 3** (runs the vendored `.hill-climb/engine/climb.py`)
- **Git**

---

## Installation

`dist/mcp-server.mjs`, `dist/cli.mjs`, and `dist/app.html` are prebuilt and self-contained — **no `npm install` is required** to run the plugin.

### Option 1: Install into Antigravity directly

```bash
git clone https://github.com/MarkLernReBar/antigravity-plugin-hillclimb.git ~/.gemini/config/plugins/hillclimb
```

Then open **Customizations → Plugins** in Antigravity (or refresh MCP servers) and enable **Hill Climb**.

### Option 2: Build from source

```bash
git clone https://github.com/MarkLernReBar/antigravity-plugin-hillclimb.git ~/.gemini/config/plugins/hillclimb
cd ~/.gemini/config/plugins/hillclimb
npm install
npm run build
npm run typecheck
npm test
```

---

## Quick Start

### 1. Open the workspace UI
Open **Hill Climb** from the Antigravity sidebar (or ask your agent: *"Open Hill Climb"*). Projects registered in Antigravity are discovered automatically; click **+ Project** to add any local git repository.

### 2. Start a locked climb in any repository
Ask your agent:
> *"Set up Hill Climb in this repo and help me build a locked check and climb card for `<metric>`."*

Or run directly from the terminal:

```bash
# Install .hill-climb/engine/ and benchmark kits (ignored via .git/info/exclude)
~/.gemini/config/plugins/hillclimb/bin/hillclimb setup --dir /path/to/repo

# Initialize a locked climb
python3 .hill-climb/engine/climb.py init my-climb \
  --goal "Reduce test failures to zero" \
  --check "pytest -q" \
  --direction min \
  --target 0 \
  --lock tests/

# Try edits, keep only improvements
python3 .hill-climb/engine/climb.py try "Fix edge case in parser"

# Read status without re-running checks
~/.gemini/config/plugins/hillclimb/bin/hillclimb status --dir /path/to/repo
```

Every active climb automatically appears in both **Climbs** and **Outcomes** in the Hill Climb UI.

### 3. Ingest CI test evidence (optional)

```bash
~/.gemini/config/plugins/hillclimb/bin/hillclimb ingest-junit \
  --report junit.xml \
  --project <project-id> \
  --dir /path/to/repo \
  --source "https://ci.example.com/runs/123" \
  --apply
```

---

## Data & Storage

All contract trees, verifier rigs, receipts, and climb links are stored locally in SQLite (`node:sqlite`, WAL mode) at:

```text
${PLUGIN_DATA}/hillclimb.db
# Default: ~/.gemini/antigravity/plugin_data/hillclimb/hillclimb.db
```

Nothing is sent to any external server.

---

## Credits & Licenses

- **Hill Climb Plugin for Antigravity:** MIT License — see [LICENSE](./LICENSE).
- **Vendored repo climb engine (`assets/engine/climb.py`, `judge.py`):** Adapted from [Bil0000/Hill-Climb](https://github.com/Bil0000/Hill-Climb) under the MIT License — see [LICENSE-hill-climb](./LICENSE-hill-climb).
- **Vendored methodology references (`skills/hill-climb/references/`):** Adapted from [Desiderata-Labs/hillclimb-skills](https://github.com/Desiderata-Labs/hillclimb-skills) under the MIT License — see [skills/hill-climb/references/LICENSE-mit](./skills/hill-climb/references/LICENSE-mit) and [PROVENANCE.md](./skills/hill-climb/references/PROVENANCE.md).
- **Optional evolutionary search integration:** Supports the MIT-licensed [hillclimb.sh](https://hillclimb.sh) CLI (`rebase-energy/hillclimb`).
