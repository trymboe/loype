"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/** OpenFreeMap: free OSM vector tiles, no API key. */
export const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
export const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";

type Coord = [number, number];

export function RouteMap({
  coords,
  hover,
  highlight,
}: {
  coords: Coord[]; // [lng, lat]
  hover: Coord | null;
  highlight: Coord[] | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!el.current || coords.length < 2) return;
    let cancelled = false;
    (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled || !el.current) return;
      // bundled MapLibre can't find its worker on its own (copied to /public at build time)
      maplibre.setWorkerUrl(`/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6fe3a8";
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibre.LngLatBounds(coords[0], coords[0]));
      const m = new maplibre.Map({
        container: el.current,
        style: dark ? STYLE_DARK : STYLE_LIGHT,
        bounds,
        fitBoundsOptions: { padding: 32 },
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
      map.current = m;
      // Map style/tiles unreachable (offline, tile host down): show the route without a base map.
      const giveUp = setTimeout(() => !ready.current && setFailed(true), 12_000);
      m.on("error", () => {
        if (!ready.current && !m.isStyleLoaded()) setFailed(true);
      });
      m.on("load", () => {
        clearTimeout(giveUp);
        m.addSource("route", { type: "geojson", data: line(coords) });
        m.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#000", "line-opacity": 0.35, "line-width": 7 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": accent, "line-width": 4 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("highlight", { type: "geojson", data: line([]) });
        m.addLayer({ id: "highlight", type: "line", source: "highlight", paint: { "line-color": "#ffffff", "line-width": 6 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("hover", { type: "geojson", data: point(null) });
        m.addLayer({ id: "hover", type: "circle", source: "hover", paint: { "circle-radius": 7, "circle-color": accent, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
        m.addSource("ends", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [pt(coords[0], "start"), pt(coords[coords.length - 1], "end")] },
        });
        m.addLayer({
          id: "ends",
          type: "circle",
          source: "ends",
          paint: { "circle-radius": 5, "circle-color": ["match", ["get", "kind"], "start", "#22c55e", "#ef4444"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
        });
        ready.current = true;
      });
    })();
    return () => {
      cancelled = true;
      ready.current = false;
      map.current?.remove();
      map.current = null;
    };
  }, [coords]);

  useEffect(() => {
    if (!failed) return;
    map.current?.remove();
    map.current = null;
  }, [failed]);

  useEffect(() => {
    if (!ready.current || !map.current) return;
    (map.current.getSource("hover") as GeoJSONSource | undefined)?.setData(point(hover));
  }, [hover]);

  useEffect(() => {
    if (!ready.current || !map.current) return;
    (map.current.getSource("highlight") as GeoJSONSource | undefined)?.setData(line(highlight ?? []));
    if (highlight && highlight.length > 1) {
      import("maplibre-gl").then((ml) => {
        const b = highlight.reduce((acc, c) => acc.extend(c), new ml.LngLatBounds(highlight[0], highlight[0]));
        map.current?.fitBounds(b, { padding: 48, duration: 500, maxZoom: 16 });
      });
    }
  }, [highlight]);

  if (coords.length < 2) return null;
  if (failed) return <RouteFallback coords={coords} highlight={highlight} />;
  return <div ref={el} className="card h-64 w-full overflow-hidden md:h-80" />;
}

function line(c: Coord[]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } };
}
function pt(c: Coord, kind: string): GeoJSON.Feature<GeoJSON.Point> {
  return { type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: c } };
}
function point(c: Coord | null): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: c ? [pt(c, "hover")] : [] };
}

/** Plain SVG of the route, used when the map can't load. */
function RouteFallback({ coords, highlight }: { coords: Coord[]; highlight: Coord[] | null }) {
  const W = 600;
  const H = 320;
  const project = useMemo(() => {
    const lats = coords.map((c) => c[1]);
    const lngs = coords.map((c) => c[0]);
    const kx = Math.cos((((Math.max(...lats) + Math.min(...lats)) / 2) * Math.PI) / 180);
    const minX = Math.min(...lngs) * kx;
    const maxY = Math.max(...lats);
    const w = Math.max(...lngs) * kx - minX || 1e-6;
    const h = maxY - Math.min(...lats) || 1e-6;
    const scale = Math.min((W - 40) / w, (H - 40) / h);
    const ox = (W - w * scale) / 2;
    const oy = (H - h * scale) / 2;
    return (c: Coord) => `${(ox + (c[0] * kx - minX) * scale).toFixed(1)},${(oy + (maxY - c[1]) * scale).toFixed(1)}`;
  }, [coords]);
  const path = (cs: Coord[]) => cs.map((c, i) => `${i ? "L" : "M"}${project(c)}`).join("");
  return (
    <div
      className="card relative overflow-hidden"
      style={{ backgroundImage: "radial-gradient(var(--grid) 1px, transparent 1px)", backgroundSize: "16px 16px" }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full md:h-80" role="img" aria-label="Route">
        <path d={path(coords)} fill="none" stroke="var(--accent)" strokeOpacity={0.2} strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path(coords)} fill="none" stroke="var(--accent)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
        {highlight && highlight.length > 1 && (
          <path d={path(highlight)} fill="none" stroke="var(--fg)" strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" />
        )}
      </svg>
      <span className="absolute bottom-3 left-4 text-[0.6875rem] text-subtle">Map unavailable · route only</span>
    </div>
  );
}
