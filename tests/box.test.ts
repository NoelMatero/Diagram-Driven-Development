/**
 * The grid arithmetic behind the drift notice.
 *
 * Worth its own tests because a box that does not line up reads as broken
 * software, and it broke for a reason that is invisible in code review: `⚠️`
 * takes one terminal cell in some terminals and two in others, so padding by
 * string length sheared every row containing it. The rule this pins is that only
 * unambiguously wide symbols are used, and that every line of a rendered box
 * comes out the same display width.
 */
import { describe, expect, it } from "vitest";

import { box, fit, pad, width } from "../scripts/lib/box.mjs";

const RED = "🔴";
const AMBER = "🟡";

describe("display width", () => {
  it("counts the wide markers as two cells", () => {
    expect(width(RED)).toBe(2);
    expect(width(AMBER)).toBe(2);
  });

  it("ignores colour, which occupies no cells", () => {
    expect(width("[31m7[0m")).toBe(1);
  });

  it("counts arrows and box characters as one cell", () => {
    // Not everything non-ASCII is wide: → and ─ are single-cell, and treating
    // them as wide would shear rows in the other direction.
    expect(width("→")).toBe(1);
    expect(width("─")).toBe(1);
    expect(width("…")).toBe(1);
  });
});

describe("padding and fitting", () => {
  it("pads by cells, so a row with a marker still lines up", () => {
    expect(width(pad(`${RED} a`, 10))).toBe(10);
    expect(width(pad("a", 10))).toBe(10);
  });

  it("marks a cut rather than truncating silently", () => {
    const cut = fit("a".repeat(40), 10);
    expect(width(cut)).toBeLessThanOrEqual(10);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("leaves text that already fits exactly alone", () => {
    expect(fit("abc", 3)).toBe("abc");
  });
});

describe("box", () => {
  const render = (rows: string[], head = "head", foot = "foot") => box({ head, foot, rows });

  it("draws every line to the same width", () => {
    const lines = render([
      `${RED} Old Cache → src/cache.ts`,
      `${AMBER} Contrast → Staggered reveal`,
      "plain row with no marker",
    ]);
    const widths = new Set(lines.map(width));
    expect([...widths]).toHaveLength(1);
  });

  it("stays aligned when the heading carries colour and a marker", () => {
    const lines = box({
      head: `board.excalidraw  ${RED} [31m2[0m  ${AMBER} [33m9[0m`,
      foot: "/update-diagram updates the diagram",
      rows: [`${RED} a → b`],
    });
    expect(new Set(lines.map(width)).size).toBe(1);
  });

  it("puts the heading and footer in the borders, not in rows of their own", () => {
    const lines = render(["only row"]);
    // Four lines total for one finding: this notice fires every turn, and rows
    // for the heading and footer plus their separators cost four more.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("head");
    expect(lines.at(-1)).toContain("foot");
  });

  it("grows for a long row and cuts one that would overrun", () => {
    const short = render(["a"]);
    const long = render(["a".repeat(50)]);
    expect(width(long[0])).toBeGreaterThan(width(short[0]));
    // Still bounded: a 300-character row must not produce a 300-cell box.
    const absurd = render(["a".repeat(300)]);
    expect(width(absurd[0])).toBeLessThan(80);
    expect(new Set(absurd.map(width)).size).toBe(1);
  });

  it("keeps a long heading from pushing the border out", () => {
    const lines = box({ head: "x".repeat(200), foot: "f", rows: ["a"] });
    expect(width(lines[0])).toBeLessThan(80);
    expect(new Set(lines.map(width)).size).toBe(1);
  });
});
