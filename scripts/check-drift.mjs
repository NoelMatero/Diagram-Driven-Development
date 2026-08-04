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
  };
  const boards = [];

  for (const arg of argv) {
    if (arg === "--no-edges") {
      opts.edges = false;
    } else if (arg === "--hook") {
      opts.hook = true;
    } else if (arg === "--details" || arg === "--full") {
      opts.details = true;
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

/** Rows of findings. Low on purpose: this fires at the end of every turn. */
const MAX_LISTED = 6;

/**
 * The report, in as few lines as it can be while still naming what is wrong.
 *
 * Severity is carried by colour, not by symbols. Emoji were used first because
 * ANSI was believed to be stripped from a systemMessage; it is not — measured by
 * putting real escapes in one and looking. Colour is strictly better here: it
 * occupies no cells, so nothing can shear, where `⚠️` is ambiguous-width and
 * sheared every padded row it appeared in.
 *
 * The diagram and its counts ride in the top border, the way out in the bottom.
 * One stale diagram lists its findings; several get a line each with their own
 * counts, because listing findings across five diagrams spends the whole notice
 * on the first one.
 */
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
function renderDetails(stale, colour) {
  const lines = [];
  stale.forEach((entry, index) => {
    const last = index === stale.length - 1;
    lines.push(
      ...box({
        head: `${path.basename(entry.file)}  ${tallyFor(entry.report, colour)}`,
        foot: last ? "/update-diagram updates the diagram" : "",
        rows: rowsFor(entry, colour),
        max: 72,
      }),
    );
  });
  return lines;
}

function render(stale, colour) {
  const tally = (gone, arrows) => tallyCounts(gone, arrows, colour);

  const totals = stale.reduce(
    (sum, { report }) => ({
      gone: sum.gone + report.findings.length,
      arrows: sum.arrows + report.edges.length,
    }),
    { gone: 0, arrows: 0 },
  );

  const single = stale.length === 1;
  const head = single
    ? `${path.basename(stale[0].file)}  ${tally(totals.gone, totals.arrows)}`
    : `${stale.length} diagrams out of date  ${tally(totals.gone, totals.arrows)}`;

  const rows = [];
  let hidden = 0;
  if (single) {
    const found = rowsFor(stale[0], colour);
    rows.push(...found.slice(0, MAX_LISTED));
    hidden = Math.max(0, found.length - MAX_LISTED);
  } else {
    const widest = Math.min(28, Math.max(...stale.map(({ file }) => path.basename(file).length)));
    for (const entry of stale.slice(0, MAX_LISTED)) {
      const label = pad(fit(path.basename(entry.file), widest), widest);
      rows.push(`${label}  ${tally(entry.report.findings.length, entry.report.edges.length)}`);
    }
    hidden = Math.max(0, stale.length - MAX_LISTED);
  }
  if (hidden > 0) {
    rows.push(paint(`\u2026 and ${hidden} more${single ? "" : " diagrams"}`, "dim", colour));
  }

  // The second hint only when something was left out: otherwise it is a longer
  // border for no reason, every turn.
  const trimmed = hidden > 0 || !single;
  const foot = trimmed
    ? "/update-diagram updates it · /expand-report explains it"
    : "/update-diagram updates the diagram";
  return box({ head, foot, rows });
}

/**
 * Is this a hook? Claude Code pipes hook input as JSON on stdin, so the script can
 * tell without being told — and a user who forgets `--hook` gets the notice rather
 * than the "Stop hook error" framing, which is the whole point of the flag.
 *
 * Guarded twice, because hanging is worse than being ugly: a terminal is excluded
 * outright, and anything slower than 200ms falls back to the plain-text path.
 */
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
  // Measured: ANSI renders in a systemMessage. Off only when the output is being
  // piped or captured, where escapes would be junk in somebody's log.
  const colour = opts.hook || Boolean(process.stderr.isTTY);
  const report = opts.details ? renderDetails : render;
  const lines = [...problems, ...(stale.length > 0 ? report(stale, colour) : [])];

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
