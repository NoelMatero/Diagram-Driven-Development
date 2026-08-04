/**
 * Drift detection. The tests that matter are the negative ones: a check that
 * reports something wrong gets switched off, and then it catches nothing.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, parseRef, refFromLabel, type Workspace } from "../src/engine/drift";
import type { ExcalidrawElement } from "../src/engine/normalize";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/** A workspace over a plain map, so the checks are testable without a tree. */
function fakeWorkspace(files: Record<string, string | "dir">): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("..") ? undefined : relative),
    stat: (target) => {
      const entry = files[target];
      if (entry === undefined) return "missing";
      return entry === "dir" ? "directory" : "file";
    },
    read: (target) => String(files[target]),
  };
}

async function boardWith(nodes: Array<{ id: string; label: string; ref?: string }>): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] });
  return result.board;
}

// The first layout loads ELK and the font metrics, which costs seconds. Paid
// here so it lands on a hook's budget instead of whichever test happened to run
// first -- boards are built through the real pipeline on purpose, so that a ref
// is proven to survive schema, customData and readGraph rather than being
// hand-placed into an element.
beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

describe("parsing refs", () => {
  it("splits path#symbol", () => {
    expect(parseRef("src/engine/layout.ts#planDiagramLayout")).toEqual({
      path: "src/engine/layout.ts",
      symbol: "planDiagramLayout",
    });
    expect(parseRef("src/engine/layout.ts")).toEqual({ path: "src/engine/layout.ts" });
    // A trailing hash is a path, not a request to check the empty symbol.
    expect(parseRef("src/engine/layout.ts#")).toEqual({ path: "src/engine/layout.ts" });
  });

  it("reads a label as a path only when it unambiguously is one", () => {
    expect(refFromLabel("src/engine/layout.ts")).toBe("src/engine/layout.ts");
    expect(refFromLabel("  docs/diagrams/a.excalidraw  ")).toBe("docs/diagrams/a.excalidraw");
    // The cases that would make this feature a liability.
    expect(refFromLabel("Auth")).toBeUndefined();
    expect(refFromLabel("POST /api/file")).toBeUndefined();
    expect(refFromLabel("Layout engine")).toBeUndefined();
    expect(refFromLabel("src/engine")).toBeUndefined();
  });
});

describe("checking a board against the code", () => {
  it("is clean when every ref exists", async () => {
    const board = await boardWith([
      { id: "layout", label: "Layout", ref: "src/engine/layout.ts" },
      { id: "graph", label: "Graph", ref: "src/engine/graph.ts" },
    ]);
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/engine/layout.ts": "x", "src/engine/graph.ts": "y" }),
    );
    expect(report).toMatchObject({ clean: true, findings: [], checked: 2, skipped: 0 });
  });

  it("reports exactly the node whose file is gone", async () => {
    const board = await boardWith([
      { id: "layout", label: "Layout", ref: "src/engine/layout.ts" },
      { id: "old", label: "Renderer", ref: "src/renderer/diagram-layout.ts" },
    ]);
    const report = checkDrift(board, fakeWorkspace({ "src/engine/layout.ts": "x" }));
    expect(report.clean).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      node: "old",
      label: "Renderer",
      kind: "missing-file",
      provenance: "recorded",
    });
    expect(report.findings[0].detail).toContain("no longer exists");
  });

  it("skips nodes with nothing to check instead of guessing", async () => {
    const board = await boardWith([
      { id: "auth", label: "Auth" },
      { id: "queue", label: "Job queue" },
    ]);
    const report = checkDrift(board, fakeWorkspace({}));
    // Clean, but honest about having examined nothing -- the tool turns this
    // into a note, because "clean" over zero checks is not a pass.
    expect(report).toMatchObject({ clean: true, checked: 0, skipped: 2 });
  });

  it("never reports hand-drawn nodes, even when their label looks like a path", () => {
    const board: BoardFile = {
      ...emptyBoard(),
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 200, height: 100, isDeleted: false, version: 1 },
        {
          id: "t1",
          type: "text",
          x: 20,
          y: 40,
          width: 160,
          height: 20,
          text: "src/gone/away.ts",
          isDeleted: false,
          version: 1,
        },
      ] as ExcalidrawElement[],
    };
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report).toMatchObject({ clean: true, findings: [], checked: 0, handDrawn: 1 });
  });

  it("checks a generated node's label when no ref was recorded, and says it inferred that", async () => {
    const board = await boardWith([{ id: "n1", label: "src/gone/away.ts" }]);
    const report = checkDrift(board, fakeWorkspace({}));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "missing-file", provenance: "inferred" });
  });

  it("catches a renamed symbol inside a file that still exists", async () => {
    const board = await boardWith([
      { id: "a", label: "Layout", ref: "src/engine/layout.ts#planDiagramLayout" },
      { id: "b", label: "Old", ref: "src/engine/layout.ts#planOldLayout" },
    ]);
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/engine/layout.ts": "export async function planDiagramLayout() {}" }),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ node: "b", kind: "missing-symbol" });
  });

  it("does not match a symbol that is only part of a longer name", async () => {
    const board = await boardWith([{ id: "a", label: "Plan", ref: "f.ts#plan" }]);
    const report = checkDrift(board, fakeWorkspace({ "f.ts": "function planDiagramLayout() {}" }));
    expect(report.findings[0]).toMatchObject({ kind: "missing-symbol" });
  });

  it("treats a directory ref as satisfied by the directory existing", async () => {
    const board = await boardWith([{ id: "eng", label: "Engine", ref: "src/engine" }]);
    expect(checkDrift(board, fakeWorkspace({ "src/engine": "dir" })).clean).toBe(true);
  });

  it("reports a symbol asked for inside a directory rather than reading it", async () => {
    const board = await boardWith([{ id: "eng", label: "Engine", ref: "src/engine#foo" }]);
    const report = checkDrift(board, fakeWorkspace({ "src/engine": "dir" }));
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });
    expect(report.findings[0].detail).toContain("directory");
  });

  it("refuses a recorded ref that leaves the repository, but ignores an inferred one", async () => {
    const escaping = await boardWith([{ id: "a", label: "Secrets", ref: "../../.ssh/id_rsa" }]);
    const report = checkDrift(escaping, fakeWorkspace({}));
    expect(report.findings[0]).toMatchObject({ kind: "unresolvable-ref" });

    // Read off a label it is a guess, not a claim, so it is not worth a finding.
    const labelled = await boardWith([{ id: "a", label: "../../.ssh/id_rsa" }]);
    expect(checkDrift(labelled, fakeWorkspace({}))).toMatchObject({ clean: true, skipped: 1 });
  });

  it("survives a ref written with a regex metacharacter in the symbol", async () => {
    const board = await boardWith([{ id: "a", label: "Odd", ref: "f.ts#a(b" }]);
    expect(() => checkDrift(board, fakeWorkspace({ "f.ts": "nothing" }))).not.toThrow();
  });
});

describe("the real filesystem workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "drift-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a path inside the root and reads it", () => {
    writeFileSync(path.join(root, "kept.ts"), "export const kept = 1;");
    const workspace = createWorkspace(root);
    const resolved = workspace.resolve("kept.ts");
    expect(resolved).toBeDefined();
    expect(workspace.stat(resolved!)).toBe("file");
    expect(workspace.read(resolved!)).toContain("kept");
  });

  it("reports a missing file as missing rather than throwing", () => {
    const workspace = createWorkspace(root);
    expect(workspace.stat(workspace.resolve("nope.ts")!)).toBe("missing");
  });

  it("refuses refs that escape the root, including via a symlink", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "x");
    mkdirSync(path.join(root, "nested"), { recursive: true });
    symlinkSync(outside, path.join(root, "nested", "escape"));

    const workspace = createWorkspace(root);
    expect(workspace.resolve("../outside/secret.txt")).toBeUndefined();
    expect(workspace.resolve("/etc/passwd")).toBeUndefined();
    // The symlink target exists, so without the realpath check this would
    // happily confirm a file outside the repository.
    expect(workspace.resolve("nested/escape/secret.txt")).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });
});
