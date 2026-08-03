/**
 * Local board server: a live window onto a .excalidraw file.
 *
 * The file stays the source of truth. This server watches it, pushes changes
 * to any open browser over SSE, and writes back what the browser draws. Claude
 * and the human therefore edit the same artifact without either one owning it,
 * and every tool keeps working unchanged when no browser is open at all.
 *
 * Conflicts resolve in the human's favour. A save carrying a stale revision is
 * refused with the current board attached; the browser merges its own edits
 * over the top and retries, so an agent write can never silently discard a
 * stroke the human just made.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoard, serializeBoard, writeBoard, type BoardFile } from "../engine/board-file";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWER_DIR = path.join(ROOT, "out/viewer");

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function revisionOf(board: BoardFile): string {
  return createHash("sha1").update(serializeBoard(board)).digest("hex").slice(0, 16);
}

interface Subscriber {
  response: ServerResponse;
  id: number;
}

export interface BoardServerOptions {
  file: string;
  port?: number;
  host?: string;
  /**
   * Paths accepted by POST /api/file must live under this directory. Without
   * it the takeover endpoint would let any local caller point the board at an
   * arbitrary file on disk.
   */
  root?: string;
}

export interface RunningBoardServer {
  url: string;
  port: number;
  /** The board currently being served. Changes via setFile. */
  readonly file: string;
  /**
   * Points the live page at a different board. Done in place rather than by
   * restarting, so open pages keep their connection and simply follow along.
   */
  setFile(next: string): Promise<void>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export async function startBoardServer(options: BoardServerOptions): Promise<RunningBoardServer> {
  let file = path.resolve(options.file);
  const host = options.host ?? "127.0.0.1";

  let subscribers: Subscriber[] = [];
  let nextSubscriberId = 0;
  let currentRevision = revisionOf(await readBoard(file));

  const broadcast = (revision: string, extra: Record<string, unknown> = {}) => {
    const frame = `data: ${JSON.stringify({ type: "board", revision, file, ...extra })}\n\n`;
    for (const subscriber of subscribers) subscriber.response.write(frame);
  };

  // Editors and our own writes both land as rename or change events, and
  // several can arrive for one logical save, so debounce and compare hashes
  // rather than trusting the event itself.
  let debounce: NodeJS.Timeout | undefined;
  const onFileEvent = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const revision = revisionOf(await readBoard(file));
        if (revision === currentRevision) return;
        currentRevision = revision;
        broadcast(revision);
      } catch {
        // A partially written file will fire again when the write completes.
      }
    }, 60);
  };

  // Watch the directory, not just the file: atomic saves replace the inode and
  // a file-level watcher goes deaf after the first one.
  let watcher: FSWatcher | undefined;
  const startWatching = () => {
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(path.dirname(file), (_event, name) => {
        if (!name || path.basename(String(name)) === path.basename(file)) onFileEvent();
      });
    } catch {
      // Without a watcher the browser still polls on reconnect; liveness
      // degrades but nothing breaks.
    }
  };
  startWatching();

  const setFile = async (next: string): Promise<void> => {
    const resolved = path.resolve(next);
    if (resolved === file) return;
    file = resolved;
    startWatching();
    currentRevision = revisionOf(await readBoard(file));
    // switchedFile tells the page this is a different document, so it reframes
    // rather than assuming the old viewport still means anything.
    broadcast(currentRevision, { switchedFile: true });
  };

  const serveViewer = async (response: ServerResponse, pathname: string) => {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(VIEWER_DIR, relative);
    if (target !== VIEWER_DIR && !target.startsWith(`${VIEWER_DIR}${path.sep}`)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": MIME_BY_EXT[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": body.byteLength,
      });
      response.end(body);
    } catch {
      if (relative === "index.html") {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Viewer is not built yet. Run `npm run build:viewer`.");
        return;
      }
      response.writeHead(404).end("not found");
    }
  };

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);

      if (url.pathname === "/api/health") {
        return json(response, 200, { ok: true, file, revision: currentRevision, pid: process.pid });
      }

      /*
       * Lets a different process steer this board. The port is shared across
       * sessions, so whichever process happens to own it must not be the only
       * one able to decide which file is on screen -- otherwise a stale
       * session pins the board to a file nobody is working on.
       */
      if (request.method === "POST" && url.pathname === "/api/file") {
        const payload = JSON.parse(await readBody(request, 8192)) as { file?: string };
        if (typeof payload.file !== "string" || !payload.file) {
          return json(response, 400, { error: "file is required" });
        }
        const requested = path.resolve(payload.file);
        const root = options.root ? path.resolve(options.root) : undefined;
        if (root) {
          const relative = path.relative(root, requested);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return json(response, 403, { error: `file is outside the board root (${root})` });
          }
        }
        if (!(await fileExists(requested))) {
          return json(response, 404, { error: `no such file: ${requested}` });
        }
        await setFile(requested);
        return json(response, 200, { ok: true, file });
      }

      if (request.method === "GET" && url.pathname === "/api/board") {
        const board = await readBoard(file);
        currentRevision = revisionOf(board);
        return json(response, 200, { revision: currentRevision, board, file });
      }

      if (request.method === "POST" && url.pathname === "/api/board") {
        const payload = JSON.parse(await readBody(request)) as {
          revision?: string;
          board?: BoardFile;
        };
        if (!payload.board || !Array.isArray(payload.board.elements)) {
          return json(response, 400, { error: "board with an elements array is required" });
        }
        const onDisk = await readBoard(file);
        const diskRevision = revisionOf(onDisk);
        if (payload.revision && payload.revision !== diskRevision) {
          // Stale write. Hand back the current board so the browser can merge
          // its own edits over it instead of clobbering or losing them.
          return json(response, 409, { error: "stale revision", revision: diskRevision, board: onDisk });
        }
        await writeBoard(file, payload.board);
        currentRevision = revisionOf(payload.board);
        broadcast(currentRevision);
        return json(response, 200, { revision: currentRevision });
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify({ type: "board", revision: currentRevision, file })}\n\n`);
        const subscriber = { response, id: ++nextSubscriberId };
        subscribers.push(subscriber);
        // Proxies drop idle streams; a periodic comment keeps it warm.
        const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
        request.on("close", () => {
          clearInterval(keepAlive);
          subscribers = subscribers.filter((candidate) => candidate.id !== subscriber.id);
        });
        return undefined;
      }

      if (request.method === "GET") return serveViewer(response, url.pathname);
      response.writeHead(405).end("method not allowed");
      return undefined;
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Board server did not bind a port"));
    });
  });

  return {
    url: `http://${host}:${port}/`,
    port,
    get file() {
      return file;
    },
    setFile,
    async close() {
      watcher?.close();
      if (debounce) clearTimeout(debounce);
      for (const subscriber of subscribers) subscriber.response.end();
      subscribers = [];
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** True when a board server is already serving this file on this port. */
export async function probeBoardServer(port: number, host = "127.0.0.1"): Promise<string | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { file?: string };
    return payload.file;
  } catch {
    return undefined;
  }
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
