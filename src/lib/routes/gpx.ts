/** GPX 1.1 writers. Tracks (trk) rather than routes (rte): Garmin Connect, Strava and most apps import tracks as courses. */
import type { LngLat } from "./geometry";

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

const f = (v: number, d: number) => Number(v.toFixed(d)).toString();

export interface GpxPoint {
  lng: number;
  lat: number;
  ele?: number | null;
  time?: Date | null;
  hr?: number | null;
  cad?: number | null;
}

export function toGpx({ name, points, description, time }: { name: string; points: GpxPoint[]; description?: string; time?: Date }): string {
  const hasExt = points.some((p) => p.hr != null || p.cad != null);
  const head = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Løype" xmlns="http://www.topografix.com/GPX/1/1"${
      hasExt ? ` xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"` : ""
    } xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
    `  <metadata>`,
    `    <name>${escapeXml(name)}</name>`,
    ...(description ? [`    <desc>${escapeXml(description)}</desc>`] : []),
    ...(time ? [`    <time>${time.toISOString()}</time>`] : []),
    `  </metadata>`,
    `  <trk>`,
    `    <name>${escapeXml(name)}</name>`,
    `    <type>running</type>`,
    `    <trkseg>`,
  ];
  const body = points.map((p) => {
    const inner: string[] = [];
    if (p.ele != null && Number.isFinite(p.ele)) inner.push(`<ele>${f(p.ele, 1)}</ele>`);
    if (p.time) inner.push(`<time>${p.time.toISOString()}</time>`);
    if (p.hr != null || p.cad != null) {
      const tpx = [p.hr != null ? `<gpxtpx:hr>${Math.round(p.hr)}</gpxtpx:hr>` : "", p.cad != null ? `<gpxtpx:cad>${Math.round(p.cad / 2)}</gpxtpx:cad>` : ""].join("");
      inner.push(`<extensions><gpxtpx:TrackPointExtension>${tpx}</gpxtpx:TrackPointExtension></extensions>`);
    }
    return `      <trkpt lat="${f(p.lat, 6)}" lon="${f(p.lng, 6)}">${inner.join("")}</trkpt>`;
  });
  return [...head, ...body, `    </trkseg>`, `  </trk>`, `</gpx>`, ""].join("\n");
}

export function routeToGpx(name: string, coords: LngLat[], elevations?: (number | null)[] | null): string {
  return toGpx({ name, points: coords.map(([lng, lat], i) => ({ lng, lat, ele: elevations?.[i] ?? null })) });
}

/** Safe file name for Content-Disposition. */
export function gpxFileName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "route"}.gpx`;
}
