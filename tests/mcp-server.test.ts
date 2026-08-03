/**
 * Drives the board server over a real stdio transport, the same way Claude
 * Code does. Nothing here reaches into the engine directly: if the tool
 * schemas, serialisation, or path handling break, these fail.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(__dirname, "..");
const BOARD = "diagrams/architecture.excalidraw";

let workspace: string;
let client: Client;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "board-mcp-"));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(REPO, "src/mcp/server.ts")],
      cwd: REPO,
      env: { ...process.env, BOARD_MCP_ROOT: workspace },
    }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("board MCP server", () => {
  it("advertises the board tools", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "board_status",
        "connect_nodes",
        "create_diagram",
        "delete_diagram",
        "edit_diagram",
        "new_board",
        "open_board",
        "place_image",
        "read_diagram",
        "render_diagram",
      ].sort(),
    );
  });

  it("creates a diagram and writes a real .excalidraw file", async () => {
    const result = jsonOf(
      await call("create_diagram", {
        path: BOARD,
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
      }),
    );
    expect(result.nodes).toBe(3);
    expect(result.edges).toBe(2);

    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    expect(board.type).toBe("excalidraw");
    expect(board.elements.length).toBeGreaterThan(5);
  }, 120_000);

  it("reads the diagram back as the graph that was written", async () => {
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    expect(graph.title).toBe("Request path");

    const nodes = graph.nodes as Array<{ id: string; label: string; provenance: string }>;
    expect(nodes.map((node) => node.id).sort()).toEqual(["api", "client", "db"]);
    expect(nodes.find((node) => node.id === "api")?.label).toBe("API");
    // Everything this tool drew must round-trip exactly, never be re-guessed.
    expect(nodes.every((node) => node.provenance === "recorded")).toBe(true);

    const edges = graph.edges as Array<{ from: string; to: string; label?: string }>;
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "client", to: "api", label: "http" }),
        expect.objectContaining({ from: "api", to: "db", label: "query" }),
      ]),
    );
  }, 60_000);

  it("edits by semantic element id and reflects it on the next read", async () => {
    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const apiElement = board.elements.find(
      (element: { customData?: { node?: string } }) => element.customData?.node === "api",
    );
    await call("edit_diagram", {
      path: BOARD,
      updates: [{ id: apiElement.id, backgroundColor: "#ffec99" }],
    });
    const after = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const updated = after.elements.find((element: { id: string }) => element.id === apiElement.id);
    expect(updated.backgroundColor).toBe("#ffec99");
  }, 60_000);

  it("connects nodes by semantic id, with bindings both ways", async () => {
    await call("connect_nodes", {
      path: BOARD,
      connections: [{ from: "db", to: "client", label: "cache" }],
    });
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    expect(graph.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "db", to: "client", label: "cache" })]),
    );

    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const arrow = board.elements.find(
      (element: { customData?: { edge?: { from?: string } } }) => element.customData?.edge?.from === "db",
    );
    expect(arrow.startBinding.elementId).toBeTruthy();
    expect(arrow.endBinding.elementId).toBeTruthy();
    // The shape must list the arrow too, or the editor drops the attachment.
    const source = board.elements.find((element: { id: string }) => element.id === arrow.startBinding.elementId);
    expect(source.boundElements.some((bound: { id: string }) => bound.id === arrow.id)).toBe(true);
  }, 60_000);

  it("reports unknown ids instead of silently doing nothing", async () => {
    const result = jsonOf(await call("edit_diagram", { path: BOARD, deletes: ["does-not-exist"] }));
    expect(result.skipped).toEqual(["does-not-exist"]);
  }, 60_000);

  it("refuses to touch paths outside the workspace", async () => {
    const result = await client.callTool({
      name: "read_diagram",
      arguments: { path: "../../../etc/passwd" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/escapes the workspace/i);
  }, 60_000);

  /**
   * The live view is the one piece of state the model cannot infer from a file,
   * and guessing produced a URL that answered nothing. It has to be askable.
   */
  it("reports whether a live board exists instead of leaving it to be guessed", async () => {
    const status = jsonOf(await call("board_status", {}));
    expect(typeof status.running).toBe("boolean");
    if (status.running) expect(String(status.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    else expect(String(status.note)).toMatch(/open_board/);
  }, 60_000);

  it("keeps edge colours through a regenerate", async () => {
    const board = "colored.excalidraw";
    const args = {
      path: board,
      title: "Colored",
      nodes: [
        { id: "a", label: "A", backgroundColor: "#4dabf7", strokeColor: "#1971c2" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b", label: "flow", strokeColor: "#1971c2" }],
    };
    await call("create_diagram", args);
    // Regenerating must not silently revert styling and force a second pass.
    await call("create_diagram", args);

    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    const live = parsed.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted);
    const arrows = live.filter((element: { type: string }) => element.type === "arrow");
    expect(arrows.length).toBeGreaterThan(0);
    expect(arrows.every((arrow: { strokeColor: string }) => arrow.strokeColor === "#1971c2")).toBe(true);

    // The label on the filled node must not inherit a near-invisible colour.
    const filled = live.find(
      (element: { customData?: { node?: string } }) => element.customData?.node === "a",
    );
    const label = live.find((element: { containerId?: string }) => element.containerId === filled.id);
    expect(label.strokeColor).not.toBe("#1971c2");
  }, 120_000);

  /**
   * Without this tool the only way to drop a diagram was to regenerate the
   * board from a graph you still had to hand, or to enumerate element ids into
   * edit_diagram. Both are workarounds standing in for a missing feature.
   */
  it("deletes a named diagram without disturbing another on the same board", async () => {
    const board = "two-diagrams.excalidraw";
    await call("create_diagram", { path: board, nodes: [{ id: "a", label: "A" }], name: "arch" });
    await call("create_diagram", {
      path: board,
      nodes: [{ id: "b", label: "B" }],
      name: "ims",
      append: true,
    });

    // The names delete_diagram takes have to be discoverable from a read.
    const before = jsonOf(await call("read_diagram", { path: board }));
    expect((before.diagrams as Array<{ name: string }>).map((diagram) => diagram.name)).toEqual([
      "arch",
      "ims",
    ]);

    const deleted = jsonOf(await call("delete_diagram", { path: board, name: "arch" }));
    expect(deleted.deleted).toEqual(["arch"]);
    expect(deleted.remainingDiagrams).toEqual(["ims"]);

    const graph = jsonOf(await call("read_diagram", { path: board }));
    expect((graph.nodes as Array<{ id: string }>).map((node) => node.id)).toEqual(["b"]);

    // Removing the last one leaves a valid, empty board rather than a stub.
    const emptied = jsonOf(await call("delete_diagram", { path: board }));
    expect(emptied.remainingDiagrams).toBeUndefined();
    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    expect(parsed.type).toBe("excalidraw");
    expect(parsed.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted)).toEqual([]);
  }, 120_000);

  it("refuses an unknown diagram name instead of reporting a no-op as success", async () => {
    const board = "named.excalidraw";
    await call("create_diagram", { path: board, nodes: [{ id: "a", label: "A" }], name: "arch" });
    const result = await client.callTool({
      name: "delete_diagram",
      arguments: { path: board, name: "nope" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/Available: arch/);
  }, 120_000);

  /**
   * Two images whose names sanitise to the same string used to land on the same
   * element id and overwrite each other in board.files, and re-placing one
   * appended a second element carrying an id the first already had.
   */
  it("gives every image its own id and updates in place when re-placed", async () => {
    const board = "with-images.excalidraw";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(workspace, "shot a.png"), png);
    await writeFile(path.join(workspace, "shot-a.png"), png);
    await call("create_diagram", { path: board, nodes: [{ id: "n", label: "N" }] });

    const first = jsonOf(await call("place_image", { path: board, image: "shot a.png" }));
    const second = jsonOf(await call("place_image", { path: board, image: "shot-a.png" }));
    expect(first.elementId).not.toBe(second.elementId);

    // Move it, the way a user would, then re-place the same file.
    await call("edit_diagram", { path: board, updates: [{ id: first.elementId, x: 500, y: 700 }] });
    const again = jsonOf(await call("place_image", { path: board, image: "shot a.png" }));
    expect(again.replacedInPlace).toBe(first.elementId);

    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    const images = parsed.elements.filter(
      (element: { type: string; isDeleted?: boolean }) => element.type === "image" && !element.isDeleted,
    ) as Array<{ id: string; x: number; y: number }>;
    const ids = images.map((element) => element.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Both images must still have their own data behind them.
    expect(Object.keys(parsed.files)).toEqual(expect.arrayContaining(ids));
    // Re-placing must not drag the image back to where it was first put.
    expect(images.find((element) => element.id === first.elementId)).toMatchObject({ x: 500, y: 700 });
  }, 120_000);

  it("returns an error result rather than crashing on a bad graph", async () => {
    const result = await client.callTool({
      name: "create_diagram",
      arguments: { path: "broken.excalidraw", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  }, 60_000);
});
