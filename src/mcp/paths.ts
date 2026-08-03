/**
 * Path confinement for the board server.
 *
 * Every tool takes a file path from the model, so all of them have to resolve
 * through here. The root defaults to the working directory and can be pinned
 * with BOARD_MCP_ROOT; anything resolving outside it is refused, symlinks
 * included.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

function realOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export const WORKSPACE_ROOT = realOrResolved(process.env.BOARD_MCP_ROOT ?? process.cwd());

function isInsideRoot(target: string): boolean {
  const relative = path.relative(WORKSPACE_ROOT, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a caller-supplied path inside the workspace. Checks the nearest
 * existing ancestor's real path too, so a symlinked parent directory cannot be
 * used to escape.
 */
export function resolveInWorkspace(candidate: string): string {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("A file path is required");
  }
  const resolved = path.resolve(WORKSPACE_ROOT, candidate);
  if (!isInsideRoot(resolved)) {
    throw new Error(`Path escapes the workspace root (${WORKSPACE_ROOT}): ${candidate}`);
  }
  // Walk up to the first directory that exists and confirm its real location
  // is still inside the root before trusting the full path.
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    const real = realOrResolved(ancestor);
    if (real !== ancestor) {
      if (!isInsideRoot(real)) {
        throw new Error(`Path resolves outside the workspace via a symlink: ${candidate}`);
      }
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  return resolved;
}

export function relativeToWorkspace(target: string): string {
  return path.relative(WORKSPACE_ROOT, target) || path.basename(target);
}

/** Diagrams default to .excalidraw so the file opens in the usual editors. */
export function resolveBoardPath(candidate: string): string {
  const resolved = resolveInWorkspace(candidate);
  return path.extname(resolved) ? resolved : `${resolved}.excalidraw`;
}
