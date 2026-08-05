#!/usr/bin/env node
/**
 * Serves a board live, without going through the MCP server.
 *
 *   npm run board docs/diagrams/example.excalidraw
 *
 * The page follows the file: anything that writes it -- Claude, another
 * editor, git checkout -- shows up immediately, and anything drawn in the page
 * is written straight back.
 */
import path from "node:path";
import { spawn } from "node:child_process";

import { readBoard, writeBoard } from "../src/engine/board-file.ts";
import { resolveBoardPort, startBoardServer } from "../src/server/board-server.ts";

const target = process.argv[2];
if (!target) {
  console.error("usage: npm run board <board.excalidraw>");
  process.exit(2);
}
const file = path.resolve(process.cwd(), path.extname(target) ? target : `${target}.excalidraw`);

// Materialise the file first so the watcher has something to follow.
await writeBoard(file, await readBoard(file));

const server = await startBoardServer({ file, port: resolveBoardPort(process.env.DIAGRAMOS_PORT) });
console.log(`board  ${path.relative(process.cwd(), file)}`);
console.log(`live   ${server.url}`);
console.log("ctrl-c to stop");

if (process.env.DIAGRAMOS_NO_OPEN !== "1") {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(command, [server.url], { detached: true, stdio: "ignore" }).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
