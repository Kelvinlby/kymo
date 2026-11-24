// Small SVG sparkline (no axes). Draws the data as given; no animation.
export function Sparkline({ values, color = 'var(--accent)', width = 220, height = 44 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return <svg class="sparkline empty" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" preserveAspectRatio="none" />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, v] of pts) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const n = values.length - 1 || 1;
  const pad = 3;
  const x = (i: number) => (i / n) * width;
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad);
  const d = pts.map(([i, v], k) => (k ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  const area = d + ` L${x(last[0]).toFixed(1)} ${height} L${x(pts[0][0]).toFixed(1)} ${height} Z`;
  const gid = 'sg' + Math.abs(hashStr(color + values.length));
  return (
    <svg class="sparkline" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={color} stop-opacity="0.22" />
          <stop offset="1" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

function hashStr(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
