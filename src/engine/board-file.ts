/**
 * Read and write `.excalidraw` files.
 *
 * The file is the source of truth: it opens in excalidraw.com, the VS Code
 * extension, or Obsidian, and it lives in the repo next to the code it
 * describes. Everything written here is deterministic so an unchanged diagram
 * produces an unchanged file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExcalidrawElement } from "./normalize";

export const EXCALIDRAW_FILE_TYPE = "excalidraw";
export const EXCALIDRAW_FILE_VERSION = 2;
// Provenance recorded in every file Excalidraw opens. Set this to the
// project's public URL once the plugin has one.
const SOURCE = "board-ai";

export interface BoardFile {
  type: string;
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export function emptyBoard(): BoardFile {
  return {
    type: EXCALIDRAW_FILE_TYPE,
    version: EXCALIDRAW_FILE_VERSION,
    source: SOURCE,
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

export function serializeBoard(board: BoardFile): string {
  // Two-space JSON with a trailing newline: the shape Excalidraw itself
  // writes, so hand-edits in the app produce minimal diffs against ours.
  return `${JSON.stringify(board, null, 2)}\n`;
}

export async function readBoard(file: string): Promise<BoardFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBoard();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${String(error)}`);
  }
  const board = parsed as Partial<BoardFile>;
  if (board.type !== EXCALIDRAW_FILE_TYPE) {
    throw new Error(`${file} is not an Excalidraw file (type=${String(board.type)})`);
  }
  return {
    ...emptyBoard(),
    ...board,
    elements: Array.isArray(board.elements) ? (board.elements as ExcalidrawElement[]) : [],
  };
}

export async function writeBoard(file: string, board: BoardFile): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, serializeBoard(board), "utf8");
}
