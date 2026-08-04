/**
 * The drift check as a person meets it: a command line and a Stop hook.
 *
 * The engine is covered by engine-drift.test.ts. What is covered here is the
 * surface that decides whether anyone acts on a finding — the exit code, and
 * whether the report says what to do. Being told a diagram is stale without
 * being told that anything can be done about it is where this stopped being
 * useful, and the guidance line was previously printed only to a terminal, so
 * from a hook — the way it actually runs — nobody ever saw it.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const run = promisify(execFile);
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/check-drift.mjs");
/**
 * This repo's own tsx, not `npx tsx`.
 *
 * These runs happen from a temp project with no node_modules, so npx resolves
 * nothing there, fetches tsx from the registry and prints `npm warn exec ...` to
 * stderr — which fails the silence check below. It passed locally anyway because
 * the npx cache was already warm, and only failed in CI. Naming the binary makes
 * the test say the same thing on every machine, and removes a network call.
 */
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let workspace: string;

/** Runs the check the way a hook does: from the project directory, not this repo. */
async function checkDrift(): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT], { cwd: workspace });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function board(nodes: Array<{ id: string; label: string; ref?: string }>) {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] })).board;
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "drift-cli-"));
  mkdirSync(path.join(workspace, "docs/diagrams"), { recursive: true });
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "src/present.ts"), "export const present = true;\n");
}, 120_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("check-drift on the command line", () => {
  it("says nothing at all when every box still points at real code", async () => {
    await writeBoard(
      path.join(workspace, "docs/diagrams/clean.excalidraw"),
      await board([{ id: "p", label: "Present", ref: "src/present.ts" }]),
    );
    const result = await checkDrift();
    // Silence is the whole design: this runs every turn, and a check that
    // announces good news thirty times an hour is one somebody switches off.
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
  }, 120_000);

  it("reports the stale box, names the file, and exits non-zero", async () => {
    await writeBoard(
      path.join(workspace, "docs/diagrams/stale.excalidraw"),
      await board([
        { id: "p", label: "Present", ref: "src/present.ts" },
        { id: "g", label: "Old Cache", ref: "src/gone.ts" },
      ]),
    );
    const result = await checkDrift();
    // Non-zero because that is the only channel a Stop hook actually shows, and
    // what CI and a pre-commit hook want besides.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stale.excalidraw");
    expect(result.stderr).toContain("Old Cache");
    expect(result.stderr).toContain("src/gone.ts");
  }, 120_000);

  it("tells the reader how to fix it, from a hook and not only from a terminal", async () => {
    // execFile pipes the child's stderr, so it is not a TTY — exactly a hook's
    // situation, and exactly the case the old TTY-gated guidance stayed silent in.
    const result = await checkDrift();
    expect(result.stderr).toContain("/update-diagram");
  }, 120_000);

  it("does not name a box whose code is still there", async () => {
    const result = await checkDrift();
    expect(result.stderr).not.toContain("Present");
    expect(result.stderr).not.toContain("clean.excalidraw");
  }, 120_000);
});

describe("unsupported edges on the command line", () => {
  // Its own project, because the boards above accumulate: once stale.excalidraw
  // exists that workspace exits 1 forever, and the --no-edges silence below
  // would have nothing left to prove.
  let project: string;

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-edges-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Both files exist, so the missing-file check stays quiet. Nothing imports,
    // mentions, or shares a string with anything — the drawn arrow is the only
    // claim of a relationship, which is exactly what the edge check flags.
    writeFileSync(path.join(project, "src/left.ts"), "export const left = 1;\n");
    writeFileSync(path.join(project, "src/right.ts"), "export const right = 1;\n");
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "edges",
      nodes: [
        { id: "left", label: "Left", ref: "src/left.ts" },
        { id: "right", label: "Right", ref: "src/right.ts" },
      ],
      edges: [{ from: "left", to: "right" }],
    });
    await writeBoard(path.join(project, "docs/diagrams/edges.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("flags the arrow, names both boxes, and only calls it worth a look", async () => {
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("edges.excalidraw");
    expect(result.stderr).toContain("Left");
    expect(result.stderr).toContain("Right");
    expect(result.stderr).toContain("worth a look");
  }, 120_000);

  it("--no-edges turns off just this check, and the report goes quiet", async () => {
    const result = await check("--no-edges");
    // The files all exist, so with edges off there is nothing to say — and the
    // point of the separate flag is that a noisy edge check can be silenced
    // without losing the missing-file check.
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
  }, 120_000);
});

/**
 * How a report with a lot in it reads.
 *
 * The failure this guards against is not wrongness, it is length: every
 * unsupported arrow fails for the same reason, and printing that reason once per
 * arrow produced a wall of near-identical lines — 2360 characters for twelve
 * arrows, measured — which is a report nobody reads to the end. Saying it once
 * and listing the arrows brings the same information to 477.
 */
describe("a report with many findings stays readable", () => {
  const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  let project: string;
  let stderr: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-many-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Every file exists and none of them touch each other, so all twelve arrows
    // are flagged and the missing-file check stays quiet.
    for (const name of NAMES) {
      writeFileSync(path.join(project, `src/${name}.ts`), `export const ${name} = 1;\n`);
    }
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "many",
      nodes: NAMES.map((name) => ({ id: name, label: name.toUpperCase(), ref: `src/${name}.ts` })),
      edges: NAMES.slice(1).map((name) => ({ from: "a", to: name })),
    });
    await writeBoard(path.join(project, "docs/diagrams/many.excalidraw"), drawn);

    try {
      await run(TSX, [SCRIPT], { cwd: project });
      stderr = "";
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? "";
    }
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("explains why once, not once per arrow", () => {
    const explanations = stderr.match(/no shared importer/g) ?? [];
    expect(explanations).toHaveLength(1);
  });

  it("counts every finding even though it lists only the first few", () => {
    expect(stderr).toContain("12 arrows");
    expect(stderr).toMatch(/… and \d+ more/);
    // The count in the heading is what makes trimming honest rather than hiding.
    // Arrow lines are indented under their heading; the exact indent is the
    // format's business, the count is the contract.
    const listed = (stderr.match(/^\s+A\s+→\s+\S/gm) ?? []).length;
    const hidden = Number(/… and (\d+) more/.exec(stderr)?.[1] ?? 0);
    expect(listed + hidden).toBe(12);
  });

  it("stays short enough to read", () => {
    // The old format spent 2360 characters on this exact case.
    expect(stderr.length).toBeLessThan(800);
  });
});

/**
 * The Stop hook channel.
 *
 * Measured, not assumed, and it took three probes to establish: plain text on
 * stdout with exit 0 is discarded; stderr with a non-zero exit shows but Claude
 * Code wraps it in "Stop hook error: Failed with non-blocking status code",
 * which reads as a broken tool rather than a finding; structured JSON on stdout
 * renders as an ordinary notice, with newlines, indentation and box-drawing
 * characters surviving.
 *
 * So the exit code has to differ by caller — 0 for the hook, non-zero for CI —
 * and that is worth pinning, because getting it backwards either loses the
 * report entirely or fails somebody's build on a diagram.
 */
describe("the hook channel", () => {
  let project: string;

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-hook-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "hook",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/hook.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("delivers the report as a systemMessage and exits 0", async () => {
    const result = await check("--hook");
    // Non-zero here is what produced the "Stop hook error: Failed" framing.
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(payload.systemMessage).toContain("Old Cache");
    expect(payload.systemMessage).toContain("/update-diagram");
    // Nothing on stderr in hook mode: it would be discarded, and a report that
    // exists in a channel nobody reads is the failure this whole thing is about.
    expect(result.stderr.trim()).toBe("");
  }, 120_000);

  it("still fails a build when it is not a hook", async () => {
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Old Cache");
    expect(result.stdout.trim()).toBe("");
  }, 120_000);

  it("says nothing in either mode when the diagram is fine", async () => {
    const clean = mkdtempSync(path.join(tmpdir(), "drift-cli-hook-clean-"));
    mkdirSync(path.join(clean, "docs/diagrams"), { recursive: true });
    try {
      for (const args of [[], ["--hook"]]) {
        const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: clean });
        expect(`${stdout}${stderr}`.trim()).toBe("");
      }
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  }, 120_000);
});
