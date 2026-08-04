# Drift check: keeping a diagram honest about the code

Status: **missing files, symbols, and edge mismatches are built** — `src/engine/drift.ts`,
the `check_drift` tool, `scripts/check-drift.mjs`, and a `Stop` hook in
`.claude/settings.json`. Unrepresented modules remain design; the rest of this file is the
reasoning behind the complete picture.

Fixing is a `/update-diagram` command, and deliberately not automatic. See
"Reporting is not the same as being actionable" below for why the exit-2
auto-fix was designed and then not built.

What changed while building it:

- **Labels that are unambiguously paths are read as refs**, reported as
  `inferred`. Without this, every diagram drawn before `ref` existed was
  invisible to the check. The pattern demands a slash and a file extension, so
  `Auth` and `POST /api/file` are still skipped.
- **`Stop`, not `PostToolUse`.** One run per turn instead of dozens, output
  arriving when the model could act on it, and no debounce logic to get wrong.
- **Silent when clean**, which matters more than it sounds: a check that
  announces good news thirty times an hour gets switched off.
- **The plugin does not ship the hook.** `hooks/hooks.json` at a plugin root is
  auto-discovered, so shipping one would spawn a subprocess on every turn in
  every project someone installs this into, most of which have no diagrams. It
  is documented as opt-in instead.
- **Refs are confined like board paths.** They are model-authored strings that
  become filesystem reads, so they resolve inside the root and are re-checked
  after realpath; a symlink out of the tree cannot be used to probe for files.

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
{ "node": "layout", "ref": "src/engine/layout.ts" }
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
- **Hard** — a `Stop` hook runs `check-drift.mjs` once per turn. The harness
  executes it whether or not the model remembered. This is what is built.
- **Hardest** — pre-commit or CI, catching drift introduced without Claude. The
  script's exit code is there for it; nothing wires it up yet.

The config shape was worth confirming twice, since a wrong key fails silently:
the published docs say `Stop` ignores matchers, while the plugin-dev validator
rejects a hook without one. `"matcher": "*"` satisfies both.

Every reporting channel was measured on a real `Stop` hook, in three rounds:

| Script behaviour | What the user sees |
| --- | --- |
| stderr, exit 1 | `Stop hook error: Failed with non-blocking status code:` then the full report |
| plain text on stdout, exit 0 | nothing at all |
| **JSON on stdout with `systemMessage`, exit 0** | **the message, rendered as an ordinary notice** |

The third row is what the check now uses, behind `--hook`. For most of this
project's life the first row was believed to be the only channel that worked, and
the report was written to apologise for the "Stop hook error" framing — a check
that had to explain it was not broken every time it spoke. It isn't necessary.

What survives inside a `systemMessage`, measured the same way: newlines,
indentation, box-drawing characters, symbols, **and ANSI colour**. Markdown
arrives literally, so `**bold**` shows its asterisks.

Colour took two rounds to establish, and the first answer was wrong. A probe put
escapes in a notice and the reply came back as pasted text — where colour is
invisible either way — which was read as "stripped". It is not: red and yellow
render. The report therefore carries severity in colour, not in emoji, which
matters for more than looks: an escape sequence occupies zero cells, while `⚠️` is
*ambiguous* width (one cell in some terminals, two in others) and sheared every
padded row it appeared in.

The notice is a box, kept to four lines for a single stale diagram: the diagram and
its counts ride in the top border, `/update-diagram` rides in the bottom, and there
is no legend — a symbol needing a footnote every turn is the wrong symbol. Several
stale diagrams get a line each with their own counts rather than a box each.

The message begins with a newline. Claude Code prefixes the first line
("Stop says: …"), which pushed the top border right by the width of that prefix and
left the box visibly crooked.

Long names are cut with an ellipsis rather than allowed to stretch the border, and
`tests/box.test.ts` pins the arithmetic: every line of a rendered box comes out the
same display width, colour counts as zero cells, and arrows and box-drawing
characters count as one.

Exit 2 was considered and not used: it puts the text in front of the model and
blocks the turn from ending. See "Reporting is not the same as being actionable".

The exit code now depends on the caller, which is the one thing to be careful
about: `--hook` exits 0 because the notice has already been delivered, while a
bare run exits non-zero so CI and pre-commit can fail on it. Both are pinned by
tests; getting them backwards either loses the report or fails a build over a
diagram.

## Reporting is not the same as being actionable

The check reported the problem and stopped short of the one thing a reader needs:
that anything can be done about it. The guidance line existed, but it was gated on
`process.stderr.isTTY` — true in a terminal, false from a hook, which is the way
it actually runs. So in normal use nobody ever saw it. Measured against the old
script from a pipe: findings, then nothing.

Fixed by printing one line that names `/update-diagram`, unconditionally. The earlier
reasoning for the gate — that from a hook this is a third line nobody asked to
read — was right about noise and wrong about which line was noise.

**`/update-diagram` is a command, not an automatic behaviour.** The alternative was
designed and rejected: exit **2** instead of 1 puts the report in front of the
model and blocks the turn from ending, which is precisely "go and fix the
diagram". It was not built, for two reasons.

- **Regeneration is not free.** It replaces what was generated before, so a board
  someone arranged by hand comes back arranged by the engine. Doing that silently,
  possibly while they are looking at it, is hostile.
- **A fix that cannot succeed blocks the turn.** Exit 2 loops until the model
  gets it right, and a box pointing at code that genuinely no longer exists has
  no correct redraw the model can guess. `stop_hook_active` in the hook's stdin
  is the documented escape, and the docs have already been wrong twice in this
  project — about matchers, and about stdout visibility — so it would need
  measuring, not trusting, before anything shipped that depends on it.

A command costs one thing to type when the reader decides it is worth it, and
carries none of that risk. If the automatic version is ever wanted, it belongs
behind a flag on the script, off by default, with `stop_hook_active` verified
empirically first.

## Open questions

- ~~Should drift auto-regenerate, or only report?~~ **Report only.** Silent
  redrawing while someone is reading the board is hostile, and regeneration
  discards layout intent.
- What is the relevance threshold for "unrepresented"? Without one, every new
  file is drift.
- Should `ref` support globs (`src/engine/*`) so one node can stand for a
  subsystem? Probably yes, and it makes (2) far more useful.
- How does this interact with hand-drawn nodes? Current answer: ignore them
  entirely. Revisit if that proves too conservative.

## Rough order of work

1. ~~`src/engine/drift.ts` with the missing-ref check only.~~ Done, plus symbols.
2. ~~`ref` on the `create_diagram` node schema, threaded through `customData`.~~
3. ~~`check_drift` MCP tool and `scripts/check-drift.mjs`.~~
4. ~~Tests.~~ `tests/engine-drift.test.ts`, plus the round trip through a real
   stdio server in `tests/mcp-server.test.ts`.
5. ~~Edge mismatches: arrows grounded in four corroboration channels.~~ Done, behind
   its own `edges` flag so a noisy check can be turned off without losing the quiet
   missing-file check.
6. Next: unrepresented modules, when the relevance threshold is settled.

The three checks are now built in descending order of confidence and cost: missing files
(milliseconds, almost always actionable), edge mismatches (import resolution, measurably
quiet), then unrepresented modules (would need a relevance bar to stay quiet).
