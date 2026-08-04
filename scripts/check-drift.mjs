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

/**
 * A rule across the notice, carrying its own label.
 *
 * Rules only, never a full box: a bordered grid is aligned to a width nothing
 * here knows. The hook has no terminal to measure, and one long diagram name or
 * a narrow window turns a grid into wreckage. A rule with nothing on its right
 * cannot be sheared by a line that overruns it.
 */
const WIDTH = 62;
function rule(label = "") {
  const head = label ? `── ${label} ` : "──";
  return head + "─".repeat(Math.max(3, WIDTH - [...head].length));
}

/** Box name as the reader sees it on the canvas. */
function boxName(finding) {
  return `"${(finding.label || finding.node).replace(/\s+/g, " ")}"`;
}

/**
 * What a stale box points at, without repeating why it is stale — the group
 * heading says that once for all of them.
 */
function target(finding) {
  const { path: file, symbol } = parseRef(finding.ref);
  const guessed = finding.provenance === "inferred" ? "  (guessed from its label)" : "";
  if (finding.kind === "missing-symbol") return `${symbol} in ${file}${guessed}`;
  if (finding.kind === "unresolvable-ref") return `${finding.ref}${guessed}`;
  return `${file}${guessed}`;
}

/** Headings per kind, so the line itself can be just the fact. */
const HEADINGS = {
  "missing-file": ["box points", "boxes point", "at code that is gone"],
  "missing-symbol": ["box points", "boxes point", "at a symbol that is gone"],
  "unresolvable-ref": ["box points", "boxes point", "at something that is not a file here"],
};

/** Listed in full up to here; past it the remainder is counted instead. */
const MAX_LISTED = 8;

/**
 * A counted group: heading, then the findings, then how many were not shown.
 *
 * The count lives in the heading, which is what makes listing eight of twelve
 * honest rather than a quiet omission.
 */
function group(out, count, heading, lines) {
  if (lines.length === 0) return;
  out.push(`   ${count} ${heading}`);
  for (const line of lines.slice(0, MAX_LISTED)) out.push(`       ${line}`);
  const hidden = lines.length - MAX_LISTED;
  if (hidden > 0) out.push(`       … and ${hidden} more`);
  out.push("");
}

/** Pads the left column so the arrows line up, without letting it run away. */
function columns(rows) {
  const width = Math.min(30, Math.max(...rows.map(([left]) => [...left].length)));
  return rows.map(([left, right]) => `${left.padEnd(width)}  →  ${right}`);
}

function renderBoard(file, report, out) {
  out.push(rule(`diagram out of date · ${path.basename(file)}`));
  out.push("");

  for (const [kind, [one, many, tail]] of Object.entries(HEADINGS)) {
    const found = report.findings.filter((finding) => finding.kind === kind);
    if (found.length === 0) continue;
    group(
      out,
      found.length,
      `${found.length === 1 ? one : many} ${tail}`,
      columns(found.map((finding) => [boxName(finding), target(finding)])),
    );
  }

  if (report.edges.length > 0) {
    const rows = report.edges.map((finding) => [
      (finding.fromLabel || finding.from).replace(/\s+/g, " "),
      (finding.toLabel || finding.to).replace(/\s+/g, " "),
    ]);
    // Why nothing connects them is said once here. It used to be repeated on
    // every line, which cost 2360 characters for twelve arrows and buried the
    // arrows themselves.
    group(
      out,
      report.edges.length,
      `${report.edges.length === 1 ? "arrow has" : "arrows have"} nothing in the code behind`
      + `${report.edges.length === 1 ? " it" : " them"} — worth a look, not wrong as such`
      + "\n       (no import either way, no shared importer, no shared route string)",
      columns(rows),
    );
  }
}

const { boards, opts } = parseArgs();
const workspace = createWorkspace(root);
const out = [];
let drifted = 0;

for (const file of await boardsToCheck(boards)) {
  let report;
  try {
    report = checkDrift(await readBoard(file), workspace, { edges: opts.edges });
  } catch (error) {
    // An unreadable board is a problem, but not drift. Say so and keep going
    // rather than failing a commit over a file that may not be a board at all.
    out.push(`${path.relative(root, file)}: could not read (${error.message})`);
    continue;
  }
  if (report.clean) continue;

  drifted += 1;
  renderBoard(file, report, out);
}

if (drifted > 0) {
  // The way out is in the frame, not buried under the findings: being told a
  // diagram is stale without being told anything can be done about it is where
  // this stopped being useful.
  out.push(rule("run /update-diagram to bring it back in line"));

  if (opts.hook) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: false, systemMessage: out.join("\n") })}\n`,
    );
    // Zero on purpose: the notice has been delivered, and a non-zero exit here
    // is what produced the "Stop hook error: Failed" framing in the first place.
    process.exit(0);
  }

  console.error(out.join("\n"));
  process.exit(1);
}

if (out.length > 0 && !opts.hook) console.error(out.join("\n"));
