/**
 * Box-drawn tables for the drift report.
 *
 * Why a module of its own: getting a grid to line up is arithmetic, and
 * arithmetic deserves tests. Every border and every row must come out the same
 * display width or the box reads as broken software rather than a table.
 *
 * Two things make that arithmetic non-obvious.
 *
 * **Emoji are not one column wide.** `❌` occupies two terminal cells while
 * being one code point, and `⚠️` is two code points (the symbol plus an
 * invisible variation selector) rendering in one or two cells. Padding by
 * `String.length` therefore shears any row containing one. WIDE lists the few
 * symbols this report uses and their real width; nothing else is assumed.
 *
 * **Colour is zero width.** ANSI escapes must be excluded from the measurement
 * and re-applied after padding, or a coloured cell pushes its row out by the
 * length of the escape codes. They are also stripped entirely from a Claude Code
 * `systemMessage`, so colour is only ever emitted to a real terminal.
 */

/**
 * Two cells, not one.
 *
 * The emoji blocks from U+1F300 up are East Asian Wide, and so are a handful of
 * older symbols that default to emoji presentation. Everything else here — arrows,
 * box drawing, the ellipsis — is a single cell, and assuming otherwise shears rows
 * just as badly in the other direction.
 *
 * Deliberately not a guess-by-range-only: `⚠` (U+26A0) is *ambiguous* width, one
 * cell in some terminals and two in others, so it is not usable in a padded row at
 * all. That is what sheared this box the first time.
 */
function isWide(codePoint) {
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return true;
  return codePoint === 0x2705 || codePoint === 0x274c || codePoint === 0x2757;
}

const ANSI = /\[[0-9;]*m/gu;
const VARIATION_SELECTOR = /️/gu;

/** Display width in terminal cells: colour ignored, wide symbols counted twice. */
export function width(text) {
  let cells = 0;
  for (const character of String(text).replace(ANSI, "").replace(VARIATION_SELECTOR, "")) {
    cells += isWide(character.codePointAt(0)) ? 2 : 1;
  }
  return cells;
}

/** Cuts to fit, marking the cut with an ellipsis rather than truncating silently. */
export function fit(text, cells) {
  if (width(text) <= cells) return String(text);
  let out = "";
  for (const character of String(text).replace(ANSI, "")) {
    if (width(out) + width(character) > cells - 1) break;
    out += character;
  }
  return `${out}…`;
}

/** Pads to a display width, so a cell holding an emoji still lines up. */
export function pad(text, cells, align = "left") {
  const gap = Math.max(0, cells - width(text));
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "centre") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

const LINES = {
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
  horizontal: "─", vertical: "│", teeRight: "├", teeLeft: "┤",
};

/**
 * A framed list. The first section's label rides in the top border, each later
 * section is introduced by a divider carrying its own label, and the footer rides
 * in the bottom border.
 *
 * One box with dividers rather than a stack of boxes: two boxes touching show
 * `└────┘` immediately above `┌────┐`, which is a wasted line and, worse, two
 * widths that have no reason to agree. Sharing one frame makes them agree by
 * construction.
 */
export function box({ head = "", foot = "", rows = [], sections, min = 38, max = 64 }) {
  const parts = sections ?? [{ label: head, rows }];
  const widest = Math.max(
    width(foot) + 4,
    ...parts.map((part) => Math.max(width(part.label ?? "") + 4, ...part.rows.map((row) => width(row)))),
  );
  const inner = Math.min(max, Math.max(min, widest));

  const edge = (left, label, right) => {
    const cut = label ? fit(label, inner - 2) : "";
    const text = cut ? `${LINES.horizontal} ${cut} ` : LINES.horizontal;
    // left edge + text + dashes + right edge must equal a row: inner + 4 cells.
    const rest = inner + 2 - width(text);
    return left + text + LINES.horizontal.repeat(Math.max(1, rest)) + right;
  };

  const lines = [];
  parts.forEach((part, index) => {
    lines.push(
      index === 0
        ? edge(LINES.topLeft, part.label, LINES.topRight)
        : edge(LINES.teeRight, part.label, LINES.teeLeft),
    );
    for (const row of part.rows) {
      lines.push(`${LINES.vertical} ${pad(fit(row, inner), inner)} ${LINES.vertical}`);
    }
  });
  lines.push(edge(LINES.bottomLeft, foot, LINES.bottomRight));
  return lines;
}
