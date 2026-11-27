# Hill Climb for Antigravity

**Honest, verifier-backed hill climbing for coding agents.**

Hill Climb is an [Antigravity](https://antigravity.google) plugin (MCP server + interactive MCP App UI + skill + rules + standalone CLI) that pairs two loops:

1. **Inner loop — Locked Repo Climbs (`climb.py`):** Define a locked scoring script, regression guards, and an unseen holdout check. Every candidate edit is measured and automatically committed only on genuine improvement (or reverted cleanly).
2. **Outer loop — Ranked Outcomes & Contracts:** Organize work into ranked Goals, Outcomes, and Given/When/Then criteria backed by verifier evidence, human-confirmed contract changes, release roadmaps, and live score charts.

Active climbs in your repository and Antigravity swarm worktrees are **automatically tracked into Outcomes by default** (with an on/off toggle in the **Climbs** tab), keeping live trajectories, claims, and verifier evidence in sync without manual bookkeeping.

---

## Features

- **Interactive MCP App UI (`hillclimb_open`) & Inline Chat Cards** — available in the Antigravity sidebar, side pane, and directly inline in chat threads:
  - **Inline Chat Decisions & Visual Design Reviews:** `hillclimb_propose_change`, `hillclimb_comment` (with `options`), and `hillclimb_design(mode="propose")` render interactive Approve/Reject, multiple-choice, and Before/After visual review cards right inside the active conversation thread (synced with **Decisions** and **Flows**).
  - **Chat-First Design with Agents (`hillclimb_design`):** Scans your repository's real UI components and CSS design tokens (`mode="kit"`), proposes live HTML mockups or workspace screenshots inline (`mode="propose"`), supports drag-to-draw visual feedback (`Pin`, `Box`, `Arrow`, `Draw`) with viewport toggles and clickable `componentRefs`, and lets agents inspect/resolve visual pins (`mode="inspect"` / `mode="resolve_pin"`).
  - **Goals (List & Map):** Pan-and-zoom tree map & ranked outline with hierarchical section numbering (`1.1`, `1.2.1`), ghosted pending proposed outcomes rendered directly under their target goal (with click-to-review), manual `blocked`/`deferred` availability controls, tags, saved views, Focus Scopes (targeting releases/goals/tags), coverage bar, and 24h / 7d / 30d activity replay with actor provenance.
  - **Climbs:** Live view of `.hill-climb/` runs across the main checkout and linked Antigravity worktrees, with plain-English status banners, progress bars, kept-vs-discarded score charts, holdout scores, event timelines, and a default-on **Auto-track Outcomes** toggle (generating 22-rule lint-clean contracts).
  - **Outcome Drawer:** Full contract + criteria, inline goal editing, availability & tag editors, linked Flows + **Design screen** shortcut, field-by-field change proposal diffs, live score trajectory + candidate lineage DAG + MAP-Elites island grid, verifier evidence ledger (with attachments & PR export), versioned plans with inline diffs & plan-version comments, and threaded questions.
  - **Flows & Decisions (Top-Level Nav) + Roadmap:** Dedicated **Flows** tab with folders, `Needs attention` filter, drag/drop/paste screenshot upload, `Attach to chat`, step-by-step Player, viewport presets, frame version restore, visual drift banners, and drag-to-draw annotations; **Decisions** tab with side-by-side Approved vs. Proposed previews and `1`–`9` / `a` / `r` keyboard shortcuts; plus **Roadmap** Timeline swimlane with SVG progress rings, inline release editing (`revise_release`), Focus Scope launch, scenario comparisons & track promotion previews.
  - **Insights & Reports:** Daily verification throughput chart with click-to-drill-down, streak & provenance breakdown, inner-loop climb telemetry (keep rate, guard regressions caught, unseen holdout gaps), evidence-backed Markdown reports (5 templates, citations, locks, history), and one-click self-contained HTML / Markdown snapshot exports.
  - **Global `⌘K` Search, Blueprints & Settings:** Instant SQLite FTS5 search across the whole workspace, 5 built-in contract blueprints + Markdown story importer with 22-rule lint preview, and project automation settings (`autoSyncMirror`, `wakeOnAnswer`, opt-in `requireApprovalForNewOutcomes`, `designKit`, plus local desktop `notify` / `shell` / HMAC `webhook` hooks).
- **34 Agent-Facing MCP Tools (`hillclimb_*`):** Interactive UI (`hillclimb_open`), chat-first visual design (`hillclimb_design`), repo climbs (`hillclimb_setup`, `hillclimb_status`, `hillclimb_card`, `hillclimb_list`, `hillclimb_log`), contract trees (`hillclimb_projects`, `hillclimb_tree`, `hillclimb_next_outcomes`, `hillclimb_outcome`, `hillclimb_act`, `hillclimb_propose_change`, `hillclimb_lint_tree`, `hillclimb_claim`, `hillclimb_release`, `hillclimb_plan_write`, `hillclimb_comment`, `hillclimb_inbox`, `hillclimb_add_evidence`, `hillclimb_set_status`, `hillclimb_sync`), search/insights/reports/import (`hillclimb_search`, `hillclimb_insights`, `hillclimb_artifact`, `hillclimb_import`), verifier rigs & dispatch (`hillclimb_rig`, `hillclimb_search_start`, `hillclimb_search_status`, `hillclimb_search_summit`), CI JUnit evidence ingestion (`hillclimb_ingest_junit`, `hillclimb_post_test_evidence`), and equal-budget studies (`hillclimb_study_preview`, `hillclimb_study_report`).
- **Battle-Tested Inner-Loop Engine (`climb.py`):** Automatic branch-based climb resolution on multi-climb repos, non-error multi-climb status overviews, stdout-first failure headlines, fast-fail pre-check guards on slow checks (`--guards-first` / automatic when avg check ≥ 60s), near-miss variance signals (`below min_gain`), branch-behind-base warnings, graceful holdout-init recovery with strict blind-holdout hygiene, automated **holdout-transfer / overfit alarms**, **anti-excuse `review` gates** (`PLATEAU` + `--skeptic` fresh-context audits), contract-vs-check drift & lint checks on `hillclimb_propose_change`, de-noised auto-track evidence, starter `notes.md` seeding, and one-click engine upgrade in the **Climbs** UI.
- **22-Rule Contract Linter:** Catches vague, untestable, or circular outcome contracts before work begins.
- **Standalone CLI (`bin/hillclimb`) & Local REST API (`hillclimb serve`):** Zero-dependency shell CLI (`search`, `insights`, `export`, `import`, `artifact`, `ingest-alert`, `sync --watch`, `serve` on `127.0.0.1`) plus cross-agent MCP setup in [AGENTS-QUICKSTART.md](./AGENTS-QUICKSTART.md).
- **Skill & Always-On Rules (`skills/hill-climb/`, `rules/AGENTS.md`):** Methodology guides and guardrails enforcing locked checks, human contract ownership, inline-card last-call discipline, blind holdout isolation, and evidence-backed status.

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

Or run directly from the terminal (if `hillclimb` is not on your `PATH`, use `<plugin-dir>/bin/hillclimb` or `node <plugin-dir>/dist/cli.mjs`):

```bash
# Install .hill-climb/engine/ and benchmark kits (ignored via .git/info/exclude)
hillclimb setup --dir /path/to/repo

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
hillclimb status --dir /path/to/repo
```

Every active climb automatically appears in both **Climbs** and **Outcomes** in the Hill Climb UI.

### 3. Ingest CI test evidence (optional)

```bash
hillclimb ingest-junit \
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
