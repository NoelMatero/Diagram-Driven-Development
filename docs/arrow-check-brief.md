# Brief: the arrow check

A design problem, handed over deliberately unsolved. Everything below was measured
in this repo on 2026-08-04; where something is opinion it says so. If a claim here
disagrees with the code, trust the code and fix this file.

**Status: solved and shipped, same day.** The measurements that decided it are in
"The rule that shipped" near the end; the original brief is kept intact above it,
with corrections marked where a claim measured false.

## The problem in one sentence

A diagram says `A → B`. Is there a mechanical check that can tell when that arrow
has stopped being true, without crying wolf?

## What is already settled — please do not relitigate

- **Detection stays mechanical, and the model is only involved in fixing.** Asking
  a model "does this diagram match the code?" costs tokens on every turn, answers
  differently each time, and cannot run constantly. Static checks cost nothing and
  are repeatable. This is the constraint that shapes everything else.
- **Reports, never auto-fixes.** Fixing is the `/fix-drift` command, invoked by a
  human who decided it was worth it. See `docs/drift-check.md` for why the
  automatic version was designed and rejected.
- **Silence when clean is the whole design.** This runs on every turn via a `Stop`
  hook. A check that announces good news thirty times an hour gets switched off —
  and switching it off costs the quiet, correct missing-file check too. That
  shared fate is the real risk of a noisy arrow check, not the noise itself.

## What exists today

`src/engine/drift.ts`, surfaced three ways: the `check_drift` MCP tool,
`scripts/check-drift.mjs` (the hook and CLI), and `/fix-drift` (`commands/`).

A node can carry a `ref`: `src/engine/layout.ts`, or `path#symbol`. Refs are
`recorded` when a tool drew the node, or `inferred` when the ref was guessed from a
hand-drawn label — an inferred ref is a guess about someone's sketch and is treated
more gently. Three findings exist: `missing-file`, `missing-symbol`,
`unresolvable-ref` — and now a fourth, `unsupported-edge`, from the rule this brief
asked for. It sits behind its own switch (`--no-edges`) so it can be turned off
without losing the quiet missing-file check.

Everything reaches the filesystem through the `Workspace` abstraction in
`drift.ts` (`resolve` / `stat` / `read`), which confines paths to the root and
re-checks after `realpath`. Refs are model-authored strings that become filesystem
reads, so a new check must go through it rather than touching `fs` directly.

Tests: `tests/engine-drift.test.ts` (engine), `tests/check-drift-cli.test.ts`
(the CLI surface).

## The corpus, measured

This matters more than any argument, because it is all the material a rule has:

| Diagram | nodes | with a ref | edges | edges with refs at both ends |
| --- | --- | --- | --- | --- |
| architecture | 16 | 0 | 21 | 0 |
| auth | 33 | 0 | 46 | 0 |
| **board-internals** | **12** | **12** | **14** | **14** |
| example | 5 | 0 | 5 | 0 |
| ims-volte | 18 | 0 | 25 | 0 |
| ims | 19 | 0 | 25 | 0 |
| ims_2 | 14 | 0 | 17 | 0 |

One diagram out of seven is checkable at all. The telecom ones have no refs *by
design*: they describe a protocol, not this repository, and inventing paths for
them would be worse than leaving refs off. So an arrow check applies to
`board-internals.excalidraw` and to future diagrams of this codebase — a small
corpus, which is an argument for a rule that is quiet rather than clever.

## The obvious rule, measured — it does not work

"Parse the imports of A's file; flag the arrow if B's file is not among them."
Run over the 14 edges (12 checkable, 2 with a directory on one end):

```
FLAG  src/engine/layout.ts      -> src/engine/convert.ts
FLAG  src/engine/convert.ts     -> src/engine/board-file.ts
FLAG  src/server/board-server.ts-> src/viewer/App.tsx
FLAG  src/viewer/App.tsx        -> src/server/board-server.ts
SKIP  src/engine/board-file.ts  -> docs/diagrams        (directory, not a module)
SKIP  src/server/board-server.ts-> docs/diagrams        (directory, not a module)

12 checkable, 4 flagged, 0 true positives.
```

**Every one of those four arrows is correct.** They fail the rule because the
arrow does not mean "imports":

- `layout → convert` — a pipeline stage. `diagram.ts` orchestrates both; neither
  imports the other.
- `convert → board-file` — data flow. Converted elements end up written to the
  file, through a caller.
- `board-server → App.tsx` — the server *serves* the built viewer. It could not
  import it: the viewer is a separate vite build.
- `App.tsx → board-server` — the page talks to the server over HTTP and SSE.
  There is no import in either direction, and there never will be.

So on the only real corpus the naive rule is not merely noisy — it is 100% noise.
That is the bar to beat, and it is a low one.

## What the measurement suggests, without prescribing an answer

Arrows in this repo's own diagram mean *data flows to*, *serves*, *talks to*, and
*is orchestrated into* at least as often as they mean *imports*. A check assuming
one relation will mostly be wrong about the others. Some directions worth weighing —
each now carries what it measured on 2026-08-04:

- **Classify edges rather than checking all of them.** If an edge could declare its
  kind (`imports`, `calls`, `serves`, `writes`, `over-http`), only the statically
  checkable kinds get checked and the rest are skipped honestly. Cost: something
  has to set that, and a model setting it re-imports the nondeterminism the
  mechanical rule exists to avoid. *Not measured — the shipped rule reached zero
  false positives without it, so the cost was never paid.*
- **Invert the question.** Instead of validating drawn arrows, look for *missing*
  ones: A imports B, both are on the diagram, no edge between them. A missing edge
  is a fact about the code, not an interpretation of an arrow. *Measured: nine
  flags on the correct diagram — every one a real import the diagram deliberately
  abstracts away. Worse than the naive rule's four. Rejected.*
- **Widen the relation beyond imports.** A mentions B's path in a string, spawns
  it, fetches its route. *Measured: path mentions caught none of the four — the
  earlier claim here that they "would have caught two" was wrong. The route half
  of the idea is what worked, one import hop out: App.tsx's fetches live in
  `src/viewer/sync.ts`, whose `/api/board` and `/api/events` literals match
  board-server.ts's. Bare path mentions also whitewash — drift.ts's own docstring
  example `ref: "src/engine/layout.ts"` would quietly bless a fabricated
  drift → layout arrow — so they were dropped and route strings kept.*
- **Report reachability, not adjacency.** `layout → convert` is true transitively
  through `diagram.ts`. A path-exists check over the import graph flags less.
  *Measured: flags exactly the same four edges as the naive rule. There is no
  directed path layout ⇝ convert — `diagram.ts` imports both, which makes it a
  shared importer, not a step on a path. That different relation is what shipped;
  reachability itself bought nothing. Rejected.*

## How to evaluate whatever you design — measure, do not argue

1. Run it over `docs/diagrams/board-internals.excalidraw`. Every flag is a false
   positive unless you can show the arrow is genuinely wrong. The naive rule scores
   4; anything that does not beat that is not worth shipping.
2. Construct a true positive: change the code or the diagram so an arrow really is
   false, and confirm it is caught. A rule that flags nothing is not a rule.
3. Report both numbers together. "No false positives" alone means nothing — the
   check that reports nothing achieves it.

## The rule that shipped (measured 2026-08-04)

An edge is **backed** when any static trace of a relationship connects its two
files; only an edge with *no* trace at all is flagged, and the wording is "worth a
look", never "wrong". Four corroboration channels:

1. **A imports B** — direct relative import.
2. **B imports A** — arrows here often mean data flow, which runs opposite the
   import.
3. **A shared importer** — some file C imports both. `diagram.ts` runs layout then
   convert; neither imports the other, and the arrow between them is still true.
   Candidates for C are the board's neighborhood: every ref'd code file on the
   board plus each one's direct imports — no repo tree walk.
4. **A shared route literal, one hop out** — string literals starting with `/`,
   collected from each endpoint file and its direct imports. This is what backs
   `server ↔ viewer`: the viewer's fetches live in `sync.ts`, one import from the
   box's ref.

Directory refs, non-TS/JS files, missing files (already reported as
`missing-file`), hand-drawn edges, and refless or inferred-ref nodes are skipped
and counted, never flagged.

The numbers, per the evaluation rules above:

- **False positives: 0 of 12** checkable edges on `board-internals.excalidraw`
  (naive rule: 4). The two directory edges are skipped, as before.
- **True positives: both constructions caught.** Deleting `server.ts`'s import of
  `paths.ts` flags `mcp → paths`; a fabricated `viewer → paths` arrow drawn on a
  copy of the diagram is flagged (nothing imports App.tsx, so no channel can
  bless it).
- **The honest cost:** of the 98 undrawn node pairs, only 26 would be caught if
  drawn as fake arrows; 72 would be whitewashed, mostly by the shared-importer
  channel through `server.ts`, which imports half the codebase. That blindness is
  the deliberate price of a check that nags every turn and has no per-edge mute:
  a miss is invisible, a false alarm costs the whole check — the same trade
  `drift.ts` already makes for symbol renames.

A regression test pins the zero: `tests/engine-drift.test.ts` runs the real
diagram against the real tree and asserts clean.

## Constraints on the implementation

- Deterministic, milliseconds, no network, no build step, no model in the loop.
- Through `Workspace`, so path confinement holds.
- Behind its own flag, so a noisy check can be turned off without losing the quiet
  missing-file check. This is the whole reason the two must be separable.
- Where it cannot be sure, say "worth a look" — or say nothing. Never "wrong".
- TypeScript and JavaScript only, and it must be silent rather than wrong on other
  languages. Missing-file checks are language-agnostic; import parsing is not.

## Also unsolved, and related

**Unrepresented modules**: a real directory no box mentions. Needs a relevance
threshold or every new file is drift. Discussed in `docs/drift-check.md`.

**Globs in refs** (`src/engine/*`), so one box can stand for a subsystem. Probably
worth doing, and it makes the above more useful.

## Running things

```bash
npm test                       # unit tests
npm run check:drift            # the check itself; silent when nothing has drifted
npm run check:drift -- --no-edges   # missing-file check only
npx vitest run tests/engine-drift.test.ts
npm run test:e2e:board         # real Chromium, the live board
```

`docs/ship-plan.md` has the project's full state and the habits that produced it —
most usefully: reproduce or measure, never theorise, and never claim something
works because the code looks right.
