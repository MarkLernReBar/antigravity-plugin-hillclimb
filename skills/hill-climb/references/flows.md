<!--
Adapted from Desiderata-Labs/hillclimb-skills — flows.md (MIT License: see LICENSE-mit).
Updated to reflect local Hill Climb plugin actions (create_flow, pin) and UI Flows tab.
-->

# Flows

> Attach ordered HTML frames linked to outcome criteria and pin spot feedback directly in the Hill Climb Flows tab.

## Local flow model

In this plugin, a flow is a named sequence of self-contained HTML frames stored in the project tree and viewed in the **Flows** tab (`hillclimb_open(page="flows")`).

Each flow has:
- **`name`**: Flow title (e.g. `"Device sign-in"`).
- **`frames[]`**: Ordered list of frames, each with:
  - `title`: Frame title
  - `key`: Outcome key (must exist in the tree)
  - `criterionId`: Criterion ID on that outcome (must exist on that outcome)
  - `html`: Standalone HTML markup rendered inside a sandboxed preview frame
  - `pins[]`: Coordinate comments (`x`, `y` in `0..1`, `text`)

## Actions (`hillclimb_act` / `hillclimb act`)

1. **Create a flow (`create_flow`)**:
   ```json
   {
     "op": "create_flow",
     "name": "Sign in",
     "frames": [
       {
         "title": "Login form",
         "key": "HC-12",
         "criterionId": "ac1",
         "html": "<!doctype html><html><body><h1>Sign in</h1><button id=\"go\">Continue</button></body></html>"
       }
     ]
   }
   ```
2. **Pin feedback on a frame (`pin`)**:
   ```json
   {
     "op": "pin",
     "name": "Sign in",
     "frame": 0,
     "x": 0.5,
     "y": 0.62,
     "text": "Button label should say Continue with SSO"
   }
   ```
   - `frame` is the zero-based index into `frames[]`.
   - `x` and `y` are normalized coordinates between `0` and `1`.

## Working with flows

- Inspect existing flows in the tree snapshot (`hillclimb_tree`) or visually in `hillclimb_open(page="flows")`.
- Use self-contained HTML/CSS in `html` (avoid external unbundled asset assumptions) and give interactive elements stable `id` attributes.
- Text outcomes define **what** must hold; flow frames show **how** each criterion looks at each step. Keep both aligned, and never claim a criterion is verified just because a mock frame exists — verify the real implementation.
