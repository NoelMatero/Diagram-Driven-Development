#!/usr/bin/env node
/**
 * Renders a .excalidraw file to PNG.
 *
 *   npx tsx scripts/render-diagram.mjs <board.excalidraw> [out.png]
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";

import { readBoard } from "../src/engine/board-file.ts";
import { renderBoardToPng } from "../src/engine/render.ts";

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("usage: npx tsx scripts/render-diagram.mjs <board.excalidraw> [out.png]");
  process.exit(2);
}
const outfile = output ?? `${input.replace(/\.excalidraw$/, "")}.png`;

const png = await renderBoardToPng(await readBoard(input));
await writeFile(outfile, png);
console.log(`wrote ${path.relative(process.cwd(), outfile)} (${(png.byteLength / 1024).toFixed(0)} KB)`);
