"use client";

import { useMemo, useState } from "react";
import { RouteMap } from "@/components/activity/route-map";
import { ElevationProfile } from "./elevation-profile";
import { SurfaceBreakdown, useSurfaces } from "./surface-breakdown";
import { cumulativeDistance, type LngLat } from "@/lib/routes/geometry";

export function RouteView({ coords, elevations, gps = false }: { coords: LngLat[]; elevations: (number | null)[] | null; gps?: boolean }) {
  const [hover, setHover] = useState<LngLat | null>(null);
  const [surfaceOnMap, setSurfaceOnMap] = useState(false);
  const profile = useMemo(() => {
    if (!elevations || elevations.length !== coords.length) return null;
    const cum = cumulativeDistance(coords);
    return coords.map((c, i) => ({ d: cum[i] / 1000, ele: elevations[i], lng: c[0], lat: c[1] }));
  }, [coords, elevations]);
  const key = useMemo(() => (coords.length > 1 ? `${coords.length}:${coords[0]}:${coords[coords.length - 1]}` : null), [coords]);
  const surface = useSurfaces(coords, key, { gps, delayMs: 0 });
  return (
    <>
      <RouteMap coords={coords} hover={hover} highlight={null} surface={surfaceOnMap ? surface.data?.segments : null} />
      {profile && <ElevationProfile data={profile} onHover={setHover} />}
      <SurfaceBreakdown data={surface.data} state={surface.state} onMap={surfaceOnMap} onToggleMap={setSurfaceOnMap} />
    </>
  );
}
