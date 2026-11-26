# Provenance of the vendored references

| Local file | Upstream | Upstream repository | License |
| --- | --- | --- | --- |
| `writing.md` | `writing.md` | [Desiderata-Labs/hillclimb-skills](https://github.com/Desiderata-Labs/hillclimb-skills) | MIT |
| `evidence.md` | `evidence.md` | same | MIT |
| `climbing.md` | `climbing.md` | same | MIT |
| `practices.md` | `practices.md` | same | MIT |
| `shaping.md` | `shaping.md` | same | MIT |
| `LICENSE-mit` | `LICENSE` (`Copyright (c) 2026 Desiderata Labs`) | same | MIT |

Retrieved 2026-11-24 from the published skill (`hillclimb.me/skill.md`, skill
version `1.0.0+0fb508b0`; reference set `me_skills_refs.txt` in the source
thread). These five guides cover
the writing rubric (which the linter enforces), evidence and CI, the climbing
loop, tree-shaping guidance, and the practice patterns.

## What was changed

- Vendored methodology guides (`writing.md`, `evidence.md`, `climbing.md`,
  `practices.md`, `shaping.md`, `comments.md`, `plans.md`, `tracks.md`,
  `roadmaps.md`, `flows.md`) were adapted for this local Antigravity plugin
  under the MIT license in `LICENSE-mit`.
- Hosted-only SaaS sections, remote API URLs, API keys/webhook tokens, and
  non-existent SaaS MCP tools were removed or rewritten to use this plugin's
  actual local `hillclimb_*` MCP tools, `hillclimb` CLI commands, and
  `src/actions.ts` schemas.
- `writing.md` preserves the `# Outcomes`, `# Criteria`, `# Goals`, and
  `# Placement` sections and all 22 rubric rule codes and titles
  (`O1`–`O6`, `C1`–`C9`, `G1`–`G4`, `P1`–`P3`) verbatim for `src/linter.ts`.


## Planning and coordination guides

The local editions of comments.md, plans.md, tracks.md, roadmaps.md, flows.md include a local action guide followed by the MIT upstream text from Desiderata-Labs/hillclimb-skills revision `2ae8ebffeea19d4e6dc7fb1d9c6c35f304feebf0`.
