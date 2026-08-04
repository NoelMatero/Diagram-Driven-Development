#!/usr/bin/env node
/**
 * Bundles the two published entry points into plain JavaScript.
 *
 *   node scripts/build-cli.mjs
 *
 * The package ships JS, not TypeScript: a consumer installed through `npx` has
 * no tsx and no devDependencies, so the sources have to be transpiled before
 * publish. Dependencies stay external — npm resolves those.
 *
 * Wired to `prepare` rather than `postinstall` in package.json, because prepare
 * runs on a local install and before publish but *not* when a consumer installs
 * the published package — which has no esbuild or vite to build with, and gets
 * the output in the tarball instead.
 *
 * OUT_DIR is two levels below the package root on purpose. Three modules locate
 * their assets relative to their own file (`../..`):
 *
 *   src/engine/convert.ts  -> vendor/excalidraw-headless.mjs
 *   src/engine/render.ts   -> vendor/excalidraw-browser.js
 *   src/server/board-server.ts -> out/viewer
 *
 * Bundling collapses all three onto this output file, so its depth *is* their
 * root calculation. Moving this output one directory shallower or deeper breaks
 * rendering and the live board at runtime, silently, in a way tests running from
 * source cannot see. The assertion below fails the build instead.
 */
import assert from "node:assert";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "out/cli";

// Exactly what those modules compute: `../..` from the directory holding them.
assert.equal(
  path.resolve(root, OUT_DIR, "../.."),
  root,
  `${OUT_DIR} must sit two levels below the package root; see the comment above`,
);

const entries = [
  { entry: "src/mcp/server.ts", outfile: `${OUT_DIR}/server.mjs`, label: "MCP server" },
  { entry: "scripts/check-drift.mjs", outfile: `${OUT_DIR}/drift.mjs`, label: "drift check" },
];

for (const target of entries) {
  const result = await build({
    entryPoints: [path.join(root, target.entry)],
    outfile: path.join(root, target.outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Bare imports resolve from the installed node_modules at runtime; only our
    // own relative modules get inlined.
    packages: "external",
    // No shebang banner: both entry points already start with one and esbuild
    // hoists it. Adding another emits it twice, and the second is a syntax error.
    logLevel: "error",
    metafile: true,
  });
  const bytes = Object.values(result.metafile.outputs).find((output) => output.bytes)?.bytes ?? 0;
  console.log(`built ${target.outfile} (${(bytes / 1024).toFixed(0)} KB) — ${target.label}`);
}
