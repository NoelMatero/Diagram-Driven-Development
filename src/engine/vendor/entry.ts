/**
 * Bundle entry for the headless Excalidraw surface.
 *
 * Built by `npm run build:vendor` into vendor/excalidraw-headless.mjs. Node
 * cannot import @excalidraw/excalidraw directly: its dependency
 * @excalidraw/laser-pointer only exposes named exports through its `module`
 * build, and Node resolves the `main` (Parcel CJS) build whose wildcard
 * re-export defeats cjs-module-lexer. A bundler resolves `module` and the
 * problem disappears, so we pre-bundle rather than import at runtime.
 *
 * The Excalidraw module body touches `window` and `FontFace` as it evaluates,
 * so the shim has to be installed first. A static re-export would not work:
 * import declarations hoist above the shim call, and the bundler emits the
 * Excalidraw body ahead of it. The dynamic import below defers that body to
 * first use, which is after installBrowserShim() has run.
 */
import { installBrowserShim } from "./browser-shim";

installBrowserShim();

export type SkeletonConverter = (skeletons: unknown[]) => Array<Record<string, unknown>>;

export async function getConverter(): Promise<SkeletonConverter> {
  installBrowserShim();
  const module = await import("@excalidraw/excalidraw");
  return module.convertToExcalidrawElements as unknown as SkeletonConverter;
}
