// Run palette: colour-blind-aware ordering (blue / orange / teal / vermillion / purple / ochre / sky / magenta …),
// mid-luminance so every colour keeps >= 3:1 contrast against both the light and the dark chart surface.
export const PALETTE = [
  '#3d7bf0', '#f07f1a', '#12a37a', '#e0464d', '#9661e3', '#c89400', '#19a6d6', '#d9509f', '#6f9e1d', '#a8775a',
  '#5c6ff0', '#e85f2e', '#2a9d8f', '#c2417d', '#8e8cf0', '#b8860b', '#3fa0ff', '#df6f6f', '#4c9e4c', '#9a7ad1',
];

export function paletteColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** '#rrggbb' + alpha -> rgba() */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function cssVar(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
