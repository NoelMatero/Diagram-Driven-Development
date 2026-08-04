/**
 * Drift detection: does a diagram still agree with the repository?
 *
 * A committed diagram is documentation, and documentation rots. A node can
 * record what it stands for -- `ref: "src/engine/layout.ts"`, or
 * `path#symbol` -- and this compares those claims against the working tree.
 *
 * Deliberately shallow: no model, no import graph, just existence. Being cheap
 * and quiet matters more here than being thorough, because a check that is slow
 * or cries wolf gets switched off, and then it catches nothing at all.
 *
 * Two rules keep false positives near zero:
 *
 * - A node with no ref is skipped, never guessed at from its label ("Auth"
 *   could be anything). The one exception is a label that is unambiguously a
 *   path, which is reported as `inferred` so a caller can weigh it accordingly.
 * - Hand-drawn nodes are ignored entirely. A box someone sketched is an
 *   intention, not a claim about code that exists today.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { BoardFile } from "./board-file";
import { readGraph, type Provenance } from "./graph";

export type DriftKind = "missing-file" | "missing-symbol" | "unresolvable-ref";

export interface DriftFinding {
  /** Node id, as edges and edit_diagram refer to it. */
  node: string;
  label: string;
  /** The ref as written, so a caller can find and fix it. */
  ref: string;
  kind: DriftKind;
  /** `recorded` refs were declared outright; `inferred` were read off a label. */
  provenance: Provenance;
  detail: string;
}

export interface DriftReport {
  clean: boolean;
  findings: DriftFinding[];
  /** Nodes that had something checkable. */
  checked: number;
  /** Generated nodes with no ref to check against. */
  skipped: number;
  /** Hand-drawn nodes, ignored by design. */
  handDrawn: number;
}

/**
 * The filesystem, narrowed to what detection needs and injected so the checks
 * are testable without a real tree.
 */
export interface Workspace {
  /** Absolute path for a repo-relative ref; undefined when it escapes the root. */
  resolve(relativePath: string): string | undefined;
  stat(absolutePath: string): "file" | "directory" | "missing";
  /** Only called when stat said "file". */
  read(absolutePath: string): string;
}

/**
 * A label worth reading as a path: at least one slash and a file extension.
 * Deliberately strict -- `POST /api/file` and `Auth` both fail, which is the
 * point. It exists so diagrams drawn before `ref` are not invisible to drift.
 */
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10}$/;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Splits `path#symbol`. Either half may be empty; the caller decides. */
export function parseRef(ref: string): { path: string; symbol?: string } {
  const hash = ref.indexOf("#");
  if (hash < 0) return { path: ref.trim() };
  return { path: ref.slice(0, hash).trim(), symbol: ref.slice(hash + 1).trim() || undefined };
}

export function refFromLabel(label: string): string | undefined {
  const candidate = label.trim();
  return PATH_LIKE.test(candidate) ? candidate : undefined;
}

/**
 * Word-boundary match, not a parse. A rename shows up; a mention in a comment
 * counts as still present. That asymmetry is deliberate: a missed rename is
 * invisible, while a wrong "this is gone" costs trust in the whole check.
 */
function mentions(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`).test(source);
}

type Inspection = DriftFinding | "ok" | "skip";

function inspect(
  node: { id: string; label: string },
  ref: string,
  provenance: Provenance,
  workspace: Workspace,
): Inspection {
  const { path: target, symbol } = parseRef(ref);
  const base = { node: node.id, label: node.label, ref, provenance };
  if (!target) {
    return { ...base, kind: "unresolvable-ref", detail: `"${ref}" names a symbol but no file.` };
  }

  const absolute = workspace.resolve(target);
  if (!absolute) {
    // An inferred ref is a reading of someone's label, not a claim they made.
    // A label pointing outside the repo just is not a code reference.
    if (provenance === "inferred") return "skip";
    return { ...base, kind: "unresolvable-ref", detail: `${target} is outside the repository.` };
  }

  const found = workspace.stat(absolute);
  if (found === "missing") {
    return { ...base, kind: "missing-file", detail: `${target} no longer exists.` };
  }
  if (!symbol) return "ok";
  if (found === "directory") {
    return {
      ...base,
      kind: "unresolvable-ref",
      detail: `${target} is a directory, so it cannot contain ${symbol}.`,
    };
  }
  if (!mentions(workspace.read(absolute), symbol)) {
    return { ...base, kind: "missing-symbol", detail: `${target} no longer mentions ${symbol}.` };
  }
  return "ok";
}

export function checkDrift(board: BoardFile, workspace: Workspace): DriftReport {
  const findings: DriftFinding[] = [];
  let checked = 0;
  let skipped = 0;
  let handDrawn = 0;

  for (const node of readGraph(board).nodes) {
    if (node.provenance !== "recorded") {
      handDrawn += 1;
      continue;
    }
    const declared = node.ref?.trim();
    const ref = declared || refFromLabel(node.label);
    if (!ref) {
      skipped += 1;
      continue;
    }
    const result = inspect(node, ref, declared ? "recorded" : "inferred", workspace);
    if (result === "skip") {
      skipped += 1;
      continue;
    }
    checked += 1;
    if (result !== "ok") findings.push(result);
  }

  return { clean: findings.length === 0, findings, checked, skipped, handDrawn };
}

/** Where diagrams live unless someone says otherwise. */
export const DEFAULT_DIAGRAM_DIR = "docs/diagrams";

/**
 * Every board in a directory, sorted so output does not depend on readdir
 * order. A project holds any number of diagrams and none of them is "current",
 * so checking means checking all of them.
 */
export async function findBoards(root: string, dir = DEFAULT_DIAGRAM_DIR): Promise<string[]> {
  try {
    const entries = await readdir(path.resolve(root, dir));
    return entries
      .filter((entry) => entry.endsWith(".excalidraw"))
      .sort()
      .map((entry) => path.resolve(root, dir, entry));
  } catch {
    return [];
  }
}

function realOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Filesystem-backed workspace rooted at a repository.
 *
 * Refs are strings a model wrote that become filesystem reads, so they are
 * confined the same way board paths are: resolved, then checked again after
 * realpath so a symlink out of the tree cannot be used to probe for files
 * elsewhere. This does not reuse the MCP resolver because the engine stays
 * independent of that layer -- the CLI check has no MCP server at all.
 */
export function createWorkspace(root: string): Workspace {
  const realRoot = realOrResolved(root);
  return {
    resolve(relativePath) {
      if (!relativePath || path.isAbsolute(relativePath)) return undefined;
      const resolved = path.resolve(realRoot, relativePath);
      if (!inside(realRoot, resolved) || !inside(realRoot, realOrResolved(resolved))) {
        return undefined;
      }
      return resolved;
    },
    stat(absolutePath) {
      try {
        return statSync(absolutePath).isDirectory() ? "directory" : "file";
      } catch {
        return "missing";
      }
    },
    read(absolutePath) {
      return readFileSync(absolutePath, "utf8");
    },
  };
}
