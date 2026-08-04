/** Types for box.mjs, so the tests that pin its arithmetic can typecheck. */
export function width(text: string): number;
export function fit(text: string, cells: number): string;
export function pad(text: string, cells: number, align?: "left" | "right" | "centre"): string;
export function box(spec: {
  head?: string;
  foot?: string;
  rows?: string[];
  sections?: Array<{ label?: string; rows: string[] }>;
  min?: number;
  max?: number;
}): string[];
