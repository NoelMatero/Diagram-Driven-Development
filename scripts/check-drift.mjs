#!/usr/bin/env node
/**
 * Reports diagrams that no longer match the code.
 *
 *   npm run check:drift                      # every board under docs/diagrams
 *   npm run check:drift docs/diagrams/a.excalidraw b.excalidraw
 *
 * Silent when nothing has drifted. That is the point: this is meant to run on
 * every turn, and a check that announces good news thirty times an hour is a
 * check someone turns off.
 *
 * Drift goes to stderr and exits 1, which is what CI and a pre-commit hook want.
 * A Claude Code Stop hook wraps that in "Stop hook error: Failed", which reads
 * as a broken tool rather than a finding -- but the alternative was measured and
 * is worse: exiting 0 with the report on stdout produced no visible output at
 * all. Visible and mislabelled beats correct and silent, so the wording below
 * carries the explanation the wrapper does not.
 */
import path from "node:path";

import { readBoard } from "../src/engine/board-file.ts";
import { checkDrift, createWorkspace, findBoards, parseRef } from "../src/engine/drift.ts";

const root = process.cwd();

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    edges: true,
  };
  const boards = [];

  for (const arg of argv) {
    if (arg === "--no-edges") {
      opts.edges = false;
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
 * One plain line per stale box. The reader is whoever asked for a diagram, not
 * whoever wrote this code, so it says what the box says and which file went
 * missing -- no "ref", no "node", no "regenerate".
 */
function describe(finding) {
  const box = `"${(finding.label || finding.node).replace(/\s+/g, " ")}"`;
  const { path: target, symbol } = parseRef(finding.ref);
  const guessed = finding.provenance === "inferred" ? " (guessed from its label)" : "";
  if (finding.kind === "missing-symbol") {
    return `${box} points at ${symbol} in ${target}, which is no longer there${guessed}`;
  }
  if (finding.kind === "unresolvable-ref") {
    return `${box} points at ${finding.ref}, which is not a file in this repo${guessed}`;
  }
  return `${box} points at ${target}, which no longer exists${guessed}`;
}

/**
 * One arrow, named by the boxes it joins.
 *
 * Why nothing connects them is deliberately not here. Every unsupported arrow
 * fails for the same reason, and repeating a twenty-word explanation once per
 * arrow buries the arrows it is meant to be showing — twelve of them turned the
 * report into a wall nobody reads to the end. The reason is printed once, as the
 * heading above the list.
 */
function describeEdge(finding) {
  const fromBox = (finding.fromLabel || finding.from).replace(/\s+/g, " ");
  const toBox = (finding.toLabel || finding.to).replace(/\s+/g, " ");
  return `${fromBox} → ${toBox}`;
}

/** Listed in full up to here; beyond it the remainder is counted instead. */
const MAX_LISTED = 8;

/**
 * A counted group under one heading.
 *
 * The heading carries the total, so showing eight of twelve hides nothing: the
 * reader is told there are twelve. Silent truncation would be the unacceptable
 * version of this.
 */
function group(heading, lines) {
  if (lines.length === 0) return;
  console.error(`  ${lines.length} ${heading}`);
  for (const line of lines.slice(0, MAX_LISTED)) console.error(`    ${line}`);
  const hidden = lines.length - MAX_LISTED;
  if (hidden > 0) console.error(`    … and ${hidden} more`);
}

const { boards, opts } = parseArgs();
const workspace = createWorkspace(root);
let drifted = 0;

for (const file of await boardsToCheck(boards)) {
  let report;
  try {
    report = checkDrift(await readBoard(file), workspace, { edges: opts.edges });
  } catch (error) {
    // An unreadable board is a problem, but not drift. Say so and keep going
    // rather than failing a commit over a file that may not be a board at all.
    console.error(`${path.relative(root, file)}: could not read (${error.message})`);
    continue;
  }
  if (report.clean) continue;

  drifted += 1;
  // A project holds several diagrams, and a Stop hook swallows the start of the
  // first line, so the file has to be named where the eye lands after that.
  console.error(`diagram out of date — ${path.basename(file)}`);
  group("boxes point at code that is gone:", report.findings.map(describe));
  group(
    "arrows with nothing in the code behind them — worth a look, not necessarily"
    + "\n  wrong (no import either way, no shared importer, no shared route string):",
    report.edges.map(describeEdge),
  );
}

if (drifted > 0) {
  // Shown from a hook too, not just a terminal. Being told a diagram is stale
  // without being told what to do about it is where this stopped being useful:
  // the findings name the problem, and the reader still has to work out that
  // anything can be done at all. One line, and it names the command.
  console.error("\nRun /update-diagram to bring it back in line, or say which boxes no longer belong.");
  process.exit(1);
}
