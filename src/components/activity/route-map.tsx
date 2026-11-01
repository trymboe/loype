"use client";

import { useEffect, useRef } from "react";
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/** OpenFreeMap: free OSM vector tiles, no API key. */
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";

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
      m.on("load", () => {
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
  return <div ref={el} className="h-64 w-full overflow-hidden rounded-2xl md:h-80" />;
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
