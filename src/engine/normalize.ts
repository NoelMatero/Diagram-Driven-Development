/**
 * Makes converted Excalidraw elements deterministic and semantically tagged.
 *
 * `convertToExcalidrawElements` mints a fresh random id, seed, and
 * versionNonce for every element on every call, and discards the ids we put
 * on the input skeletons. For a board that lives in git that is unusable:
 * redrawing an unchanged diagram would rewrite every line of the file.
 *
 * This pass restores the plan's stable ids, rewrites every cross-reference to
 * match, derives seeds from those ids, and stamps `customData` so a diagram
 * Claude drew can be read back as the graph it came from instead of being
 * re-inferred from geometry.
 */

export type ExcalidrawElement = Record<string, unknown> & {
  id: string;
  type: string;
};

/**
 * What produced an element. Stamped on everything the engine emits, including
 * the labels Excalidraw synthesises, so regenerating a diagram can replace its
 * own output without ever touching something a human drew.
 */
export type ElementOrigin = "diagram" | "connector" | "image";

export interface NormalizeOptions {
  /** Stable ids, positionally matching the skeletons that were converted. */
  skeletonIds: string[];
  /** Optional per-skeleton semantic payload, keyed by stable id. */
  customData?: Map<string, Record<string, unknown>>;
  /** Recorded as customData.origin on every element produced. */
  origin?: ElementOrigin;
  /**
   * Recorded as customData.diagram on every element produced, labels included.
   * Names which diagram an element belongs to, so one diagram can be removed
   * from a board holding several without inferring membership from its id.
   */
  diagram?: string;
}

/**
 * Excalidraw mints seeds with `Math.floor(Math.random() * 2 ** 31)`, so every
 * seed it writes is below this bound. Staying inside the same range keeps our
 * files indistinguishable from ones the app produced; a raw uint32 hash would
 * be the only field in the file outside Excalidraw's own value space.
 */
const MAX_SEED = 2 ** 31;

/** FNV-1a. Small, dependency-free, and stable across Node versions. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MAX_SEED;
}

function remap(map: Map<string, string>, id: unknown): string | undefined {
  return typeof id === "string" ? map.get(id) ?? id : undefined;
}

export function normalizeElements(
  converted: readonly ExcalidrawElement[],
  options: NormalizeOptions,
): ExcalidrawElement[] {
  const elements = converted.map((element) => ({ ...element })) as ExcalidrawElement[];

  // Bound labels are the elements the converter synthesised; everything else
  // corresponds 1:1, in order, to an input skeleton.
  const primaries = elements.filter((element) => typeof element.containerId !== "string");
  const labels = elements.filter((element) => typeof element.containerId === "string");
  if (primaries.length !== options.skeletonIds.length) {
    throw new Error(
      `Cannot normalize: ${primaries.length} primary elements for ${options.skeletonIds.length} skeletons. `
        + "The Excalidraw converter's output shape changed.",
    );
  }

  const idMap = new Map<string, string>();
  primaries.forEach((element, index) => idMap.set(element.id, options.skeletonIds[index]));
  for (const label of labels) {
    const container = idMap.get(String(label.containerId));
    if (!container) throw new Error(`Bound label ${label.id} references an unknown container`);
    idMap.set(label.id, `${container}-label`);
  }

  for (const element of elements) {
    const stableId = idMap.get(element.id);
    if (!stableId) throw new Error(`Element ${element.id} was not assigned a stable id`);
    element.id = stableId;
    element.seed = hash32(`${stableId}:seed`);
    element.versionNonce = hash32(`${stableId}:nonce`);
    // A fixed version/updated pair keeps re-emitted files byte-identical.
    // Excalidraw bumps both itself once a human touches the element.
    element.version = 1;
    element.updated = 0;

    if (typeof element.containerId === "string") {
      element.containerId = remap(idMap, element.containerId);
    }
    if (typeof element.frameId === "string") {
      element.frameId = remap(idMap, element.frameId);
    }
    if (Array.isArray(element.boundElements)) {
      element.boundElements = (element.boundElements as Array<Record<string, unknown>>).map((bound) => ({
        ...bound,
        id: remap(idMap, bound.id),
      }));
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = element[key] as Record<string, unknown> | null | undefined;
      if (binding && typeof binding === "object") {
        element[key] = { ...binding, elementId: remap(idMap, binding.elementId) };
      }
    }

    const custom = options.customData?.get(stableId);
    if (custom || options.origin || options.diagram) {
      element.customData = {
        ...((element.customData as object) ?? {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.diagram ? { diagram: options.diagram } : {}),
        ...custom,
      };
    }
  }

  return elements;
}
