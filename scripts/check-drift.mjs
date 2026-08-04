#!/usr/bin/env node
/**
 * Reports diagrams that no longer match the code.
 *
 *   npm run check:drift                      # every board under docs/diagrams
 *   npm run check:drift docs/diagrams/a.excalidraw b.excalidraw
 *   npm run check:drift -- --hook            # as a Claude Code Stop hook
 *
 * Silent when nothing has drifted. That is the point: this is meant to run on
 * every turn, and a check that announces good news thirty times an hour is a
 * check someone turns off.
 *
 * Two ways out, because two readers want opposite things:
 *
 * - **A terminal, CI, a pre-commit hook** want the report on stderr and a
 *   non-zero exit, so a build can fail on it. That is the default.
 * - **A Claude Code Stop hook** wants `--hook`: the report goes out as a
 *   `systemMessage` on stdout and the process exits 0.
 *
 * That second channel was measured rather than assumed, twice. Plain text on
 * stdout with exit 0 is discarded silently. stderr with a non-zero exit shows,
 * but Claude Code wraps it in "Stop hook error: Failed with non-blocking status
 * code", which reads as a broken tool rather than a finding — the check spent
 * its whole life apologising for working. Structured JSON on stdout renders as
 * an ordinary notice, and newlines, indentation, box-drawing characters and
 * symbols all survive it. ANSI colour does not; it is stripped cleanly, so there
 * is no point emitting any.
 *
 * The JSON shape below is the one that was measured. Slimming it is not obviously
 * safe without measuring again.
 */
import path from "node:path";

import { box } from "./lib/box.mjs";
import { readBoard } from "../src/engine/board-file.ts";
import { checkDrift, createWorkspace, findBoards, parseRef } from "../src/engine/drift.ts";

const root = process.cwd();

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    edges: true,
    hook: false,
  };
  const boards = [];

  for (const arg of argv) {
    if (arg === "--no-edges") {
      opts.edges = false;
    } else if (arg === "--hook") {
      opts.hook = true;
    } else if (!arg.startsWith("--")) {
      boards.push(arg);
    }
  }

  return { boards, opts };
}

async function boardsToCheck(boards) {
  return boards.length > 0 ? boards.map((entry) => path.resolve(root, entry)) : findBoards(root);
}

/** Box name as the reader sees it on the canvas. */
function boxName(finding) {
  return (finding.label || finding.node).replace(/\s+/g, " ");
}

/** What a stale box points at. */
function target(finding) {
  const { path: file, symbol } = parseRef(finding.ref);
  if (finding.kind === "missing-symbol") return `${symbol} in ${file}`;
  if (finding.kind === "unresolvable-ref") return finding.ref;
  return file;
}

/**
 * Colour, only ever to a real terminal.
 *
 * A Claude Code systemMessage strips ANSI, measured — so in the notice the
 * severity has to be carried by a symbol instead, and emitting escapes there
 * would only risk the padding arithmetic for nothing.
 */
const COLOUR = { red: "\u001b[31m", yellow: "\u001b[33m", dim: "\u001b[2m", off: "\u001b[0m" };
function paint(text, colour, enabled) {
  return enabled && colour ? `${COLOUR[colour]}${text}${COLOUR.off}` : String(text);
}

/**
 * Markers, chosen for width rather than looks.
 *
 * Both are East Asian Wide, so they take two cells in every terminal. `⚠️` is
 * "ambiguous" — one cell or two depending on the terminal — and it sheared every
 * padded row it appeared in. These also carry the red/amber meaning into a
 * systemMessage, where ANSI colour is stripped.
 */
const GONE = "\u{1F534}";    // points at code that is not there
const SUSPECT = "\u{1F7E1}"; // an arrow with no static trace: worth a look

/** Kept low on purpose: this fires at the end of every turn. */
const MAX_LISTED = 5;

/**
 * The report, as short as it can be while still naming what is wrong.
 *
 * The diagram and its counts ride in the top border, the way out in the bottom
 * one, and the legend is gone entirely — a symbol that needs explaining every
 * turn is the wrong symbol. Four lines for a stale diagram instead of twelve.
 */
function render(stale, colour) {
  const lines = [];

  for (const { file, report } of stale) {
    const rows = [
      ...report.findings.map((finding) => `${GONE} ${boxName(finding)} \u2192 ${target(finding)}`),
      ...report.edges.map(
        (finding) =>
          `${SUSPECT} ${boxName({ label: finding.fromLabel, node: finding.from })}`
          + ` \u2192 ${boxName({ label: finding.toLabel, node: finding.to })}`,
      ),
    ];

    const counts = [
      report.findings.length ? `${GONE} ${paint(report.findings.length, "red", colour)}` : "",
      report.edges.length ? `${SUSPECT} ${paint(report.edges.length, "yellow", colour)}` : "",
    ].filter(Boolean).join("  ");

    const shown = rows.slice(0, MAX_LISTED);
    const hidden = rows.length - shown.length;
    if (hidden > 0) shown.push(paint(`\u2026 and ${hidden} more`, "dim", colour));

    lines.push(
      ...box({
        head: `${path.basename(file)}  ${counts}`,
        foot: "/update-diagram updates the diagram",
        rows: shown,
      }),
    );
  }

  return lines;
}

const { boards, opts } = parseArgs();
const workspace = createWorkspace(root);
const stale = [];
const problems = [];

for (const file of await boardsToCheck(boards)) {
  let report;
  try {
    report = checkDrift(await readBoard(file), workspace, { edges: opts.edges });
  } catch (error) {
    // An unreadable board is a problem, but not drift. Say so and keep going
    // rather than failing a commit over a file that may not be a board at all.
    problems.push(`${path.relative(root, file)}: could not read (${error.message})`);
    continue;
  }
  if (report.clean) continue;

  stale.push({ file, report });
}

if (stale.length > 0 || problems.length > 0) {
  // Colour only where it survives and means something: a real terminal. In a
  // systemMessage the escapes are stripped, so the symbols carry severity there.
  const colour = !opts.hook && Boolean(process.stderr.isTTY);
  const lines = [...problems, ...(stale.length > 0 ? render(stale, colour) : [])];

  if (opts.hook) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: false, systemMessage: lines.join("\n") })}\n`,
    );
    // Zero on purpose: the notice has been delivered, and a non-zero exit here is
    // what produced the "Stop hook error: Failed" framing in the first place.
    process.exit(0);
  }

  console.error(lines.join("\n"));
  process.exit(1);
}
