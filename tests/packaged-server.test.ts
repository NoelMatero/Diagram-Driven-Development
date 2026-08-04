/**
 * Drives the *built* server — out/cli/server.mjs, the file published to npm and
 * the one an installed plugin runs — rather than the TypeScript sources.
 *
 * Bundling collapses every module onto one file, so anything that locates an
 * asset relative to its own source file resolves differently there than it does
 * under tsx: the vendored Excalidraw bundle, the Excalifont metrics, out/viewer.
 * A source-run test cannot see that class of break, and it does not surface as a
 * crash either — a missing font measurer just sizes every box wrong.
 *
 * No graceful skip when the bundle is absent: `npm install` builds it through
 * `prepare`, so a missing bundle is a real regression, not a reason to pass.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { measureExcalifont } from "../src/engine/font";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(__dirname, "..");
const BUNDLE = path.join(REPO, "out/cli/server.mjs");
const BOARD = "diagrams/packaged.excalidraw";
/** Mirrors FALLBACK_CHAR_RATIO in src/engine/font.ts. */
const FALLBACK_CHAR_RATIO = 0.55;

let workspace: string;
let client: Client;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** Fails with the server's own message: a bundling break says why in the text. */
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
}

beforeAll(async () => {
  if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} is not built. Run \`npm run build:cli\`.`);
  workspace = mkdtempSync(path.join(os.tmpdir(), "board-packaged-"));
  client = new Client({ name: "packaged-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE],
      // Deliberately not REPO: an installed server runs from anywhere, and the
      // workspace arrives through the environment the way the plugin sets it.
      cwd: os.tmpdir(),
      env: { ...process.env, BOARD_MCP_ROOT: workspace },
    }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("packaged server", () => {
  it("serves the same tools as the source build", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("create_diagram");
    expect(names).toContain("read_diagram");
    expect(names).toContain("open_board");
  });

  it("draws a diagram, which means it found the vendored Excalidraw bundle", async () => {
    await call("create_diagram", {
      path: BOARD,
      nodes: [
        { id: "api", label: "API" },
        { id: "db", label: "Database" },
      ],
      edges: [{ from: "api", to: "db" }],
    });
    expect(existsSync(path.join(workspace, BOARD))).toBe(true);
  }, 120_000);

  it("sizes boxes from real font metrics rather than the fallback estimate", async () => {
    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8")) as {
      elements: Array<{ type: string; text?: string; width: number; fontSize: number }>;
    };
    const label = board.elements.find((element) => element.type === "text" && element.text === "Database");
    expect(label).toBeDefined();

    // Compared against the measurer rather than a hardcoded pixel count, which
    // would pin the test to a font version. If the packaged bundle failed to
    // load fontkit or find the font files, font.ts silently substitutes
    // length * fontSize * 0.55 and every box comes out the wrong size — the
    // failure this test exists for, and one that throws nothing.
    const real = measureExcalifont(label!.text!, label!.fontSize);
    const fallback = label!.text!.length * label!.fontSize * FALLBACK_CHAR_RATIO;
    expect(Math.abs(label!.width - real)).toBeLessThan(1);
    expect(Math.abs(real - fallback)).toBeGreaterThan(1);
  });

  it("reads the diagram back as a graph", async () => {
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    const nodes = (graph.nodes ?? []) as Array<{ label?: string }>;
    expect(nodes.map((node) => node.label)).toEqual(expect.arrayContaining(["API", "Database"]));
  });
});
