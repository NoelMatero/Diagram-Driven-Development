/**
 * The live board server: file -> browser and browser -> file, plus the
 * conflict rule that keeps an agent write from erasing a human stroke.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, readBoard, writeBoard, type BoardFile } from "../src/engine/board-file";
import {
  DEFAULT_BOARD_PORT,
  resolveBoardPort,
  startBoardServer,
  type RunningBoardServer,
} from "../src/server/board-server";

let workspace: string;
let boardFile: string;
let server: RunningBoardServer;

function elementNamed(id: string, x = 0): Record<string, unknown> {
  return {
    id,
    type: "rectangle",
    x,
    y: 0,
    width: 100,
    height: 60,
    version: 1,
    isDeleted: false,
  };
}

function boardWith(...ids: string[]): BoardFile {
  return { ...emptyBoard(), elements: ids.map((id, index) => elementNamed(id, index * 200)) as never };
}

const api = (route: string) => new URL(route, server.url).href;

/** Resolves on the first SSE frame whose revision differs from `known`. */
function waitForPush(known: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("No SSE push arrived"));
    }, timeoutMs);

    void (async () => {
      try {
        const response = await fetch(api("/api/events"), { signal: controller.signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (const line of buffer.split("\n\n")) {
            const match = /^data: (.*)$/m.exec(line);
            if (!match) continue;
            const payload = JSON.parse(match[1]) as { revision?: string };
            if (payload.revision && payload.revision !== known) {
              clearTimeout(timer);
              controller.abort();
              return resolve(payload.revision);
            }
          }
          buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
        }
      } catch (error) {
        if (!controller.signal.aborted) reject(error);
      }
    })();
  });
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "board-live-"));
  boardFile = path.join(workspace, "board.excalidraw");
  await writeBoard(boardFile, boardWith("a"));
  server = await startBoardServer({ file: boardFile, port: 0, root: workspace });
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("board server", () => {
  it("serves the board with a revision", async () => {
    const payload = (await (await fetch(api("/api/board"))).json()) as {
      revision: string;
      board: BoardFile;
    };
    expect(payload.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.board.elements).toHaveLength(1);
  });

  it("writes what the browser sends and hands back the new revision", async () => {
    const before = (await (await fetch(api("/api/board"))).json()) as { revision: string };
    const response = await fetch(api("/api/board"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: before.revision, board: boardWith("a", "b") }),
    });
    expect(response.status).toBe(200);

    const onDisk = JSON.parse(await readFile(boardFile, "utf8")) as BoardFile;
    expect(onDisk.elements.map((element) => element.id)).toEqual(["a", "b"]);
  });

  /** This is the path a Claude tool write takes to reach an open browser. */
  it("pushes an SSE frame when the file changes underneath it", async () => {
    const before = (await (await fetch(api("/api/board"))).json()) as { revision: string };
    const pushed = waitForPush(before.revision);
    // Let the stream attach before touching the file.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeBoard(boardFile, boardWith("a", "b", "c"));

    const revision = await pushed;
    expect(revision).not.toBe(before.revision);
    const after = (await (await fetch(api("/api/board"))).json()) as { board: BoardFile };
    expect(after.board.elements).toHaveLength(3);
  }, 20_000);

  it("refuses a stale save and returns the current board to merge against", async () => {
    const stale = "0000000000000000";
    const response = await fetch(api("/api/board"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: stale, board: boardWith("only-mine") }),
    });
    expect(response.status).toBe(409);

    const conflict = (await response.json()) as { revision: string; board: BoardFile };
    expect(conflict.board.elements.length).toBeGreaterThan(1);

    // The rejected write must not have landed.
    const onDisk = await readBoard(boardFile);
    expect(onDisk.elements.map((element) => element.id)).not.toEqual(["only-mine"]);

    // Retrying against the revision it just learned succeeds.
    const retry = await fetch(api("/api/board"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: conflict.revision, board: boardWith("a", "b", "c", "d") }),
    });
    expect(retry.status).toBe(200);
  }, 20_000);

  it("rejects a payload that is not a board", async () => {
    const response = await fetch(api("/api/board"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: { nope: true } }),
    });
    expect(response.status).toBe(400);
  });

  it("does not serve files outside the viewer directory", async () => {
    const response = await fetch(api("/../../package.json"), { redirect: "manual" });
    expect(response.status).not.toBe(200);
  });

  /**
   * The reported failure: a board pinned to one file shows nothing when a tool
   * writes a different one, and looks identical to a board that has stopped
   * working. Switching happens in place so open pages keep their connection.
   */
  it("follows a switch to another file and tells subscribers", async () => {
    const other = path.join(workspace, "other.excalidraw");
    await writeBoard(other, boardWith("x", "y", "z"));

    const before = (await (await fetch(api("/api/board"))).json()) as { revision: string };
    const pushed = waitForPush(before.revision);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await server.setFile(other);
    await pushed;

    const after = (await (await fetch(api("/api/board"))).json()) as {
      board: BoardFile;
      file: string;
    };
    expect(after.file).toBe(other);
    expect(after.board.elements.map((element) => element.id)).toEqual(["x", "y", "z"]);
    expect(server.file).toBe(other);

    // Writes to the newly followed file must reach subscribers too, i.e. the
    // watcher moved rather than staying on the old path.
    const mid = (await (await fetch(api("/api/board"))).json()) as { revision: string };
    const second = waitForPush(mid.revision);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeBoard(other, boardWith("x", "y", "z", "w"));
    await expect(second).resolves.toBeTruthy();

    await server.setFile(boardFile);
  }, 20_000);

  /**
   * The port is shared across sessions, so a stale process must not be able to
   * pin the board to a file nobody is working on. Any local session can steer
   * whoever holds it.
   */
  it("lets another process re-point the board over HTTP", async () => {
    const other = path.join(workspace, "steered.excalidraw");
    await writeBoard(other, boardWith("p", "q"));

    const response = await fetch(api("/api/file"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: other }),
    });
    expect(response.status).toBe(200);
    expect(server.file).toBe(other);

    const shown = (await (await fetch(api("/api/board"))).json()) as { board: BoardFile };
    expect(shown.board.elements.map((element) => element.id)).toEqual(["p", "q"]);
    await server.setFile(boardFile);
  }, 20_000);

  it("refuses to be steered outside its root", async () => {
    const response = await fetch(api("/api/file"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "/etc/hosts" }),
    });
    expect(response.status).toBe(403);
    expect(server.file).toBe(boardFile);
  }, 20_000);

  it("reports a missing file rather than serving an empty board", async () => {
    const response = await fetch(api("/api/file"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: path.join(workspace, "nope.excalidraw") }),
    });
    expect(response.status).toBe(404);
    expect(server.file).toBe(boardFile);
  }, 20_000);

  /**
   * Number("abc") is NaN, and NaN is not nullish, so a coerced port survives
   * every `?? default` on the way down to listen(). The reason to refuse rather
   * than fall back is diagnostic: a NaN port makes the health probe report "no
   * board running", which is the one answer that sends a caller looking in
   * entirely the wrong place.
   */
  it("refuses a port that is not a port instead of coercing it", () => {
    expect(resolveBoardPort(undefined)).toBe(DEFAULT_BOARD_PORT);
    expect(resolveBoardPort("")).toBe(DEFAULT_BOARD_PORT);
    expect(resolveBoardPort(" 5100 ")).toBe(5100);
    for (const bad of ["abc", "4747abc", "0", "65536", "-1", "80.5", "NaN"]) {
      expect(() => resolveBoardPort(bad), bad).toThrow(/not a port number/);
    }
  });

  it("reports health with the file it is serving", async () => {
    const health = (await (await fetch(api("/api/health"))).json()) as { ok: boolean; file: string };
    expect(health.ok).toBe(true);
    expect(health.file).toBe(boardFile);
  });
});

/**
 * Several boards at once, so a project split across diagrams can have them side
 * by side. One server, one port; the page names its board with `?file=`.
 *
 * The invariant worth protecting: a pinned page is answerable only to its own
 * file. Re-pointing the follow view, or writing another diagram, must not move
 * it -- that would be the old single-board behaviour wearing a new URL.
 */
describe("board server serving several boards", () => {
  const second = () => path.join(workspace, "second.excalidraw");
  const pinned = (route: string, file: string) => `${api(route)}?file=${encodeURIComponent(file)}`;

  beforeAll(async () => {
    await writeBoard(second(), boardWith("s1", "s2"));
  });

  it("serves a board named in the query, not the one it was started on", async () => {
    const payload = (await (await fetch(pinned("/api/board", second()))).json()) as {
      board: BoardFile;
      file: string;
    };
    expect(payload.file).toBe(second());
    expect(payload.board.elements.map((element) => (element as { id: string }).id)).toEqual(["s1", "s2"]);
  });

  it("keeps each board's revision separate", async () => {
    const one = (await (await fetch(api("/api/board"))).json()) as { revision: string };
    const two = (await (await fetch(pinned("/api/board", second()))).json()) as { revision: string };
    expect(one.revision).not.toBe(two.revision);
  });

  it("writes to the board named in the query and leaves the other alone", async () => {
    const before = await readBoard(boardFile);
    const response = await fetch(pinned("/api/board", second()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: boardWith("s1", "s2", "s3") }),
    });
    expect(response.status).toBe(200);

    expect((await readBoard(second())).elements).toHaveLength(3);
    // The board this server was started on must be untouched.
    expect((await readBoard(boardFile)).elements).toEqual(before.elements);
  });

  it("does not move a pinned page when the follow view is re-pointed", async () => {
    // A pinned stream must hear nothing at all from a switch: the frame it would
    // hear is the one that makes the page load a different diagram.
    const controller = new AbortController();
    const frames: Array<{ file?: string; switchedFile?: boolean }> = [];
    const stream = (async () => {
      const response = await fetch(pinned("/api/events", second()), { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const match of decoder.decode(value, { stream: true }).matchAll(/^data: (.*)$/gm)) {
          frames.push(JSON.parse(match[1]));
        }
      }
    })().catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const opening = frames.length; // the stream's own opening frame
    await server.setFile(boardFile);
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    await stream;

    expect(server.file).toBe(boardFile);
    expect(frames.slice(opening)).toEqual([]);
    // And every frame it did get was about its own board.
    expect(frames.every((frame) => frame.file === second())).toBe(true);
  }, 20_000);

  it("refuses a board outside its root", async () => {
    const response = await fetch(pinned("/api/board", "/etc/passwd"));
    expect(response.status).toBe(403);
  });

  it("refuses a query that climbs out of the root", async () => {
    const response = await fetch(`${api("/api/board")}?file=${encodeURIComponent("../../etc/passwd")}`);
    expect(response.status).toBe(403);
  });

  it("404s a board that does not exist rather than serving an empty one", async () => {
    const response = await fetch(pinned("/api/board", path.join(workspace, "ghost.excalidraw")));
    expect(response.status).toBe(404);
  });

  it("advertises that it understands pinned URLs, and lists what is open", async () => {
    const health = (await (await fetch(api("/api/health"))).json()) as {
      multiBoard?: boolean;
      boards?: string[];
    };
    // Another session reads this to decide whether a pinned URL is safe to hand
    // out, or whether it has to re-point an older server's single page instead.
    expect(health.multiBoard).toBe(true);
    expect(health.boards).toContain(boardFile);
    expect(health.boards).toContain(second());
  });

  it("builds a pinned URL that names the board relative to the root", () => {
    expect(server.urlFor(second())).toBe(`${server.url}?file=second.excalidraw`);
    expect(server.boards()[0]).toBe(server.file);
  });
});
