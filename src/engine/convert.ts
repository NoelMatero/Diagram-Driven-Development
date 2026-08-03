/**
 * Headless skeleton -> Excalidraw element conversion.
 *
 * Wraps the pre-bundled converter (see vendor/entry.ts) and always runs the
 * determinism pass, so callers cannot accidentally emit a board file with
 * random ids in it.
 */
import { normalizeElements, type ElementOrigin, type ExcalidrawElement } from "./normalize";

type Converter = (skeletons: unknown[]) => ExcalidrawElement[];

const VENDOR_BUNDLE = new URL("../../vendor/excalidraw-headless.mjs", import.meta.url);

let converter: Converter | undefined;

export async function loadConverter(): Promise<Converter> {
  if (converter) return converter;
  // The bundled shim measures text through this hook. It has to be in place
  // before the bundle evaluates, or Excalidraw sizes text with an estimate.
  const { measureFromCanvasFont } = await import("./font");
  (globalThis as { __boardMeasureText?: (text: string, font: string) => number }).__boardMeasureText
    = measureFromCanvasFont;
  let getConverter: (() => Promise<Converter>) | undefined;
  try {
    ({ getConverter } = (await import(VENDOR_BUNDLE.href)) as {
      getConverter?: () => Promise<Converter>;
    });
  } catch (error) {
    throw new Error(
      `Could not load the headless Excalidraw bundle at ${VENDOR_BUNDLE.pathname}. `
        + `Run \`npm run build:vendor\` to generate it. (${String(error)})`,
    );
  }
  if (typeof getConverter !== "function") {
    throw new Error("Headless Excalidraw bundle does not export getConverter");
  }
  converter = await getConverter();
  return converter;
}

export interface ConvertOptions {
  /** Semantic payload per skeleton id, written to each element's customData. */
  customData?: Map<string, Record<string, unknown>>;
  /** Recorded as customData.origin on every element produced. */
  origin?: ElementOrigin;
  /** Recorded as customData.diagram: which diagram these elements belong to. */
  diagram?: string;
}

/**
 * Converts skeletons to elements with stable ids. Every skeleton must carry a
 * string `id`; that id becomes the element's durable identity in the file.
 */
export async function convertSkeletons(
  skeletons: readonly Record<string, unknown>[],
  options: ConvertOptions = {},
): Promise<ExcalidrawElement[]> {
  const skeletonIds = skeletons.map((skeleton, index) => {
    const id = skeleton.id;
    if (typeof id !== "string" || !id) {
      throw new Error(`Skeleton at index ${index} (${String(skeleton.type)}) has no stable string id`);
    }
    return id;
  });
  const duplicates = skeletonIds.filter((id, index) => skeletonIds.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`Duplicate skeleton ids: ${[...new Set(duplicates)].join(", ")}`);

  const convert = await loadConverter();
  const converted = convert(skeletons.map((skeleton) => ({ ...skeleton })));
  return normalizeElements(converted, {
    skeletonIds,
    customData: options.customData,
    origin: options.origin,
    diagram: options.diagram,
  });
}
