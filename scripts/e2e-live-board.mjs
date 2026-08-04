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
const scene = (page) =>
  page.evaluate(() => window.__boardScene?.() ?? { count: -1, ids: [], revealing: false });

/** Settled means the reveal has finished, so a count can be trusted as final. */
const settled = (value) => !value.revealing;

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
  // Wait for the reveal to settle before counting: mid-reveal the canvas holds
  // a deliberate subset, and comparing against that would be measuring the
  // animation rather than the board.
  const initial = await waitForScene(page, (value) => value.count > 0 && settled(value));
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
  const swapped = await waitForScene(
    page,
    (value) => value.ids.some((id) => expectedIds.has(id)) && settled(value),
  );
  const shown = new Set(swapped.ids);
  const missing = [...expectedIds].filter((id) => !shown.has(id));
  const stale = swapped.ids.filter((id) => !expectedIds.has(id));

  check("replacement diagram reaches the canvas", missing.length === 0, `${missing.length} missing`);
  check("stale elements are gone from the canvas", stale.length === 0, `${stale.length} left: ${stale.slice(0, 4).join(", ")}`);
  await page.screenshot({ path: shot("2-after-replacement") });

  // 3. The reveal. A tool writes a diagram as one atomic save, so without this
  //    the whole picture flicks into existence at once. It should be drawn on.
  const revealNodes = Array.from({ length: 12 }, (_, index) => ({
    id: `s${index}`,
    label: `Step ${index}`,
  }));
  const revealed = await createDiagram(await readBoard(file), {
    title: "Revealed",
    name: "v3",
    nodes: revealNodes,
    edges: revealNodes.slice(1).map((node, index) => ({ from: revealNodes[index].id, to: node.id })),
  });
  const revealIds = new Set(
    revealed.board.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)),
  );
  const revealTotal = revealIds.size;

  const before = (await scene(page)).count;
  await writeBoard(file, revealed.board);
  // Sample far faster than the reveal advances, so intermediate frames cannot
  // slip between two polls.
  const counts = [];
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await scene(page);
    counts.push(value.count);
    if (counts.length > 2 && settled(value) && value.count === revealTotal) break;
    await page.waitForTimeout(25);
  }
  // Ignore the outgoing scene's own count; only states belonging to the new
  // diagram say anything about how it was revealed.
  const partial = [...new Set(counts)].filter(
    (count) => count !== before && count > 0 && count < revealTotal,
  );

  check(
    "diagram is revealed in steps rather than all at once",
    partial.length >= 3,
    `${partial.length} intermediate scenes: ${[...new Set(counts)].join(" -> ")}`,
  );
  // Only from the first frame of the new diagram onwards. The step down from the
  // outgoing scene's count is the replacement itself, not a reveal going
  // backwards -- a wholesale swap has to drop the old elements to show the new.
  const during = counts.slice(counts.findIndex((count) => count !== before));
  check(
    "the reveal only ever grows once it has started",
    during.length > 1 && during.every((count, index) => index === 0 || count >= during[index - 1]),
    during.join(" "),
  );
  check(
    "the reveal finishes on the complete scene",
    counts.at(-1) === revealTotal,
    `${counts.at(-1)} of ${revealTotal}`,
  );
  await page.screenshot({ path: shot("3-after-reveal") });

  // 4. Every write must also survive on disk, not just on screen: a viewer that
  //    pushes a stale -- or half-revealed -- scene back would undo the tool.
  await page.waitForTimeout(1200);
  const onDisk = await readBoard(file);
  const diskIds = new Set(onDisk.elements.filter((element) => !element.isDeleted).map((element) => String(element.id)));
  check(
    "file still holds the full diagram after the viewer settles",
    [...revealIds].every((id) => diskIds.has(id)),
    `${diskIds.size} ids on disk, expected ${revealTotal}`,
  );

  // 5. The status pill has to name the board actually being served, and stop
  //    claiming to when it cannot know. Both failed before: a switch between two
  //    files holding identical content left the old name in place reading `live`,
  //    because the revision is a content hash and the page skipped the pull.
  const pillText = () => page.$eval(".status", (el) => el.textContent.replace(/\s+/g, " ").trim());
  const twin = path.join(workspace, "twin.excalidraw");
  await writeBoard(twin, await readBoard(file));

  await server.setFile(twin);
  await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("twin"), undefined, {
    timeout: 8000,
  }).catch(() => undefined);
  check("pill follows a switch to a board with identical content", (await pillText()).includes("twin.excalidraw"), await pillText());

  // The pill must not present a filename as current once the connection is gone:
  // the server may have been re-pointed or replaced, and the page cannot tell.
  await server.close();
  await page.waitForFunction(() => document.querySelector(".status-file-stale") !== null, undefined, {
    timeout: 10_000,
  }).catch(() => undefined);
  check("pill marks the filename stale once disconnected", await page.$eval(".status", (el) => el.querySelector(".status-file-stale") !== null), await pillText());

  // Excalidraw owns the bottom-right corner: the Help button and the zen-mode
  // exit both live there, and the pill used to sit on top of them.
  const overlapping = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const hit = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    const pill = rect(document.querySelector(".status"));
    return [...document.querySelectorAll("button, .help-icon")]
      .filter((el) => rect(el).width > 0 && hit(pill, rect(el)))
      .map((el) => el.getAttribute("aria-label") ?? el.className.toString().slice(0, 30));
  });
  check("pill does not cover Excalidraw's own controls", overlapping.length === 0, overlapping.join(", "));

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(
    `\nscreenshots: ${shot("1-initial")}  ${shot("2-after-replacement")}  ${shot("3-after-reveal")}`,
  );
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
