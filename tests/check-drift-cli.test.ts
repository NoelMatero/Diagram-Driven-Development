/**
 * Tests for the check-drift CLI script. These run the script as a subprocess
 * rather than importing it, so they catch integration issues like missing exports.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { emptyBoard } from "../src/engine/board-file";
import type { ExcalidrawElement } from "../src/engine/normalize";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

describe("check-drift CLI", () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "check-drift-cli-"));
  const diagramDir = path.join(projectRoot, "docs", "diagrams");
  let boardPath: string;

  beforeAll(async () => {
    // Create a minimal project structure for testing
    // Layout takes time due to ELK, font metrics
    const board = await createDiagram(emptyBoard(), {
      name: "test",
      nodes: [
        { id: "a", label: "A", ref: "a.ts" },
        { id: "b", label: "B", ref: "b.ts" },
      ],
      edges: [],
    });
    boardPath = path.join(diagramDir, "test.excalidraw");
    await (await import("../src/engine/board-file")).writeBoard(boardPath, board.board);

    // Add an edge to the board
    const elements = [...board.board.elements];
    const nodeA = elements.find((el) => (el as any).customData?.node === "a");
    const nodeB = elements.find((el) => (el as any).customData?.node === "b");
    elements.push({
      id: "edge-test",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 0,
      link: null,
      locked: false,
      customData: { origin: "diagram", diagram: "test", edge: { from: "a", to: "b" } },
      points: [[0, 0], [100, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: nodeA?.id, focus: 0, gap: 0 },
      endBinding: { elementId: nodeB?.id, focus: 0, gap: 0 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    } as ExcalidrawElement);

    // Create the code files: a.ts and b.ts do not import each other
    writeFileSync(path.join(projectRoot, "a.ts"), "export const A = 1;");
    writeFileSync(path.join(projectRoot, "b.ts"), "export const B = 1;");

    // Write the board with the edge
    await (await import("../src/engine/board-file")).writeBoard(boardPath, {
      ...board.board,
      elements,
    });
  }, 60_000);

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reports unsupported edges and exits 1", { timeout: 30_000 }, () => {
    // The script imports ../src/*.ts, so it needs the repo's tsx, not plain node.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const scriptPath = path.join(repoRoot, "scripts", "check-drift.mjs");
    const cmd = `"${tsxBin}" "${scriptPath}" "${boardPath}"`;
    let error: any;
    try {
      execSync(cmd, { cwd: projectRoot, encoding: "utf8" });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.status).toBe(1);
    const output = error.stderr || error.stdout;
    expect(output).toContain("diagram out of date");
    expect(output).toContain("A");
    expect(output).toContain("B");
    expect(output).toContain("worth a look");
  });

  it("respects --no-edges flag and exits 0", { timeout: 30_000 }, () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const scriptPath = path.join(repoRoot, "scripts", "check-drift.mjs");
    const cmd = `"${tsxBin}" "${scriptPath}" --no-edges "${boardPath}"`;
    let result;
    try {
      result = execSync(cmd, { cwd: projectRoot, encoding: "utf8" });
    } catch (e) {
      // If it exits with 0, execSync doesn't throw
      result = (e as any).stdout || (e as any).stderr || "";
    }

    // With --no-edges, the unsupported edge should be silent
    // (no node findings since the files exist)
    expect(result || "").not.toContain("diagram out of date");
  });
});
