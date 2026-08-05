#!/usr/bin/env node
/**
 * Board MCP server: gives Claude read/write access to a durable Excalidraw
 * diagram that lives in the repo next to the code it describes.
 *
 * Files are the source of truth. Every tool is a read-modify-write on a
 * .excalidraw file, so a diagram survives the session, opens in any Excalidraw
 * editor, and diffs in git.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { emptyBoard, readBoard, writeBoard } from "../engine/board-file";
import {
  applyEdits,
  connectNodes,
  createDiagram,
  deleteDiagram,
  listDiagrams,
} from "../engine/diagram";
import { readGraph } from "../engine/graph";
import { checkDrift, createWorkspace, DEFAULT_DIAGRAM_DIR, findBoards } from "../engine/drift";
import { loadConverter } from "../engine/convert";
import { renderBoardToPng } from "../engine/render";
import {
  probeBoard,
  probeBoardServer,
  resolveBoardPort,
  startBoardServer,
  type RunningBoardServer,
} from "../server/board-server";
import { relativeToWorkspace, resolveBoardPath, resolveInWorkspace, WORKSPACE_ROOT } from "./paths";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const MAX_IMAGE_BYTES = 4_000_000;

/**
 * Board id for an image, derived from its workspace-relative path.
 *
 * The basename alone is not enough: `ui/shot.png` and `api/shot.png` reduce to
 * the same string, and so do `shot a.png` and `shot-a.png` once punctuation is
 * replaced. Two distinct images sharing an id overwrite each other's data in
 * board.files, so the full path goes in, and a digest of it settles the cases
 * where sanitising still collides.
 */
function imageElementId(relativePath: string): string {
  const slug = relativePath
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-48);
  const digest = createHash("sha1").update(relativePath).digest("hex").slice(0, 8);
  return `img-${slug || "image"}-${digest}`;
}

/**
 * Tool results go to a model, not a person, so they are not pretty-printed.
 * Indentation cost 37% of a read_diagram response on a 24-node board -- pure
 * whitespace, charged on every call, buying nothing a model needs.
 */
function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  };
}

/**
 * The fields an element's geometry is actually addressed by.
 *
 * A raw Excalidraw element carries 27 keys -- seeds, nonces, fill styles,
 * roughness, indices -- and dumping them cost ~25k tokens on one 24-node board.
 * An edit needs position, size, and the colours it might be changing; the rest
 * is engine bookkeeping the model can neither use nor safely set.
 */
function projectElement(element: Record<string, unknown>): Record<string, unknown> {
  const keep = ["id", "type", "x", "y", "width", "height", "strokeColor", "backgroundColor"];
  const projected: Record<string, unknown> = {};
  for (const key of keep) if (element[key] !== undefined) projected[key] = element[key];
  if (typeof element.text === "string" && element.text) projected.text = element.text;
  if (typeof element.containerId === "string") projected.containerId = element.containerId;
  return projected;
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/** Every tool body funnels through here so a throw becomes a tool error. */
async function guard<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

const nodeSchema = z.object({
  id: z.string().describe("Stable id, used by edges and later edits"),
  label: z.string().describe("Text shown inside the shape"),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  rounded: z.boolean().optional(),
  ref: z
    .string()
    .optional()
    .describe(
      "What this node stands for in the repo: a path, or path#symbol, e.g. src/engine/layout.ts. "
      + "Set it when a node is a real file or module so check_drift can tell when it goes stale. "
      + "Leave it off for anything not in this repository.",
    ),
});

const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().describe("One or two words; longer crowds the diagram"),
  strokeColor: z
    .string()
    .optional()
    // Set here, not patched afterwards: a regenerate would revert a patch.
    .describe("Arrow and edge-label colour, e.g. #1971c2. Set it here, not by patching after."),
});

/**
 * One live board per session. Every tool that writes points it at the file it
 * just wrote, so the page follows the work instead of staying pinned to
 * whatever was opened first -- a board silently watching a different file is
 * indistinguishable from one that has stopped updating.
 */
let live: RunningBoardServer | undefined;

/**
 * Read on use rather than once at load, so a malformed DIAGRAMOS_PORT fails only
 * the two tools that need a port. Resolving it at module scope would throw
 * before the transport connects and take the whole server down, including every
 * file tool that never touches the network.
 */
function boardPort(): number {
  return resolveBoardPort(process.env.DIAGRAMOS_PORT);
}

/**
 * A URL pinned to one board on a server this process does not own.
 *
 * The absolute path goes in rather than the workspace-relative one: another
 * session may be rooted somewhere else, and an absolute path either resolves to
 * the same file or is refused outright. A relative one could quietly resolve to a
 * different file of the same name in that session's project.
 */
function pinnedBoardUrl(port: number, file: string): string {
  return `http://127.0.0.1:${port}/?file=${encodeURIComponent(file)}`;
}

/** Asks a board server owned by another process to show this file. */
async function steerExistingBoard(file: string): Promise<string | undefined> {
  const port = boardPort();
  const serving = await probeBoardServer(port);
  if (serving === undefined) return undefined;
  if (serving === file) return `http://127.0.0.1:${port}/`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    return `http://127.0.0.1:${port}/`;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the live page on the file being worked on.
 *
 * The board may be owned by this process or by another session that happens to
 * hold the port -- a long-lived one, or a stale one. Either way the page must
 * follow the work, so try our own server first and otherwise steer whoever has
 * it. A board silently watching a different file is indistinguishable from one
 * that has stopped updating, which is the worst possible failure here.
 */
async function followBoard(file: string): Promise<void> {
  try {
    if (live) {
      if (live.file !== file) await live.setFile(file);
      return;
    }
    await steerExistingBoard(file);
  } catch {
    // Losing the live view must never fail the write that succeeded.
  }
}

const server = new McpServer(
  { name: "diagramos", version: "0.1.0" },
  {
    instructions:
      "Diagrams are .excalidraw files in the repo. A board holds one diagram: create_diagram "
      + "replaces what it generated before and keeps anything drawn by hand; delete_diagram removes "
      + "one. Read an existing board before editing it. Nodes keep their semantic ids, so refer to "
      + "them by id later. Hand-drawn elements are reported as inferred: treat them as the spec and "
      + "never redraw them.\n"
      + "The live web view exists only while a board server runs. Use open_board to start it or to "
      + "get the URL for another diagram, board_status to ask what is up. Each board has its own "
      + "URL, so several can be open side by side and opening one never disturbs another; a project "
      + "split across diagrams is meant to be watched that way. Never give the user a localhost URL "
      + "you did not get back from one of those two in this session; an address that answers "
      + "nothing is worse than none.",
  },
);

server.registerTool(
  "create_diagram",
  {
    title: "Create diagram",
    description:
      "Lay out a graph into a .excalidraw file. Give nodes and edges, never coordinates: layout, "
      + "sizing, routing, and bindings are automatic. Replaces every diagram previously generated in "
      + "this file, keeps hand-drawn elements, so regenerating is the normal way to update a board. "
      + "Use delete_diagram to remove one, not a throwaway graph.",
    inputSchema: {
      path: z.string().describe("e.g. docs/diagrams/architecture.excalidraw"),
      title: z.string().optional(),
      nodes: z.array(nodeSchema).min(1),
      edges: z.array(edgeSchema).default([]),
      direction: z.enum(["RIGHT", "DOWN"]).optional().describe("Layout flow; RIGHT by default"),
      name: z.string().optional().describe("Element id prefix; from the title otherwise"),
      append: z
        .boolean()
        .default(false)
        .describe(
          "Add below what is there instead of replacing. Only when the user wants two diagrams in "
          + "one file; it makes node ids ambiguous across them. False removes EVERY generated "
          + "diagram here, not just a same-named one.",
        ),
    },
  },
  async ({ path: boardPath, title, nodes, edges, direction, name, append }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const board = await readBoard(file);
      const result = await createDiagram(board, {
        title,
        nodes,
        edges,
        name,
        append,
        ...(direction ? { layout: { direction } } : {}),
      });
      await writeBoard(file, result.board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        nodes: result.nodeCount,
        edges: result.edgeCount,
        elements: result.elementCount,
        idPrefix: result.prefix,
        ...(result.replacedCount
          ? {
              replaced: { diagrams: result.replacedDiagrams, elements: result.replacedCount },
              ...(result.replacedDiagrams.length > 1
                ? {
                    warning:
                      `This board held ${result.replacedDiagrams.length} generated diagrams and all `
                      + "of them were replaced. If that was not intended, pass append: true.",
                  }
                : {}),
            }
          : {}),
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
        note: "Call render_diagram to see it.",
      });
    }),
);

server.registerTool(
  "read_diagram",
  {
    title: "Read diagram",
    description:
      "Read a board back as a semantic graph: nodes, edges, labels, and anything unattributed. "
      + "Each fact is marked recorded (drawn by this tool, exact) or inferred (hand-drawn, derived "
      + "from geometry). Use this to treat a diagram as a specification.",
    inputSchema: {
      path: z.string(),
      geometry: z
        .boolean()
        .default(false)
        .describe(
          "Add positions and sizes to each node and edge. Off by default because it doubles the "
          + "response and a question about the graph does not need it; turn it on to fix layout.",
        ),
      includeElements: z
        .boolean()
        .default(false)
        .describe(
          "Also list every element with its position, size, and colours -- what edit_diagram needs "
          + "to address one. Large on a big board; prefer the node and edge ids above where they "
          + "will do.",
        ),
    },
  },
  async ({ path: boardPath, geometry, includeElements }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const board = await readBoard(file);
      const graph = readGraph(board);
      const inferred = [...graph.nodes, ...graph.edges].filter((item) => item.provenance === "inferred");
      const diagrams = listDiagrams(board);
      // Geometry is dropped unless asked for. readGraph stays rich because the
      // engine and its tests want the whole picture; what crosses to the model
      // is trimmed here, where the cost is paid.
      const nodes = geometry
        ? graph.nodes
        : graph.nodes.map(({ x: _x, y: _y, width: _w, height: _h, ...rest }) => rest);
      return text({
        file: relativeToWorkspace(file),
        ...graph,
        nodes,
        // Named here so a caller can address a single diagram (delete_diagram,
        // or create_diagram with append) without having to guess its name from
        // element id prefixes.
        ...(diagrams.length ? { diagrams } : {}),
        summary: `${graph.nodes.length} nodes, ${graph.edges.length} edges`
          + (inferred.length ? `, ${inferred.length} inferred from hand-drawn elements` : ""),
        ...(includeElements
          ? {
              elements: board.elements
                .filter((element) => element.isDeleted !== true)
                .map(projectElement),
            }
          : {}),
      });
    }),
);

server.registerTool(
  "check_drift",
  {
    title: "Check drift",
    description:
      "Do these diagrams still match the code? Compares each node's ref against the working tree "
      + "and reports the ones pointing at a file or symbol that is gone, and checks arrows for static "
      + "connections through imports, shared orchestrators, or route literals — unsupported ones are "
      + "worth a look, not wrong. Read-only, and cheap "
      + "enough to run whenever module structure changes. Nodes without a ref are skipped, "
      + "hand-drawn ones ignored, and edges touching refless nodes are skipped, so a clean report means "
      + "nothing checkable disagreed -- not that the diagram is correct.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe(`One board to check. Omit to check every board in ${DEFAULT_DIAGRAM_DIR}.`),
    },
  },
  async ({ path: boardPath }) =>
    guard(async () => {
      const files = boardPath
        ? [resolveBoardPath(boardPath)]
        : await findBoards(WORKSPACE_ROOT);
      if (files.length === 0) {
        return text({
          note:
            `No .excalidraw files in ${DEFAULT_DIAGRAM_DIR}. Pass path to check a board somewhere `
            + "else.",
        });
      }

      const workspace = createWorkspace(WORKSPACE_ROOT);
      const totals = { checked: 0, skipped: 0, handDrawn: 0, edgesChecked: 0, edgesSkipped: 0 };
      const findings: Array<Record<string, unknown>> = [];
      const edges: Array<Record<string, unknown>> = [];
      for (const file of files) {
        const report = checkDrift(await readBoard(file), workspace);
        totals.checked += report.checked;
        totals.skipped += report.skipped;
        totals.handDrawn += report.handDrawn;
        totals.edgesChecked += report.edgesChecked;
        totals.edgesSkipped += report.edgesSkipped;
        // Named per finding rather than grouped: a caller acting on one needs to
        // know which file to redraw, and flat is cheaper than nesting.
        for (const finding of report.findings) {
          findings.push({ board: relativeToWorkspace(file), ...finding });
        }
        for (const finding of report.edges) {
          edges.push({ board: relativeToWorkspace(file), ...finding });
        }
      }

      return text({
        boards: files.map((file) => relativeToWorkspace(file)),
        clean: findings.length === 0 && edges.length === 0,
        findings,
        edges,
        ...totals,
        // "clean: true, checked: 0" reads as a pass when nothing was examined,
        // so say which it was.
        ...(totals.checked === 0
          ? {
              note:
                "No node carried a ref, so nothing was compared against the code. Set ref on nodes "
                + "that stand for a file or module when regenerating these diagrams.",
            }
          : {}),
      });
    }),
);

server.registerTool(
  "render_diagram",
  {
    title: "Render diagram",
    description:
      "Rasterise a board to PNG and return the image, so you can look at the result and judge "
      + "layout, overlap, and readability directly rather than inferring them from the data. "
      + "One look after the diagram is finished is usually enough; rendering after every tweak "
      + "costs an image each time.",
    inputSchema: {
      path: z.string(),
      // Scale 1 is legible enough to judge layout and overlap, and costs less
      // than half of scale 2. Raise it only to inspect something specific.
      scale: z.number().min(1).max(3).default(1),
    },
  },
  async ({ path: boardPath, scale }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const png = await renderBoardToPng(await readBoard(file), { scale });
      return {
        content: [
          { type: "text" as const, text: `${relativeToWorkspace(file)} (${(png.byteLength / 1024).toFixed(0)} KB)` },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    }),
);

server.registerTool(
  "connect_nodes",
  {
    title: "Connect nodes",
    description:
      "Draw bound arrows between shapes that already exist, hand-drawn ones included. Each end is a "
      + "node id or an element id; arrows attach to the perimeter and stay attached when shapes "
      + "move. For a diagram you are generating, pass edges to create_diagram instead so the layout "
      + "routes them.",
    inputSchema: {
      path: z.string(),
      connections: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            label: z.string().optional(),
            bidirectional: z.boolean().optional(),
          }),
        )
        .min(1),
    },
  },
  async ({ path: boardPath, connections }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const { board, created } = await connectNodes(await readBoard(file), connections);
      await writeBoard(file, board);
      await followBoard(file);
      return text({ wrote: relativeToWorkspace(file), arrows: created });
    }),
);

server.registerTool(
  "edit_diagram",
  {
    title: "Edit diagram",
    description:
      "Patch or delete elements by id, hand-drawn ones included: move, resize, recolour, relabel. "
      + "Deleting a shape takes its bound label. Read the board first; change only what must change.",
    inputSchema: {
      path: z.string(),
      updates: z
        .array(z.object({ id: z.string() }).passthrough())
        .default([])
        .describe('e.g. {"id":"api","backgroundColor":"#ffec99","width":220}'),
      deletes: z.array(z.string()).default([]),
    },
  },
  async ({ path: boardPath, updates, deletes }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const result = applyEdits(await readBoard(file), updates, deletes);
      await writeBoard(file, result.board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        updated: result.updated,
        deleted: result.deleted,
        ...(result.skipped.length ? { skipped: result.skipped, note: "No element has these ids." } : {}),
      });
    }),
);

server.registerTool(
  "delete_diagram",
  {
    title: "Delete diagram",
    description:
      "Remove a generated diagram, or all of them when name is omitted. Always keeps hand-drawn "
      + "elements and any arrow that still has both ends. Use this to delete: not a throwaway "
      + "regenerate, not a list of element ids in edit_diagram.",
    inputSchema: {
      path: z.string(),
      name: z
        .string()
        .optional()
        .describe("As reported by read_diagram. Omit to remove every generated diagram in the file."),
    },
  },
  async ({ path: boardPath, name }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const result = deleteDiagram(await readBoard(file), name);
      await writeBoard(file, result.board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        deleted: result.deleted,
        elementsRemoved: result.deletedElements,
        ...(result.remaining.length ? { remainingDiagrams: result.remaining } : {}),
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
      });
    }),
);

server.registerTool(
  "place_image",
  {
    title: "Place image",
    description:
      "Put an image from the workspace onto the board -- a screenshot of what you built, beside the "
      + "diagram that specified it. Placing the same file again updates it in place.",
    inputSchema: {
      path: z.string().describe("Board file"),
      image: z.string().describe("Image file in the workspace"),
      width: z.number().optional(),
    },
  },
  async ({ path: boardPath, image, width }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const imageFile = resolveInWorkspace(image);
      const mime = IMAGE_MIME_BY_EXT[path.extname(imageFile).toLowerCase()];
      if (!mime) throw new Error(`Unsupported image type: ${path.extname(imageFile) || "(none)"}`);
      const data = await readFile(imageFile);
      if (data.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${relativeToWorkspace(imageFile)} exceeds 4 MB; use a smaller image`);
      }

      const board = await readBoard(file);
      const live = board.elements.filter((element) => element.isDeleted !== true);
      const bottom = live.reduce(
        (lowest, element) => Math.max(lowest, (Number(element.y) || 0) + (Number(element.height) || 0)),
        0,
      );
      const naturalWidth = data.byteLength >= 24 && mime === "image/png" ? data.readUInt32BE(16) : 800;
      const naturalHeight = data.byteLength >= 24 && mime === "image/png" ? data.readUInt32BE(20) : 600;
      const renderWidth = Math.min(960, Math.max(120, width ?? Math.min(640, naturalWidth)));
      const renderHeight = Math.max(80, Math.round(renderWidth * (naturalHeight / Math.max(1, naturalWidth))));

      const fileId = imageElementId(relativeToWorkspace(imageFile));
      // Placing the same image twice used to append a second element carrying
      // the id the first one already had, and convertSkeletons only checks for
      // duplicates inside its own batch. Two ids alike is a corrupt scene, so a
      // repeat placement updates what is there instead of stacking onto it.
      const existing = board.elements.find((element) => String(element.id) === fileId);
      const elements = existing
        ? board.elements.map((element) =>
            String(element.id) === fileId
              ? {
                  ...element,
                  // Position is deliberately left alone: the user may have moved
                  // the image, and re-placing it should not drag it back.
                  width: renderWidth,
                  height: renderHeight,
                  isDeleted: false,
                  version: (Number(element.version) || 1) + 1,
                }
              : element,
          )
        : [
            ...board.elements,
            ...(await (await import("../engine/convert")).convertSkeletons(
              [
                {
                  id: fileId,
                  type: "image",
                  fileId,
                  x: 0,
                  y: bottom + 120,
                  width: renderWidth,
                  height: renderHeight,
                },
              ],
              { origin: "image" },
            )),
          ];

      await writeBoard(file, {
        ...board,
        elements,
        files: {
          ...board.files,
          [fileId]: {
            id: fileId,
            mimeType: mime,
            dataURL: `data:${mime};base64,${data.toString("base64")}`,
            created: 0,
          },
        },
      });
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        placed: relativeToWorkspace(imageFile),
        ...(existing ? { replacedInPlace: fileId } : { elementId: fileId }),
        size: `${renderWidth}x${renderHeight}`,
      });
    }),
);

server.registerTool(
  "new_board",
  {
    title: "New board",
    description: "Create an empty board file, or empty an existing one. Use only when starting over.",
    inputSchema: { path: z.string() },
  },
  async ({ path: boardPath }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      await writeBoard(file, emptyBoard());
      await followBoard(file);
      return text({ wrote: relativeToWorkspace(file), elements: 0 });
    }),
);

server.registerTool(
  "board_status",
  {
    title: "Board status",
    description:
      "Whether a live board is running, which boards are open and the URL of each. Check before "
      + "telling the user where to look, and before assuming the live view exists.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      // Ask the port rather than trusting our own handle: the board may belong
      // to another session, and ours may have been superseded.
      const port = boardPort();
      const probe = await probeBoard(port);
      const serving = probe?.file;
      if (serving === undefined) {
        return text({
          running: false,
          note: "No live board. Call open_board to start one; every other tool works without it.",
        });
      }
      // Every board with a page of its own, so the model can say which URL shows
      // what instead of handing over one address for several diagrams.
      const open = (live?.boards() ?? probe?.boards ?? [serving]).map((file) => ({
        file: relativeToWorkspace(file),
        url: pinnedBoardUrl(port, file),
      }));
      return text({
        running: true,
        boards: open,
        // The bare URL, which follows whichever board was opened or written last.
        followUrl: `http://127.0.0.1:${port}/`,
        showing: relativeToWorkspace(serving),
        ownedByThisSession: live?.file === serving,
      });
    }),
);

server.registerTool(
  "open_board",
  {
    title: "Open live board",
    description:
      "Open the board in a live local page. It updates the moment any tool writes the file, and "
      + "what the user draws is saved back, so you both edit the same board. Returns a URL pinned to "
      + "this board: several can be open at once and each stays on its own diagram, so opening a "
      + "second one does not disturb a page the user is watching. One server serves them all. "
      + "Prefer it to a shell command.",
    inputSchema: {
      path: z.string(),
      open: z.boolean().default(true).describe("Also launch the system browser"),
    },
  },
  async ({ path: boardPath, open }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      // Make sure the file exists before watching it, or a brand-new board
      // shows the viewer an error until something writes.
      await writeBoard(file, await readBoard(file));

      // Another session may already hold the port. Using its server is better
      // than starting a second board the user has to know about.
      let url: string | undefined;
      if (!live) {
        const port = boardPort();
        const probe = await probeBoard(port);
        if (probe?.multiBoard) {
          url = pinnedBoardUrl(port, file);
        } else if (probe) {
          // Older server: it has no idea about pinned URLs, so the only way to
          // put this board on screen is to re-point the one page it serves.
          url = await steerExistingBoard(file);
        }
      }
      if (!url) {
        live ??= await startBoardServer({ file, port: boardPort(), root: WORKSPACE_ROOT });
        url = live.urlFor(file);
      }
      // Keep the bare URL on this board too, so a page opened without one still
      // shows what was asked for last. Pinned pages are untouched by design.
      await followBoard(file);

      if (open) {
        const { spawn } = await import("node:child_process");
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
      }
      return text({
        url,
        file: relativeToWorkspace(file),
        note: "Live. Edits in the page and edits from these tools both land in the file.",
      });
    }),
);

async function main(): Promise<void> {
  // Warm the converter so the first create_diagram is not the one that pays
  // for parsing the bundle.
  void loadConverter().catch(() => undefined);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; diagnostics must go to stderr.
  console.error(`diagramos MCP server ready (workspace: ${WORKSPACE_ROOT})`);
}

main().catch((error) => {
  console.error("board MCP server failed to start:", error);
  process.exit(1);
});
