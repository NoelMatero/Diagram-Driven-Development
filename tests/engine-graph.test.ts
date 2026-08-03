/**
 * Reading a board back as a graph. The generated case must be exact; the
 * hand-drawn case is the one that makes a sketch usable as a specification.
 */
import { describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { connectNodes, createDiagram, deleteDiagram, listDiagrams } from "../src/engine/diagram";
import { readGraph } from "../src/engine/graph";
import type { ExcalidrawElement } from "../src/engine/normalize";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/** A bare element of the kind Excalidraw writes when a human draws it. */
function drawn(element: Partial<ExcalidrawElement> & { id: string; type: string }): ExcalidrawElement {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    isDeleted: false,
    version: 1,
    ...element,
  } as ExcalidrawElement;
}

function boardOf(elements: ExcalidrawElement[]): BoardFile {
  return { ...emptyBoard(), elements };
}

describe("reading a hand-drawn board", () => {
  it("treats a box with text on it as a labelled node", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "r1", type: "rectangle", x: 0, y: 0, width: 200, height: 100 }),
        drawn({ id: "t1", type: "text", x: 60, y: 40, width: 80, height: 20, text: "Auth" }),
      ]),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ id: "r1", label: "Auth", provenance: "inferred" });
    // The text became the label, so it is not also loose content.
    expect(graph.unattributed).toHaveLength(0);
  });

  it("infers an edge from an unbound arrow whose ends touch two shapes", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
        drawn({ id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 60 }),
        drawn({ id: "arrow", type: "arrow", x: 105, y: 30, width: 190, height: 0, points: [[0, 0], [190, 0]] }),
      ]),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b", provenance: "inferred" });
  });

  it("does not invent an edge from an arrow floating in empty space", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
        drawn({ id: "loose", type: "arrow", x: 800, y: 800, width: 100, height: 0, points: [[0, 0], [100, 0]] }),
      ]),
    );
    expect(graph.edges).toHaveLength(0);
    expect(graph.unattributed.map((item) => item.elementId)).not.toContain("a");
  });

  it("prefers explicit bindings over proximity", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
        drawn({ id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 60 }),
        drawn({
          id: "arrow",
          type: "arrow",
          x: 0,
          y: 500,
          width: 10,
          height: 0,
          points: [[0, 0], [10, 0]],
          startBinding: { elementId: "a", focus: 0, gap: 4 },
          endBinding: { elementId: "b", focus: 0, gap: 4 },
        }),
      ]),
    );
    // Geometry says these ends touch nothing; the bindings still win.
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("attaches a nearby loose label to the arrow it annotates", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
        drawn({ id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 60 }),
        drawn({ id: "arrow", type: "arrow", x: 105, y: 30, width: 190, height: 0, points: [[0, 0], [190, 0]] }),
        drawn({ id: "lbl", type: "text", x: 180, y: 10, width: 40, height: 18, text: "reads" }),
      ]),
    );
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b", label: "reads" });
  });

  it("reports genuinely stray content instead of hiding it", () => {
    const graph = readGraph(
      boardOf([
        drawn({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
        drawn({ id: "note", type: "text", x: 900, y: 900, width: 200, height: 20, text: "TODO: split this" }),
      ]),
    );
    expect(graph.unattributed).toEqual([
      expect.objectContaining({ elementId: "note", type: "text", text: "TODO: split this" }),
    ]);
  });
});

describe("reading a mixed board", () => {
  it("keeps generated nodes exact while inferring the sketched ones", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "Services",
      nodes: [
        { id: "api", label: "API" },
        { id: "db", label: "DB" },
      ],
      edges: [{ from: "api", to: "db", label: "query" }],
    });

    // The user then sketches a box of their own next to it.
    const sketched = boardOf([
      ...board.elements,
      drawn({ id: "mine", type: "rectangle", x: 0, y: 900, width: 200, height: 100 }),
      drawn({ id: "mine-text", type: "text", x: 60, y: 940, width: 80, height: 20, text: "Cache" }),
    ]);

    const graph = readGraph(sketched);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(byId.get("api")).toMatchObject({ label: "API", provenance: "recorded" });
    expect(byId.get("db")).toMatchObject({ label: "DB", provenance: "recorded" });
    expect(byId.get("mine")).toMatchObject({ label: "Cache", provenance: "inferred" });
    expect(graph.edges).toEqual([
      expect.objectContaining({ from: "api", to: "db", label: "query", provenance: "recorded" }),
    ]);
    expect(graph.title).toBe("Services");
  }, 60_000);

  it("survives a round trip through create and read without drift", async () => {
    const nodes = [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
      { id: "three", label: "Three" },
    ];
    const edges = [
      { from: "one", to: "two", label: "a" },
      { from: "two", to: "three", label: "b" },
      { from: "one", to: "three" },
    ];
    const { board } = await createDiagram(emptyBoard(), { title: "Round trip", nodes, edges });
    const graph = readGraph(board);

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["one", "three", "two"]);
    expect(graph.nodes.map((node) => node.label).sort()).toEqual(["One", "Three", "Two"]);
    expect(
      graph.edges.map((edge) => `${edge.from}->${edge.to}${edge.label ? `:${edge.label}` : ""}`).sort(),
    ).toEqual(["one->three", "one->two:a", "two->three:b"]);
  }, 60_000);
});

describe("one diagram per file", () => {
  it("replaces a previous generated diagram instead of stacking a second", async () => {
    const first = await createDiagram(emptyBoard(), {
      title: "V1",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    });
    const second = await createDiagram(first.board, {
      title: "V2",
      nodes: [{ id: "a", label: "A" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "c" }],
    });

    expect(second.replacedCount).toBeGreaterThan(0);
    const graph = readGraph(second.board);
    expect(graph.title).toBe("V2");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["a", "c"]);
    // The stale node is gone, not merely hidden behind the new one.
    expect(graph.nodes.some((node) => node.id === "b")).toBe(false);
    expect(graph.unattributed).toHaveLength(0);
  }, 60_000);

  it("never removes hand-drawn elements when regenerating", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "V1",
      nodes: [{ id: "a", label: "A" }],
      edges: [],
    });
    const sketched = {
      ...board,
      elements: [
        ...board.elements,
        drawn({ id: "mine", type: "rectangle", x: 0, y: 900, width: 200, height: 100 }),
        drawn({ id: "mine-text", type: "text", x: 60, y: 940, width: 80, height: 20, text: "Keep me" }),
      ],
    };

    const regenerated = await createDiagram(sketched, {
      title: "V2",
      nodes: [{ id: "z", label: "Z" }],
      edges: [],
    });
    expect(regenerated.keptHandDrawn).toBe(2);

    const graph = readGraph(regenerated.board);
    expect(graph.nodes.find((node) => node.id === "mine")).toMatchObject({
      label: "Keep me",
      provenance: "inferred",
    });
  }, 60_000);

  it("appends only when explicitly asked", async () => {
    const first = await createDiagram(emptyBoard(), {
      title: "One",
      nodes: [{ id: "a", label: "A" }],
      edges: [],
    });
    const second = await createDiagram(first.board, {
      title: "Two",
      nodes: [{ id: "b", label: "B" }],
      edges: [],
      append: true,
    });
    expect(second.replacedCount).toBe(0);
    expect(readGraph(second.board).nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
  }, 60_000);

  it("refuses an ambiguous node id rather than binding to the wrong shape", async () => {
    const first = await createDiagram(emptyBoard(), {
      nodes: [{ id: "shared", label: "First" }, { id: "x", label: "X" }],
      edges: [],
      name: "one",
    });
    const both = await createDiagram(first.board, {
      nodes: [{ id: "shared", label: "Second" }, { id: "y", label: "Y" }],
      edges: [],
      name: "two",
      append: true,
    });

    await expect(connectNodes(both.board, [{ from: "shared", to: "y" }])).rejects.toThrow(
      /matches 2 nodes/,
    );
    // An unambiguous id in the same board still works.
    await expect(connectNodes(both.board, [{ from: "x", to: "y" }])).resolves.toBeTruthy();
  }, 60_000);

  it("drops connectors left dangling by a regenerated diagram", async () => {
    const first = await createDiagram(emptyBoard(), {
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [],
    });
    const linked = await connectNodes(first.board, [{ from: "a", to: "b", label: "link" }]);
    expect(linked.created).toHaveLength(1);

    const regenerated = await createDiagram(linked.board, {
      nodes: [{ id: "c", label: "C" }],
      edges: [],
    });
    const ids = new Set(regenerated.board.elements.map((element) => String(element.id)));
    for (const arrow of regenerated.board.elements.filter((element) => element.type === "arrow")) {
      const start = (arrow.startBinding as { elementId?: string } | null)?.elementId;
      expect(start === undefined || ids.has(start), `dangling connector ${arrow.id}`).toBe(true);
    }
  }, 60_000);

  /**
   * The count alone was misleading in practice: a board holding two diagrams
   * reported "replaced 154 elements" without saying that both were gone.
   */
  it("names every diagram a regenerate replaced, not just how many elements", async () => {
    const first = await createDiagram(emptyBoard(), {
      nodes: [{ id: "a", label: "A" }],
      edges: [],
      name: "arch",
    });
    const both = await createDiagram(first.board, {
      nodes: [{ id: "b", label: "B" }],
      edges: [],
      name: "ims",
      append: true,
    });
    expect(listDiagrams(both.board).map((diagram) => diagram.name)).toEqual(["arch", "ims"]);

    const third = await createDiagram(both.board, { nodes: [{ id: "c", label: "C" }], edges: [] });
    expect(third.replacedDiagrams).toEqual(["arch", "ims"]);
    expect(third.replacedCount).toBeGreaterThan(1);
  }, 60_000);
});

describe("deleting a diagram", () => {
  it("removes one diagram and leaves the other intact", async () => {
    const first = await createDiagram(emptyBoard(), {
      title: "Architecture",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
      name: "arch",
    });
    const both = await createDiagram(first.board, {
      nodes: [{ id: "x", label: "X" }],
      edges: [],
      name: "ims",
      append: true,
    });

    const result = deleteDiagram(both.board, "arch");
    expect(result.deleted).toEqual(["arch"]);
    expect(result.deletedElements).toBeGreaterThan(0);
    expect(result.remaining).toEqual(["ims"]);

    const graph = readGraph(result.board);
    expect(graph.nodes.map((node) => node.id)).toEqual(["x"]);
    // The deleted diagram's title and labels go too, rather than surviving as
    // floating text that readGraph would report as hand-drawn.
    expect(graph.unattributed).toHaveLength(0);
    expect(graph.title).toBeUndefined();
  }, 60_000);

  it("lists diagrams with the names delete takes", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "Request path",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    });
    expect(listDiagrams(board)).toEqual([
      { name: "request-path", title: "Request path", nodes: 2, elements: expect.any(Number) },
    ]);
  }, 60_000);

  it("keeps hand-drawn work and sweeps its own connectors", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [],
    });
    const linked = await connectNodes(board, [{ from: "a", to: "b", label: "link" }]);
    const sketched = {
      ...linked.board,
      elements: [
        ...linked.board.elements,
        drawn({ id: "mine", type: "rectangle", x: 0, y: 900, width: 200, height: 100 }),
      ],
    };

    const result = deleteDiagram(sketched);
    expect(result.keptHandDrawn).toBe(1);
    expect(result.remaining).toEqual([]);
    // A connector whose endpoints are gone must go with them.
    expect(result.board.elements.filter((element) => element.type === "arrow")).toHaveLength(0);
    expect(result.board.elements.map((element) => String(element.id))).toContain("mine");
  }, 60_000);

  /**
   * The count has to match what left the board. Counting only the elements
   * tagged as belonging to the diagram missed the labels and connectors swept
   * with them, which on a real board understated the total by a quarter.
   */
  it("reports the number of elements that actually went", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "Counted",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", label: "flow" }],
    });
    // Labels written before the origin marker carry no customData at all, so
    // they are only reachable through their container.
    const older = {
      ...board,
      elements: board.elements.map((element) =>
        typeof element.containerId === "string" ? { ...element, customData: undefined } : element,
      ),
    };
    const liveBefore = older.elements.filter((element) => element.isDeleted !== true).length;

    const result = deleteDiagram(older);
    expect(result.board.elements.filter((element) => element.isDeleted !== true)).toHaveLength(0);
    expect(result.deletedElements).toBe(liveBefore);
  }, 60_000);

  it("refuses an unknown name and says what is available", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      nodes: [{ id: "a", label: "A" }],
      edges: [],
      name: "arch",
    });
    // Silently deleting nothing is the dangerous outcome here: it reads exactly
    // like success, so the caller believes the diagram is gone.
    expect(() => deleteDiagram(board, "achr")).toThrow(/Available: arch/);
  }, 60_000);

  it("finds diagrams on boards written before the membership marker", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      title: "Old",
      nodes: [{ id: "a", label: "A" }],
      edges: [],
      name: "legacy",
    });
    // Strip customData.diagram to match what earlier versions wrote.
    const older = {
      ...board,
      elements: board.elements.map((element) => {
        const { diagram: _dropped, ...rest } = (element.customData ?? {}) as Record<string, unknown>;
        return { ...element, customData: rest };
      }),
    };

    expect(listDiagrams(older).map((diagram) => diagram.name)).toEqual(["legacy"]);
    const result = deleteDiagram(older, "legacy");
    expect(result.remaining).toEqual([]);
    expect(readGraph(result.board).nodes).toHaveLength(0);
  }, 60_000);
});
