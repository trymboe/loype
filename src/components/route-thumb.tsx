/** Small static SVG of a route (no map tiles), for lists. */
export function RouteThumb({ points, size = 56 }: { points: [number, number][] | null; size?: number }) {
  const radius = Math.round(size * 0.24);
  if (!points || points.length < 2) {
    return (
      <div style={{ width: size, height: size, borderRadius: radius }} className="flex shrink-0 items-center justify-center bg-surface-2" aria-hidden>
        <div className="h-[2px] w-1/3 rounded-full bg-surface-3" />
      </div>
    );
  }
  const lats = points.map((p) => p[1]);
  const lngs = points.map((p) => p[0]);
  const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = lngs.map((x) => x * kx);
  const minX = Math.min(...xs);
  const maxY = Math.max(...lats);
  const w = Math.max(...xs) - minX || 1e-6;
  const h = maxY - Math.min(...lats) || 1e-6;
  const pad = size * 0.2;
  const scale = (size - pad * 2) / Math.max(w, h);
  const ox = (size - w * scale) / 2;
  const oy = (size - h * scale) / 2;
  const xy = (p: [number, number]) => [ox + (p[0] * kx - minX) * scale, oy + (maxY - p[1]) * scale] as const;
  const d = points.map((p, i) => `${i ? "L" : "M"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join("");
  const [sx, sy] = xy(points[0]);
  const stroke = size >= 64 ? 2.5 : 2;
  return (
    <svg width={size} height={size} className="shrink-0 bg-surface-2" style={{ borderRadius: radius }} aria-hidden>
      <path d={d} fill="none" stroke="var(--accent)" strokeOpacity={0.22} strokeWidth={stroke + 4} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx} cy={sy} r={stroke + 0.5} fill="var(--surface)" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  );
}
