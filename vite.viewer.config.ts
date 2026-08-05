import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the live board viewer into out/viewer, which the board server serves
 * statically. publicDir copies Excalidraw's own assets (fonts especially)
 * alongside the bundle so EXCALIDRAW_ASSET_PATH resolves against the server.
 */
export default defineConfig({
  root: resolve("src/viewer"),
  publicDir: resolve("node_modules/@excalidraw/excalidraw/dist/prod"),
  plugins: [react()],
  build: {
    outDir: resolve("out/viewer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DIAGRAMOS_VIEWER_DEV_PORT?.trim() || 5175),
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.DIAGRAMOS_PORT?.trim() || 4747}` } },
  },
});
