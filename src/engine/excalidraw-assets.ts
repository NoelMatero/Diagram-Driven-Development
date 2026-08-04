/**
 * Where Excalidraw's font files are, for the two places that need them: real
 * text metrics in Node (./font.ts) and the render page's asset origin
 * (./render.ts).
 *
 * They come from the viewer build rather than from node_modules, which is what
 * lets `@excalidraw/excalidraw` stay a devDependency. That matters more than it
 * looks: as a runtime dependency it made `npm install` of this package
 * unresolvable in practice — its own dependency list pins UI packages whose peer
 * ranges stop at React 18 while it accepts 19, and npm oscillates. Measured at
 * 2079 re-placements of React across seven minutes without converging, in a
 * plain `npm install <tarball>` of this package.
 *
 * Nothing is duplicated to make this work: `out/viewer/fonts` is already
 * published for the live board, and a render was traced requesting exactly two
 * paths — `/excalidraw-browser.js` and one file under `/fonts/`. No chunks, no
 * locales, no subset workers.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let cached: string | null | undefined;

/**
 * Null when the fonts cannot be found at all, which callers must handle: text
 * then measures and rasterises in a fallback face rather than failing loudly.
 */
export function excalidrawFontsDir(): string | null {
  if (cached !== undefined) return cached;

  const built = path.join(ROOT, "out/viewer/fonts");
  if (existsSync(built)) {
    cached = built;
    return cached;
  }

  // Source checkout where the viewer has not been built yet.
  try {
    const require = createRequire(import.meta.url);
    const fromPackage = path.join(
      path.dirname(require.resolve("@excalidraw/excalidraw/package.json")),
      "dist/prod/fonts",
    );
    if (existsSync(fromPackage)) {
      cached = fromPackage;
      return cached;
    }
  } catch {
    // Not installed either; fall through.
  }

  cached = null;
  return cached;
}
