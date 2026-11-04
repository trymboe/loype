import { MapPin } from "lucide-react";
import { googleMapsUrl } from "@/lib/routes/google-maps";
import type { LngLat } from "@/lib/routes/geometry";

/** Opens the route in the Google Maps app (or website) as walking directions. */
export function OpenInGoogleMaps({ coords, className = "btn btn-secondary btn-sm" }: { coords: LngLat[]; className?: string }) {
  const url = googleMapsUrl(coords);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className} title="Walking directions through points along this route">
      <MapPin size={16} /> Open in Google Maps
    </a>
  );
}
