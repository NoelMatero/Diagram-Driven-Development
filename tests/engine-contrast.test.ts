/**
 * Label legibility. A mid-blue stroke on a mid-blue fill measured about 2.3:1
 * on a real board, which is the case these guard against.
 */
import { describe, expect, it } from "vitest";

import { contrastRatio, readableInk, relativeLuminance } from "../src/engine/contrast";

describe("contrast", () => {
  it("measures luminance at the extremes", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("accepts shorthand and rejects nonsense", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("not-a-colour")).toBeUndefined();
    expect(contrastRatio("#fff", "transparent")).toBeUndefined();
  });

  it("reproduces the ratio that was failing on the real board", () => {
    const ratio = contrastRatio("#1971c2", "#4dabf7");
    expect(ratio).toBeDefined();
    expect(ratio!).toBeLessThan(4.5);
  });

  it("replaces a preferred colour that is illegible on the fill", () => {
    const ink = readableInk("#4dabf7", "#1971c2");
    expect(ink).not.toBe("#1971c2");
    expect(contrastRatio(ink, "#4dabf7")!).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a preferred colour that is already legible", () => {
    // Dark blue on a very light blue fill is fine; do not override a choice.
    expect(readableInk("#e7f5ff", "#1971c2")).toBe("#1971c2");
  });

  it("goes light on dark fills and dark on light fills", () => {
    expect(readableInk("#1e1e1e")).toBe("#ffffff");
    expect(readableInk("#ffec99")).toBe("#1e1e1e");
  });

  it("leaves transparent shapes to the caller's stroke", () => {
    expect(readableInk("transparent", "#1971c2")).toBe("#1971c2");
    expect(readableInk(undefined, "#1971c2")).toBe("#1971c2");
  });
});
