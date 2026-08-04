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
import { execFile, execFileSync } from "node:child_process";
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

  it("flags the arrow, names both boxes, and never calls it wrong", async () => {
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("edges.excalidraw");
    expect(result.stderr).toContain("Left");
    expect(result.stderr).toContain("Right");
    // An unsupported arrow is a suspicion, not a verdict. The notice carries that
    // in colour rather than in a sentence repeated every turn, and says "arrow",
    // never "wrong".
    expect(result.stderr).toContain("1 arrow");
    expect(result.stderr).not.toContain("gone");
    expect(result.stderr.toLowerCase()).not.toContain("wrong");
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

  it("does not explain itself at all — the marker carries it", () => {
    // This fires at the end of every turn. The explanation was printed once per
    // arrow (2360 characters for twelve), then once per report, and is now in the
    // documentation where it is read once.
    expect(stderr).not.toContain("no shared importer");
    expect(stderr).not.toContain("worth a look");
    // And no colour when the output is captured: escapes in a log or a CI
    // transcript are noise.
    expect(stderr).not.toContain("\\u001b[");
  });

  it("counts every finding even though it lists only the first few", () => {
    // The count rides in the heading: "many.excalidraw  12 arrows".
    expect(stderr).toMatch(/12 arrows/);
    expect(stderr).toMatch(/… and \d+ more/);
    // The count in the heading is what makes trimming honest rather than hiding.
    // Arrow lines are indented under their heading; the exact indent is the
    // format's business, the count is the contract.
    const listed = (stderr.match(/│ A → /g) ?? []).length;
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

/**
 * Colour, and where it is allowed to go.
 *
 * ANSI does render inside a Claude Code systemMessage — measured by putting real
 * escapes in one and looking, after an earlier round concluded the opposite from a
 * copy-paste, where colour is invisible either way. That is why severity is colour
 * and not emoji: colour occupies no cells and cannot shear a padded row, while
 * `⚠️` is ambiguous-width and did.
 *
 * It must not reach a pipe though, and that is the half a test can check.
 */
describe("colour", () => {
  const RED = "\u001b[31m";
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-colour-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "colour",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/colour.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("paints the notice, because the notice renders it", async () => {
    const { stdout } = await run(TSX, [SCRIPT, "--hook"], { cwd: project });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    expect(payload.systemMessage).toContain(RED);
  }, 120_000);

  it("leaves captured output plain", async () => {
    try {
      await run(TSX, [SCRIPT], { cwd: project });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      const failure = error as { stderr?: string };
      expect(failure.stderr).toContain("Old Cache");
      expect(failure.stderr).not.toContain("\u001b[");
    }
  }, 120_000);

  it("switches to the notice when hook JSON arrives on stdin, with no flag", () => {
    // execFile ignores `input`; only the sync form actually writes to stdin, which
    // is why an earlier version of this test proved nothing.
    const stdout = execFileSync(TSX, [SCRIPT], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "test" }),
      encoding: "utf8",
    });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    // The flag is a trap otherwise: forget it and the report comes back wrapped in
    // "Stop hook error: Failed", which reads as a broken tool rather than a finding.
    expect(payload.systemMessage).toContain("Old Cache");
  }, 120_000);

  it("survives stdin being /dev/null rather than a pipe", () => {
    // process.stdin is a socket when piped and an fs stream when redirected from a
    // file or /dev/null, and only the socket has unref(). Every test here used a
    // pipe, so a crash on the other shape went unnoticed until a shell ran it.
    const stdout = execFileSync(TSX, [SCRIPT, "--hook"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(JSON.parse(stdout).systemMessage).toContain("Old Cache");
  }, 120_000);

  it("starts the notice on its own line, so the harness prefix cannot shift the border", async () => {
    const { stdout } = await run(TSX, [SCRIPT, "--hook"], { cwd: project });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    // "Stop says: ┌───" pushed the top border right by the width of that prefix.
    expect(payload.systemMessage.startsWith("\n")).toBe(true);
  }, 120_000);
});

/**
 * The expanded view behind `--details`.
 *
 * The notice is trimmed because it fires every turn; this is what someone gets when
 * they ask. What it must not do is grow a second personality: same rows, same
 * colours, one box per diagram, nothing capped, and the command once at the bottom.
 */
describe("--details", () => {
  const MANY = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-details-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    for (const name of MANY) {
      writeFileSync(path.join(project, `src/${name}.ts`), `export const ${name} = 1;\n`);
    }
    const { board: first } = await createDiagram(emptyBoard(), {
      name: "one",
      nodes: MANY.map((name) => ({ id: name, label: name.toUpperCase(), ref: `src/${name}.ts` })),
      edges: MANY.slice(1).map((name) => ({ from: "a", to: name })),
    });
    await writeBoard(path.join(project, "docs/diagrams/one.excalidraw"), first);

    const { board: second } = await createDiagram(emptyBoard(), {
      name: "two",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/two.excalidraw"), second);
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function details() {
    try {
      execFileSync(TSX, [SCRIPT, "--details"], { cwd: project, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      return "";
    } catch (error) {
      return (error as { stderr?: string }).stderr ?? "";
    }
  }

  it("lists every finding, where the notice would have trimmed to six", () => {
    const out = details();
    const arrows = (out.match(/│ A → /g) ?? []).length;
    expect(arrows).toBe(12);
    expect(out).not.toContain("more");
  }, 180_000);

  it("gives each diagram its own box, headed by its own counts", () => {
    const out = details();
    expect(out).toContain("one.excalidraw");
    expect(out).toContain("two.excalidraw");
    expect(out).toContain("12 arrows");
    expect(out).toContain("1 gone");
    // One frame, not two boxes: the second diagram is introduced by a divider, so
    // there is a single top border and a single bottom one.
    expect((out.match(/┌/g) ?? []).length).toBe(1);
    expect((out.match(/├/g) ?? []).length).toBe(1);
    expect((out.match(/└/g) ?? []).length).toBe(1);
  }, 180_000);

  it("names the command once, under everything", () => {
    const out = details();
    expect((out.match(/\/update-diagram/g) ?? []).length).toBe(1);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.at(-1)).toContain("/update-diagram");
  }, 180_000);
});

/**
 * When the notice shows findings and when it gives up and counts them.
 *
 * The rule is the total across every stale diagram, not the number of diagrams.
 * Collapsing to counts because a second diagram existed threw away detail there
 * was room for.
 */
describe("the notice fits what it can", () => {
  let project: string;

  async function notice() {
    const stdout = execFileSync(TSX, [SCRIPT, "--hook"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
  }

  beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-fit-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
  });

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  async function board(name: string, boxes: number) {
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name,
      nodes: Array.from({ length: boxes }, (_, index) => ({
        id: `${name}${index}`,
        label: `${name.toUpperCase()}${index}`,
        ref: `src/${name}${index}.ts`,
      })),
      edges: [],
    });
    await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), drawn);
  }

  it("lists findings from two diagrams when together they fit", async () => {
    await board("alpha", 2);
    await board("beta", 2);
    const message = await notice();
    // Four findings across two diagrams: shown, not counted.
    expect(message).toContain("ALPHA0 →");
    expect(message).toContain("BETA1 →");
    // One frame, joined by a divider rather than stacked.
    expect((message.match(/┌/g) ?? []).length).toBe(1);
    expect((message.match(/├/g) ?? []).length).toBe(1);
    expect(message).not.toContain("expand-report");
  }, 180_000);

  it("falls back to counts, and points at the fuller view, when they do not", async () => {
    await board("gamma", 8);
    const message = await notice();
    expect(message).toContain("gamma.excalidraw");
    expect(message).toContain("/expand-report");
    // Counts per diagram rather than twelve rows of findings.
    expect(message).toMatch(/8 gone/);
  }, 180_000);
});
