#!/usr/bin/env node
/**
 * Reproduces the real usage flow against the live board.
 *
 *   npx tsx scripts/e2e-live-board.mjs
 *
 * Every assertion reads the scene the canvas is actually showing, via the
 * __boardScene test hook. Asserting through /api/board instead only proves the
 * server is reachable, which is how an earlier version of this script passed
 * while the canvas silently failed to update.
 */
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { chromium } from "playwright";

import { installExcalifontMeasurer } from "../tests/helpers/excalifont.ts";
import { emptyBoard, readBoard, writeBoard } from "../src/engine/board-file.ts";
import { createDiagram, connectNodes } from "../src/engine/diagram.ts";
import { startBoardServer } from "../src/server/board-server.ts";

installExcalifontMeasurer();

const workspace = mkdtempSync(path.join(os.tmpdir(), "board-e2e-"));
const file = path.join(workspace, "live.excalidraw");
const shot = (name) => path.join("/tmp", `live-${name}.png`);

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** The scene as rendered, not as served. */
const scene = (page) => page.evaluate(() => window.__boardScene?.() ?? { count: -1, ids: [] });

async function waitForScene(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = await scene(page);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await page.waitForTimeout(150);
    last = await scene(page);
  }
  return last;
}

let server;
let browser;
try {
  const first = await createDiagram(emptyBoard(), {
    title: "Version one",
    name: "v1",
    nodes: [
      { id: "editor", label: "Your browser" },
      { id: "file", label: "board.excalidraw", backgroundColor: "#d0ebff" },
    ],
    edges: [{ from: "editor", to: "file", label: "saves" }],
  });
  await writeBoard(file, first.board);

  server = await startBoardServer({ file, port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // Not networkidle: the SSE stream never closes, so the page is never idle.
  await page.goto(server.url, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__boardScene === "function", undefined, { timeout: 20_000 });
  const initial = await waitForScene(page, (value) => value.count > 0);
  check("initial board reaches the canvas", initial.count > 0, `${initial.count} elements`);
  await page.screenshot({ path: shot("1-initial") });

  // 1. Adding to the same file, the case that already worked.
  const grown = await connectNodes(await readBoard(file), [
    { from: "file", to: "editor", label: "pushes back" },
  ]);
  await writeBoard(file, grown.board);
  const after = await waitForScene(page, (value) => value.count > initial.count);
  check("added arrow appears without a reload", after.count > initial.count, `${initial.count} -> ${after.count}`);

  // 2. The reported failure: an entirely new diagram replacing the old one in
  //    the same file. Every element id changes, so a viewer that only merges
  //    additions will look frozen.
  const replaced = await createDiagram(await readBoard(file), {
    title: "Version two",
    name: "v2",
    nodes: [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ],
    edges: [
      { from: "alpha", to: "beta", label: "one" },
      { from: "beta", to: "gamma", label: "two" },
    ],
  });
  await writeBoard(file, replaced.board);

  const expectedIds = new Set(
    replaced.board.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)),
  );
  const swapped = await waitForScene(page, (value) => value.ids.some((id) => expectedIds.has(id)));
  const shown = new Set(swapped.ids);
  const missing = [...expectedIds].filter((id) => !shown.has(id));
  const stale = swapped.ids.filter((id) => !expectedIds.has(id));

  check("replacement diagram reaches the canvas", missing.length === 0, `${missing.length} missing`);
  check("stale elements are gone from the canvas", stale.length === 0, `${stale.length} left: ${stale.slice(0, 4).join(", ")}`);
  await page.screenshot({ path: shot("2-after-replacement") });

  // 3. The replacement must also survive on disk, not just on screen: a viewer
  //    that pushes its stale scene back would silently undo the tool's write.
  await page.waitForTimeout(1200);
  const onDisk = await readBoard(file);
  const diskIds = new Set(onDisk.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)));
  check(
    "file still holds the replacement after the viewer settles",
    [...expectedIds].every((id) => diskIds.has(id)),
    `${diskIds.size} ids on disk`,
  );

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\nscreenshots: ${shot("1-initial")}  ${shot("2-after-replacement")}`);
} finally {
  await browser?.close();
  await server?.close();
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
