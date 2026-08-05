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
 * That second channel was measured rather than assumed, three times. Plain text on
 * stdout with exit 0 is discarded silently. stderr with a non-zero exit shows, but
 * Claude Code wraps it in "Stop hook error: Failed with non-blocking status code",
 * which reads as a broken tool rather than a finding — the check spent its whole
 * life apologising for working. Structured JSON on stdout renders as an ordinary
 * notice, and newlines, indentation, box-drawing characters, symbols and ANSI
 * colour all survive it.
 *
 * Colour took two rounds to settle, and the first answer was wrong: escapes were
 * put in a notice and the reply came back as pasted text, where colour is invisible
 * either way. It renders. Severity is carried by colour rather than emoji, which
 * matters beyond looks — an escape occupies no cells, while `⚠️` is ambiguous-width
 * and sheared every padded row it appeared in.
 *
 * The JSON shape below is the one that was measured. Slimming it is not obviously
 * safe without measuring again.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { box, fit, pad } from "./lib/box.mjs";
import { readBoard } from "../src/engine/board-file.ts";
import { checkDrift, createWorkspace, findBoards, parseRef } from "../src/engine/drift.ts";

const root = process.cwd();

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    edges: true,
    hook: false,
    details: false,
    expand: false,
    shrink: false,
  };
  const boards = [];

  for (const arg of argv) {
    if (arg === "--no-edges") {
      opts.edges = false;
    } else if (arg === "--hook") {
      opts.hook = true;
    } else if (arg === "--details" || arg === "--full") {
      opts.details = true;
    } else if (arg === "--expand") {
      opts.expand = true;
    } else if (arg === "--shrink") {
      opts.shrink = true;
    } else if (!arg.startsWith("--")) {
      boards.push(arg);
    }
  }

  return { boards, opts };
}

/**
 * Whether the notice has been asked to stay expanded.
 *
 * A file rather than an argument, because the caller that needs to know is the
 * *next* hook run, and a command cannot reach into a message the hook has already
 * written. It lives in .diagramos/, which is gitignored, so the preference is one
 * person's and not the repository's.
 *
 * The obvious objection to a mode is that it is invisible once set and then
 * puzzling — so the expanded notice always names the way back. Nothing here is
 * remembered that the notice does not say out loud.
 */
const MODE_FILE = path.join(root, ".diagramos", "report-expanded");

function setExpanded(on) {
  if (on) {
    mkdirSync(path.dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, "expanded\n");
  } else {
    rmSync(MODE_FILE, { force: true });
  }
}

function isExpanded() {
  return existsSync(MODE_FILE);
}

async function boardsToCheck(boards) {
  return boards.length > 0 ? boards.map((entry) => path.resolve(root, entry)) : findBoards(root);
}

/** Box name as the reader sees it on the canvas. */
function boxName(finding) {
  return (finding.label || finding.node).replace(/\s+/g, " ");
}

/**
 * Why a finding is a finding, spelled out.
 *
 * Deliberately absent from the notice, which fires every turn and would otherwise
 * repeat it — and present here, where somebody has asked.
 */
const REASONS = {
  "missing-file": "that file is not in the repo any more",
  "missing-symbol": "the file is there, that name in it is not",
  "unresolvable-ref": "that is not a path in this repo at all",
};
const EDGE_REASON = "nothing in the code connects them: no import either way, "
  + "no third file importing both, no shared route string";

/** What a stale box points at. */
function target(finding) {
  const { path: file, symbol } = parseRef(finding.ref);
  if (finding.kind === "missing-symbol") return `${symbol} in ${file}`;
  if (finding.kind === "unresolvable-ref") return finding.ref;
  return file;
}

/** Colour, applied where it renders: a terminal, and the notice. Never a pipe. */
const COLOUR = { red: "\u001b[31m", yellow: "\u001b[33m", dim: "\u001b[2m", off: "\u001b[0m" };
function paint(text, colour, enabled) {
  return enabled && colour ? `${COLOUR[colour]}${text}${COLOUR.off}` : String(text);
}

/** Rows of findings. Low on purpose: this fires at the end of every turn. */
const MAX_LISTED = 6;

/** One finding per row: what the box says, and what it points at. */
function rowsFor({ report }, colour) {
  return [
    ...report.findings.map((finding) => paint(`${boxName(finding)} \u2192 ${target(finding)}`, "red", colour)),
    ...report.edges.map((finding) =>
      paint(
        `${boxName({ label: finding.fromLabel, node: finding.from })}`
        + ` \u2192 ${boxName({ label: finding.toLabel, node: finding.to })}`,
        "yellow",
        colour,
      ),
    ),
  ];
}

/** "2 gone  1 arrow", each part coloured, empty parts dropped. */
function tallyCounts(gone, arrows, colour) {
  return [
    gone ? paint(`${gone} gone`, "red", colour) : "",
    arrows ? paint(`${arrows} ${arrows === 1 ? "arrow" : "arrows"}`, "yellow", colour) : "",
  ].filter(Boolean).join("  ");
}

function tallyFor(report, colour) {
  return tallyCounts(report.findings.length, report.edges.length, colour);
}

/**
 * The long form: the same rows as the notice, one box per diagram, nothing capped.
 *
 * No reasons on the rows. The notice is trimmed for brevity, so what is missing
 * from it is the *findings*, not an explanation of them — and someone who wants
 * the reasoning can ask, or read docs/drift-check.md. The command sits in the
 * bottom border of the last box, so it appears once under everything.
 */
function renderDetails(stale, colour, foot = "/update-diagram updates the diagram") {
  return box({
    sections: stale.map((entry) => ({
      label: `${path.basename(entry.file)}  ${tallyFor(entry.report, colour)}`,
      rows: rowsFor(entry, colour),
    })),
    foot,
    max: 72,
  });
}

/**
 * The notice. Small by default, because it fires at the end of every turn.
 *
 * One stale diagram lists what is wrong with it. Several list themselves with
 * their counts, and /expand-report is how somebody sees all of it — a command that
 * shows more once, rather than a mode that has to be switched back off.
 */
function render(stale, colour) {
  const single = stale.length === 1;
  const found = stale.map((entry) => ({ entry, rows: rowsFor(entry, colour) }));

  // One diagram shows its findings; several show a line each with their counts.
  //
  // Listing findings across diagrams was tried and reverted: three findings in two
  // diagrams became a seven-line box where counts were four, which is the opposite
  // of what a notice firing every turn should do. The rule is now the simple one —
  // one diagram, see what is wrong; several, see where.
  const totals = stale.reduce(
    (sum, { report }) => ({
      gone: sum.gone + report.findings.length,
      arrows: sum.arrows + report.edges.length,
    }),
    { gone: 0, arrows: 0 },
  );

  // Too many to list: counts per diagram, and a pointer to the view that has room.
  const head = single
    ? `${path.basename(stale[0].file)}  ${tallyCounts(totals.gone, totals.arrows, colour)}`
    : `${stale.length} diagrams out of date  ${tallyCounts(totals.gone, totals.arrows, colour)}`;

  const rows = [];
  let hidden = 0;
  if (single) {
    rows.push(...found[0].rows.slice(0, MAX_LISTED));
    hidden = found[0].rows.length - MAX_LISTED;
  } else {
    const widest = Math.min(28, Math.max(...stale.map(({ file }) => path.basename(file).length)));
    for (const { entry } of found.slice(0, MAX_LISTED)) {
      rows.push(`${pad(fit(path.basename(entry.file), widest), widest)}  ${tallyFor(entry.report, colour)}`);
    }
    hidden = Math.max(0, stale.length - MAX_LISTED);
  }
  if (hidden > 0) {
    rows.push(paint(`\u2026 and ${hidden} more${single ? "" : " diagrams"}`, "dim", colour));
  }

  return box({ head, foot: "/update-diagram updates it · /expand-report shows them all", rows });
}

async function hookOnStdin() {
  if (process.stdin.isTTY) return false;

  let timer;
  const read = new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
  const raw = await Promise.race([
    read,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(""), 200);
    }),
  ]);

  // Both of these matter. Listening on stdin puts it in flowing mode and holds the
  // event loop open, so a clean run — which prints nothing and never calls exit —
  // hung until the test harness killed it at two minutes. The timer holds it open
  // the same way.
  clearTimeout(timer);
  process.stdin.pause();
  // Only a socket has unref. Redirect stdin from /dev/null and it is an fs stream
  // instead, where calling it throws — which is how `npm run check:drift` from a
  // script died while every test, all of which used a pipe, passed.
  if (typeof process.stdin.unref === "function") process.stdin.unref();

  try {
    const payload = JSON.parse(raw);
    return Boolean(payload && typeof payload === "object" && payload.hook_event_name);
  } catch {
    return false;
  }
}

const { boards, opts } = parseArgs();
if (!opts.hook) opts.hook = await hookOnStdin();
if (opts.expand) setExpanded(true);
if (opts.shrink) setExpanded(false);
// --details is a one-off; the mode file is what the next hook run reads.
const expanded = opts.details || opts.expand || (!opts.shrink && isExpanded());
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
  // Measured: ANSI renders in a systemMessage. Off only when the output is being
  // piped or captured, where escapes would be junk in somebody's log.
  const colour = opts.hook || Boolean(process.stderr.isTTY);
  const lines = [
    ...problems,
    ...(stale.length === 0
      ? []
      : expanded
        ? renderDetails(
            stale,
            colour,
            // Never a mode you cannot find your way out of: while it is on, the
            // notice says how to turn it off.
            isExpanded()
              ? "/update-diagram updates it · /shrink-report makes this short again"
              : "/update-diagram updates the diagram",
          )
        : render(stale, colour)),
  ];

  if (opts.hook) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: false, systemMessage: `\n${lines.join("\n")}` })}\n`,
    );
    // Zero on purpose: the notice has been delivered, and a non-zero exit here is
    // what produced the "Stop hook error: Failed" framing in the first place.
    process.exit(0);
  }

  console.error(lines.join("\n"));
  process.exit(1);
}
