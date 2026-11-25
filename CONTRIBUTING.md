# Contributing to Hill Climb for Antigravity

Thanks for helping improve Hill Climb!

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite`)
- **Python 3** (used by `assets/engine/climb.py` and the integration tests)
- **Git**

## Development workflow

```bash
npm install
npm run build
npm run typecheck
npm test
```

- `npm run build` compiles:
  - `dist/app.html` — single-file React MCP App bundle (`scripts/build-ui.mjs`)
  - `dist/mcp-server.mjs` — self-contained ESM MCP server bundle (no `node_modules` required at runtime)
  - `dist/cli.mjs` — self-contained ESM CLI bundle invoked by `bin/hillclimb`
- Commit rebuilt `dist/` artifacts alongside source changes so Antigravity users installing directly from Git can run the plugin with zero build step.

## Architecture invariants

- **Humans own the contract:** Contract approval (`approve_change`, `reject_change`) and track promotion (`promote_track`) must remain gated behind explicit human confirmation in the UI, never auto-approved by an agent tool.
- **No fabricated verification:** Outcome status (`verified` / `unverified` / `broken` / `stale` / `recheck`) is derived solely from current-version, criterion-bound verifier evidence and receipts — never prose.
- **Keep `.hill-climb/` out of tracked git diffs:** `hillclimb_setup` writes to `.git/info/exclude`, never `.gitignore`.
