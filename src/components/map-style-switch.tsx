"use client";

import clsx from "clsx";
import { availableMapStyles, isMapTiler, MAP_STYLE_LABEL, type MapStyleId } from "@/lib/map-style";

/** Map / Outdoor / Satellite toggle overlaid on a map; renders nothing when only one style is available. */
export function MapStyleSwitch({ value, onChange, className }: { value: MapStyleId; onChange: (id: MapStyleId) => void; className?: string }) {
  const styles = availableMapStyles();
  if (styles.length < 2) return null;
  return (
    <div className={clsx("seg pointer-events-auto bg-surface/90 shadow-[var(--shadow-pop)] backdrop-blur", className)}>
      {styles.map((s) => (
        <button key={s} type="button" aria-pressed={value === s} onClick={() => onChange(s)}>
          {MAP_STYLE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

/** MapTiler's free plan asks for its logo on the map. */
export function MapTilerLogo({ style, className }: { style: MapStyleId; className?: string }) {
  if (!isMapTiler(style)) return null;
  return (
    <a href="https://www.maptiler.com" target="_blank" rel="noreferrer" className={clsx("pointer-events-auto absolute", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" width={67} height={20} />
    </a>
  );
}
