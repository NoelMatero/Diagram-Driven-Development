/**
 * Bundle entry for rendering a board to PNG inside a headless browser.
 *
 * Rasterising genuinely needs a canvas and loaded webfonts, so unlike the
 * conversion path this one runs in Chromium. Built by `npm run build:vendor`
 * into vendor/excalidraw-browser.js as an IIFE on `window.ExcalidrawExport`.
 */
export { exportToBlob, restoreElements } from "@excalidraw/excalidraw";
