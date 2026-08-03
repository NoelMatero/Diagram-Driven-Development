# Drift check: keeping a diagram honest about the code

Status: **design, not built.** Reference this file when implementing.

A committed diagram is documentation, and documentation rots. The point of
diagram-driven development is that the picture stays true, so the board needs a
way to notice when the code has moved out from under it.

## What makes this tractable here

Generated elements carry `customData` (`{ node, edge, edgeLabelFor, role, origin }`),
so `readGraph()` returns an exact node and edge list rather than something
re-derived from geometry. Drift detection is therefore a real set comparison,
not fuzzy matching against rectangles.

Hand-drawn elements are reported as `provenance: "inferred"`. They must be
treated differently: a box you sketched is an *intention*, not a claim about
current code, and reporting it as drift would be noise.

## Two jobs, deliberately separate

| | Cost | Needs a model | When to run |
| --- | --- | --- | --- |
| **Detection** — does the diagram disagree with the code? | milliseconds | no | every edit, pre-commit, CI |
| **Regeneration** — what should the diagram now say? | a model call | yes | when a human or the drift report asks |

Keeping these apart is the whole design. Detection is deterministic and safe to
run constantly; regeneration is a judgement call about what is worth showing and
should not fire on every keystroke.

## What "drift" means concretely

A diagram node claims a thing exists. Drift is a mismatch between that claim and
the repository. Three kinds, in descending confidence:

1. **Missing** — a node names a module, file, or symbol that no longer exists.
   High confidence, almost always actionable.
2. **Unrepresented** — a significant module exists in the code but appears
   nowhere on the board. Needs a relevance threshold or it reports every file.
3. **Edge mismatch** — the diagram draws `A → B` but nothing in `A` imports or
   calls `B`, or a real dependency is undrawn. The most valuable signal and the
   most likely to produce false positives.

Start with (1). It is nearly free and nearly always right. Add (2) and (3) only
once (1) is quiet in practice.

## Binding nodes to code

Detection needs to know what a node refers to. Guessing from the label is
unreliable ("Auth" could be anything). Better: let a node record its referent
explicitly.

```jsonc
// customData on a generated node
{ "node": "auth", "ref": "src/main/voice-token.ts" }
```

Add an optional `ref` to the `create_diagram` node schema — a repo-relative path
or a `path#symbol`. Nodes without a `ref` are simply skipped by detection rather
than guessed at. Opt-in keeps false positives near zero, which is what decides
whether anyone leaves the check switched on.

## Tool and script surface

- `check_drift(path)` — MCP tool. Returns `{ missing[], unrepresented[], edgeMismatches[], clean: boolean }`.
  Read-only; never edits the board.
- `scripts/check-drift.mjs <board>` — same logic, CLI, non-zero exit when drift
  is found. This is what hooks and CI call.

Sharing one implementation in `src/engine/drift.ts` keeps the tool and the
script from disagreeing.

## Wiring it to fire automatically

MCP is pull-only: a tool sits there until the model calls it. Automatic
behaviour has to come from the harness.

- **Soft** — a line in the plugin skill: regenerate the affected diagram after
  changing module structure. Usually works, not guaranteed.
- **Hard** — a Claude Code `PostToolUse` hook matching `Edit|Write` runs
  `check-drift.mjs`. The harness executes it whether or not the model
  remembered. Output lands in context, and regeneration follows from there.
- **Hardest** — pre-commit or CI, catching drift introduced without Claude.

Confirm the exact hook event name and config schema against current Claude Code
docs before writing `settings.json`; a wrong key fails silently, which is worse
than not having the hook.

**Debounce.** Firing on every `Edit` is noisy and slow. Only run when the edit
touched a file some node's `ref` points at, or batch on `Stop` instead of
per-edit.

## Open questions

- Should drift auto-regenerate, or only report? Leaning **report only**: silent
  redrawing while someone is reading the board is hostile, and regeneration
  discards layout intent.
- What is the relevance threshold for "unrepresented"? Without one, every new
  file is drift.
- Should `ref` support globs (`src/engine/*`) so one node can stand for a
  subsystem? Probably yes, and it makes (2) far more useful.
- How does this interact with hand-drawn nodes? Current answer: ignore them
  entirely. Revisit if that proves too conservative.

## Rough order of work

1. `src/engine/drift.ts` with the missing-ref check only.
2. `ref` on the `create_diagram` node schema, threaded through `customData`.
3. `check_drift` MCP tool and `scripts/check-drift.mjs`.
4. Tests: a board whose refs all exist is clean; deleting a referenced file
   reports exactly one missing node; hand-drawn nodes never appear as drift.
5. Only then: unrepresented modules and edge mismatches, each behind its own
   flag so a noisy check can be turned off without losing the useful one.
