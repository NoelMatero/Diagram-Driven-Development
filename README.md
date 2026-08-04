<p align="center">
  <img src="assets/wiley-logo.svg" alt="Wiley" width="380" />
</p>

<p align="center">
  <b>Diagram-driven development.</b><br/>
  Diagrams live in your repo. Claude draws them, reads them back, and writes code from them.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/protocol-MCP-4C6EF5" alt="MCP" />
  <img src="https://img.shields.io/badge/canvas-Excalidraw-2F9E44" alt="canvas" />
  <img src="https://img.shields.io/badge/layout-ELK-E8590C" alt="layout" />
</p>

---

A diagram is usually a screenshot in a wiki that stopped being true six months ago. This makes it a file in the repo instead — `docs/diagrams/architecture.excalidraw`, next to the code it describes, diffable in git, openable in any Excalidraw editor.

Claude gets that file as a first-class artifact. It can draw a diagram, read one back as a graph, edit it, and treat what you sketched as the specification for what it builds. You can open the same file in a live local page and draw on it at the same time.

<p align="center">
  <img src="assets/board.png" alt="A board holding a generated architecture diagram, a hand-drawn wireframe with its labels filled in, and a screenshot placed beside it" width="920" />
</p>

## How it works

**Files are the source of truth.** Every tool is a read-modify-write on a `.excalidraw` file. Nothing lives in a session, so a diagram outlives the conversation that produced it.

**You supply meaning, never coordinates.** `create_diagram` takes nodes and edges; ELK decides the geometry, and node sizes come from real Excalifont metrics via `fontkit`, so a label never overflows the box drawn for it.

**Output is deterministic.** Element ids and seeds are derived by hashing stable ids, so regenerating an unchanged diagram produces a byte-identical file. Diagrams diff usefully instead of churning every line.

**Your drawings are never redrawn.** Generated elements carry a `customData` marker; anything without one is yours. Regeneration replaces only what it made before, and `read_diagram` labels every fact `recorded` (drawn by a tool, exact) or `inferred` (hand-drawn, derived from geometry), so a caller knows what to trust.

## Install

It is a Claude Code plugin. From inside Claude Code:

```
/plugin marketplace add NoelMatero/Diagram-Driven-Development
/plugin install board@diagram-driven-development
```

That brings the ten board tools and a `diagram` skill. Diagrams are written into
whichever project you are working in, never into the plugin's own directory.

The server itself comes from npm (`npx -y board-ai`), which npm fetches once and
caches — the first session after installing takes a few seconds longer to
connect. Exporting a PNG additionally needs a headless browser; `render_diagram`
prints the one command to install it the first time you ask for one. Nothing else
does.

Then just ask: *"Draw how this project works to docs/diagrams/architecture.excalidraw and open the board."*

## Working on the plugin itself

```bash
npm install    # builds the headless Excalidraw bundle and the viewer
npm test
```

Working inside this repo needs no install: the `.mcp.json` here registers the
server for this project, so edits to `src/` take effect on the next reconnect.

To exercise the plugin from *another* project without waiting on a release, link
it into a skills directory — it loads in place rather than being copied:

```bash
ln -s "$PWD" ~/.claude/skills/board    # loads as board@skills-dir
```

A marketplace install copies into a version-pinned cache instead, so bump
`version` in `.claude-plugin/plugin.json` to ship an update; without a bump,
existing users stay on the version they have.

### Releasing

Three things move together, and a release is broken if they disagree: `version`
in `package.json`, `version` in `.claude-plugin/plugin.json`, and the pinned
`board-ai@x.y.z` that plugin's `mcpServers` command runs.

```bash
npm version patch                      # or minor / major
# match the new version in .claude-plugin/plugin.json: "version" and the npx arg
npm publish                            # `prepare` builds the bundles and viewer first
git push --follow-tags
```

The pin is deliberate. A plugin install is cached by version, so an unpinned
`npx -y board-ai` would hand an old plugin a newer server on some future morning
with nothing in the release notes to explain it.

## Tools

| Tool | What it does |
| --- | --- |
| `create_diagram` | Lay out nodes and edges into a file. Replaces what it generated before. |
| `read_diagram` | Read a board back as a graph, with provenance on every fact. |
| `edit_diagram` | Patch or delete elements by id, hand-drawn ones included. |
| `delete_diagram` | Remove a named diagram, keeping hand-drawn work. |
| `check_drift` | Report nodes pointing at code that no longer exists. |
| `connect_nodes` | Draw bound arrows between existing shapes, including ones you drew. |
| `render_diagram` | Rasterise to PNG, so the model can look at what it made. |
| `place_image` | Put an image on the board, beside the diagram that specified it. |
| `open_board` / `board_status` | Start the live page, or ask whether one is running. |
| `new_board` | Empty a board and start over. |

Every path is confined to the workspace root: symlinks are resolved, and a path that escapes is refused.

## The live board

```bash
npm run board docs/diagrams/architecture.excalidraw
```

A local page on `127.0.0.1:4747` showing the file. Anything that writes it — a tool, your editor, `git checkout` — appears immediately over SSE, and anything you draw is written straight back. Both sides edit one artifact.

Conflicts resolve in your favour. A save carrying a stale revision is refused with the current board attached, so an agent write cannot discard a stroke you just made.

**Several diagrams at once.** One server serves them all; the page says which board it wants:

```
127.0.0.1:4747/?file=docs/diagrams/ims.excalidraw
127.0.0.1:4747/?file=docs/diagrams/volte.excalidraw
```

Open two and they stay put — writing one diagram, or asking Claude to open a third, never drags a page onto a different file. That is what makes splitting a large system across diagrams workable rather than a constant flick between them. `open_board` returns the pinned URL for whatever it opened, and `board_status` lists every open board with its own address.

The bare `127.0.0.1:4747` behaves as it always has: it follows whichever board was opened or written last, which is what you want when you are working on one diagram and letting Claude drive.

## Development

```bash
npm test               # unit tests, plus the MCP server over a real stdio transport
npm run typecheck
npm run test:e2e:board # real Chromium: file to canvas and back
npm run diagram:render docs/diagrams/example.excalidraw out.png
```

The end-to-end board test asserts against the scene the viewer actually rendered rather than the HTTP response — a weak assertion there is what previously let a sync bug hide.

## Layout of the code

```
src/engine/   diagrams as data: layout, conversion, determinism, fonts, rendering
src/mcp/      the MCP server and its path confinement
src/server/   the live board: HTTP, SSE, file watching, conflict handling
src/viewer/   the browser page and the sync loop behind it
```

## Keeping a diagram honest

A node can record what it stands for — `ref: "src/engine/layout.ts"`, or
`path#symbol` — and `check_drift` compares those claims against the working tree:

```bash
npm run check:drift                    # every board in docs/diagrams
npm run check:drift docs/diagrams/architecture.excalidraw
```

Silent when nothing has drifted, exit 1 with a report when a node points at a
file or symbol that is gone — which is what CI and pre-commit want.

When something has drifted, `/update-diagram` redraws it: Claude re-runs the check,
repoints the boxes whose code moved, removes the ones whose code is gone, and
tells you which was which. It asks rather than guesses about hand-drawn boxes,
whose refs were inferred from their labels.

Nothing is fixed automatically. The check reports and stops there, because a
diagram silently rewritten every turn is worse than one you know is stale —
regeneration lays the generated part out fresh, so a board someone arranged by
hand comes back arranged by the engine.

`.claude/settings.json` here also runs it at the end of every turn. To do the
same in your own project, add this to its `.claude/settings.json`:

```json
{ "hooks": { "Stop": [{ "matcher": "*", "hooks": [
  { "type": "command", "command": "npx -y -p board-ai@0.1.0 board-drift --hook" }
] }] } }
```

`--hook` is optional now: the script recognises hook input on stdin and switches by
itself. Either way a stale diagram arrives as an ordinary notice, four lines, with
the counts in red and amber:

```
┌─ board-internals.excalidraw  2 gone  1 arrow ─┐
│ Old Cache → src/cache.ts                      │
│ Legacy sync → src/sync/legacy.ts              │
│ Contrast → Staggered reveal                   │
└─ /update-diagram updates the diagram ─────────┘
```

Several stale diagrams get a line each with their own counts instead. Without the
notice channel the report still appears, but wrapped in
`Stop hook error: Failed with non-blocking status code`, which reads as a broken
tool rather than a finding. Leave the flag off anywhere an exit code is the point —
CI, a pre-commit hook — where a non-zero exit is exactly what you want, and where
the output stays plain because escapes in a log are noise.

Point it at a clone instead (`npx tsx /abs/path/to/board/scripts/check-drift.mjs
--hook`) if you are working on this repo; either way the path cannot use
`${CLAUDE_PLUGIN_ROOT}`, which is only substituted in configuration the plugin
itself provides, not in yours. The plugin does not install this hook for you
either, because a project with no diagrams should not pay for a subprocess on
every turn.

Deliberately shallow: existence only, no import graph, no model. Nodes without a
`ref` are skipped rather than guessed at and hand-drawn boxes are ignored
entirely, so a clean report means nothing checkable disagreed — not that the
diagram is correct. Remaining design, including edge mismatches, in
[docs/drift-check.md](docs/drift-check.md).
