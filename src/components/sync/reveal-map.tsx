"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { STYLE_DARK } from "@/components/activity/route-map";

type Coord = [number, number];

/** Cumulative along-route distance (equirectangular, fine at route scale) so the line draws at a steady speed. */
function cumulative(coords: Coord[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const kx = Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((x2 - x1) * kx, y2 - y1));
  }
  return out;
}

/** The first `p` (0–1) of the route by distance, ending on an interpolated point. */
export function sliceRoute(coords: Coord[], cum: number[], p: number): Coord[] {
  const total = cum[cum.length - 1];
  if (p >= 1 || total === 0) return coords;
  const target = total * Math.max(0, p);
  let i = 1;
  while (i < cum.length && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (target - cum[i - 1]) / seg;
  const a = coords[i - 1];
  const b = coords[i];
  return [...coords.slice(0, i), [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]];
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Dark map that draws the run's route from start to finish, with the camera slowly tilting in.
 * Falls back to an SVG drawing when tiles or WebGL aren't available. Calls onDrawn once the line is complete.
 */
export function RevealMap({ coords, durationMs, onDrawn }: { coords: Coord[]; durationMs: number; onDrawn: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const drawn = useRef(false);
  const done = useRef(onDrawn);
  done.current = onDrawn;
  const finish = useCallback(() => {
    if (drawn.current) return;
    drawn.current = true;
    done.current();
  }, []);

  useEffect(() => {
    if (!el.current || coords.length < 2) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let map: MlMap | null = null;
    let raf = 0;
    let cancelled = false;
    let loaded = false;
    // Don't make the reveal wait on slow tiles: draw the SVG version instead.
    const giveUp = setTimeout(() => !loaded && !cancelled && setFallback(true), 3500);
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !el.current) return;
        maplibre.setWorkerUrl(`/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff6b3d";
        const bounds = coords.reduce((b, c) => b.extend(c), new maplibre.LngLatBounds(coords[0], coords[0]));
        map = new maplibre.Map({
          container: el.current,
          style: STYLE_DARK,
          bounds,
          fitBoundsOptions: { padding: 56 },
          attributionControl: { compact: true },
          interactive: false,
          fadeDuration: 0,
        });
        map.on("error", () => {
          if (!loaded) setFallback(true);
        });
        map.on("load", () => {
          if (cancelled || !map) return;
          loaded = true;
          clearTimeout(giveUp);
          const empty: GeoJSON.Feature<GeoJSON.LineString> = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
          map.addSource("trail", { type: "geojson", data: empty });
          map.addLayer({ id: "trail-glow", type: "line", source: "trail", paint: { "line-color": accent, "line-width": 14, "line-opacity": 0.28, "line-blur": 8 }, layout: { "line-join": "round", "line-cap": "round" } });
          map.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": accent, "line-width": 4.5 }, layout: { "line-join": "round", "line-cap": "round" } });
          map.addSource("head", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          map.addLayer({ id: "head-halo", type: "circle", source: "head", paint: { "circle-radius": 13, "circle-color": accent, "circle-opacity": 0.3, "circle-blur": 0.6 } });
          map.addLayer({ id: "head", type: "circle", source: "head", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": accent, "circle-stroke-width": 3 } });
          map.addSource("start", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coords[0] } } });
          map.addLayer({ id: "start", type: "circle", source: "start", paint: { "circle-radius": 5, "circle-color": "#0a0b0d", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });

          const trail = map.getSource("trail") as GeoJSONSource;
          const head = map.getSource("head") as GeoJSONSource;
          const cum = cumulative(coords);
          const draw = (p: number) => {
            const part = sliceRoute(coords, cum, p);
            trail.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: part } });
            head.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: part[part.length - 1] } }] });
          };
          if (reduced) {
            draw(1);
            finish();
            return;
          }
          // tilt and turn slowly while the line draws, like a flyover
          const cam = map.cameraForBounds(bounds, { padding: { top: 70, bottom: 90, left: 48, right: 48 } });
          if (cam) map.easeTo({ ...cam, pitch: 42, bearing: -18, duration: durationMs + 900, easing: (t) => t * (2 - t) });
          const t0 = performance.now() + 250;
          const tick = (now: number) => {
            const p = Math.min(1, Math.max(0, (now - t0) / durationMs));
            draw(ease(p));
            if (p < 1) raf = requestAnimationFrame(tick);
            else finish();
          };
          raf = requestAnimationFrame(tick);
        });
      } catch {
        setFallback(true);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(giveUp);
      cancelAnimationFrame(raf);
      map?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, durationMs]);

  if (fallback) return <SvgDraw coords={coords} durationMs={durationMs} onDrawn={finish} />;
  return <div ref={el} className="absolute inset-0" />;
}

/** Route drawn with stroke-dashoffset on a dotted grid, for when the map can't load. */
function SvgDraw({ coords, durationMs, onDrawn }: { coords: Coord[]; durationMs: number; onDrawn: () => void }) {
  const W = 400;
  const H = 400;
  const d = useMemo(() => {
    const lats = coords.map((c) => c[1]);
    const lngs = coords.map((c) => c[0]);
    const kx = Math.cos((((Math.max(...lats) + Math.min(...lats)) / 2) * Math.PI) / 180);
    const minX = Math.min(...lngs) * kx;
    const maxY = Math.max(...lats);
    const w = Math.max(...lngs) * kx - minX || 1e-6;
    const h = maxY - Math.min(...lats) || 1e-6;
    const scale = Math.min((W - 80) / w, (H - 80) / h);
    const ox = (W - w * scale) / 2;
    const oy = (H - h * scale) / 2;
    return coords.map((c, i) => `${i ? "L" : "M"}${(ox + (c[0] * kx - minX) * scale).toFixed(1)},${(oy + (maxY - c[1]) * scale).toFixed(1)}`).join("");
  }, [coords]);
  useEffect(() => {
    const t = setTimeout(onDrawn, durationMs + 250);
    return () => clearTimeout(t);
  }, [durationMs, onDrawn]);
  return (
    <div className="absolute inset-0 pb-20" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden>
        <path d={d} pathLength={1} fill="none" stroke="var(--accent)" strokeOpacity={0.3} strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" className="reveal-draw" style={{ animationDuration: `${durationMs}ms` }} />
        <path d={d} pathLength={1} fill="none" stroke="var(--accent)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" className="reveal-draw" style={{ animationDuration: `${durationMs}ms` }} />
      </svg>
    </div>
  );
}
