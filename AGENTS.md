# Board AI agent instructions

This repository is a diagram-driven-development toolkit: an MCP server that gives
a coding agent read/write access to `.excalidraw` files that live in the repo,
plus a live local board for editing them alongside a human.

## Ground rules

- **The file is the source of truth.** Every operation is a read-modify-write on a
  `.excalidraw` file. Never hold diagram state in memory across a session.
- **Never destroy hand-drawn work.** Elements without a `customData` marker were
  drawn by a human. Regeneration replaces only what the engine generated; a
  sketch is a specification, not a draft to be redrawn.
- **Supply meaning, not geometry.** Callers pass nodes and edges. Layout, sizing,
  connector routing, and bindings are the engine's job. If a diagram needs manual
  coordinates, the layout has a bug worth fixing instead.
- **Keep output deterministic.** Ids and seeds are hashed from stable ids so an
  unchanged diagram regenerates byte-identically. Anything introducing randomness
  or timestamps into a board file breaks git diffs and the tests that guard them.
- **Confine every path.** Tool inputs resolve through `src/mcp/paths.ts`, which
  refuses anything outside the workspace root, symlinks included.

## Working on this repo

- Report provenance honestly: `readGraph` marks each fact `recorded` or
  `inferred`, and callers depend on that distinction. Never present a geometric
  guess as a recorded fact.
- Prefer reproducing a bug over reasoning about it. Both wrong diagnoses in this
  codebase's history came from theorising; the fixes came from a probe or a test.
- Assertions should check the thing a user sees. The board sync bug hid behind a
  test that asserted on an HTTP response instead of the rendered canvas.
- A tool that cannot report its own state forces the caller to guess. When a
  failure comes from an agent misusing a tool, first ask whether the tool made
  the truth observable.
