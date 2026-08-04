---
name: diagram
description: Draw, read, or update an Excalidraw diagram in this repo — architecture, flows, data models, sequence overviews. Use when the user asks for a diagram or asks about one that already exists, and when a hand-drawn sketch should drive what gets built.
---

# Diagrams that live in the repo

Diagrams are `.excalidraw` files next to the code they describe. They are the
artifact, not a picture of one: they diff in git, open in any Excalidraw editor,
and are read back as a graph so a sketch can act as a specification.

## Draw it, don't lecture about it

The diagram is the deliverable. After writing one, say what changed in **a
sentence or two** and stop.

Do not follow a diagram with an essay explaining the domain it depicts. If the
user wants the concepts explained they will ask, and a diagram they can look at
is the reason they asked for a diagram. A paragraph per node is the single
largest cost of a diagram task and almost never what was wanted.

Worth mentioning after a write: anything you inferred rather than were told,
anything you left out, and the live URL if you started a board. Nothing else.

## Path

Default to `docs/diagrams/<topic>.excalidraw` unless the user names somewhere
else. One diagram per file — `create_diagram` replaces what it generated last
time, which is how you update a board.

## Give meaning, never geometry

`create_diagram` takes nodes and edges. Layout, node sizing, connector routing,
arrow binding and label contrast are all decided by the engine using real font
metrics. Passing coordinates is not possible and not wanted; if a layout comes
out wrong, that is a bug worth reporting, not something to hand-place around.

Pass all edges to `create_diagram` in one call. `connect_nodes` draws straight
arrows between existing shapes and does not re-run layout, so using it to build a
graph incrementally produces connectors that cut across boxes. It is for joining
things that already exist — especially shapes the user drew.

Colour carries meaning cheaply: give each subsystem its own `backgroundColor`,
and set `strokeColor` on edges in the same call rather than patching arrows
afterwards, since the next regenerate would revert a patch.

Keep edge labels to one or two words. `direction: "DOWN"` suits a sequence or a
pipeline; the default `RIGHT` suits most architecture.

## Point nodes at the code they stand for

When a node is a real file or module in this repo, set `ref` on it:
`ref: "src/engine/layout.ts"`, or `path#symbol` for a single function. That is
what lets `check_drift` say later that a diagram has gone stale.

Only for things that exist in the repository. A diagram of a protocol, a vendor
system, or anything you are sketching out has nothing to point at, and inventing
a path there is worse than leaving it off.

Run `check_drift` after changing module structure, and regenerate the diagram it
complains about. A clean report with `checked: 0` means no node had a ref, not
that the diagram is right.

## Check your work once

`render_diagram` returns an image you can actually look at — use it to catch
overlap, crowding, or an unreadable label. Once, after the diagram is finished.
Rendering after every tweak costs an image each time and rarely changes anything.

## Reading, and honouring, what is already there

`read_diagram` marks every fact `recorded` (drawn by a tool, exact) or `inferred`
(hand-drawn, derived from geometry). Keep that distinction when you report:
an inferred label is a guess about someone's sketch.

Never redraw a user's drawing. Their rectangles, their arrows, their handwriting
are the spec. Label them, connect to them, build from them — `create_diagram`
preserves them automatically, and `connect_nodes` and `edit_diagram` both accept
hand-drawn elements by id.

By default `read_diagram` omits positions and sizes. Ask for `geometry: true`
when you need to fix layout, and `includeElements: true` only when you need to
address individual elements in `edit_diagram`.

## The live board

`open_board` starts a local page that follows the file: your writes appear as the
diagram being drawn, and anything the user draws is saved back. Offer it when
someone wants to watch or join in.

Each board gets its own URL, served by one local server. Opening a second diagram
leaves the first page where it is, so a project split across several diagrams can
have them open side by side — call `open_board` once per diagram and give the user
both addresses rather than one that changes under them.

`board_status` says what is running: every open board with its own URL, and which
one the bare address is currently following. Never give the user a localhost URL
you did not get back from one of those two tools in this session — an address that
answers nothing is worse than none.

## Model choice

The model's job here is to emit a node and edge list; the engine does the
drawing. This does not need a frontier model. If the user is on one and mentions
cost or speed, saying so is more useful than optimising the prompt.
