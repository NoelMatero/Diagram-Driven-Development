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

async function boardsToCheck() {
  const given = process.argv.slice(2).filter((entry) => !entry.startsWith("--"));
  return given.length > 0 ? given.map((entry) => path.resolve(root, entry)) : findBoards(root);
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

const workspace = createWorkspace(root);
let drifted = 0;

for (const file of await boardsToCheck()) {
  let report;
  try {
    report = checkDrift(await readBoard(file), workspace);
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
  for (const finding of report.findings) console.error(`  ${describe(finding)}`);
}

if (drifted > 0) {
  // Shown from a hook too, not just a terminal. Being told a diagram is stale
  // without being told what to do about it is where this stopped being useful:
  // the findings name the problem, and the reader still has to work out that
  // anything can be done at all. One line, and it names the command.
  console.error("\nRun /fix-drift to have it redrawn, or say which boxes no longer belong.");
  process.exit(1);
}
