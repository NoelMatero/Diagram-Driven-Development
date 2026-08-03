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

## Tools

| Tool | What it does |
| --- | --- |
| `create_diagram` | Lay out nodes and edges into a file. Replaces what it generated before. |
| `read_diagram` | Read a board back as a graph, with provenance on every fact. |
| `edit_diagram` | Patch or delete elements by id, hand-drawn ones included. |
| `delete_diagram` | Remove a named diagram, keeping hand-drawn work. |
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

Planned: drift detection, so a diagram that no longer matches the code says so. Design in [docs/drift-check.md](docs/drift-check.md).
