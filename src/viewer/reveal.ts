/**
 * Staggered reveal for a board that arrived all at once.
 *
 * A diagram written by a tool lands in the file as a single atomic save, so the
 * browser learns about forty elements in one frame and the whole picture flicks
 * into existence. Drawing it on in steps reads as someone working rather than a
 * page refresh, which is the difference between watching a colleague and
 * refreshing a wiki.
 *
 * This module only decides *what* to show and *when*. It holds no browser state
 * and touches no canvas, so the ordering rules below are testable on their own.
 */

/**
 * The little we need from an element to order it. Deliberately structural: the
 * planner passes elements straight through, so it must accept whatever shape the
 * board file happens to hold.
 */
export interface RevealElement extends Record<string, unknown> {
  id?: unknown;
  type?: unknown;
  containerId?: unknown;
  customData?: unknown;
}

/**
 * The element this one should appear alongside, if any.
 *
 * Two different kinds of attachment, and missing the second one showed: a bound
 * label is tied to its container structurally, but an edge label is a free
 * text element positioned at the arrow's midpoint with nothing linking it to the
 * connector. Grouping only by `containerId` let edge labels arrive with the
 * boxes, a beat before their arrows, so a stray word hung in empty space. The
 * engine records the relationship, so use it.
 */
function attachedTo(element: RevealElement, present: ReadonlySet<string>): string | undefined {
  const container = element.containerId;
  if (typeof container === "string" && present.has(container)) return container;
  const custom = element.customData as { edgeLabelFor?: unknown } | undefined;
  const edge = custom?.edgeLabelFor;
  if (typeof edge === "string" && present.has(edge)) return edge;
  // An attachment whose target is not on this board has to stand on its own, or
  // it would be grouped under an id that never appears and silently vanish.
  return undefined;
}

export interface RevealOptions {
  /** Wall-clock budget for the whole reveal. */
  totalMs?: number;
  /** Upper bound on canvas updates, so a big diagram does not thrash. */
  maxFrames?: number;
  /** Below this many groups a reveal is not worth the delay. */
  minGroups?: number;
}

export interface RevealPlan {
  /** Cumulative scenes: each frame is everything visible at that point. */
  frames: RevealElement[][];
  intervalMs: number;
}

const DEFAULTS = { totalMs: 640, maxFrames: 14, minGroups: 3 };

/**
 * Elements bundled into the units they should appear as.
 *
 * A label is not its own event: a box whose text arrives a frame later, or an
 * edge label without its arrow, reads as a glitch. Arrows come after every shape
 * because a connector drawn before the thing it connects points at nothing, and
 * because "boxes, then the lines between them" is the order a person draws in.
 */
export function revealGroups(elements: readonly RevealElement[]): RevealElement[][] {
  const present = new Set(elements.map((element) => String(element.id)));
  const attachments = new Map<string, RevealElement[]>();
  const primaries: RevealElement[] = [];

  for (const element of elements) {
    const target = attachedTo(element, present);
    if (target === undefined) primaries.push(element);
    else attachments.set(target, [...(attachments.get(target) ?? []), element]);
  }

  const isArrow = (element: RevealElement) => element.type === "arrow";
  // File order within each band: that is layout order, so nodes appear roughly
  // the way the graph flows rather than at random.
  const ordered = [...primaries.filter((e) => !isArrow(e)), ...primaries.filter(isArrow)];

  return ordered.map((primary) => [primary, ...(attachments.get(String(primary.id)) ?? [])]);
}

/**
 * Splits `items` into at most `buckets` runs, largest first, so a reveal of 40
 * elements takes the same number of canvas updates as one of 14.
 */
function chunk<T>(items: readonly T[], buckets: number): T[][] {
  const result: T[][] = [];
  const size = Math.ceil(items.length / buckets);
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * Frames to apply in order. The last frame always holds every element, in the
 * original order, so finishing the reveal leaves exactly the scene that was
 * asked for -- z-order included, which is why frames filter the input rather
 * than accumulate groups.
 */
export function planReveal(
  elements: readonly RevealElement[],
  options: RevealOptions = {},
): RevealPlan {
  const { totalMs, maxFrames, minGroups } = { ...DEFAULTS, ...options };
  const all = [...elements];
  const groups = revealGroups(all);

  // Too small to be worth a delay: show it immediately.
  if (groups.length < minGroups) return { frames: [all], intervalMs: 0 };

  const revealed = new Set<string>();
  const frames = chunk(groups, maxFrames).map((bucket) => {
    for (const group of bucket) {
      for (const element of group) revealed.add(String(element.id));
    }
    return all.filter((element) => revealed.has(String(element.id)));
  });

  return { frames, intervalMs: Math.round(totalMs / Math.max(1, frames.length)) };
}

/** Honours the OS "reduce motion" setting; animation is never load-bearing. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
