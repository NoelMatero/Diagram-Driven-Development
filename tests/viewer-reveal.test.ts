/**
 * The reveal planner. Its job is to make a diagram appear as if it were being
 * drawn, without ever leaving the canvas holding something other than the scene
 * that was asked for -- so the last frame is the property that matters most.
 */
import { describe, expect, it } from "vitest";

import { planReveal, revealGroups, type RevealElement } from "../src/viewer/reveal";

function element(id: string, extra: Partial<RevealElement> = {}): RevealElement {
  return { id, type: "rectangle", ...extra };
}

/** A board shaped like one create_diagram writes: title, boxes, labels, arrows. */
function diagram(nodes: number): RevealElement[] {
  const elements: RevealElement[] = [element("title", { type: "text" })];
  for (let index = 0; index < nodes; index++) {
    elements.push(element(`n${index}`));
    elements.push(element(`n${index}-label`, { type: "text", containerId: `n${index}` }));
  }
  for (let index = 0; index < nodes - 1; index++) {
    elements.push(element(`e${index}`, { type: "arrow" }));
    // Edge labels are free text at the arrow's midpoint, not bound labels.
    elements.push(
      element(`e${index}-text`, { type: "text", customData: { edgeLabelFor: `e${index}` } }),
    );
  }
  return elements;
}

describe("reveal planning", () => {
  it("ends holding exactly the scene it was given, in the same order", () => {
    const elements = diagram(6);
    const { frames } = planReveal(elements);
    expect(frames.length).toBeGreaterThan(1);
    // Order matters: it is the z-order the file specified.
    expect(frames.at(-1)).toEqual(elements);
  });

  it("grows monotonically and never shows an element twice", () => {
    const { frames } = planReveal(diagram(8));
    let previous = 0;
    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(previous);
      expect(new Set(frame.map((item) => item.id)).size).toBe(frame.length);
      previous = frame.length;
    }
  });

  it("keeps a bound label with the shape it sits in", () => {
    // A box that appears a frame before its own text reads as a glitch.
    for (const frame of planReveal(diagram(6)).frames) {
      const ids = new Set(frame.map((item) => String(item.id)));
      for (const item of frame) {
        if (typeof item.containerId === "string") expect(ids).toContain(item.containerId);
      }
    }
  });

  /**
   * Caught on screen before it was caught here: a mid-reveal frame showed the
   * word "next" floating between two boxes, because its arrow had not arrived.
   */
  it("never shows an edge label before the arrow it belongs to", () => {
    for (const frame of planReveal(diagram(8)).frames) {
      const ids = new Set(frame.map((item) => String(item.id)));
      for (const item of frame) {
        const target = (item.customData as { edgeLabelFor?: string } | undefined)?.edgeLabelFor;
        if (target) expect(ids, `${item.id} orphaned`).toContain(target);
      }
    }
  });

  it("keeps an attachment whose target is missing rather than dropping it", () => {
    // Grouping under an id that never appears would silently lose the element,
    // and the last frame would no longer equal the scene that was asked for.
    const orphans = [
      element("a"),
      element("ghost-label", { type: "text", containerId: "not-here" }),
      element("ghost-edge-text", { type: "text", customData: { edgeLabelFor: "gone" } }),
      element("b"),
      element("c"),
    ];
    expect(planReveal(orphans).frames.at(-1)).toEqual(orphans);
  });

  it("draws every shape before any connector", () => {
    const groups = revealGroups(diagram(5));
    const firstArrow = groups.findIndex((group) => group[0].type === "arrow");
    const lastShape = groups.reduce(
      (last, group, index) => (group[0].type === "arrow" ? last : index),
      -1,
    );
    expect(firstArrow).toBeGreaterThan(lastShape);
  });

  it("shows a small board at once rather than making it wait", () => {
    const tiny = [element("a"), element("a-label", { type: "text", containerId: "a" })];
    const { frames, intervalMs } = planReveal(tiny);
    expect(frames).toEqual([tiny]);
    expect(intervalMs).toBe(0);
  });

  it("caps canvas updates so a large diagram does not thrash", () => {
    const big = diagram(60);
    const { frames, intervalMs } = planReveal(big, { maxFrames: 14, totalMs: 640 });
    expect(frames.length).toBeLessThanOrEqual(14);
    expect(frames.at(-1)).toHaveLength(big.length);
    // The budget is wall-clock, not per-element: a bigger diagram must not take
    // proportionally longer to finish appearing.
    expect(frames.length * intervalMs).toBeLessThanOrEqual(800);
  });

  it("handles a board of nothing but hand-drawn strokes", () => {
    const strokes = Array.from({ length: 5 }, (_, index) => element(`s${index}`, { type: "freedraw" }));
    expect(planReveal(strokes).frames.at(-1)).toEqual(strokes);
  });
});
