/**
 * Rasterises a board file to PNG in headless Chromium.
 *
 * This is the one part of the pipeline that genuinely needs a browser: an
 * accurate raster requires a real canvas and the Excalifont webfonts actually
 * loaded. Everything upstream (layout, conversion, file writing) stays in Node.
 *
 * Assets are served through Playwright request interception rather than a real
 * HTTP server, so there is no port to allocate and nothing to tear down.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BoardFile } from "./board-file";
import { excalidrawFontsDir } from "./excalidraw-assets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BROWSER_BUNDLE = path.join(ROOT, "vendor/excalidraw-browser.js");
const ORIGIN = "http://board.local";

/**
 * playwright-core carries no browser download, so installing this package stays
 * a few seconds rather than ~150 MB. Rendering is the only feature that needs
 * Chromium, so it asks for it at the point of use instead of at install time.
 */
async function launchChromium() {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch();
  } catch (error) {
    const message = String(error);
    if (!/Executable doesn't exist|Failed to launch|browserType.launch/i.test(message)) throw error;
    // Version-pinned: playwright-core only runs the browser revision it was
    // built against, and a bare `playwright install` fetches whatever is latest.
    const version = await playwrightVersion();
    throw new Error(
      "Rendering a PNG needs a headless browser, which is not installed yet. Run:\n"
        + `  npx playwright@${version} install chromium\n`
        + "Drawing, reading and the live board all work without it.",
    );
  }
}

async function playwrightVersion(): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("playwright-core/package.json");
    return JSON.parse(await readFile(manifest, "utf8")).version as string;
  } catch {
    return "latest";
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface RenderOptions {
  /** Pixel ratio; 2 gives a crisp image on retina displays. */
  scale?: number;
  background?: boolean;
  padding?: number;
}

export async function renderBoardToPng(board: BoardFile, options: RenderOptions = {}): Promise<Buffer> {
  const visible = board.elements.filter((element) => element.isDeleted !== true);
  if (visible.length === 0) throw new Error("Cannot render an empty board");

  if (!existsSync(BROWSER_BUNDLE)) {
    throw new Error(`Missing ${path.relative(ROOT, BROWSER_BUNDLE)}. Run \`npm run build:vendor\`.`);
  }

  const browser = await launchChromium();
  try {
    const page = await browser.newPage();

    // Serve the bundle and Excalidraw's own assets (fonts especially, or text
    // rasterises in a fallback face) from a synthetic origin.
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>",
        });
      }
      if (url.pathname === "/excalidraw-browser.js") {
        return route.fulfill({
          body: await readFile(BROWSER_BUNDLE),
          contentType: "text/javascript",
        });
      }

      // Fonts are the only other thing the page asks for — traced, and the
      // reason @excalidraw/excalidraw need not be installed at runtime. Anything
      // else is not something this render has ever needed.
      const fonts = excalidrawFontsDir();
      const match = /^\/fonts\/(.+)$/.exec(url.pathname);
      if (!fonts || !match) return route.fulfill({ status: 404, body: "not found" });

      const file = path.join(fonts, match[1]);
      // Never let a crafted path escape the asset root.
      if (!file.startsWith(`${fonts}${path.sep}`)) {
        return route.fulfill({ status: 403, body: "forbidden" });
      }
      try {
        return route.fulfill({
          body: await readFile(file),
          contentType: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        });
      } catch {
        return route.fulfill({ status: 404, body: "not found" });
      }
    });

    await page.goto(`${ORIGIN}/`);
    // esbuild (via tsx) wraps functions in its `__name` helper to preserve
    // names. Playwright serialises the evaluate callback as source, so that
    // helper has to exist in the page or the callback throws on entry.
    await page.addScriptTag({ content: "globalThis.__name ||= (fn) => fn;" });
    await page.addScriptTag({ content: "window.EXCALIDRAW_ASSET_PATH = '/';" });
    // Fetched through the route above rather than inlined: holding the 13 MB
    // bundle as a JS string per render is enough to exhaust the heap.
    await page.addScriptTag({ url: "/excalidraw-browser.js" });

    const dataUrl = await page.evaluate(
      async ({ elements, appState, files, scale, background, padding }) => {
        const api = (window as unknown as { ExcalidrawExport: { exportToBlob: (args: unknown) => Promise<Blob> } })
          .ExcalidrawExport;
        const blob = await api.exportToBlob({
          elements,
          appState: { ...appState, exportBackground: background, exportPadding: padding },
          files: files ?? {},
          mimeType: "image/png",
          // The canvas must grow with the scale factor. Returning the
          // unscaled size draws 2x content into a 1x canvas, which silently
          // crops everything outside the top-left quadrant.
          getDimensions: (width: number, height: number) => ({
            width: width * scale,
            height: height * scale,
            scale,
          }),
        });
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read exported blob"));
          reader.readAsDataURL(blob);
        });
      },
      {
        elements: visible,
        appState: board.appState ?? {},
        files: board.files ?? {},
        scale: options.scale ?? 2,
        background: options.background ?? true,
        padding: options.padding ?? 24,
      },
    );

    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (!base64) throw new Error("Excalidraw returned an empty image");
    return Buffer.from(base64, "base64");
  } finally {
    await browser.close();
  }
}
