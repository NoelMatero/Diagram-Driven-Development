/**
 * Graph -> laid-out Excalidraw skeletons.
 *
 * ELK decides the geometry; this turns its result into the skeleton shapes the
 * converter understands, with real font metrics behind every size so a label
 * never overflows the box drawn for it. Callers supply meaning (nodes, edges,
 * labels) and never coordinates.
 */
import ELK from "elkjs/lib/elk.bundled";
import { readableInk } from "./contrast";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

type JsonObject = Record<string, unknown>;

export type GraphShape = "rectangle" | "diamond" | "ellipse";
export type GraphNode = {
  id: string;
  label: string;
  shape?: GraphShape;
  /** Compatibility for diagrams created before `shape` became canonical. */
  kind?: "box" | "diamond" | "ellipse";
  backgroundColor?: string;
  strokeColor?: string;
  rounded?: boolean;
};
export type GraphEdge = { from: string; to: string; label?: string; strokeColor?: string };
export type DiagramLayoutOptions = {
  direction?: "RIGHT" | "DOWN";
  nodeSpacing?: number;
  layerSpacing?: number;
};
export type LayoutParams = {
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  anchor?: string;
  anchorDirection?: "right" | "left" | "above" | "below";
  layout?: DiagramLayoutOptions;
};

export interface DiagramPlan {
  skeletons: JsonObject[];
  nodeCount: number;
  edgeCount: number;
  edgeLabelCount: number;
  elementIdByNode: Map<string, string>;
  idPrefix: string;
  graphWidth: number;
}

export const MODEL_GRID_SIZE = 20;

const NODE_FONT_SIZE = 20;
const EDGE_LABEL_FONT_SIZE = 16;
// fontFamily 5 in Excalidraw's FONT_FAMILY map; the editor loads this face,
// so canvas measureText below measures the genuinely rendered font.
const DIAGRAM_FONT_CSS = "Excalifont";
// Fallback ratio for headless environments (tests) where no canvas 2D
// context exists and the real font cannot be measured.
const FALLBACK_CHAR_WIDTH_RATIO = 0.62;
const LINE_HEIGHT_RATIO = 1.3;
const NODE_PADDING_X = 48;
const NODE_PADDING_Y = 36;
const NODE_MIN_WIDTH = 160;
const NODE_MAX_WIDTH = 440;
const NODE_MIN_HEIGHT = 80;
const NODE_TEXT_WRAP_WIDTH = 280;
// Ports separated by more than one grid cell can never snap onto each other.
const PORT_SPACING = 28;

const elk = new ELK();

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function snapModelCoordinate(value: unknown, fallback = 0): number {
  return Math.round(finiteNumber(value, fallback) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
}

export function snapModelSize(value: unknown, fallback: number): number {
  return Math.max(MODEL_GRID_SIZE, snapModelCoordinate(value, fallback));
}

function snapUpSize(value: number): number {
  return Math.max(MODEL_GRID_SIZE, Math.ceil(value / MODEL_GRID_SIZE) * MODEL_GRID_SIZE);
}

export function nodeToType(node: GraphNode): GraphShape {
  if (node.shape) return node.shape;
  if (node.kind === "diamond") return "diamond";
  if (node.kind === "ellipse") return "ellipse";
  return "rectangle";
}

let measuringContext: CanvasRenderingContext2D | null | undefined;

function fontMeasuringContext(): CanvasRenderingContext2D | null {
  if (measuringContext !== undefined) return measuringContext;
  measuringContext = typeof document !== "undefined"
    ? document.createElement("canvas").getContext("2d")
    : null;
  return measuringContext;
}

export type DiagramTextMeasurer = (text: string, fontSize: number, fontFamily: string) => number | null;

let measurerOverride: DiagramTextMeasurer | null = null;

/** Node test runs install a measurer parsed from the real font files. */
export function setDiagramTextMeasurer(measurer: DiagramTextMeasurer | null): void {
  measurerOverride = measurer;
}

/**
 * Measures the width the rendered font actually produces: an installed
 * measurer first (tests parse the shipped Excalifont), then the browser
 * canvas with the loaded face. The average-glyph estimate is a last resort
 * for environments with neither.
 */
export function measureText(
  text: string,
  fontSize: number,
  fontFamily = DIAGRAM_FONT_CSS,
): { width: number; height: number } {
  const height = fontSize * LINE_HEIGHT_RATIO;
  const overridden = measurerOverride?.(text, fontSize, fontFamily);
  if (typeof overridden === "number" && Number.isFinite(overridden) && overridden > 0) {
    return { width: overridden, height };
  }
  const context = fontMeasuringContext();
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`;
    const width = context.measureText(text).width;
    if (Number.isFinite(width) && width > 0) return { width, height };
  }
  return { width: Math.max(1, text.length) * fontSize * FALLBACK_CHAR_WIDTH_RATIO, height };
}

export function wrapLabel(
  label: string,
  fontSize = NODE_FONT_SIZE,
  maxWidth = NODE_TEXT_WRAP_WIDTH,
): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measureText(candidate, fontSize).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Excalidraw wraps bound text to the container's inscribed area, not its
 * bounding box: a diamond offers about half its width at the label band and
 * an ellipse about width/sqrt(2). Oversize those shapes accordingly.
 */
function shapeFactor(shape: GraphShape): number {
  if (shape === "diamond") return 2;
  if (shape === "ellipse") return Math.SQRT2;
  return 1;
}

export function nodeDimensions(
  node: GraphNode,
  portDemand = 0,
  direction: "RIGHT" | "DOWN" = "RIGHT",
): { width: number; height: number } {
  const factor = shapeFactor(nodeToType(node));
  const lines = wrapLabel(node.label, NODE_FONT_SIZE, NODE_TEXT_WRAP_WIDTH / factor);
  const textWidth = lines.reduce((max, line) => Math.max(max, measureText(line, NODE_FONT_SIZE).width), 1);
  const textHeight = lines.length * NODE_FONT_SIZE * LINE_HEIGHT_RATIO;
  // Ports land on the side facing the previous layer: vertical sides in a
  // RIGHT layout, horizontal sides in a DOWN layout. That side needs room
  // for every connector to stay more than one grid cell apart.
  const portSide = (portDemand + 1) * PORT_SPACING;
  const width = Math.max(
    Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, textWidth * factor + NODE_PADDING_X)),
    direction === "DOWN" ? portSide : 0,
  );
  const height = Math.max(
    NODE_MIN_HEIGHT,
    textHeight * factor + NODE_PADDING_Y,
    direction === "RIGHT" ? portSide : 0,
  );
  return { width: snapUpSize(width), height: snapUpSize(height) };
}

function validateGraph(params: LayoutParams): void {
  if (!Array.isArray(params?.nodes) || params.nodes.length === 0) {
    throw new Error("layout-diagram requires at least one node");
  }
  const nodeIds = new Set<string>();
  for (const node of params.nodes) {
    if (!node?.id || !node.label || nodeIds.has(node.id)) {
      throw new Error("Diagram nodes require unique ids and non-empty labels");
    }
    if (node.shape && !["rectangle", "diamond", "ellipse"].includes(node.shape)) {
      throw new Error(`Diagram node ${node.id} has an unsupported shape`);
    }
    nodeIds.add(node.id);
  }
  for (const edge of params.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Diagram edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
  }
}

function dedupePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.filter((point, index) => index === 0
    || point.x !== points[index - 1].x
    || point.y !== points[index - 1].y);
}

export async function planDiagramLayout(
  params: LayoutParams,
  origin: { x: number; y: number },
  idPrefix = `agent-${Date.now().toString(36)}`,
): Promise<DiagramPlan> {
  validateGraph(params);
  const edges = params.edges ?? [];
  const direction = params.layout?.direction ?? "RIGHT";
  const nodeSpacing = Math.min(240, Math.max(60, snapModelCoordinate(params.layout?.nodeSpacing, 80)));
  const layerSpacing = Math.min(360, Math.max(80, snapModelCoordinate(params.layout?.layerSpacing, 140)));

  const degreeIn = new Map<string, number>();
  const degreeOut = new Map<string, number>();
  for (const edge of edges) {
    degreeOut.set(edge.from, (degreeOut.get(edge.from) ?? 0) + 1);
    degreeIn.set(edge.to, (degreeIn.get(edge.to) ?? 0) + 1);
  }
  const sizes = new Map(params.nodes.map((node) => [
    node.id,
    nodeDimensions(node, Math.max(degreeIn.get(node.id) ?? 0, degreeOut.get(node.id) ?? 0), direction),
  ]));

  const layoutResult = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
      // Channel spacing stays above one grid cell so snapping can never merge
      // two parallel routes or a route into a node border.
      "elk.spacing.edgeNode": "40",
      "elk.spacing.edgeEdge": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
      "elk.spacing.edgeLabel": "10",
    },
    children: params.nodes.map((node) => ({
      id: node.id,
      width: sizes.get(node.id)?.width ?? NODE_MIN_WIDTH,
      height: sizes.get(node.id)?.height ?? NODE_MIN_HEIGHT,
    })),
    edges: edges.map((edge, index) => ({
      id: `edge-${index}`,
      sources: [edge.from],
      targets: [edge.to],
      ...(edge.label?.trim()
        ? {
            labels: [{
              text: edge.label.trim(),
              ...measureText(edge.label.trim(), EDGE_LABEL_FONT_SIZE),
            }],
          }
        : {}),
    })),
  });

  const positions = new Map<string, { x: number; y: number }>(
    (layoutResult.children ?? []).map((node: ElkNode) => [node.id, {
      x: snapModelCoordinate(node.x),
      y: snapModelCoordinate(node.y),
    }]),
  );
  const elkEdges = (layoutResult.edges ?? []) as ElkExtendedEdge[];
  const elementIdByNode = new Map(
    params.nodes.map((node, index) => [node.id, `${idPrefix}-node-${index}`]),
  );

  const nodeSkeletons: JsonObject[] = params.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const size = sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const type = nodeToType(node);
    return {
      id: elementIdByNode.get(node.id),
      type,
      x: snapModelCoordinate(origin.x + position.x),
      y: snapModelCoordinate(origin.y + position.y),
      width: size.width,
      height: size.height,
      strokeColor: node.strokeColor ?? "#1e1e1e",
      backgroundColor: node.backgroundColor ?? "transparent",
      ...(node.backgroundColor && node.backgroundColor !== "transparent" ? { fillStyle: "solid" } : {}),
      ...(type === "rectangle" && node.rounded ? { roundness: { type: 3 } } : {}),
      // Excalidraw would give the label the container's stroke colour, which
      // on a filled shape can be nearly the same colour as the fill.
      label: {
        text: node.label,
        strokeColor: readableInk(node.backgroundColor, node.strokeColor ?? "#1e1e1e"),
      },
    };
  });

  const edgeSkeletons: JsonObject[] = [];
  const edgeLabelSkeletons: JsonObject[] = [];
  for (const [index, edge] of edges.entries()) {
    const elkEdge = elkEdges.find((candidate) => candidate.id === `edge-${index}`);
    const section = elkEdge?.sections?.[0];
    const fromPosition = positions.get(edge.from) ?? { x: 0, y: 0 };
    const toPosition = positions.get(edge.to) ?? { x: 0, y: 0 };
    const fromSize = sizes.get(edge.from) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const toSize = sizes.get(edge.to) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    // ELK routes to distributed border points; fall back to side midpoints
    // only if a section is missing entirely.
    const fallbackStart = {
      x: fromPosition.x + fromSize.width,
      y: fromPosition.y + fromSize.height / 2,
    };
    const fallbackEnd = { x: toPosition.x, y: toPosition.y + toSize.height / 2 };
    // Routes stay unsnapped: ELK separates parallel runs by as little as
    // 16 px, and snapping those channels onto the 20 px grid is exactly what
    // merges arrows into one overlapping line.
    const absoluteRoute = dedupePoints([
      section?.startPoint ?? fallbackStart,
      ...(section?.bendPoints ?? []),
      section?.endPoint ?? fallbackEnd,
    ].map((point) => ({
      x: origin.x + point.x,
      y: origin.y + point.y,
    })));
    const routeOrigin = absoluteRoute[0];
    edgeSkeletons.push({
      id: `${idPrefix}-edge-${index}`,
      type: "arrow",
      x: routeOrigin.x,
      y: routeOrigin.y,
      points: absoluteRoute.map((point) => [point.x - routeOrigin.x, point.y - routeOrigin.y]),
      start: { id: elementIdByNode.get(edge.from) },
      end: { id: elementIdByNode.get(edge.to) },
      endArrowhead: "arrow",
      strokeColor: edge.strokeColor ?? "#1e1e1e",
    });
    const label = elkEdge?.labels?.[0];
    if (label?.text) {
      const size = measureText(label.text, EDGE_LABEL_FONT_SIZE);
      edgeLabelSkeletons.push({
        id: `${idPrefix}-edgelabel-${index}`,
        type: "text",
        x: origin.x + finiteNumber(label.x),
        y: origin.y + finiteNumber(label.y),
        width: size.width,
        height: size.height,
        text: label.text,
        fontSize: EDGE_LABEL_FONT_SIZE,
        fontFamily: 5,
        // Edge labels sit on the canvas, not on a fill, so they follow the
        // edge's own colour.
        strokeColor: edge.strokeColor ?? "#1e1e1e",
        backgroundColor: "transparent",
      });
    }
  }

  const graphWidth = snapUpSize(Math.max(
    360,
    finiteNumber((layoutResult as ElkNode).width, 0),
    ...[...positions.entries()].map(([id, position]) => position.x + (sizes.get(id)?.width ?? 0)),
  ));
  const title = params.title?.trim();
  // Top-left, its own measured width, and a full band of headroom: a title
  // centered across the graph sits exactly where inbound arrows and
  // neighboring clusters land.
  const titleSize = title ? measureText(title, 24) : { width: 0, height: 0 };
  const skeletons: JsonObject[] = [
    ...(title ? [{
      id: `${idPrefix}-title`,
      type: "text",
      x: origin.x,
      y: snapModelCoordinate(origin.y - 100),
      width: titleSize.width,
      height: 40,
      text: title,
      fontSize: 24,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "middle",
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
    }] : []),
    ...nodeSkeletons,
    ...edgeSkeletons,
    ...edgeLabelSkeletons,
  ];

  return {
    skeletons,
    nodeCount: params.nodes.length,
    edgeCount: edges.length,
    edgeLabelCount: edgeLabelSkeletons.length,
    elementIdByNode,
    idPrefix,
    graphWidth,
  };
}

export interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function planBounds(plan: DiagramPlan): PlanBounds {
  const bounds: PlanBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  const include = (x: number, y: number) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  for (const skeleton of plan.skeletons) {
    const x = finiteNumber(skeleton.x);
    const y = finiteNumber(skeleton.y);
    if (skeleton.type === "arrow" && Array.isArray(skeleton.points)) {
      for (const point of skeleton.points as Array<[number, number]>) {
        include(x + finiteNumber(point[0]), y + finiteNumber(point[1]));
      }
    } else {
      include(x, y);
      include(x + finiteNumber(skeleton.width), y + finiteNumber(skeleton.height));
    }
  }
  if (!Number.isFinite(bounds.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return bounds;
}

/** Shifts a plan wholesale; arrow points are relative and move with x/y. */
export function translatePlan(plan: DiagramPlan, dx: number, dy: number): void {
  for (const skeleton of plan.skeletons) {
    if (typeof skeleton.x === "number") skeleton.x += dx;
    if (typeof skeleton.y === "number") skeleton.y += dy;
  }
}

export interface DiagramQualityReport {
  nodeOverlaps: string[];
  labelCollisions: string[];
  edgesThroughNodes: string[];
  sharedPorts: string[];
  overlappingParallelSegments: string[];
  offGrid: string[];
}

type Box = { id: string; x: number; y: number; width: number; height: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.width + margin
    && b.x < a.x + a.width + margin
    && a.y < b.y + b.height + margin
    && b.y < a.y + a.height + margin;
}

function segmentIntersectsBox(segment: Segment, box: Box, shrink: number): boolean {
  const left = box.x + shrink;
  const right = box.x + box.width - shrink;
  const top = box.y + shrink;
  const bottom = box.y + box.height - shrink;
  if (left >= right || top >= bottom) return false;
  // Orthogonal segments cover the layout output; a conservative bbox check
  // covers any residual diagonal.
  const minX = Math.min(segment.x1, segment.x2);
  const maxX = Math.max(segment.x1, segment.x2);
  const minY = Math.min(segment.y1, segment.y2);
  const maxY = Math.max(segment.y1, segment.y2);
  return minX < right && maxX > left && minY < bottom && maxY > top;
}

function arrowSegments(arrow: JsonObject): Segment[] {
  const originX = finiteNumber(arrow.x);
  const originY = finiteNumber(arrow.y);
  const points = (Array.isArray(arrow.points) ? arrow.points : []) as Array<[number, number]>;
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index++) {
    segments.push({
      x1: originX + points[index - 1][0],
      y1: originY + points[index - 1][1],
      x2: originX + points[index][0],
      y2: originY + points[index][1],
    });
  }
  return segments;
}

export function evaluateDiagramPlan(plan: DiagramPlan): DiagramQualityReport {
  const report: DiagramQualityReport = {
    nodeOverlaps: [],
    labelCollisions: [],
    edgesThroughNodes: [],
    sharedPorts: [],
    overlappingParallelSegments: [],
    offGrid: [],
  };
  const nodes: Box[] = [];
  const labels: Box[] = [];
  const arrows: JsonObject[] = [];
  for (const skeleton of plan.skeletons) {
    const id = String(skeleton.id ?? "");
    const box: Box = {
      id,
      x: finiteNumber(skeleton.x),
      y: finiteNumber(skeleton.y),
      width: finiteNumber(skeleton.width),
      height: finiteNumber(skeleton.height),
    };
    if (skeleton.type === "arrow") arrows.push(skeleton);
    else if (id.includes("-node-")) nodes.push(box);
    // The title competes for the same space as edge labels; hold it to the
    // same collision standard.
    else if (id.includes("-edgelabel-") || id.endsWith("-title")) labels.push(box);
  }

  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (boxesOverlap(nodes[a], nodes[b])) report.nodeOverlaps.push(`${nodes[a].id} x ${nodes[b].id}`);
    }
  }

  for (const label of labels) {
    for (const node of nodes) {
      if (boxesOverlap(label, node)) report.labelCollisions.push(`${label.id} x ${node.id}`);
    }
    for (const other of labels) {
      if (other.id <= label.id) continue;
      if (boxesOverlap(label, other)) report.labelCollisions.push(`${label.id} x ${other.id}`);
    }
  }

  const portsByNode = new Map<string, Map<string, string>>();
  for (const arrow of arrows) {
    const segments = arrowSegments(arrow);
    const startNode = String((arrow.start as { id?: string } | undefined)?.id ?? "");
    const endNode = String((arrow.end as { id?: string } | undefined)?.id ?? "");
    for (const node of nodes) {
      if (node.id === startNode || node.id === endNode) continue;
      if (segments.some((segment) => segmentIntersectsBox(segment, node, 4))) {
        report.edgesThroughNodes.push(`${String(arrow.id)} x ${node.id}`);
      }
    }
    const points = (Array.isArray(arrow.points) ? arrow.points : []) as Array<[number, number]>;
    if (points.length >= 2) {
      const endpoints: Array<[string, [number, number]]> = [
        [startNode, points[0]],
        [endNode, points[points.length - 1]],
      ];
      for (const [nodeId, point] of endpoints) {
        if (!nodeId) continue;
        const absolute = `${finiteNumber(arrow.x) + point[0]},${finiteNumber(arrow.y) + point[1]}`;
        const ports = portsByNode.get(nodeId) ?? new Map<string, string>();
        const owner = ports.get(absolute);
        if (owner && owner !== String(arrow.id)) {
          report.sharedPorts.push(`${nodeId} @ ${absolute} (${owner}, ${String(arrow.id)})`);
        }
        ports.set(absolute, String(arrow.id));
        portsByNode.set(nodeId, ports);
      }
    }
  }

  for (let a = 0; a < arrows.length; a++) {
    for (let b = a + 1; b < arrows.length; b++) {
      for (const first of arrowSegments(arrows[a])) {
        for (const second of arrowSegments(arrows[b])) {
          const firstVertical = Math.abs(first.x1 - first.x2) < 1;
          const secondVertical = Math.abs(second.x1 - second.x2) < 1;
          if (firstVertical !== secondVertical) continue;
          if (firstVertical) {
            if (Math.abs(first.x1 - second.x1) >= 2) continue;
            const overlap = Math.min(Math.max(first.y1, first.y2), Math.max(second.y1, second.y2))
              - Math.max(Math.min(first.y1, first.y2), Math.min(second.y1, second.y2));
            if (overlap > 10) {
              report.overlappingParallelSegments.push(`${String(arrows[a].id)} x ${String(arrows[b].id)}`);
            }
          } else {
            if (Math.abs(first.y1 - second.y1) >= 2) continue;
            const overlap = Math.min(Math.max(first.x1, first.x2), Math.max(second.x1, second.x2))
              - Math.max(Math.min(first.x1, first.x2), Math.min(second.x1, second.x2));
            if (overlap > 10) {
              report.overlappingParallelSegments.push(`${String(arrows[a].id)} x ${String(arrows[b].id)}`);
            }
          }
        }
      }
    }
  }

  // Only shapes live on the hidden grid; connector routes and edge labels
  // keep ELK's exact channel geometry.
  for (const skeleton of plan.skeletons) {
    if (skeleton.type === "text" || skeleton.type === "arrow") continue;
    for (const key of ["x", "y", "width", "height"] as const) {
      const value = skeleton[key];
      if (typeof value === "number" && value % MODEL_GRID_SIZE !== 0) {
        report.offGrid.push(`${String(skeleton.id)}.${key}=${value}`);
      }
    }
  }

  return report;
}
