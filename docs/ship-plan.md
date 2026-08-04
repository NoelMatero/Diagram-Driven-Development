# Shipping plan and handoff

Written to survive a fresh session. Everything below was measured in this repo,
not assumed; where something is unverified it says so. If a claim here disagrees
with the code, trust the code and fix this file.

Read this top to bottom once, then work the phases in order. Phase 1 blocks
everything: until a clean clone builds, no packaging work can be tested.

## What this project is

A Claude Code plugin plus MCP server for diagram-driven development. Excalidraw
diagrams live in the repo as `.excalidraw` files; Claude draws them, reads them
back as a graph, and can treat a hand-drawn sketch as a specification. An
optional live local page shows a board and syncs both ways while you draw on it.

Design decisions already settled, do not relitigate:

- **Files are the source of truth.** Every tool is a read-modify-write on a file.
- **One diagram per file.** `create_diagram` replaces what it generated before.
- **The caller supplies meaning, never coordinates.** ELK does layout, node sizes
  come from real Excalifont metrics via `fontkit`.
- **Output is deterministic.** Ids and seeds are hashed from stable ids, so an
  unchanged diagram regenerates byte-identically.
- **Hand-drawn elements are never redrawn.** Generated elements carry
  `customData`; anything without it belongs to the user. `read_diagram` marks
  every fact `recorded` (exact) or `inferred` (derived from geometry).
- **Drift detection reports, never auto-fixes** — see phase 4, which adds an
  opt-in to that, not a change of default.

Code layout:

```
src/engine/   diagrams as data: layout, conversion, determinism, fonts, drift, rendering
src/mcp/      the MCP server (11 tools) and its path confinement
src/server/   the live board: HTTP, SSE, file watching, conflict handling
src/viewer/   the browser page and the sync loop behind it
```

## Current state

Branch `new-version`. **Uncommitted** — commit before touching anything
(phase 0):

```
 M README.md docs/drift-check.md package.json skills/diagram/SKILL.md
 M src/engine/diagram.ts src/engine/graph.ts src/engine/layout.ts
 M src/mcp/server.ts tests/mcp-server.test.ts
?? .claude/ docs/diagrams/board-internals.excalidraw docs/ship-plan.md
?? scripts/check-drift.mjs src/engine/drift.ts tests/engine-drift.test.ts
```

Green as of writing: `npx vitest run` 117 passing, `npx tsc --noEmit` clean,
`npm run test:e2e:board` all checks pass, `claude plugin validate . --strict`
passes.

## Measured facts — do not re-derive these

**A clean clone cannot build.** `.gitignore` line 14 is `vendor/`, which matches
*any* directory named vendor at any depth, including `src/engine/vendor/`. That
directory holds three hand-written source files the build needs
(`entry.ts`, `browser-entry.ts`, `browser-shim.ts`) and none of them is committed.
Reproduce:

```bash
git clone --no-hardlinks . /tmp/shiptest && cd /tmp/shiptest && npm install
# npm error command sh -c node scripts/build-vendor.mjs && npm run build:viewer
```

**A marketplace-installed plugin has no dependencies and no build output.**
Installing copies files into a version-pinned cache and never runs `npm install`.
Measured by copying only tracked files and starting the server:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'`. Also missing: the
~13 MB vendored Excalidraw bundle (so nothing can be drawn) and `out/viewer`
(so the live board serves nothing).

**`${CLAUDE_PLUGIN_ROOT}` is only substituted in configuration the plugin itself
ships**, not in a user's own `settings.json`. Putting it in `.mcp.json` here once
broke a working project-scoped server; `.mcp.json` deliberately uses a relative
path and the plugin config lives inline in `.claude-plugin/plugin.json`. Both were
tested loading side by side without colliding.

**Stop hook output channels**, measured on a real hook:

| Script behaviour | What the user sees |
| --- | --- |
| stderr, exit 1 | `Stop hook error: Failed with non-blocking status code:` then the report |
| stdout, exit 0 | nothing at all |

So exit 1 is the only usable channel despite the misleading prefix. The report
wording carries the framing the wrapper strips. Do not "fix" this by exiting 0 —
that was tried and the feature went silent.

**Stop hook config shape.** The published docs say `Stop` ignores matchers; the
`plugin-dev` validator rejects a hook without one. `"matcher": "*"` satisfies
both. The nested `{ matcher, hooks: [...] }` form is what shipped plugins use.
Validate with:
`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/hook-development/scripts/validate-hook-schema.sh`

**Do not add `hooks/hooks.json` at the plugin root.** It is auto-discovered, so
shipping one spawns a subprocess on every turn in every project someone installs
this into, most of which have no diagrams. The hook is documented as opt-in in
the README instead, and lives in this repo's `.claude/settings.json` for
dogfooding.

**Session restarts.** `.claude/settings.json` and MCP tool changes only load at
session start. A test that "does nothing" is usually a stale session.

## Phase 0 — commit what is there

Suggested split, oldest work first:

1. Staggered reveal in the viewer (`src/viewer/reveal.ts`, `App.tsx`,
   `tests/viewer-reveal.test.ts`, e2e additions).
2. Tool-output cost reductions (`src/mcp/server.ts` compact JSON, projected
   elements, `geometry` flag, render scale default).
3. Plugin manifest, marketplace manifest and the `diagram` skill.
4. Drift detection (`src/engine/drift.ts`, `check_drift`,
   `scripts/check-drift.mjs`, `.claude/settings.json`, tests, docs,
   `docs/diagrams/board-internals.excalidraw`).

## Phase 1 — make the repo buildable (blocks everything)

1. Change `.gitignore` line 14 from `vendor/` to `/vendor/` so it only matches the
   top-level build output, not `src/engine/vendor/`.
2. `git add -f src/engine/vendor/entry.ts src/engine/vendor/browser-entry.ts
   src/engine/vendor/browser-shim.ts` and confirm nothing else in that directory
   is generated output that should stay ignored (check `scripts/build-vendor.mjs`
   for what it writes, and ignore only that).
3. Verify by cloning again into a temp dir and running `npm install && npm test`.
   Do not declare this done without a clone that builds from scratch.
4. Add a CI workflow running `npm ci`, `npm run typecheck`, `npm test` on push.
   This exact class of bug is what CI exists to catch.

Acceptance: a fresh clone installs, builds, and passes tests with no files
copied by hand.

## Phase 2 — make the plugin work when installed

**Decided: publish to npm.** The plugin's `mcpServers` command is
`npx -y board-ai@<version>`, pinned to the plugin version so a version-cached
plugin install cannot pick up a newer server. Rejected: committing ~51 MB of
build output per rebuild into git, and bootstrapping dependencies on first run
(silent, slow, offline-hostile).

The published package is JS, not TypeScript: `scripts/build-cli.mjs` bundles
`src/mcp/server.ts` and `scripts/check-drift.mjs` into `out/cli/` with
dependencies left external. `prepare` (not `postinstall`) builds, so a consumer
installing the tarball never runs a build it has no tools for.

**Measured while doing this — do not re-derive:**

- **Bundling changes how three modules find their assets.** `convert.ts`,
  `render.ts` and `board-server.ts` each resolve `../..` from their own file to
  reach `vendor/` and `out/viewer`. A bundle collapses all three onto one file, so
  the output's *depth* is that calculation. `out/cli/` is two levels down for
  exactly this reason and `build-cli.mjs` asserts it. Moving it breaks rendering
  and the live board at runtime, silently.
- **`elkjs/lib/elk.bundled` had no file extension.** tsx and vite guess it; plain
  Node ESM does not, so only the built server failed —
  `ERR_MODULE_NOT_FOUND`. Now `.js`. Any other extensionless deep import will
  behave the same way.
- **Two runtime dependencies were declared dev-only**: `fontkit`
  (`src/engine/diagram.ts` → `font.ts`, every `create_diagram`) and Playwright.
  A published package would have failed on both — and the fontkit path fails
  *silently*, substituting `length × fontSize × 0.55` and sizing every box wrong.
- **`@excalidraw/excalidraw` cannot be a runtime dependency.** With it in
  `dependencies`, `npm install <tarball>` of this package does not converge: its
  own dependency list pins UI packages whose React peer ranges stop at 18 while it
  accepts 19, and npm oscillates. Measured twice — 703 re-placements of React in
  27 minutes, then 2079 in 7 minutes after moving React itself to
  devDependencies. It is a devDependency now and the install takes **3 seconds**.
  Do not put it back to "fix" a path problem; fix the path.
- **All it was needed for at runtime is font files, and those already ship.** A
  render was traced requesting exactly two paths: `/excalidraw-browser.js` and one
  file under `/fonts/`. No chunks, no locales, no subset workers. `out/viewer/fonts`
  is already published for the live board, so `src/engine/excalidraw-assets.ts`
  points both the metrics path and the render origin at it — zero added bytes.
  Verified by a render before and after: 261 KB PNG either way.
- **npm hoists dependencies to a sibling of the installed package**, so any
  `ROOT/node_modules/<dep>` path is wrong in an install. That was the first
  attempt at the above and it worked, but it kept the dependency; prefer not
  needing the package at all.
- **Playwright ships as `playwright-core`** (no browser download) and
  `render_diagram` asks for Chromium at the point of use. Full `playwright` as a
  dependency would download ~150 MB before the server could start, which reads as
  a hang and can time out the MCP handshake. The install command must be
  version-pinned: playwright-core only runs the browser revision it was built
  against.
- **`files` in package.json beats `.gitignore`** — `out/` and `vendor/` are
  gitignored and still ship. Verified with `npm pack --dry-run`: 441 files,
  23.2 MB packed, 53.4 MB unpacked.
- **`tests/packaged-server.test.ts` drives the built bundle**, because every
  failure above is invisible to a test that runs from source.

**Run so far.** `npm pack` then `npm install <tarball>` into an empty project
unrelated to this repo (never a symlink — a symlink borrows this repo's
`node_modules` and passes misleadingly), then driving the installed
`node_modules/.bin/board-ai` over stdio. 9/9: server starts and lists 11 tools,
`create_diagram` writes a file, `read_diagram` returns the graph, `check_drift`
catches a box pointing at a deleted file, `render_diagram` returns a real 30 KB
PNG, `open_board` serves the viewer page *and* its built bundle over HTTP,
`board_status` sees the running board. The missing-Chromium path was checked
separately with `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty directory: it
prints the version-pinned install command instead of failing.

**Still unverified, and the last link in the chain**: installing through
`/plugin marketplace add` in Claude Code, i.e. that the plugin manifest registers
the server and `${CLAUDE_PROJECT_DIR}` reaches it as `BOARD_MCP_ROOT`. Cannot be
tested end to end until `board-ai` is on npm, because the manifest pins
`npx -y board-ai@0.1.0`. Use a throwaway `CLAUDE_CONFIG_DIR` when doing it, and
verify afterwards that the real config was untouched.

**Publishing is the user's to run** — the account is theirs and `npm whoami`
reports nobody logged in:

```bash
npm login
npm publish        # `prepare` builds vendor, viewer and out/cli first
```

## Phase 3 — optional auto-fix after drift

The user wants the *option* for Claude to update a diagram once drift is
reported. Report-only stays the default.

Mechanism: exit **2** instead of 1. Per the docs, exit 2 on `Stop` blocks the turn
from ending and feeds stderr to the model, which is exactly "go fix the diagram".
Implement as a flag on `scripts/check-drift.mjs` so the user chooses.

Two things to get right:

- **Loop protection.** If the model cannot fix it, exit 2 could block forever.
  Claude Code passes `stop_hook_active` in the hook's stdin JSON for this; read it
  and exit 0 when it is set. Verify this empirically — do not trust the docs
  alone, they have already been wrong once in this project about matchers and
  about stdout visibility.
- **Regeneration discards layout intent.** Redrawing is not free: it replaces
  what was generated before. Say so in the flag's documentation.

## Phase 4 — the arrow check (drift, part two)

Design constraint that matters more than the feature: **detection stays
mechanical, the model is only involved in fixing.** Asking a model "does this
diagram match the code?" costs tokens per turn, gives a different answer each
time, and cannot run on every turn. Static checks cost nothing and are
repeatable.

The next useful check: the diagram draws A → B, so parse the imports of A's file
and see whether B's file is among them. Milliseconds, zero tokens.

Constraints, all of which were reasons to defer it:

- Language specific. Missing-file checks are language-agnostic; import parsing is
  TypeScript/JavaScript only.
- Genuine false positives: A may reach B by event, injection or dynamic import
  with no import statement anywhere. Report those as "worth a look", not "wrong",
  or the check becomes the one that cries wolf and gets switched off — which
  costs the quiet, correct check too.
- Put it behind its own flag so a noisy check can be disabled without losing
  missing-file detection.

Also still design-only: "unrepresented" modules — a real folder no box mentions.
Needs a relevance threshold or every new file is drift. See
`docs/drift-check.md` for the full reasoning and open questions.

## Phase 5 — viewer status pill bug — DONE

Reported: after the live page is pointed at a different board, the pill in the
bottom-right still shows the previous filename and reads `offline`, and it sits on
top of Excalidraw's help button.

**Reproduced in Chromium first, and the suspect named here was innocent.** For the
record, because this plan previously pointed at it: the `sync.ts` guard that
refuses to save a scene sharing no element ids ("That looks like a different
file") is *not* involved. Measured behaviour of the unfixed code:

| Scenario | Pill showed | Verdict |
| --- | --- | --- |
| Switch to a different board | new name, `live` | already correct |
| Server killed, replaced on the same port with another board | new name, `live` | already correct |
| Switch to a board holding *identical* content | **old** name, `live` | bug |
| Connection lost | old name, `offline` | bug — the reported one |

So "does the browser page follow a switch?" is now answered: yes, and the
recovery path after a server restart works too. Two real defects, both fixed:

- **Identical content, different file.** The revision is a hash of the content,
  so the frame announcing the switch looked like an echo of the page's own save
  and the pull was skipped. `BoardSync` now tracks the served file alongside the
  revision and pulls when *either* changes.
- **A filename presented as fact while disconnected.** The server may have been
  re-pointed or replaced and the page cannot know, so the name now renders dimmed
  and italic with a tooltip saying so. This is the reported symptom: the user's
  page was attached to a server that went away.

The pill moved to `bottom: 62px`. The old position measurably overlapped both the
help button and the zen-mode exit (pill 1096–1266 × 759–786, help 1228–1264 ×
748–784 at a 1280×800 viewport).

Three checks added to `npm run test:e2e:board`, all of which fail without the
change: follows a switch to identical content, marks the filename stale once
disconnected, does not cover Excalidraw's own controls.

## How to verify anything in this project

```bash
npx vitest run                 # unit tests + MCP server over a real stdio transport
npx tsc --noEmit
npm run test:e2e:board         # real Chromium: file to canvas and back
npm run check:drift            # silent when nothing has drifted
claude plugin validate . --strict
npm run board docs/diagrams/board-internals.excalidraw   # live page
npm run diagram:render <board> out.png                   # look at a diagram
```

## Working habits that paid off here, and one that did not

- **Reproduce or measure; do not theorise.** Probing a real board found a
  miscount that reasoning had missed. A screenshot found a reveal glitch the unit
  tests passed. An empirical test settled a plugin-config question the docs left
  open. A clone found the build bug that reading `.gitignore` had not.
- **Never claim a thing works because the code looks right.** Two claims in this
  project were wrong that way: that `.mcp.json` could safely use
  `${CLAUDE_PLUGIN_ROOT}` (it broke a working setup), and that board switching
  works end to end (only the server half was checked).
- **Report honestly what was actually examined.** `clean: true, checked: 0` is
  not a pass, which is why `check_drift` says so outright.
- **The user vibecoded this and does not read the code.** Explain in plain words,
  keep it short, and use a two-or-three-option question when a decision is
  genuinely theirs. Dense technical prose aimed at someone who knows the codebase
  is wasted on them; keep that reasoning in comments and docs like this one.
