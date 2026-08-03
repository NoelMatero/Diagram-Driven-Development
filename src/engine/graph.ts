/**
 * Recovers the semantic graph from a board file.
 *
 * Two kinds of content live on a board and they are read very differently:
 *
 * - Anything this engine drew carries `customData`, so its node and edge
 *   identity is read back exactly, and survives you dragging boxes around.
 * - Anything you drew by hand carries nothing, so it is inferred from
 *   geometry: text inside a shape is that shape's label, an arrow endpoint
 *   near a shape connects to it.
 *
 * Inference is always reported as such. A caller deciding whether to trust a
 * label needs to know whether it was recorded or guessed.
 */
import type { ExcalidrawElement } from "./normalize";
import type { BoardFile } from "./board-file";

export type NodeShape = "rectangle" | "ellipse" | "diamond";
export const NODE_SHAPES: readonly string[] = ["rectangle", "ellipse", "diamond"];

/** How confident we are in a recovered fact. */
export type Provenance = "recorded" | "inferred";

export interface RecoveredNode {
  id: string;
  label: string;
  shape: string;
  elementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  provenance: Provenance;
}

export interface RecoveredEdge {
  from: string;
  to: string;
  label?: string;
  elementId: string;
  provenance: Provenance;
}

export interface RecoveredGraph {
  title?: string;
  nodes: RecoveredNode[];
  edges: RecoveredEdge[];
  /** Elements that are neither node nor edge: annotations, images, strays. */
  unattributed: Array<{ elementId: string; type: string; text?: string; x: number; y: number }>;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How close an unbound arrow endpoint must sit to count as touching a shape. */
const ENDPOINT_TOLERANCE = 24;

function isLive(element: ExcalidrawElement): boolean {
  return element.isDeleted !== true;
}

function box(element: ExcalidrawElement): Box {
  return {
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    width: Number(element.width) || 0,
    height: Number(element.height) || 0,
  };
}

function centerOf(element: ExcalidrawElement): { x: number; y: number } {
  const bounds = box(element);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function contains(outer: Box, point: { x: number; y: number }): boolean {
  return (
    point.x >= outer.x
    && point.x <= outer.x + outer.width
    && point.y >= outer.y
    && point.y <= outer.y + outer.height
  );
}

function distanceToBox(bounds: Box, point: { x: number; y: number }): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

/** Absolute coordinates of an arrow's two ends, from its relative points. */
function arrowEndpoints(arrow: ExcalidrawElement): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
  const points = arrow.points as Array<[number, number]> | undefined;
  if (!Array.isArray(points) || points.length < 2) return undefined;
  const originX = Number(arrow.x) || 0;
  const originY = Number(arrow.y) || 0;
  const first = points[0];
  const last = points[points.length - 1];
  return {
    start: { x: originX + (first[0] ?? 0), y: originY + (first[1] ?? 0) },
    end: { x: originX + (last[0] ?? 0), y: originY + (last[1] ?? 0) },
  };
}

function customOf(element: ExcalidrawElement): Record<string, unknown> {
  const custom = element.customData;
  return custom && typeof custom === "object" ? (custom as Record<string, unknown>) : {};
}

export function readGraph(board: BoardFile): RecoveredGraph {
  const elements = board.elements.filter(isLive);
  const byId = new Map(elements.map((element) => [element.id, element]));

  // Bound labels belong to their container and are never standalone content.
  const labelByContainer = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "text" && typeof element.containerId === "string") {
      labelByContainer.set(element.containerId, String(element.text ?? "").trim());
    }
  }
  const boundLabelIds = new Set(
    elements.filter((element) => typeof element.containerId === "string").map((element) => element.id),
  );

  const shapes = elements.filter((element) => NODE_SHAPES.includes(String(element.type)));
  const consumed = new Set<string>(boundLabelIds);

  // Free-floating text that sits inside a shape is that shape's label. This is
  // how a hand-drawn box with a word typed on top of it becomes a named node.
  const inferredLabelByShape = new Map<string, string>();
  for (const element of elements) {
    if (element.type !== "text" || consumed.has(element.id)) continue;
    const point = centerOf(element);
    const host = shapes.find((shape) => contains(box(shape), point));
    if (!host) continue;
    const text = String(element.text ?? "").trim();
    if (!text) continue;
    inferredLabelByShape.set(host.id, [inferredLabelByShape.get(host.id), text].filter(Boolean).join(" "));
    consumed.add(element.id);
  }

  const nodes: RecoveredNode[] = [];
  const nodeIdByElement = new Map<string, string>();
  for (const shape of shapes) {
    const custom = customOf(shape);
    const recordedId = typeof custom.node === "string" ? custom.node : undefined;
    const id = recordedId ?? shape.id;
    const bounds = box(shape);
    nodes.push({
      id,
      label: labelByContainer.get(shape.id) ?? inferredLabelByShape.get(shape.id) ?? "",
      shape: String(shape.type),
      elementId: shape.id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      provenance: recordedId ? "recorded" : "inferred",
    });
    nodeIdByElement.set(shape.id, id);
    consumed.add(shape.id);
  }

  // Edge labels: recorded ones name their edge outright; otherwise a free text
  // element is matched to the nearest arrow it plausibly annotates.
  const arrows = elements.filter((element) => element.type === "arrow");
  const recordedEdgeLabel = new Map<string, string>();
  const looseLabels: ExcalidrawElement[] = [];
  for (const element of elements) {
    if (element.type !== "text" || consumed.has(element.id)) continue;
    const custom = customOf(element);
    const target = custom.edgeLabelFor;
    if (typeof target === "string") {
      recordedEdgeLabel.set(target, String(element.text ?? "").trim());
      consumed.add(element.id);
    } else {
      looseLabels.push(element);
    }
  }

  const edges: RecoveredEdge[] = [];
  for (const arrow of arrows) {
    const custom = customOf(arrow);
    const recorded = custom.edge as { from?: string; to?: string } | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let provenance: Provenance = "recorded";

    if (recorded && typeof recorded.from === "string" && typeof recorded.to === "string") {
      from = recorded.from;
      to = recorded.to;
    } else {
      // Explicit bindings are still authoritative even without customData:
      // Excalidraw maintains them when either shape moves.
      const startId = (arrow.startBinding as { elementId?: string } | null)?.elementId;
      const endId = (arrow.endBinding as { elementId?: string } | null)?.elementId;
      from = startId ? nodeIdByElement.get(startId) : undefined;
      to = endId ? nodeIdByElement.get(endId) : undefined;
      provenance = "inferred";

      // Nothing bound: fall back to whichever shapes the ends land on.
      const ends = arrowEndpoints(arrow);
      if ((!from || !to) && ends) {
        const nearest = (point: { x: number; y: number }) => {
          let best: { id: string; distance: number } | undefined;
          for (const shape of shapes) {
            const distance = distanceToBox(box(shape), point);
            if (distance <= ENDPOINT_TOLERANCE && (!best || distance < best.distance)) {
              best = { id: nodeIdByElement.get(shape.id) ?? shape.id, distance };
            }
          }
          return best?.id;
        };
        from ??= nearest(ends.start);
        to ??= nearest(ends.end);
      }
    }

    consumed.add(arrow.id);
    if (!from || !to) continue;

    let label = recordedEdgeLabel.get(arrow.id) ?? labelByContainer.get(arrow.id);
    if (!label) {
      const ends = arrowEndpoints(arrow);
      if (ends) {
        const midpoint = { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2 };
        let best: { element: ExcalidrawElement; distance: number } | undefined;
        for (const candidate of looseLabels) {
          if (consumed.has(candidate.id)) continue;
          const distance = Math.hypot(
            centerOf(candidate).x - midpoint.x,
            centerOf(candidate).y - midpoint.y,
          );
          if (distance < 80 && (!best || distance < best.distance)) best = { element: candidate, distance };
        }
        if (best) {
          label = String(best.element.text ?? "").trim();
          consumed.add(best.element.id);
        }
      }
    }

    edges.push({
      from,
      to,
      ...(label ? { label } : {}),
      elementId: arrow.id,
      provenance,
    });
  }

  const titleElement = elements.find((element) => customOf(element).role === "title");
  const unattributed = elements
    .filter((element) => !consumed.has(element.id) && element.id !== titleElement?.id)
    .map((element) => ({
      elementId: element.id,
      type: String(element.type),
      ...(typeof element.text === "string" && element.text.trim() ? { text: element.text.trim() } : {}),
      x: Number(element.x) || 0,
      y: Number(element.y) || 0,
    }));

  return {
    ...(titleElement ? { title: String(titleElement.text ?? "").trim() } : {}),
    nodes,
    edges,
    unattributed,
  };
}
