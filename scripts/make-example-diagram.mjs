#!/usr/bin/env node
/**
 * End-to-end proof of the headless pipeline: graph -> ELK layout -> Excalidraw
 * elements -> a real .excalidraw file, with no browser anywhere.
 *
 *   npm run diagram:example
 *
 * Open the result in excalidraw.com, or render it with `npm run diagram:render`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installExcalifontMeasurer } from "../tests/helpers/excalifont.ts";
import { emptyBoard, writeBoard } from "../src/engine/board-file.ts";
import { createDiagram } from "../src/engine/diagram.ts";
import { readGraph } from "../src/engine/graph.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? path.join(root, "docs/diagrams/example.excalidraw");

// Measure in the font Excalidraw actually renders, not an estimate.
installExcalifontMeasurer();

const { board, nodeCount, edgeCount, elementCount } = await createDiagram(emptyBoard(), {
  title: "Diagram-driven development",
  name: "example",
  nodes: [
    { id: "claude", label: "Claude Code", rounded: true },
    { id: "mcp", label: "Board MCP server" },
    { id: "engine", label: "ELK layout engine" },
    { id: "file", label: "board.excalidraw", backgroundColor: "#d0ebff" },
    { id: "human", label: "You", shape: "ellipse", backgroundColor: "#ffec99" },
  ],
  edges: [
    { from: "claude", to: "mcp", label: "tool call" },
    { from: "mcp", to: "engine", label: "graph" },
    { from: "engine", to: "file", label: "writes" },
    { from: "file", to: "mcp", label: "reads back" },
    { from: "human", to: "file", label: "edits" },
  ],
  layout: { direction: "RIGHT" },
});

await writeBoard(outfile, board);

// Read it straight back: the file has to survive the round trip, not just be
// writable.
const graph = readGraph(board);
const guessed = [...graph.nodes, ...graph.edges].filter((item) => item.provenance !== "recorded");

console.log(`wrote ${path.relative(root, outfile)}`);
console.log(`  ${nodeCount} nodes, ${edgeCount} edges -> ${elementCount} elements`);
console.log(`  read back: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${guessed.length} inferred`);
console.log("  render it with: npm run diagram:render docs/diagrams/example.excalidraw out.png");
