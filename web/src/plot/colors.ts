// Run palette: distinguishable on light and dark backgrounds.
export const PALETTE = [
  '#4c78e0', '#e8553e', '#2ca25f', '#a259d9', '#f0a020', '#17a8b8', '#d6487e', '#7f8c2a',
  '#8c6d4f', '#5a6fbf', '#e07b39', '#3fb68b', '#c048b0', '#b8a019', '#2b8fd6', '#cf3d3d',
  '#6aa84f', '#9b6bd1', '#e3893b', '#41a7a1',
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
