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

export interface EdgeDriftFinding {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  fromRef: string;
  toRef: string;
  kind: "unsupported-edge";
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
  edges: EdgeDriftFinding[];
  /** Edges checked for corroboration. */
  edgesChecked: number;
  /** Edges skipped (directory refs, non-TS/JS, missing files, hand-drawn, refless). */
  edgesSkipped: number;
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

/**
 * Resolve a relative import specifier to a file path within the workspace.
 * Tries the spec as written, each extension variant, and index.<ext> in the directory.
 * fromFile should be a repo-relative path (not absolute).
 * Returns { abs: absolute path, rel: repo-relative path } or undefined if not found.
 */
function resolveImport(
  spec: string,
  fromFile: string,
  workspace: Workspace,
): { abs: string; rel: string } | undefined {
  // Relative imports only. Absolute specifiers or node_modules are skipped.
  if (!spec.startsWith(".")) {
    return undefined;
  }

  // Compute the directory of fromFile (repo-relative)
  const lastSlash = fromFile.lastIndexOf("/");
  const fromDir = lastSlash < 0 ? "" : fromFile.substring(0, lastSlash);

  // Resolve the import spec relative to fromDir
  let base = spec;
  // Remove leading ./ for joining
  if (base.startsWith("./")) {
    base = base.substring(2);
  }

  // Join with directory (keep ../ as-is for workspace.resolve to normalize)
  let resolved = base;
  if (fromDir) {
    resolved = fromDir + "/" + base;
  }

  // Generate candidates with extension variants
  const candidates: string[] = [resolved];

  if (resolved.endsWith(".js")) {
    candidates.push(resolved.slice(0, -3) + ".ts", resolved.slice(0, -3) + ".tsx");
  } else if (resolved.endsWith(".mjs")) {
    candidates.push(resolved.slice(0, -4) + ".ts", resolved.slice(0, -4) + ".tsx");
  } else if (!resolved.match(/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/)) {
    // No extension: try common TS/JS extensions
    candidates.push(resolved + ".ts", resolved + ".tsx", resolved + ".js", resolved + ".mjs");
    // Try index variants
    candidates.push(resolved + "/index.ts", resolved + "/index.tsx", resolved + "/index.js", resolved + "/index.mjs");
  }

  // Check each candidate (workspace.resolve will normalize and validate)
  for (const candidate of candidates) {
    const abs = workspace.resolve(candidate);
    if (abs && workspace.stat(abs) === "file") {
      return { abs, rel: candidate };
    }
  }

  return undefined;
}

/**
 * Extract all relative imports from a file, caching results per file within a single check.
 * fileAbsolute is the absolute path; fileRelative is the repo-relative path.
 * Returns array of { abs, rel } objects for each resolved import.
 */
function getImports(fileAbsolute: string, fileRelative: string, workspace: Workspace, cache: Map<string, Array<{ abs: string; rel: string }>>): Array<{ abs: string; rel: string }> {
  if (cache.has(fileAbsolute)) {
    return cache.get(fileAbsolute)!;
  }

  const imports: Array<{ abs: string; rel: string }> = [];
  const found = workspace.stat(fileAbsolute);
  if (found !== "file") {
    cache.set(fileAbsolute, imports);
    return imports;
  }

  const source = workspace.read(fileAbsolute);
  // Match relative imports: import x from "path", require("path"), import("path"), export ... from "path"
  // Patterns:
  //   - import ... from "path" / export ... from "path"
  //   - require("path")
  //   - import("path")
  //   - import "path" (rarely used but valid)
  const importRegex = /(?:import|export|require|from)\s+[^"'`]*?["'`](\.[^"'`]+)["'`]|require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)|import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec) {
      const resolved = resolveImport(spec, fileRelative, workspace);
      if (resolved) {
        imports.push(resolved);
      }
    }
  }

  cache.set(fileAbsolute, imports);
  return imports;
}

/**
 * Extract route literals (strings starting with "/") from a file.
 */
function getRouteLiterals(file: string, workspace: Workspace): Set<string> {
  const routes = new Set<string>();
  const found = workspace.stat(file);
  if (found !== "file") {
    return routes;
  }

  const source = workspace.read(file);
  // Match: /(\/[A-Za-z0-9_\-./:]+)/
  const routeRegex = /(['"`])(\/[A-Za-z0-9_\-./:]+)\1/g;
  let match;
  while ((match = routeRegex.exec(source)) !== null) {
    const route = match[2];
    if (route && route.length > 1) {
      routes.add(route);
    }
  }

  return routes;
}

/**
 * Check if edge A → B is backed by one of the four corroboration channels.
 * Assumes both files are valid TS/JS files; returns a finding if not backed, undefined if backed.
 */
function checkEdgeCorroboration(
  fromRef: string,
  toRef: string,
  fromLabel: string,
  toLabel: string,
  workspace: Workspace,
  importCache: Map<string, Array<{ abs: string; rel: string }>>,
  sharedImporterCandidates: Map<string, string>,
): EdgeDriftFinding | undefined {
  // Parse refs: keep only path, ignore symbol
  const { path: fromPath } = parseRef(fromRef);
  const { path: toPath } = parseRef(toRef);

  // Resolve both files (already validated above)
  const fromFileAbs = workspace.resolve(fromPath)!;
  const toFileAbs = workspace.resolve(toPath)!;

  // Channel 1: A imports B
  const importsFrom = getImports(fromFileAbs, fromPath, workspace, importCache);
  if (importsFrom.some((imp) => imp.abs === toFileAbs)) {
    return undefined;
  }

  // Channel 2: B imports A
  const importsTo = getImports(toFileAbs, toPath, workspace, importCache);
  if (importsTo.some((imp) => imp.abs === fromFileAbs)) {
    return undefined;
  }

  // Channel 3: Shared importer — any file C that imports both A and B
  // C = sharedImporterCandidates (hoisted from checkDrift)
  for (const [file, fileRel] of sharedImporterCandidates) {
    const fileImports = getImports(file, fileRel, workspace, importCache);
    if (
      fileImports.some((imp) => imp.abs === fromFileAbs)
      && fileImports.some((imp) => imp.abs === toFileAbs)
    ) {
      return undefined;
    }
  }

  // Channel 4: Shared route literal, one hop out
  const fromRoutes = new Set([
    ...getRouteLiterals(fromFileAbs, workspace),
  ]);
  for (const imp of importsFrom) {
    for (const route of getRouteLiterals(imp.abs, workspace)) {
      fromRoutes.add(route);
    }
  }

  const toRoutes = new Set([
    ...getRouteLiterals(toFileAbs, workspace),
  ]);
  for (const imp of importsTo) {
    for (const route of getRouteLiterals(imp.abs, workspace)) {
      toRoutes.add(route);
    }
  }

  if ([...fromRoutes].some((route) => toRoutes.has(route))) {
    return undefined;
  }

  // No channel fires: flag it as worth a look, not necessarily wrong
  return {
    from: fromPath,
    to: toPath,
    fromLabel,
    toLabel,
    fromRef,
    toRef,
    kind: "unsupported-edge",
    detail: `nothing in ${fromPath} imports, is imported by, shares an importer with, or shares a route string with ${toPath} — worth a look, not necessarily wrong.`,
  };
}

export function checkDrift(
  board: BoardFile,
  workspace: Workspace,
  options?: { edges?: boolean },
): DriftReport {
  const findings: DriftFinding[] = [];
  let checked = 0;
  let skipped = 0;
  let handDrawn = 0;

  const graph = readGraph(board);

  for (const node of graph.nodes) {
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

  // Edge checking: check each generated edge for corroboration
  const edges: EdgeDriftFinding[] = [];
  let edgesChecked = 0;
  let edgesSkipped = 0;

  if (options?.edges !== false) {
    const nodeById = new Map<string, typeof graph.nodes[0]>();
    for (const node of graph.nodes) {
      nodeById.set(node.id, node);
    }

    const importCache = new Map<string, Array<{ abs: string; rel: string }>>();

    // Build shared importer candidates once per board:
    // every recorded-ref code file + their direct imports (one hop out)
    const sharedImporterCandidates = new Map<string, string>();  // absolute path -> repo-relative path
    for (const node of graph.nodes) {
      const nodeRef = node.ref?.trim();
      if (!nodeRef) continue;
      const { path: nodePath } = parseRef(nodeRef);
      const resolved = workspace.resolve(nodePath);
      if (resolved && workspace.stat(resolved) === "file") {
        sharedImporterCandidates.set(resolved, nodePath);
      }
    }

    // Expand with direct imports (one hop) — for imported files, use their repo-relative path
    for (const [file, fileRel] of sharedImporterCandidates) {
      const fileImports = getImports(file, fileRel, workspace, importCache);
      for (const imp of fileImports) {
        if (!sharedImporterCandidates.has(imp.abs)) {
          sharedImporterCandidates.set(imp.abs, imp.rel);
        }
      }
    }

    for (const edge of graph.edges) {
      // Only generated edges
      if (edge.provenance !== "recorded") {
        edgesSkipped += 1;
        continue;
      }

      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);

      // Both endpoints must exist, be recorded, have refs
      if (!fromNode || !toNode) {
        edgesSkipped += 1;
        continue;
      }

      const fromRef = fromNode.ref?.trim();
      const toRef = toNode.ref?.trim();
      if (!fromRef || !toRef) {
        edgesSkipped += 1;
        continue;
      }

      // Parse refs and check if both point to TS/JS files (not directories or missing)
      const { path: fromPath } = parseRef(fromRef);
      const { path: toPath } = parseRef(toRef);
      const fromFile = workspace.resolve(fromPath);
      const toFile = workspace.resolve(toPath);

      // Skip if either file is missing or is not a file
      if (!fromFile || !toFile) {
        edgesSkipped += 1;
        continue;
      }
      const fromStat = workspace.stat(fromFile);
      const toStat = workspace.stat(toFile);
      if (fromStat !== "file" || toStat !== "file") {
        edgesSkipped += 1;
        continue;
      }

      // Skip if not TS/JS files
      const tsJsExt = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
      if (!tsJsExt.test(fromFile) || !tsJsExt.test(toFile)) {
        edgesSkipped += 1;
        continue;
      }

      edgesChecked += 1;

      const finding = checkEdgeCorroboration(
        fromRef,
        toRef,
        fromNode.label,
        toNode.label,
        workspace,
        importCache,
        sharedImporterCandidates,
      );
      if (finding) {
        edges.push(finding);
      }
    }
  }

  return {
    clean: findings.length === 0 && edges.length === 0,
    findings,
    checked,
    skipped,
    handDrawn,
    edges,
    edgesChecked,
    edgesSkipped,
  };
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
