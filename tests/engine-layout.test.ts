import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MODEL_GRID_SIZE,
  evaluateDiagramPlan,
  measureText,
  nodeDimensions,
  planDiagramLayout,
  wrapLabel,
  type LayoutParams,
} from "../src/engine/layout";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 200, y: 200 };

/** The exact architecture diagram the user drew that came out tangled. */
const planningDiagram: LayoutParams = {
  title: "Voice coding architecture",
  nodes: [
    { id: "plan", label: "Planning Model", shape: "rectangle", rounded: true, backgroundColor: "#d1f7c4" },
    { id: "tests", label: "Local Coder • Tests", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "backend", label: "Local Coder • Backend", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "frontend", label: "Local Coder • Frontend", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "runtime", label: "Local Runtime / Workspace", shape: "rectangle", rounded: true, backgroundColor: "#efe2fd" },
    { id: "voice", label: "Voice Assistant / Orchestrator", shape: "ellipse", backgroundColor: "#d6e6ff" },
  ],
  edges: [
    { from: "plan", to: "tests", label: "tasks" },
    { from: "plan", to: "backend", label: "tasks" },
    { from: "plan", to: "frontend", label: "tasks" },
    { from: "tests", to: "plan", label: "tasks" },
    { from: "backend", to: "runtime", label: "code" },
    { from: "backend", to: "runtime", label: "verify" },
    { from: "runtime", to: "voice", label: "results" },
    { from: "frontend", to: "voice", label: "delegate" },
  ],
};

const stressGraphs: Array<{ name: string; params: LayoutParams }> = [
  { name: "user planning diagram", params: planningDiagram },
  {
    name: "fan-in of eight labelled edges",
    params: {
      nodes: [
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `source-${index}`,
          label: `Producer ${index + 1}`,
        })),
        { id: "sink", label: "Aggregator", shape: "rectangle" },
      ],
      edges: Array.from({ length: 8 }, (_, index) => ({
        from: `source-${index}`,
        to: "sink",
        label: index % 2 === 0 ? "emit" : "flush",
      })),
    },
  },
  {
    name: "fan-out of eight",
    params: {
      nodes: [
        { id: "hub", label: "Dispatcher", shape: "diamond" },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `worker-${index}`,
          label: `Worker ${index + 1}`,
        })),
      ],
      edges: Array.from({ length: 8 }, (_, index) => ({
        from: "hub",
        to: `worker-${index}`,
        label: "job",
      })),
    },
  },
  {
    name: "twelve-node chain",
    params: {
      layout: { direction: "DOWN" },
      nodes: Array.from({ length: 12 }, (_, index) => ({
        id: `step-${index}`,
        label: `Step ${index + 1}`,
      })),
      edges: Array.from({ length: 11 }, (_, index) => ({
        from: `step-${index}`,
        to: `step-${index + 1}`,
        label: index % 3 === 0 ? "then" : undefined,
      })),
    },
  },
  {
    name: "dense bipartite mesh",
    params: {
      nodes: [
        ...Array.from({ length: 4 }, (_, index) => ({ id: `left-${index}`, label: `Service ${index + 1}` })),
        ...Array.from({ length: 4 }, (_, index) => ({ id: `right-${index}`, label: `Queue ${index + 1}` })),
      ],
      edges: Array.from({ length: 16 }, (_, index) => ({
        from: `left-${Math.floor(index / 4)}`,
        to: `right-${index % 4}`,
      })),
    },
  },
  {
    name: "long labels across shapes",
    params: {
      nodes: [
        { id: "a", label: "Authentication and session management gateway", shape: "rectangle" },
        { id: "b", label: "Is the refresh token still within its validity window?", shape: "diamond" },
        { id: "c", label: "Long-running background reconciliation loop", shape: "ellipse" },
        { id: "d", label: "OK", shape: "rectangle" },
      ],
      edges: [
        { from: "a", to: "b", label: "validate" },
        { from: "b", to: "c", label: "expired so re-enroll" },
        { from: "b", to: "d", label: "still valid" },
        { from: "c", to: "a", label: "retry" },
      ],
    },
  },
  {
    name: "decision tree with yes/no labels",
    params: {
      layout: { direction: "DOWN" },
      nodes: [
        { id: "start", label: "Request", shape: "ellipse" },
        { id: "auth", label: "Authenticated?", shape: "diamond" },
        { id: "quota", label: "Quota left?", shape: "diamond" },
        { id: "serve", label: "Serve", shape: "rectangle" },
        { id: "deny", label: "Deny", shape: "rectangle" },
        { id: "bill", label: "Bill account", shape: "rectangle" },
      ],
      edges: [
        { from: "start", to: "auth" },
        { from: "auth", to: "quota", label: "yes" },
        { from: "auth", to: "deny", label: "no" },
        { from: "quota", to: "serve", label: "yes" },
        { from: "quota", to: "deny", label: "no" },
        { from: "serve", to: "bill" },
      ],
    },
  },
  {
    name: "top-to-bottom fan-in (ports spread across node width)",
    params: {
      title: "Task and Verification Loop",
      layout: { direction: "DOWN" },
      nodes: [
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `source-${index}`,
          label: `Stage ${index + 1}`,
        })),
        { id: "ledger", label: "SQLite Runtime Ledger jobs, events, board" },
        { id: "verify", label: "Verify local tests", shape: "diamond" },
      ],
      edges: [
        ...Array.from({ length: 6 }, (_, index) => ({
          from: `source-${index}`,
          to: "ledger",
          label: index % 2 === 0 ? "events" : undefined,
        })),
        { from: "ledger", to: "verify", label: "edit + test" },
        { from: "verify", to: "ledger", label: "pass" },
      ],
    },
  },
  {
    name: "cycle with parallel edges",
    params: {
      nodes: [
        { id: "a", label: "Editor" },
        { id: "b", label: "Compiler" },
        { id: "c", label: "Runner" },
      ],
      edges: [
        { from: "a", to: "b", label: "source" },
        { from: "b", to: "c", label: "binary" },
        { from: "c", to: "a", label: "feedback" },
        { from: "a", to: "b", label: "config" },
      ],
    },
  },
];

describe("diagram layout quality", () => {
  it.each(stressGraphs)("lays out $name without overlaps, shared ports, or collisions", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, "agent-test");
    const report = evaluateDiagramPlan(plan);
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.sharedPorts).toEqual([]);
    expect(report.overlappingParallelSegments).toEqual([]);
    expect(report.offGrid).toEqual([]);
  });

  it.each(stressGraphs)("produces complete, finite geometry for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, "agent-test");
    expect(plan.nodeCount).toBe(params.nodes.length);
    expect(plan.edgeCount).toBe(params.edges.length);
    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows).toHaveLength(params.edges.length);
    for (const arrow of arrows) {
      expect(arrow.start).toBeTruthy();
      expect(arrow.end).toBeTruthy();
      expect((arrow.points as number[][]).length).toBeGreaterThanOrEqual(2);
    }
    for (const skeleton of plan.skeletons) {
      for (const key of ["x", "y", "width", "height"] as const) {
        if (key in skeleton) expect(Number.isFinite(skeleton[key])).toBe(true);
      }
    }
  });

  it("fits every wrapped label line inside its node's usable width", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    const nodesById = new Map(
      plan.skeletons
        .filter((skeleton) => String(skeleton.id).includes("-node-"))
        .map((skeleton) => [String(skeleton.id), skeleton]),
    );
    for (const [index, node] of planningDiagram.nodes.entries()) {
      const skeleton = nodesById.get(`agent-test-node-${index}`);
      expect(skeleton).toBeTruthy();
      const factor = node.shape === "diamond" ? 2 : node.shape === "ellipse" ? Math.SQRT2 : 1;
      const usable = (skeleton!.width as number) / factor - 16;
      for (const line of wrapLabel(node.label)) {
        expect(measureText(line, 20).width).toBeLessThanOrEqual(usable);
      }
    }
  });

  it("grows a node's connector side with its edge degree on the axis edges attach to", () => {
    const quiet = nodeDimensions({ id: "a", label: "Hub" }, 1, "RIGHT");
    const busy = nodeDimensions({ id: "a", label: "Hub" }, 8, "RIGHT");
    expect(busy.height).toBeGreaterThan(quiet.height);
    expect(busy.height).toBeGreaterThanOrEqual(9 * 28);
    // DOWN layouts attach edges along the top and bottom, so width grows.
    const busyDown = nodeDimensions({ id: "a", label: "Hub" }, 8, "DOWN");
    expect(busyDown.width).toBeGreaterThanOrEqual(9 * 28);
    expect(busyDown.height).toBeLessThan(busy.height);
  });

  it("keeps the title clear of nodes, labels, and its own headroom band", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    const title = plan.skeletons.find((skeleton) => String(skeleton.id).endsWith("-title"))!;
    expect(title).toBeTruthy();
    expect(title.textAlign).toBe("left");
    const nodeTops = plan.skeletons
      .filter((skeleton) => String(skeleton.id).includes("-node-"))
      .map((skeleton) => skeleton.y as number);
    // Full headroom band between the title and the top row of nodes.
    expect((title.y as number) + (title.height as number)).toBeLessThanOrEqual(Math.min(...nodeTops) - 40);
  });

  it("measures with the real Excalifont, not the fallback estimate", () => {
    const wide = measureText("WWWW", 20).width;
    const narrow = measureText("iiii", 20).width;
    // The fallback estimate is width-per-character; the real font is not.
    expect(wide).not.toBeCloseTo(narrow, 5);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("snaps node geometry to the hidden model grid", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    for (const skeleton of plan.skeletons) {
      if (skeleton.type === "text" || skeleton.type === "arrow") continue;
      expect((skeleton.x as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.y as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.width as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.height as number) % MODEL_GRID_SIZE).toBe(0);
    }
  });
});
