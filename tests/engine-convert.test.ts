import { describe, expect, it } from "vitest";

import { convertSkeletons, loadConverter } from "../src/engine/convert";
import { normalizeElements } from "../src/engine/normalize";
import { planDiagramLayout } from "../src/engine/layout";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const GRAPH = {
  title: "Request path",
  nodes: [
    { id: "client", label: "Client" },
    { id: "api", label: "API" },
    { id: "db", label: "Database" },
  ],
  edges: [
    { from: "client", to: "api", label: "http" },
    { from: "api", to: "db", label: "query" },
  ],
};

describe("headless Excalidraw conversion", () => {
  // Cold load is ~125ms in plain Node; the generous budget here absorbs
  // vitest's transform pass, which dominates and is not a runtime cost.
  it("loads the pre-bundled converter without a DOM", async () => {
    const started = performance.now();
    await expect(loadConverter()).resolves.toBeTypeOf("function");
    const elapsed = performance.now() - started;
    expect(elapsed, `cold load took ${elapsed.toFixed(0)}ms`).toBeLessThan(20_000);
    // Second call must be cached, not re-parsed.
    const warm = performance.now();
    await loadConverter();
    expect(performance.now() - warm).toBeLessThan(50);
  }, 30_000);

  it("preserves skeleton ids and rewrites bindings to match", async () => {
    const elements = await convertSkeletons([
      { type: "rectangle", id: "box-a", x: 0, y: 0, width: 160, height: 80, label: { text: "API" } },
      { type: "rectangle", id: "box-b", x: 300, y: 0, width: 160, height: 80, label: { text: "DB" } },
      { type: "arrow", id: "edge-1", x: 160, y: 40, width: 140, height: 0, start: { id: "box-a" }, end: { id: "box-b" } },
    ]);

    expect(elements.map((element) => element.id).sort()).toEqual(
      ["box-a", "box-a-label", "box-b", "box-b-label", "edge-1"].sort(),
    );

    const arrow = elements.find((element) => element.type === "arrow");
    expect(arrow?.startBinding).toMatchObject({ elementId: "box-a" });
    expect(arrow?.endBinding).toMatchObject({ elementId: "box-b" });

    // Containers must point back at the labels by their rewritten ids too,
    // otherwise Excalidraw drops the label on load.
    const boxA = elements.find((element) => element.id === "box-a");
    expect(boxA?.boundElements).toEqual(
      expect.arrayContaining([{ id: "box-a-label", type: "text" }]),
    );
    expect(elements.find((element) => element.id === "box-a-label")?.containerId).toBe("box-a");
  });

  it("is byte-identical across runs, so committed boards do not churn", async () => {
    const skeletons = () => [
      { type: "rectangle", id: "n1", x: 0, y: 0, width: 160, height: 80, label: { text: "One" } },
      { type: "ellipse", id: "n2", x: 300, y: 0, width: 160, height: 80, label: { text: "Two" } },
      { type: "arrow", id: "e1", x: 160, y: 40, width: 140, height: 0, start: { id: "n1" }, end: { id: "n2" } },
    ];
    const first = await convertSkeletons(skeletons());
    const second = await convertSkeletons(skeletons());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((element) => Number.isInteger(element.seed))).toBe(true);
  });

  // Excalidraw's own seeds are always below 2^31; matching that keeps every
  // field in our files inside the app's value space.
  it("keeps seeds inside the range Excalidraw itself emits", async () => {
    const elements = await convertSkeletons([
      { type: "rectangle", id: "seed-a", x: 0, y: 0, width: 160, height: 80, label: { text: "A" } },
      { type: "ellipse", id: "seed-b", x: 300, y: 0, width: 160, height: 80, label: { text: "B" } },
      { type: "diamond", id: "seed-c", x: 600, y: 0, width: 160, height: 80, label: { text: "C" } },
      { type: "arrow", id: "seed-d", x: 160, y: 40, width: 140, height: 0, start: { id: "seed-a" }, end: { id: "seed-b" } },
    ]);
    for (const element of elements) {
      expect(element.seed, `${element.id} seed out of range`).toBeGreaterThanOrEqual(0);
      expect(element.seed, `${element.id} seed out of range`).toBeLessThan(2 ** 31);
      expect(element.versionNonce, `${element.id} nonce out of range`).toBeLessThan(2 ** 31);
    }
  });

  it("stamps semantic customData so a drawn graph reads back as a graph", async () => {
    const elements = await convertSkeletons(
      [
        { type: "rectangle", id: "n1", x: 0, y: 0, width: 160, height: 80, label: { text: "API" } },
        { type: "arrow", id: "e1", x: 0, y: 200, width: 100, height: 0 },
      ],
      {
        customData: new Map([
          ["n1", { node: "api" }],
          ["e1", { edge: { from: "api", to: "db" } }],
        ]),
      },
    );
    expect(elements.find((element) => element.id === "n1")?.customData).toEqual({ node: "api" });
    expect(elements.find((element) => element.id === "e1")?.customData).toEqual({
      edge: { from: "api", to: "db" },
    });
  });

  it("rejects skeletons without a stable id", async () => {
    await expect(
      convertSkeletons([{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }]),
    ).rejects.toThrow(/no stable string id/);
  });

  it("rejects duplicate skeleton ids", async () => {
    await expect(
      convertSkeletons([
        { type: "rectangle", id: "dup", x: 0, y: 0, width: 10, height: 10 },
        { type: "rectangle", id: "dup", x: 20, y: 0, width: 10, height: 10 },
      ]),
    ).rejects.toThrow(/Duplicate skeleton ids: dup/);
  });

  it("fails loudly if the converter stops matching skeletons one-to-one", () => {
    expect(() =>
      normalizeElements([{ id: "x", type: "rectangle" }], { skeletonIds: ["a", "b"] }),
    ).toThrow(/output shape changed/);
  });
});

describe("full ELK layout to elements, headless", () => {
  it("lays out and converts a real graph end to end in Node", async () => {
    const plan = await planDiagramLayout(GRAPH, { x: 0, y: 0 }, "diagram");
    const customData = new Map(
      [...plan.elementIdByNode].map(([nodeId, elementId]) => [elementId, { node: nodeId }]),
    );
    const elements = await convertSkeletons(plan.skeletons as Record<string, unknown>[], { customData });

    expect(plan.nodeCount).toBe(3);
    expect(plan.edgeCount).toBe(2);
    expect(elements.length).toBeGreaterThan(plan.skeletons.length);

    // Every node the caller asked for is findable by its semantic id alone.
    for (const nodeId of ["client", "api", "db"]) {
      const element = elements.find(
        (candidate) => (candidate.customData as { node?: string } | undefined)?.node === nodeId,
      );
      expect(element, `no element carries node=${nodeId}`).toBeDefined();
    }

    // Arrows must bind to real elements, not dangle at coordinates.
    const ids = new Set(elements.map((element) => element.id));
    for (const arrow of elements.filter((element) => element.type === "arrow")) {
      const start = (arrow.startBinding as { elementId?: string } | null)?.elementId;
      const end = (arrow.endBinding as { elementId?: string } | null)?.elementId;
      expect(start && ids.has(start), `dangling start on ${arrow.id}`).toBe(true);
      expect(end && ids.has(end), `dangling end on ${arrow.id}`).toBe(true);
    }
  });

  it("produces an identical file for an identical graph", async () => {
    const render = async () => {
      const plan = await planDiagramLayout(GRAPH, { x: 0, y: 0 }, "diagram");
      return JSON.stringify(await convertSkeletons(plan.skeletons as Record<string, unknown>[]));
    };
    expect(await render()).toBe(await render());
  });
});
