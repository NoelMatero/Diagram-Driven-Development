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
