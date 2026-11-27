# Hill Climb — Agent Quickstart (`llms.txt`)

Zero-install, local-first contract tree + locked repo hill-climbing engine (`v0.9.1`).
Everything lives locally in SQLite (`~/.gemini/antigravity/plugin_data/hillclimb/hillclimb.db`).

## 1. Connect Any MCP-Compatible Agent

`dist/mcp-server.mjs` is prebuilt and standalone (Node.js 22.5+ required, zero `npm install`).

### Antigravity
Install into `~/.gemini/config/plugins/hillclimb` and enable **Hill Climb** in Customizations → Plugins.

### Claude Code (`~/.claude.json` or `.mcp.json`)
```json
{
  "mcpServers": {
    "hillclimb": {
      "command": "node",
      "args": ["/path/to/antigravity-plugin-hillclimb/dist/mcp-server.mjs"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "hillclimb": {
      "command": "node",
      "args": ["/path/to/antigravity-plugin-hillclimb/dist/mcp-server.mjs"]
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.hillclimb]
command = "node"
args = ["/path/to/antigravity-plugin-hillclimb/dist/mcp-server.mjs"]
```

---

## 2. Core Agent Loop (60-Second Guide)

1. **Pick work:** `hillclimb_next_outcomes` (supports `tag` and `scope` filters; skips manually `blocked` or `deferred` outcomes).
2. **Claim lease:** `hillclimb_claim` (always `hillclimb_release` when stopping).
3. **Read full context:** `hillclimb_outcome` returns criteria, ancestor briefs, plans, evidence, linked visual Flows, and pending Flow proposals.
4. **Design UI visually in chat (when changing UI):** Call `hillclimb_design(mode="kit")` first to pull real repo UI components & CSS tokens, then call `hillclimb_design(mode="propose")` as your final tool step to render an interactive Before/After review card with drag-to-draw annotations directly in the thread. Resolve addressed visual pins with `hillclimb_design(mode="resolve_pin")`.
5. **Search workspace:** `hillclimb_search` queries SQLite FTS5 across goals, outcomes, criteria, plans, evidence, comments, flows, artifacts, and repo climbs.
6. **Iterate honestly, break plateaus & audit wins (inner loop):** Run `hillclimb_setup`, initialize `.hill-climb/engine/climb.py init ... [--probe "<fast-slice>"] [--holdout-every 3] --lock <tests>`, and iterate with atomic `climb.py try` steps (prove slow-check edits trigger on missed cases via `--probe` first; both `climb.py` and `hillclimb_status` auto-resolve the active `climb/<name>` branch and surface per-case `CANCEL-OUT` / `ZERO-CASE-CHANGE` diffs, `STALL` / `THRASH DETECTED` alerts, `HOLDOUT CHECKPOINT DUE` reminders, and stale `notes.md` warnings). Keep `notes.md` Pareto + Dead Ends current every 2–3 steps, fan out parallel orthogonal subagents on `STALL`, measure variance with `climb.py check-noise`, keep holdout checks strictly blind, never declare a ceiling/vendor blocker without a fresh-context Skeptic audit (`climb.py review "..." --skeptic "..."`), and run `climb.py audit` + a fresh-context Adversarial Win Audit before confirming criteria or merging.
7. **Prove & close:** Record version-scoped criterion proof with `hillclimb_add_evidence` (supports `attachments`), then call `hillclimb_set_status`.
8. **Propose contract or visual changes inline:** Never alter contracts to make broken code pass. Finish all prep/selftests first, then call `hillclimb_propose_change` (pass `goalKey` for new outcomes), `hillclimb_comment` (with `options`), or `hillclimb_design(mode="propose")` as your **final tool call before yielding** so the inline decision card stays visible in chat (and synced in **Decisions** / **Goals**).

---

## 3. Useful Standalone CLI Commands (`bin/hillclimb`)

```bash
# Search everything across the local database & repo climbs
hillclimb search "idempotency" --project my-app

# Read analytics + inner-loop climb keep rate & holdout gap
hillclimb insights --project my-app --days 30

# Seed from a built-in contract blueprint or Markdown spec (dry-run or --apply)
hillclimb import --project my-app --blueprint saas-api --apply
hillclimb import --project my-app --file SPEC.md --propose --apply

# Generate an evidence-backed report or export a self-contained HTML snapshot
hillclimb artifact generate --project my-app --template weekly-update
hillclimb export --project my-app --format html --out snapshot.html

# Ingest monitoring alert as denying evidence (marks outcome broken & fires hooks)
hillclimb ingest-alert --project my-app --key API-LATENCY --text "p99 > 900ms" --source "pagerduty:inc-42"

# Keep .hillclimb/ Markdown mirror continuously synced
hillclimb sync --project my-app --dir /path/to/repo --watch

# Opt-in loopback-only REST API (127.0.0.1, Bearer token required)
hillclimb serve --port 4189 --token "$HILLCLIMB_API_TOKEN"
```
