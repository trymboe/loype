"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Base map styles. "map" is OpenFreeMap Liberty (OSM, free, no key). "outdoor"
 * (contours + hill shading) and "satellite" come from MapTiler and are offered
 * only when NEXT_PUBLIC_MAPTILER_KEY is set (free tier is plenty for one user).
 */
export type MapStyleId = "map" | "outdoor" | "satellite";

export const MAP_STYLE_LABEL: Record<MapStyleId, string> = { map: "Map", outdoor: "Outdoor", satellite: "Satellite" };

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

export const LIBERTY = "https://tiles.openfreemap.org/styles/liberty";

export function availableMapStyles(): MapStyleId[] {
  return MAPTILER_KEY ? ["map", "outdoor", "satellite"] : ["map"];
}

export function mapStyleUrl(id: MapStyleId): string {
  if (!MAPTILER_KEY || id === "map") return LIBERTY;
  const name = id === "outdoor" ? "outdoor-v2" : "hybrid";
  return `https://api.maptiler.com/maps/${name}/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`;
}

export const isMapTiler = (id: MapStyleId) => Boolean(MAPTILER_KEY) && id !== "map";

const KEY = "loype.mapStyle";
const EVENT = "loype:map-style";

/** The remembered choice, read synchronously (for maps that don't offer a switch). */
export function currentMapStyle(): MapStyleId {
  try {
    const v = localStorage.getItem(KEY) as MapStyleId | null;
    if (v && availableMapStyles().includes(v)) return v;
  } catch {
    // storage blocked: default
  }
  return "map";
}

/** The chosen base map, remembered on this device and shared by every map on the page. */
export function useMapStyle(): [MapStyleId, (id: MapStyleId) => void] {
  const [id, setId] = useState<MapStyleId>("map");
  useEffect(() => {
    setId(currentMapStyle());
    const on = () => setId(currentMapStyle());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = useCallback((next: MapStyleId) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // not remembered, still switches
    }
    setId(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [id, set];
}
