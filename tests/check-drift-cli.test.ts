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
    expect(result.stderr).toContain("/fix-drift");
  }, 120_000);

  it("does not name a box whose code is still there", async () => {
    const result = await checkDrift();
    expect(result.stderr).not.toContain("Present");
    expect(result.stderr).not.toContain("clean.excalidraw");
  }, 120_000);
});
