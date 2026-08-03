import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { convertSkeletons } from "../src/engine/convert";
import { emptyBoard } from "../src/engine/board-file";
import { renderBoardToPng } from "../src/engine/render";
import { planDiagramLayout } from "../src/renderer/diagram-layout";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/** Chromium is a local dev dependency, not something CI necessarily has. */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = await chromiumAvailable();

function pngSize(buffer: Buffer): { width: number; height: number } {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error("Not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function boardFromGraph() {
  const plan = await planDiagramLayout(
    {
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      edges: [{ from: "a", to: "b", label: "next" }],
    },
    { x: 0, y: 0 },
    "render-test",
  );
  const elements = await convertSkeletons(plan.skeletons as Record<string, unknown>[]);
  return { ...emptyBoard(), elements };
}

describe.skipIf(!hasChromium)("board rendering", () => {
  it("rasterises a laid-out graph to a real PNG", async () => {
    const png = await renderBoardToPng(await boardFromGraph(), { scale: 1 });
    const { width, height } = pngSize(png);
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(40);
  }, 120_000);

  /**
   * Regression guard. Excalidraw's getDimensions callback sets both the canvas
   * size and the draw scale; returning the unscaled size with scale > 1 draws
   * oversized content into a small canvas and silently crops everything
   * outside the top-left quadrant. Structural assertions cannot see that, but
   * the output dimensions can.
   */
  it("scales the canvas with the scale factor instead of cropping", async () => {
    const board = await boardFromGraph();
    const single = pngSize(await renderBoardToPng(board, { scale: 1 }));
    const double = pngSize(await renderBoardToPng(board, { scale: 2 }));
    expect(double.width).toBe(single.width * 2);
    expect(double.height).toBe(single.height * 2);
  }, 180_000);

  it("refuses to render an empty board rather than emitting a blank image", async () => {
    await expect(renderBoardToPng(emptyBoard())).rejects.toThrow(/empty board/i);
  });
});
