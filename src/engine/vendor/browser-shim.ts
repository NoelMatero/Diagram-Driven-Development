/**
 * Minimal browser globals so the Excalidraw bundle can be evaluated in Node.
 *
 * Excalidraw ships a single browser bundle that runs feature detection and
 * registers its fonts at module-eval time. None of that is needed for
 * skeleton conversion, but it all has to not throw. This shim only has to
 * survive import; `convertToExcalidrawElements` is pure arithmetic afterwards.
 */
const noop = (): void => {};

type AnyRecord = Record<string, unknown>;

/**
 * Text measurement is injected rather than imported.
 *
 * Excalidraw sizes every text element through canvas.measureText while
 * building elements, so the shim has to measure properly or the editor clips
 * the result. Importing the font module here would bundle fontkit into this
 * artifact as a second copy, with its own font cache, on top of the one the
 * application already loads. The host installs the real measurer instead.
 */
type MeasureHook = (text: string, font: string) => number;

function measure(text: string, font: string): number {
  const hook = (globalThis as { __boardMeasureText?: MeasureHook }).__boardMeasureText;
  if (hook) return hook(text, font);
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  return text.length * (size ? Number(size[1]) : 16) * 0.55;
}

function fontSizeFrom(font: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  return size ? Number(size[1]) : 16;
}

function fakeContext2d(): AnyRecord {
  // Excalidraw sizes every text element through this context while building
  // elements. A crude estimate here produces text boxes narrower than the
  // glyphs they hold, and the editor then clips them, so measure for real.
  const target: AnyRecord = {
    filter: "none",
    font: "",
    textBaseline: "alphabetic",
    canvas: { width: 0, height: 0 },
    measureText(this: AnyRecord, text = "") {
      const font = String(this?.font ?? "");
      const fontSize = fontSizeFrom(font);
      return {
        width: measure(String(text), font),
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
        fontBoundingBoxAscent: fontSize * 0.8,
        fontBoundingBoxDescent: fontSize * 0.2,
      };
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
  };
  // `has` must be permissive: the bundle probes support with `"filter" in ctx`.
  return new Proxy(target, {
    has: () => true,
    get: (obj, key) => (key in obj ? obj[key as string] : typeof key === "string" ? noop : undefined),
  });
}

function fakeElement(tag = "div"): AnyRecord {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    getContext: (kind: string) => (kind === "2d" ? fakeContext2d() : null),
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    appendChild: (child: unknown) => child,
    removeChild: (child: unknown) => child,
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    toDataURL: () => "data:,",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

export function installBrowserShim(): void {
  const g = globalThis as AnyRecord;
  if (g.__excalidrawShimInstalled) return;

  g.navigator ??= { userAgent: "node", platform: "node", language: "en-US", clipboard: {}, maxTouchPoints: 0 };
  g.document ??= {
    createElement: (tag: string) => fakeElement(tag),
    createElementNS: (_ns: string, tag: string) => fakeElement(tag),
    createTextNode: (text: string) => ({ nodeValue: text }),
    documentElement: fakeElement("html"),
    head: fakeElement("head"),
    body: fakeElement("body"),
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    fonts: {
      addEventListener: noop,
      removeEventListener: noop,
      load: async () => [],
      check: () => true,
      add: noop,
      forEach: noop,
    },
  };
  g.window ??= g;
  g.self ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.matchMedia ??= () => ({
    matches: false,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
  });
  g.devicePixelRatio ??= 1;
  g.location ??= new URL("http://localhost/");
  g.requestAnimationFrame ??= (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 0);
  g.cancelAnimationFrame ??= clearTimeout;

  // The bundle installs prototype polyfills (Element.prototype.replaceChildren
  // and friends), so these must be real constructors, not plain objects.
  g.EventTarget ??= class EventTarget {
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return true; }
  };
  g.Node ??= class Node extends (g.EventTarget as ObjectConstructor) {};
  g.Element ??= class Element extends (g.Node as ObjectConstructor) {};
  g.CharacterData ??= class CharacterData extends (g.Node as ObjectConstructor) {};
  g.Text ??= class Text extends (g.CharacterData as ObjectConstructor) {};
  g.DocumentFragment ??= class DocumentFragment extends (g.Node as ObjectConstructor) {};
  g.HTMLElement ??= class HTMLElement extends (g.Element as ObjectConstructor) {};
  g.SVGElement ??= class SVGElement extends (g.Element as ObjectConstructor) {};
  g.HTMLCanvasElement ??= class HTMLCanvasElement extends (g.HTMLElement as ObjectConstructor) {};
  g.Image ??= class Image {};

  // Excalidraw registers its font faces at module-eval time.
  g.FontFace ??= class FontFace {
    status = "unloaded";
    constructor(family: string, source: unknown, descriptors: AnyRecord = {}) {
      Object.assign(this, { family, source, ...descriptors });
    }
    async load(): Promise<unknown> {
      this.status = "loaded";
      return this;
    }
  };

  g.ResizeObserver ??= class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  g.MutationObserver ??= class MutationObserver {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return []; }
  };
  g.OffscreenCanvas ??= class OffscreenCanvas {
    getContext(kind: string): unknown {
      return kind === "2d" ? fakeContext2d() : null;
    }
  };
  g.EXCALIDRAW_ASSET_PATH ??= "/";

  g.__excalidrawShimInstalled = true;
}
