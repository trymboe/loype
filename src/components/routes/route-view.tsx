"use client";

import { useMemo, useState } from "react";
import { RouteMap } from "@/components/activity/route-map";
import { ElevationProfile } from "./elevation-profile";
import { cumulativeDistance, type LngLat } from "@/lib/routes/geometry";

export function RouteView({ coords, elevations }: { coords: LngLat[]; elevations: (number | null)[] | null }) {
  const [hover, setHover] = useState<LngLat | null>(null);
  const profile = useMemo(() => {
    if (!elevations || elevations.length !== coords.length) return null;
    const cum = cumulativeDistance(coords);
    return coords.map((c, i) => ({ d: cum[i] / 1000, ele: elevations[i], lng: c[0], lat: c[1] }));
  }, [coords, elevations]);
  return (
    <>
      <RouteMap coords={coords} hover={hover} highlight={null} />
      {profile && <ElevationProfile data={profile} onHover={setHover} />}
    </>
  );
}
