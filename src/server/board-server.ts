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

/** Where the board listens unless BOARD_PORT says otherwise. */
export const DEFAULT_BOARD_PORT = 4747;

/**
 * The port to serve on, from a BOARD_PORT-style value.
 *
 * A bad value is refused rather than coerced. `Number("abc")` is NaN, which is
 * not nullish, so it survives every `?? default` on the way down and reaches
 * `listen` -- and a NaN port makes probeBoardServer report "no board running"
 * when the truth is "your configuration is broken". Falling back to the default
 * would hide the typo just as effectively; the only useful answer is to say so.
 */
export function resolveBoardPort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_BOARD_PORT;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BOARD_PORT is "${raw}", which is not a port number between 1 and 65535.`);
  }
  return port;
}

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
  /** The follow view: shows whichever board is current, and follows setFile. */
  url: string;
  port: number;
  /** The board the follow view is showing. Changes via setFile. */
  readonly file: string;
  /**
   * Points the follow view at a different board. Done in place rather than by
   * restarting, so open pages keep their connection and simply follow along.
   * Pages pinned to a specific board with `?file=` are deliberately unaffected.
   */
  setFile(next: string): Promise<void>;
  /**
   * A URL pinned to one board. Two of these opened side by side stay on their
   * own file no matter what any tool writes, which is the point of them.
   */
  urlFor(file: string): string;
  /** Boards this server has been asked for, current one first. */
  boards(): string[];
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

/** Per-board state. One of these exists for every board anyone has asked for. */
interface BoardState {
  revision: string;
  /** Pages pinned to this board with `?file=`. */
  subscribers: Subscriber[];
  debounce?: NodeJS.Timeout;
}

export async function startBoardServer(options: BoardServerOptions): Promise<RunningBoardServer> {
  let file = path.resolve(options.file);
  const host = options.host ?? "127.0.0.1";
  const root = options.root ? path.resolve(options.root) : undefined;

  let nextSubscriberId = 0;
  /**
   * Every board this server has been asked for, by absolute path. Several can be
   * live at once: a project split across diagrams wants them side by side, and
   * one server on one port beats a scatter of ports nobody can keep track of.
   */
  const boards = new Map<string, BoardState>();
  /**
   * Pages on the bare URL, with no board named. They show whichever board is
   * current and follow setFile, which is what every tool that writes a diagram
   * relies on to bring it on screen.
   */
  let followers: Subscriber[] = [];
  // One watcher per directory rather than per board: boards usually share a
  // directory, and watching it twice would deliver every event twice.
  const watchers = new Map<string, FSWatcher>();

  const write = (subscribers: Subscriber[], payload: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const subscriber of subscribers) subscriber.response.write(frame);
  };

  /** Tells everyone watching `target` about it: pinned pages, and followers when it is current. */
  const announce = (target: string, revision: string, extra: Record<string, unknown> = {}) => {
    const state = boards.get(target);
    if (state) write(state.subscribers, { type: "board", revision, file: target, ...extra });
    if (target === file) write(followers, { type: "board", revision, file: target, ...extra });
  };

  // Editors and our own writes both land as rename or change events, and
  // several can arrive for one logical save, so debounce and compare hashes
  // rather than trusting the event itself.
  const onFileEvent = (target: string) => {
    const state = boards.get(target);
    if (!state) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(async () => {
      try {
        const revision = revisionOf(await readBoard(target));
        if (revision === state.revision) return;
        state.revision = revision;
        announce(target, revision);
      } catch {
        // A partially written file will fire again when the write completes.
      }
    }, 60);
  };

  // Watch the directory, not just the file: atomic saves replace the inode and
  // a file-level watcher goes deaf after the first one.
  const watchDirectory = (directory: string) => {
    if (watchers.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, name) => {
        if (!name) {
          // No filename: check every board in this directory.
          for (const target of boards.keys()) {
            if (path.dirname(target) === directory) onFileEvent(target);
          }
          return;
        }
        const target = path.join(directory, path.basename(String(name)));
        if (boards.has(target)) onFileEvent(target);
      });
      watchers.set(directory, watcher);
    } catch {
      // Without a watcher the browser still polls on reconnect; liveness
      // degrades but nothing breaks.
    }
  };

  /** Starts tracking a board, so it can be served and watched. */
  const track = async (target: string): Promise<BoardState> => {
    const existing = boards.get(target);
    if (existing) return existing;
    const state: BoardState = { revision: revisionOf(await readBoard(target)), subscribers: [] };
    boards.set(target, state);
    watchDirectory(path.dirname(target));
    return state;
  };

  await track(file);

  const setFile = async (next: string): Promise<void> => {
    const resolved = path.resolve(next);
    if (resolved === file) return;
    const state = await track(resolved);
    file = resolved;
    // switchedFile tells the page this is a different document, so it reframes
    // rather than assuming the old viewport still means anything. Only followers
    // hear it; a pinned page has not switched to anything.
    write(followers, { type: "board", revision: state.revision, file, switchedFile: true });
  };

  /**
   * Which board a request is about: `?file=` when given, the current one
   * otherwise. Relative paths resolve against the root, and anything outside it
   * is refused — the query string is as much an untrusted input as the
   * takeover endpoint's body.
   */
  const requestedFile = (url: URL): { file?: string; error?: string } => {
    const raw = url.searchParams.get("file");
    if (!raw) return { file };
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root ?? ROOT, raw);
    if (root) {
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { error: `file is outside the board root (${root})` };
      }
    }
    return { file: resolved };
  };

  /** How a pinned URL names a board: relative to the root when there is one. */
  const nameFor = (target: string) => {
    const resolved = path.resolve(target);
    if (!root) return resolved;
    const relative = path.relative(root, resolved);
    return relative.startsWith("..") || path.isAbsolute(relative) ? resolved : relative;
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
        return json(response, 200, {
          ok: true,
          file,
          revision: boards.get(file)?.revision,
          pid: process.pid,
          // Tells another process that `?file=` is understood here. Without it a
          // newer session would hand out pinned URLs to an older server, which
          // ignores the query and silently serves the wrong board.
          multiBoard: true,
          boards: [...boards.keys()],
        });
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
        const target = requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        if (!(await fileExists(target.file))) {
          return json(response, 404, { error: `no such file: ${target.file}` });
        }
        const state = await track(target.file);
        const board = await readBoard(target.file);
        state.revision = revisionOf(board);
        return json(response, 200, { revision: state.revision, board, file: target.file });
      }

      if (request.method === "POST" && url.pathname === "/api/board") {
        const target = requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        const payload = JSON.parse(await readBody(request)) as {
          revision?: string;
          board?: BoardFile;
        };
        if (!payload.board || !Array.isArray(payload.board.elements)) {
          return json(response, 400, { error: "board with an elements array is required" });
        }
        const state = await track(target.file);
        const onDisk = await readBoard(target.file);
        const diskRevision = revisionOf(onDisk);
        if (payload.revision && payload.revision !== diskRevision) {
          // Stale write. Hand back the current board so the browser can merge
          // its own edits over it instead of clobbering or losing them.
          return json(response, 409, { error: "stale revision", revision: diskRevision, board: onDisk });
        }
        await writeBoard(target.file, payload.board);
        state.revision = revisionOf(payload.board);
        announce(target.file, state.revision);
        return json(response, 200, { revision: state.revision });
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        const target = requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        // A stream named a board explicitly: pin it, so nothing re-points it.
        const pinned = url.searchParams.has("file");
        const state = await track(target.file);

        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ type: "board", revision: state.revision, file: target.file })}\n\n`,
        );
        const subscriber = { response, id: ++nextSubscriberId };
        if (pinned) state.subscribers.push(subscriber);
        else followers.push(subscriber);
        // Proxies drop idle streams; a periodic comment keeps it warm.
        const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
        request.on("close", () => {
          clearInterval(keepAlive);
          if (pinned) {
            state.subscribers = state.subscribers.filter((candidate) => candidate.id !== subscriber.id);
          } else {
            followers = followers.filter((candidate) => candidate.id !== subscriber.id);
          }
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
    urlFor(target: string) {
      return `http://${host}:${port}/?file=${encodeURIComponent(nameFor(target))}`;
    },
    boards() {
      return [file, ...[...boards.keys()].filter((candidate) => candidate !== file)];
    },
    async close() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const state of boards.values()) {
        if (state.debounce) clearTimeout(state.debounce);
        for (const subscriber of state.subscribers) subscriber.response.end();
        state.subscribers = [];
      }
      for (const subscriber of followers) subscriber.response.end();
      followers = [];
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface BoardProbe {
  /** The board its follow view is showing. */
  file?: string;
  /**
   * Whether it understands `?file=` pinned URLs. Absent on a server from before
   * boards could be opened side by side — handing such a server a pinned URL
   * would look fine and quietly serve whatever board it happens to be on.
   */
  multiBoard?: boolean;
  boards?: string[];
}

/** What the board server on this port says about itself, if one is there. */
export async function probeBoard(port: number, host = "127.0.0.1"): Promise<BoardProbe | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as BoardProbe;
  } catch {
    return undefined;
  }
}

/** The file a board server is serving on this port, or undefined if none is. */
export async function probeBoardServer(port: number, host = "127.0.0.1"): Promise<string | undefined> {
  return (await probeBoard(port, host))?.file;
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
