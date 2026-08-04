---
description: Redraw the diagrams that have gone stale against the code
allowed-tools: Bash(npm run check:drift), Bash(npx -y -p board-ai board-drift), mcp__board__check_drift, mcp__board__read_diagram, mcp__board__create_diagram, mcp__board__edit_diagram, mcp__board__delete_diagram, Read, Grep, Glob
---

A diagram in this repo points at code that has moved or gone. Bring the diagram
back in line with what is actually there.

## Find what drifted

Run `check_drift` (no arguments checks every board under `docs/diagrams`). If the
MCP board tools are unavailable, run `npm run check:drift` instead.

If the report is clean, say so in one line and stop. Do not go looking for
problems it did not find, and do not redraw a diagram that is fine.

## Decide what each finding means

A finding says a box points at a file or symbol that no longer exists. That has
two possible causes and they need opposite treatment, so establish which before
changing anything:

- **The code moved or was renamed.** Point the box at the new location. Search
  for the symbol or a plausible new path before assuming; a box saying
  `src/engine/layout.ts` when the file is now `src/engine/layout/index.ts` is a
  ref to update, not a subsystem to delete.
- **The code is genuinely gone.** Remove the box. Also remove arrows that only
  existed to reach it, or the diagram keeps a dangling claim.

Boxes marked `inferred` were hand-drawn, and their ref was *guessed from the
label*. Treat those as the user's intention, not as a wrong claim: mention them
and ask, rather than deleting someone's sketch because a guessed path missed.

## Redraw

Read the diagram first, then regenerate it with `create_diagram` on the same
path, carrying over every node and edge that is still right and fixing the ones
that are not.

Two things to be honest about when you report:

- **Regeneration replaces what was generated before.** Hand-drawn elements
  survive, but layout of the generated part is decided fresh, so a diagram
  someone arranged by hand comes back arranged by the engine.
- Say which boxes you repointed, which you removed, and anything you were unsure
  about. A diagram silently rewritten is worse than one left stale.

Finish by re-running the check to confirm it is clean, and report in a sentence
or two. No essay about the architecture.
