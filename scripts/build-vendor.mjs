#!/usr/bin/env node
/**
 * Pre-bundles the two Excalidraw surfaces we need.
 *
 *   node scripts/build-vendor.mjs
 *
 * Outputs are build artifacts (~13 MB each), so they are gitignored and
 * rebuilt on install rather than committed. See src/engine/vendor/entry.ts for
 * why bundling is necessary at all.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    label: "node converter",
    entry: "src/engine/vendor/entry.ts",
    outfile: "vendor/excalidraw-headless.mjs",
    options: { format: "esm", platform: "node", target: "node22" },
  },
  {
    label: "browser renderer",
    entry: "src/engine/vendor/browser-entry.ts",
    outfile: "vendor/excalidraw-browser.js",
    options: { format: "iife", platform: "browser", target: "chrome120", globalName: "ExcalidrawExport" },
  },
];

for (const target of targets) {
  const outfile = path.join(root, target.outfile);
  const result = await build({
    entryPoints: [path.join(root, target.entry)],
    outfile,
    bundle: true,
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    ...target.options,
  });
  const bytes = Object.values(result.metafile.outputs).find((output) => output.bytes)?.bytes ?? 0;
  console.log(`built ${target.outfile} (${(bytes / 1_048_576).toFixed(1)} MB) — ${target.label}`);
}
