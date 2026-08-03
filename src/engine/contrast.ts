/**
 * Readable label colours.
 *
 * Excalidraw gives a bound label the container's stroke colour. That is fine on
 * a transparent shape and bad on a filled one: a mid-blue stroke on a mid-blue
 * fill lands around 2.3:1, well under the 4.5:1 usually expected of body text.
 * Nobody should have to notice that and ask for it to be fixed, so the label
 * colour is derived from the fill instead of inherited.
 */

/** Near-black and near-white, matching Excalidraw's own palette ends. */
const DARK_INK = "#1e1e1e";
const LIGHT_INK = "#ffffff";

function parseHex(color: string): { r: number; g: number; b: number } | undefined {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string): number | undefined {
  const rgb = parseHex(color);
  if (!rgb) return undefined;
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a: string, b: string): number | undefined {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  if (first === undefined || second === undefined) return undefined;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Colour for text sitting on `background`.
 *
 * `preferred` (usually the shape's stroke) is kept when it is legible, so a
 * caller's deliberate choice survives; otherwise this falls back to whichever
 * of near-black or near-white reads better.
 */
export function readableInk(background: string | undefined, preferred?: string): string {
  if (!background || background === "transparent") return preferred ?? DARK_INK;

  if (preferred) {
    const ratio = contrastRatio(preferred, background);
    if (ratio !== undefined && ratio >= 4.5) return preferred;
  }

  // Compare both candidates rather than thresholding luminance. A pivot has to
  // be calibrated and a wrong one silently picks the worse colour: #4dabf7 sits
  // just below a naive midpoint, yet black beats white on it 8.5:1 to 2.5:1.
  const darkRatio = contrastRatio(DARK_INK, background);
  const lightRatio = contrastRatio(LIGHT_INK, background);
  if (darkRatio === undefined || lightRatio === undefined) return preferred ?? DARK_INK;
  return darkRatio >= lightRatio ? DARK_INK : LIGHT_INK;
}
