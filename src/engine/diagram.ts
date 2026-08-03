/**
 * Board operations: create a laid-out diagram, connect existing elements,
 * patch or delete elements.
 *
 * Everything here takes a BoardFile and returns a new one. Nothing touches
 * disk, so the MCP layer stays a thin read-modify-write around these.
 */
import { convertSkeletons } from "./convert";
import { installNodeFontMeasurer } from "./font";
import { emptyBoard, type BoardFile } from "./board-file";
import type { ExcalidrawElement } from "./normalize";
import { NODE_SHAPES } from "./graph";
import {
  planBounds,
  planDiagramLayout,
  translatePlan,
  type GraphEdge,
  type GraphNode,
  type DiagramLayoutOptions,
} from "../renderer/diagram-layout";

/** Vertical breathing room between an existing board and a new diagram. */
const STACK_GAP = 160;

export interface CreateDiagramParams {
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout?: DiagramLayoutOptions;
  /** Stable prefix for generated element ids; derived from the title if absent. */
  name?: string;
  /**
   * Add this diagram below whatever is already there instead of replacing.
   *
   * Off by default, and note what that sweeps: *every* generated diagram on the
   * board, not the one with a matching name. That is the one-diagram-per-file
   * model, which is what keeps semantic node ids unique and therefore
   * addressable by connect_nodes and edit_diagram. Appending reintroduces
   * duplicate ids across diagrams; use deleteDiagram to remove just one.
   */
  append?: boolean;
}

function originOf(element: ExcalidrawElement): string | undefined {
  const custom = element.customData as
    | { origin?: string; node?: unknown; edge?: unknown; edgeLabelFor?: unknown; role?: unknown }
    | undefined;
  if (custom?.origin) return custom.origin;
  // Boards written before elements carried an explicit origin. Their semantic
  // tags identify them just as well, so regeneration still replaces them
  // rather than stacking a second diagram on top.
  if (custom && (custom.node || custom.edge || custom.edgeLabelFor || custom.role)) return "diagram";
  return undefined;
}

/** Elements a human drew, which regeneration must never touch. */
function isHandDrawn(element: ExcalidrawElement): boolean {
  return originOf(element) === undefined;
}

/**
 * Ids minted by planDiagramLayout, from which a legacy element's diagram can be
 * recovered: `<prefix>-node-3`, `-edge-3`, `-edgelabel-3`, `-title`, and the
 * `-label` suffix Excalidraw adds to a bound label.
 */
const GENERATED_ID = /^(.+?)-(?:node|edge|edgelabel)-\d+(?:-label)?$|^(.+?)-title$/;

/**
 * Which diagram an element belongs to, or undefined if it belongs to none.
 *
 * Recorded on everything written since diagrams became individually removable.
 * Older boards predate the marker, so their membership is recovered from the id
 * pattern instead -- worth doing, because the alternative is that delete cannot
 * see the very diagrams most likely to need deleting.
 */
export function diagramNameOf(element: ExcalidrawElement): string | undefined {
  const custom = element.customData as { diagram?: unknown } | undefined;
  if (typeof custom?.diagram === "string" && custom.diagram) return custom.diagram;
  if (originOf(element) !== "diagram") return undefined;
  const match = GENERATED_ID.exec(String(element.id));
  return match ? match[1] ?? match[2] : undefined;
}

/**
 * Drops `seeds` and everything left meaningless by their absence: labels bound
 * to a removed shape, and connectors that would be left dangling.
 */
function removeWithDependents(board: BoardFile, seeds: Iterable<string>): BoardFile {
  const removed = new Set(seeds);
  if (removed.size === 0) return board;

  // Labels bound to a removed shape go with it. On older boards these carry no
  // marker of their own, so without this they survive as floating text.
  for (const element of board.elements) {
    const container = element.containerId;
    if (typeof container === "string" && removed.has(container)) removed.add(String(element.id));
  }

  // A connector bound to a node that is going away would be left dangling.
  for (const element of board.elements) {
    if (originOf(element) !== "connector") continue;
    const start = (element.startBinding as { elementId?: string } | null)?.elementId;
    const end = (element.endBinding as { elementId?: string } | null)?.elementId;
    if ((start && removed.has(start)) || (end && removed.has(end))) {
      removed.add(String(element.id));
      for (const bound of (element.boundElements as Array<{ id?: string }> | undefined) ?? []) {
        if (bound?.id) removed.add(bound.id);
      }
    }
  }

  return {
    ...board,
    elements: board.elements
      .filter((element) => !removed.has(String(element.id)))
      .map((element) => {
        const bound = element.boundElements as Array<{ id?: string }> | undefined;
        if (!Array.isArray(bound) || !bound.some((entry) => entry.id && removed.has(entry.id))) return element;
        return { ...element, boundElements: bound.filter((entry) => !(entry.id && removed.has(entry.id))) };
      }),
  };
}

/**
 * Clears every diagram this engine generated, keeping hand-drawn work and any
 * connectors that do not depend on what is being removed.
 */
function clearGeneratedDiagram(board: BoardFile): BoardFile {
  return removeWithDependents(
    board,
    board.elements.filter((element) => originOf(element) === "diagram").map((element) => String(element.id)),
  );
}

export interface DiagramSummary {
  /** The name to pass to delete_diagram; also the element id prefix. */
  name: string;
  title?: string;
  nodes: number;
  elements: number;
}

/**
 * The generated diagrams on a board, in the order they were written.
 *
 * A caller cannot ask for a diagram to be removed without first being able to
 * name it, so this is what makes deletion addressable.
 */
export function listDiagrams(board: BoardFile): DiagramSummary[] {
  const summaries = new Map<string, DiagramSummary>();
  for (const element of liveElements(board)) {
    const name = diagramNameOf(element);
    if (!name) continue;
    const summary = summaries.get(name) ?? { name, nodes: 0, elements: 0 };
    summary.elements += 1;
    const custom = element.customData as { node?: unknown; role?: unknown } | undefined;
    if (custom?.node) summary.nodes += 1;
    if (custom?.role === "title" && typeof element.text === "string") summary.title = element.text;
    summaries.set(name, summary);
  }
  return [...summaries.values()];
}

export interface DeleteDiagramResult {
  board: BoardFile;
  /** Diagrams actually removed. */
  deleted: string[];
  deletedElements: number;
  /** Generated diagrams still on the board afterwards. */
  remaining: string[];
  /** Hand-drawn elements carried through untouched. */
  keptHandDrawn: number;
}

/**
 * Removes one generated diagram, or all of them when `name` is omitted.
 *
 * Hand-drawn elements are never touched, so this is safe on a board a human has
 * also been working on. An unknown name is refused with the available ones
 * attached rather than silently deleting nothing, since a no-op reported as
 * success reads exactly like a successful delete.
 */
export function deleteDiagram(board: BoardFile, name?: string): DeleteDiagramResult {
  const present = listDiagrams(board).map((summary) => summary.name);
  if (name !== undefined && !present.includes(name)) {
    throw new Error(
      `No diagram named "${name}" on this board. `
        + (present.length
          ? `Available: ${present.join(", ")}.`
          : "It holds no generated diagrams; anything on it was drawn by hand."),
    );
  }

  const doomed = board.elements.filter((element) => {
    const owner = diagramNameOf(element);
    return owner !== undefined && (name === undefined || owner === name);
  });
  const next = removeWithDependents(board, doomed.map((element) => String(element.id)));

  return {
    board: next,
    deleted: name === undefined ? present : [name],
    // Measured, not derived from the seed list: the sweep also takes bound
    // labels and dangling connectors, and counting only the seeds under-reports
    // by every one of them. On boards whose labels predate the origin marker
    // that was five elements in twenty-one.
    deletedElements: liveElements(board).length - liveElements(next).length,
    remaining: listDiagrams(next).map((summary) => summary.name),
    keptHandDrawn: next.elements.filter(isHandDrawn).length,
  };
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/** Keeps a second diagram on the same board from colliding with the first. */
function uniquePrefix(board: BoardFile, base: string): string {
  const taken = new Set(board.elements.map((element) => String(element.id)));
  const collides = (prefix: string) => [...taken].some((id) => id.startsWith(`${prefix}-`));
  if (!collides(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!collides(candidate)) return candidate;
  }
  throw new Error(`Cannot find a free element id prefix for "${base}"`);
}

function liveElements(board: BoardFile): ExcalidrawElement[] {
  return board.elements.filter((element) => element.isDeleted !== true);
}

function boardBottom(board: BoardFile): number {
  let bottom = Number.NEGATIVE_INFINITY;
  for (const element of liveElements(board)) {
    bottom = Math.max(bottom, (Number(element.y) || 0) + (Number(element.height) || 0));
  }
  return Number.isFinite(bottom) ? bottom : 0;
}

export interface CreateDiagramResult {
  board: BoardFile;
  prefix: string;
  nodeCount: number;
  edgeCount: number;
  elementCount: number;
  /** Elements from previously generated diagrams that this call replaced. */
  replacedCount: number;
  /**
   * Names of the diagrams replaced. Reported separately from the element count
   * because "replaced 154 elements" hides the fact that they came from more
   * than one diagram, which is the part a caller would want to have known.
   */
  replacedDiagrams: string[];
  /** Hand-drawn elements carried through untouched. */
  keptHandDrawn: number;
}

/**
 * Lays out a graph and writes it to the board, replacing any diagram this
 * engine generated before while leaving hand-drawn elements alone. Every
 * generated element is tagged so readGraph can recover the graph exactly
 * rather than re-deriving it from geometry.
 */
export async function createDiagram(
  board: BoardFile,
  params: CreateDiagramParams,
): Promise<CreateDiagramResult> {
  if (!Array.isArray(params.nodes) || params.nodes.length === 0) {
    throw new Error("A diagram needs at least one node");
  }
  // Node sizing is only as good as the font metrics behind it, and callers
  // should not have to remember this.
  await installNodeFontMeasurer();

  const replacedDiagrams = params.append ? [] : listDiagrams(board).map((summary) => summary.name);
  const target = params.append ? board : clearGeneratedDiagram(board);
  // Live elements only: tombstones get swept too, but reporting them would
  // overstate what the user actually loses. Measured against the cleared board
  // rather than counted by origin, so swept labels and connectors are included.
  const replacedCount = liveElements(board).length - liveElements(target).length;

  const prefix = uniquePrefix(target, slugify(params.name ?? params.title ?? "diagram", "diagram"));
  const plan = await planDiagramLayout(
    { title: params.title, nodes: params.nodes, edges: params.edges ?? [], layout: params.layout },
    { x: 0, y: 0 },
    prefix,
  );

  // Drop the new graph clear of whatever survived instead of on top of it.
  const existing = liveElements(target);
  if (existing.length > 0) {
    const bounds = planBounds(plan);
    translatePlan(plan, -bounds.minX, boardBottom(target) + STACK_GAP - bounds.minY);
  }

  const customData = new Map<string, Record<string, unknown>>();
  for (const [nodeId, elementId] of plan.elementIdByNode) {
    customData.set(elementId, { node: nodeId });
  }
  (params.edges ?? []).forEach((edge, index) => {
    customData.set(`${prefix}-edge-${index}`, { edge: { from: edge.from, to: edge.to } });
    customData.set(`${prefix}-edgelabel-${index}`, { edgeLabelFor: `${prefix}-edge-${index}` });
  });
  if (params.title?.trim()) customData.set(`${prefix}-title`, { role: "title" });

  const created = await convertSkeletons(plan.skeletons as Record<string, unknown>[], {
    customData,
    origin: "diagram",
    diagram: prefix,
  });
  return {
    board: { ...target, elements: [...target.elements, ...created] },
    prefix,
    nodeCount: plan.nodeCount,
    edgeCount: plan.edgeCount,
    elementCount: created.length,
    replacedCount,
    replacedDiagrams,
    keptHandDrawn: target.elements.filter(isHandDrawn).length,
  };
}

export interface Connection {
  from: string;
  to: string;
  label?: string;
  bidirectional?: boolean;
}

/**
 * Point on a box's perimeter facing a target. Arrows must stop at the edge of
 * a shape, never terminate inside its label.
 */
function perimeterPoint(
  bounds: { x: number; y: number; width: number; height: number },
  towards: { x: number; y: number },
): { x: number; y: number } {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const dx = towards.x - centerX;
  const dy = towards.y - centerY;
  if (dx === 0 && dy === 0) return { x: centerX, y: centerY };
  const scaleX = dx !== 0 ? bounds.width / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? bounds.height / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

/**
 * Connects elements that already exist, hand-drawn ones included. Accepts
 * either an element id or a semantic node id at each end.
 */
export async function connectNodes(
  board: BoardFile,
  connections: Connection[],
): Promise<{ board: BoardFile; created: string[] }> {
  if (!Array.isArray(connections) || connections.length === 0) {
    throw new Error("connect_nodes requires at least one connection");
  }
  const live = liveElements(board);
  const byElementId = new Map(live.map((element) => [String(element.id), element]));
  // Collected as lists, not a map: two diagrams on one board can define the
  // same node id, and silently binding to whichever was written last is worse
  // than refusing.
  const byNodeId = new Map<string, ExcalidrawElement[]>();
  for (const element of live) {
    const custom = element.customData as { node?: string } | undefined;
    if (custom?.node) byNodeId.set(custom.node, [...(byNodeId.get(custom.node) ?? []), element]);
  }
  const resolve = (reference: string): ExcalidrawElement => {
    const matches = byNodeId.get(reference) ?? [];
    if (matches.length > 1) {
      throw new Error(
        `connect_nodes: "${reference}" matches ${matches.length} nodes `
          + `(${matches.map((match) => String(match.id)).join(", ")}). `
          + "Use the element id instead, or keep one diagram per file.",
      );
    }
    const element = matches[0] ?? byElementId.get(reference);
    if (!element) throw new Error(`connect_nodes: no element or node named "${reference}"`);
    if (!NODE_SHAPES.includes(String(element.type))) {
      throw new Error(`connect_nodes: "${reference}" is a ${String(element.type)}, not a connectable shape`);
    }
    return element;
  };

  // Arrows already joining a pair of shapes, so a second one between the same
  // two does not land exactly on top of the first.
  const pairKey = (a: string, b: string) => [a, b].sort().join(" ");
  const lanes = new Map<string, number>();
  for (const element of live) {
    if (element.type !== "arrow") continue;
    const start = (element.startBinding as { elementId?: string } | null)?.elementId;
    const end = (element.endBinding as { elementId?: string } | null)?.elementId;
    if (!start || !end) continue;
    const key = pairKey(start, end);
    lanes.set(key, (lanes.get(key) ?? 0) + 1);
  }

  const taken = new Set(live.map((element) => String(element.id)));
  const skeletons = connections.map((connection) => {
    const from = resolve(connection.from);
    const to = resolve(connection.to);
    if (from.id === to.id) throw new Error(`connect_nodes cannot connect "${connection.from}" to itself`);

    const bounds = (element: ExcalidrawElement) => ({
      x: Number(element.x) || 0,
      y: Number(element.y) || 0,
      width: Number(element.width) || 0,
      height: Number(element.height) || 0,
    });
    const fromBox = bounds(from);
    const toBox = bounds(to);
    const start = perimeterPoint(fromBox, {
      x: toBox.x + toBox.width / 2,
      y: toBox.y + toBox.height / 2,
    });
    const end = perimeterPoint(toBox, {
      x: fromBox.x + fromBox.width / 2,
      y: fromBox.y + fromBox.height / 2,
    });

    // Push each additional arrow between the same pair onto its own lane,
    // perpendicular to the run, so neither the lines nor their labels stack.
    const key = pairKey(String(from.id), String(to.id));
    const lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    if (lane > 0) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy) || 1;
      // Alternate sides so lanes fan out around the direct line.
      const offset = Math.ceil(lane / 2) * 34 * (lane % 2 === 1 ? 1 : -1);
      const shiftX = (-dy / length) * offset;
      const shiftY = (dx / length) * offset;
      start.x += shiftX;
      start.y += shiftY;
      end.x += shiftX;
      end.y += shiftY;
    }

    let id = `connect-${slugify(connection.from, "a")}-${slugify(connection.to, "b")}`;
    for (let suffix = 2; taken.has(id); suffix++) id = `${id.replace(/-\d+$/, "")}-${suffix}`;
    taken.add(id);

    return {
      skeleton: {
        id,
        type: "arrow",
        x: start.x,
        y: start.y,
        points: [[0, 0], [end.x - start.x, end.y - start.y]],
        endArrowhead: "arrow",
        ...(connection.bidirectional ? { startArrowhead: "arrow" } : {}),
        strokeColor: "#1e1e1e",
        ...(connection.label?.trim() ? { label: { text: connection.label.trim() } } : {}),
      },
      fromId: String(from.id),
      toId: String(to.id),
      semantic: {
        from: (from.customData as { node?: string } | undefined)?.node ?? String(from.id),
        to: (to.customData as { node?: string } | undefined)?.node ?? String(to.id),
      },
    };
  });

  const customData = new Map(
    skeletons.map(({ skeleton, semantic }) => [skeleton.id, { edge: semantic }]),
  );
  const created = await convertSkeletons(
    skeletons.map(({ skeleton }) => skeleton),
    { customData, origin: "connector" },
  );

  // Bind both directions: the arrow points at each shape, and each shape lists
  // the arrow, so Excalidraw keeps them attached when anything moves.
  const boundAdditions = new Map<string, Array<{ id: string; type: "arrow" }>>();
  for (const { skeleton, fromId, toId } of skeletons) {
    const arrow = created.find((element) => element.id === skeleton.id);
    if (!arrow) throw new Error(`connect_nodes: arrow ${skeleton.id} was not created`);
    arrow.startBinding = { elementId: fromId, focus: 0, gap: 4 };
    arrow.endBinding = { elementId: toId, focus: 0, gap: 4 };
    for (const endpoint of [fromId, toId]) {
      boundAdditions.set(endpoint, [
        ...(boundAdditions.get(endpoint) ?? []),
        { id: String(arrow.id), type: "arrow" },
      ]);
    }
  }

  const elements = board.elements.map((element) => {
    const additions = boundAdditions.get(String(element.id));
    if (!additions) return element;
    return {
      ...element,
      boundElements: [...((element.boundElements as unknown[]) ?? []), ...additions],
      version: (Number(element.version) || 1) + 1,
    };
  });

  return {
    board: { ...board, elements: [...elements, ...created] },
    created: created.filter((element) => element.type === "arrow").map((element) => String(element.id)),
  };
}

export interface EditResult {
  board: BoardFile;
  updated: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Patches and deletes elements by id. Deleting a shape takes its bound label
 * with it, matching what the editor does, so no orphaned text is left behind.
 */
export function applyEdits(
  board: BoardFile,
  updates: Array<Record<string, unknown>> = [],
  deletes: string[] = [],
): EditResult {
  const byId = new Map(board.elements.map((element) => [String(element.id), element]));

  const doomed = new Set(deletes.map(String));
  for (const id of [...doomed]) {
    for (const bound of (byId.get(id)?.boundElements as Array<{ id?: string; type?: string }> | undefined) ?? []) {
      if (bound?.type === "text" && bound.id) doomed.add(bound.id);
    }
  }

  // Callers send either {id, props:{...}} or a flat {id, ...props}; accepting
  // only one shape would silently no-op half the requests.
  const patches = new Map<string, Record<string, unknown>>();
  for (const update of updates) {
    const { id, props, ...rest } = update as { id?: unknown; props?: unknown };
    if (typeof id !== "string") continue;
    patches.set(id, (props && typeof props === "object" ? props : rest) as Record<string, unknown>);
  }

  const skipped = [...new Set([...patches.keys(), ...doomed].filter((id) => !byId.has(id)))];
  const updated: string[] = [];
  const deleted: string[] = [];

  const elements = board.elements.map((element) => {
    const id = String(element.id);
    if (doomed.has(id)) {
      deleted.push(id);
      return { ...element, isDeleted: true, version: (Number(element.version) || 1) + 1 };
    }
    const patch = patches.get(id);
    if (!patch) return element;
    updated.push(id);
    // id and type are identity, never patchable.
    const { id: _ignoredId, type: _ignoredType, ...safe } = patch;
    return { ...element, ...safe, version: (Number(element.version) || 1) + 1 };
  });

  return { board: { ...board, elements }, updated, deleted, skipped };
}

export { emptyBoard };
