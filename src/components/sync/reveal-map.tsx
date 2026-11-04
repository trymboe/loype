"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { currentMapStyle, mapStyleUrl } from "@/lib/map-style";

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
 * Map (the same base style as everywhere else) that draws the run's route from start to finish, with the camera slowly tilting in.
 * The drawing starts once the map has loaded (onStart), so it is never missed while tiles load.
 * Falls back to an SVG drawing when the map style or WebGL isn't available. Calls onDrawn once the line is complete.
 */
export function RevealMap({ coords, durationMs, onStart, onDrawn }: { coords: Coord[]; durationMs: number; onStart: () => void; onDrawn: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const cbs = useRef({ onStart, onDrawn });
  useEffect(() => {
    cbs.current = { onStart, onDrawn };
  });
  const flags = useRef({ started: false, drawn: false });
  const start = useCallback(() => {
    setWaiting(false);
    if (flags.current.started) return;
    flags.current.started = true;
    cbs.current.onStart();
  }, []);
  const finish = useCallback(() => {
    if (flags.current.drawn) return;
    flags.current.drawn = true;
    cbs.current.onDrawn();
  }, []);

  useEffect(() => {
    if (fallback || !el.current || coords.length < 2) return;
    // Reduced motion: keep the line drawing (no large movement) but hold the camera still.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let map: MlMap | null = null;
    let raf = 0;
    let cancelled = false;
    let loaded = false;
    const giveUp = setTimeout(() => !loaded && !cancelled && setFallback(true), 10_000);
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !el.current) return;
        maplibre.setWorkerUrl(`/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff6b3d";
        const bounds = coords.reduce((b, c) => b.extend(c), new maplibre.LngLatBounds(coords[0], coords[0]));
        const m = new maplibre.Map({
          container: el.current,
          style: mapStyleUrl(currentMapStyle()),
          bounds,
          fitBoundsOptions: { padding: { top: 48, bottom: 96, left: 40, right: 40 } },
          attributionControl: { compact: true },
          interactive: false,
        });
        map = m;
        // a single failed tile isn't fatal; only give up if the style itself never loads
        m.on("error", () => {
          if (!loaded && !m.isStyleLoaded()) setFallback(true);
        });
        m.on("load", () => {
          if (cancelled) return;
          loaded = true;
          clearTimeout(giveUp);
          m.resize(); // the card was mid scale-in animation when the map measured itself
          const empty: GeoJSON.Feature<GeoJSON.LineString> = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
          m.addSource("trail", { type: "geojson", data: empty });
          m.addLayer({ id: "trail-glow", type: "line", source: "trail", paint: { "line-color": accent, "line-width": 14, "line-opacity": 0.28, "line-blur": 8 }, layout: { "line-join": "round", "line-cap": "round" } });
          m.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": accent, "line-width": 4.5 }, layout: { "line-join": "round", "line-cap": "round" } });
          m.addSource("head", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "head-halo", type: "circle", source: "head", paint: { "circle-radius": 13, "circle-color": accent, "circle-opacity": 0.3, "circle-blur": 0.6 } });
          m.addLayer({ id: "head", type: "circle", source: "head", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": accent, "circle-stroke-width": 3 } });
          m.addSource("start", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coords[0] } } });
          m.addLayer({ id: "start", type: "circle", source: "start", paint: { "circle-radius": 5, "circle-color": "#0a0b0d", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });

          const trail = m.getSource("trail") as GeoJSONSource;
          const head = m.getSource("head") as GeoJSONSource;
          const cum = cumulative(coords);
          const draw = (p: number) => {
            const part = sliceRoute(coords, cum, p);
            trail.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: part } });
            head.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: part[part.length - 1] } }] });
          };
          start();
          // tilt and turn slowly while the line draws, like a flyover
          if (!still) {
            const cam = m.cameraForBounds(bounds, { padding: { top: 70, bottom: 110, left: 48, right: 48 } });
            if (cam) m.easeTo({ ...cam, pitch: 42, bearing: -18, duration: durationMs + 900, easing: (t) => t * (2 - t) });
          }
          const t0 = performance.now() + 200;
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
  }, [coords, durationMs, fallback, start, finish]);

  if (fallback) return <SvgDraw coords={coords} durationMs={durationMs} onStart={start} onDrawn={finish} />;
  return (
    <>
      {/* MapLibre's own CSS makes its container position: relative, so it can't be the absolute layer itself */}
      <div className="map-dim absolute inset-0">
        <div ref={el} className="h-full w-full" />
      </div>
      {waiting && <div className="skeleton pointer-events-none absolute inset-0 rounded-none opacity-40" />}
    </>
  );
}

/** Route drawn stroke by stroke on a dotted grid, for when the map can't load. */
function SvgDraw({ coords, durationMs, onStart, onDrawn }: { coords: Coord[]; durationMs: number; onStart: () => void; onDrawn: () => void }) {
  const W = 400;
  const H = 400;
  const glow = useRef<SVGPathElement>(null);
  const line = useRef<SVGPathElement>(null);
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
  // Measured length + rAF instead of CSS pathLength, which older WebKit ignores for dashes.
  useEffect(() => {
    const paths = [glow.current, line.current].filter((x): x is SVGPathElement => !!x);
    const len = line.current?.getTotalLength() ?? 0;
    for (const p of paths) {
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
    }
    onStart();
    let raf = 0;
    const t0 = performance.now() + 200;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / durationMs));
      for (const p of paths) p.style.strokeDashoffset = `${len * (1 - ease(t))}`;
      if (t < 1) raf = requestAnimationFrame(tick);
      else onDrawn();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [d, durationMs, onStart, onDrawn]);
  return (
    <div className="absolute inset-0 pb-20" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden>
        <path ref={glow} d={d} fill="none" stroke="var(--accent)" strokeOpacity={0.3} strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
        <path ref={line} d={d} fill="none" stroke="var(--accent)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}
