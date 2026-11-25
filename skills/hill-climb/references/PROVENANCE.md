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

- A header comment was added to each file: the upstream source, the MIT license
  pointer, and a mapping from the remote MCP tool names the upstream text uses to
  this plugin's local commands (`hillclimb tree`, `hillclimb act`,
  `hillclimb sync`). The body below each header is unmodified.
- Upstream web links are left as they are: they are the authority for anything
  this plugin does not restate.
- Nothing was removed. Where the upstream text describes a hosted product
  feature this plugin does not implement (hosted accounts, API keys, uploads),
  it is still accurate guidance for the hosted product and is marked as such
  here rather than deleted, so a reader can tell which parts ride on the local
  commands and which are hosted-only.


## Planning and coordination guides

The local editions of comments.md, plans.md, tracks.md, roadmaps.md, flows.md include a local action guide followed by the MIT upstream text from Desiderata-Labs/hillclimb-skills revision `2ae8ebffeea19d4e6dc7fb1d9c6c35f304feebf0`.
