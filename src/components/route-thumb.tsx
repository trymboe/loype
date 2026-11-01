/** Small static SVG of a route (no map tiles), for lists. */
export function RouteThumb({ points, size = 56 }: { points: [number, number][] | null; size?: number }) {
  if (!points || points.length < 2) {
    return <div style={{ width: size, height: size }} className="rounded-xl bg-surface-2" aria-hidden />;
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
  const scale = (size - 10) / Math.max(w, h);
  const ox = (size - w * scale) / 2;
  const oy = (size - h * scale) / 2;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(ox + (p[0] * kx - minX) * scale).toFixed(1)},${(oy + (maxY - p[1]) * scale).toFixed(1)}`)
    .join("");
  return (
    <svg width={size} height={size} className="shrink-0 rounded-xl bg-surface-2" aria-hidden>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
