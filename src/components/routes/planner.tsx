"use client";

import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CornerUpLeft, Loader2, Repeat, Route as RouteIcon, Shuffle, Trash2, Undo2, Waypoints } from "lucide-react";
import { MapStyleSwitch, MapTilerLogo } from "@/components/map-style-switch";
import { mapStyleUrl, useMapStyle } from "@/lib/map-style";
import { ElevationProfile } from "./elevation-profile";
import { SurfaceBreakdown, useSurfaces } from "./surface-breakdown";
import { OpenInGoogleMaps } from "./google-maps";
import { SURFACE_COLOR_EXPR, surfaceGeoJson } from "@/lib/routes/surface";
import { cumulativeDistance, elevationStats, joinSegments, lineLength, simplify, type LngLat } from "@/lib/routes/geometry";
import { saveRouteAction } from "@/app/(app)/routes/actions";

interface Segment {
  coords: LngLat[];
  snapped: boolean;
  pending?: boolean;
}

interface State {
  waypoints: LngLat[];
  segments: Segment[];
}

export interface PlannerInitial {
  id: string;
  name: string;
  waypoints: LngLat[];
  snapped: boolean[];
  coords: LngLat[];
  source: "drawn" | "loop";
}

type Mode = "draw" | "loop";

const EMPTY: State = { waypoints: [], segments: [] };
const GOLDEN = 137.508;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong");
  return json as T;
}

/**
 * Splits a saved route back into per-waypoint segments for editing. Saved
 * coords were simplified, so each waypoint is matched to its nearest coord.
 */
function fromSaved(init: PlannerInitial): State {
  if (init.waypoints.length < 2) return { waypoints: init.waypoints, segments: [] };
  const idx: number[] = [];
  let from = 0;
  for (const w of init.waypoints) {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < init.coords.length; i++) {
      const d = (init.coords[i][0] - w[0]) ** 2 + (init.coords[i][1] - w[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    idx.push(best);
    from = best;
  }
  idx[0] = 0;
  idx[idx.length - 1] = init.coords.length - 1;
  const segments = init.waypoints.slice(1).map((_, k) => ({
    coords: init.coords.slice(idx[k], Math.max(idx[k] + 2, idx[k + 1] + 1)),
    snapped: init.snapped[k] ?? false,
  }));
  return { waypoints: init.waypoints, segments };
}

export function RoutePlanner({ initial, center, runs }: { initial: PlannerInitial | null; center: LngLat | null; runs: LngLat[][] }) {
  const router = useRouter();
  const [state, setState] = useState<State>(() => (initial ? fromSaved(initial) : EMPTY));
  const [history, setHistory] = useState<State[]>([]);
  const [mode, setMode] = useState<Mode>(initial?.source === "loop" ? "loop" : "draw");
  const [snap, setSnap] = useState(true);
  const [showRuns, setShowRuns] = useState(runs.length > 0);
  const [loopKm, setLoopKm] = useState(8);
  const [bearing, setBearing] = useState(() => Math.round(Math.random() * 360));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elevations, setElevations] = useState<(number | null)[] | null>(null);
  const [eleState, setEleState] = useState<"idle" | "loading" | "failed">("idle");
  const [hover, setHover] = useState<LngLat | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState<"drawn" | "loop">(initial?.source ?? "drawn");

  const stateRef = useRef(state);
  stateRef.current = state;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const commit = useCallback((next: State) => {
    setHistory((h) => [...h.slice(-49), stateRef.current]);
    setState(next);
  }, []);

  // ---- routing ----
  const routeSegment = useCallback(async (a: LngLat, b: LngLat, key: string) => {
    try {
      const res = await postJson<{ legs: LngLat[][] }>("/api/routes/route", { waypoints: [a, b] });
      setState((s) => {
        const i = s.segments.findIndex((seg, k) => seg.pending && segKey(s.waypoints[k], s.waypoints[k + 1]) === key);
        if (i < 0) return s;
        const segments = s.segments.slice();
        segments[i] = { coords: res.legs[0], snapped: true };
        return { ...s, segments };
      });
    } catch (e) {
      setNotice(`${(e as Error).message} Drew a straight line instead.`);
      setState((s) => {
        const i = s.segments.findIndex((seg, k) => seg.pending && segKey(s.waypoints[k], s.waypoints[k + 1]) === key);
        if (i < 0) return s;
        const segments = s.segments.slice();
        segments[i] = { coords: [a, b], snapped: false };
        return { ...s, segments };
      });
    }
  }, []);

  const makeSegment = useCallback(
    (a: LngLat, b: LngLat, snapped: boolean): Segment => {
      if (!snapped) return { coords: [a, b], snapped: false };
      void routeSegment(a, b, segKey(a, b));
      return { coords: [a, b], snapped: true, pending: true };
    },
    [routeSegment],
  );

  const addPoint = useCallback(
    (p: LngLat) => {
      const s = stateRef.current;
      if (modeRef.current === "loop") {
        setNotice(null);
        commit({ waypoints: [p], segments: [] });
        return;
      }
      setNotice(null);
      if (!s.waypoints.length) return commit({ waypoints: [p], segments: [] });
      const last = s.waypoints[s.waypoints.length - 1];
      commit({ waypoints: [...s.waypoints, p], segments: [...s.segments, makeSegment(last, p, snapRef.current)] });
    },
    [commit, makeSegment],
  );

  const moveWaypoint = useCallback(
    (i: number, p: LngLat) => {
      const s = stateRef.current;
      const waypoints = s.waypoints.slice();
      waypoints[i] = p;
      const segments = s.segments.slice();
      if (i > 0) segments[i - 1] = makeSegment(waypoints[i - 1], p, s.segments[i - 1]?.snapped ?? snapRef.current);
      if (i < segments.length) segments[i] = makeSegment(p, waypoints[i + 1], s.segments[i]?.snapped ?? snapRef.current);
      commit({ waypoints, segments });
    },
    [commit, makeSegment],
  );

  const removeWaypoint = useCallback(
    (i: number) => {
      const s = stateRef.current;
      if (s.waypoints.length <= 1) return commit(EMPTY);
      const waypoints = s.waypoints.filter((_, k) => k !== i);
      let segments: Segment[];
      if (i === 0) segments = s.segments.slice(1);
      else if (i === s.waypoints.length - 1) segments = s.segments.slice(0, -1);
      else
        segments = [
          ...s.segments.slice(0, i - 1),
          makeSegment(s.waypoints[i - 1], s.waypoints[i + 1], s.segments[i - 1].snapped || s.segments[i].snapped),
          ...s.segments.slice(i + 1),
        ];
      commit({ waypoints, segments });
    },
    [commit, makeSegment],
  );

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setState(h[h.length - 1]);
      return h.slice(0, -1);
    });
  };
  const clear = () => {
    commit(EMPTY);
    setNotice(null);
  };
  const closeLoop = () => {
    const s = stateRef.current;
    if (s.waypoints.length < 2) return;
    addPoint(s.waypoints[0]);
  };
  const reverse = () => {
    const s = stateRef.current;
    commit({
      waypoints: s.waypoints.slice().reverse(),
      segments: s.segments
        .slice()
        .reverse()
        .map((seg) => ({ ...seg, coords: seg.coords.slice().reverse() })),
    });
  };

  const generate = async (b = bearing) => {
    const start = stateRef.current.waypoints[0];
    if (!start) {
      setNotice("Tap the map to set where the loop starts.");
      return;
    }
    setBusy("loop");
    setNotice(null);
    try {
      const res = await postJson<{ legs: LngLat[][]; waypoints: LngLat[]; distanceM: number }>("/api/routes/loop", { start, distanceM: loopKm * 1000, bearing: b });
      const wps = res.waypoints.slice();
      // use the routed leg ends as waypoints so editing later lines up with the path
      res.legs.forEach((leg, i) => {
        if (leg.length && i + 1 < wps.length - 1) wps[i + 1] = leg[leg.length - 1];
      });
      commit({ waypoints: wps, segments: res.legs.map((coords) => ({ coords, snapped: true })) });
      setSource("loop");
      const off = Math.abs(res.distanceM / (loopKm * 1000) - 1);
      if (off > 0.12) setNotice(`Closest loop found is ${(res.distanceM / 1000).toFixed(1)} km. Try another direction or tweak it in Draw.`);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const another = () => {
    const nb = (bearing + GOLDEN) % 360;
    setBearing(nb);
    void generate(nb);
  };

  // ---- derived geometry ----
  const pending = state.segments.some((s) => s.pending);
  const coords = useMemo(() => joinSegments(state.segments.map((s) => s.coords)), [state.segments]);
  const simplified = useMemo(() => (coords.length > 2 ? simplify(coords, 2) : coords), [coords]);
  const distanceM = useMemo(() => lineLength(coords), [coords]);
  const geomKey = useMemo(() => (pending ? null : simplified.map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(";")), [simplified, pending]);

  // elevation lookup, debounced, once routing has settled
  useEffect(() => {
    setElevations(null);
    if (!geomKey || simplified.length < 2) {
      setEleState("idle");
      return;
    }
    setEleState("loading");
    const ctrl = { cancelled: false };
    const t = setTimeout(async () => {
      try {
        const res = await postJson<{ elevations: (number | null)[] }>("/api/routes/elevation", { coords: simplified });
        if (!ctrl.cancelled) {
          setElevations(res.elevations);
          setEleState("idle");
        }
      } catch {
        if (!ctrl.cancelled) setEleState("failed");
      }
    }, 700);
    return () => {
      ctrl.cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomKey]);

  const surface = useSurfaces(simplified, geomKey);
  const [surfaceOnMap, setSurfaceOnMap] = useState(false);

  const ele = useMemo(() => (elevations && elevations.length === simplified.length ? elevationStats(elevations) : null), [elevations, simplified]);
  const profile = useMemo(() => {
    if (!elevations || elevations.length !== simplified.length) return null;
    const cum = cumulativeDistance(simplified);
    return simplified.map((c, i) => ({ d: cum[i] / 1000, ele: elevations[i], lng: c[0], lat: c[1] }));
  }, [elevations, simplified]);

  // ---- map ----
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const markers = useRef<Marker[]>([]);
  const ml = useRef<typeof import("maplibre-gl") | null>(null);
  const [mapStyle, setMapStyle] = useMapStyle();
  const mapStyleRef = useRef(mapStyle);
  const [styleGen, setStyleGen] = useState(0); // bumps when overlays were re-added after a style swap

  useEffect(() => {
    if (!el.current) return;
    let cancelled = false;
    (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled || !el.current) return;
      ml.current = maplibre;
      maplibre.setWorkerUrl(`/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
      const init = stateRef.current.waypoints;
      const startCoords = initial?.coords.length ? initial.coords : init;
      const m = new maplibre.Map({
        container: el.current,
        style: mapStyleUrl(mapStyleRef.current),
        center: center ?? [10.7522, 59.9139],
        zoom: center ? 13 : 11,
        attributionControl: { compact: true },
      });
      if (startCoords.length > 1) {
        const b = startCoords.reduce((acc, c) => acc.extend(c), new maplibre.LngLatBounds(startCoords[0], startCoords[0]));
        m.fitBounds(b, { padding: 48, duration: 0 });
      }
      m.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      m.addControl(new maplibre.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "top-right");
      map.current = m;
      const giveUp = setTimeout(() => !m.isStyleLoaded() && setMapFailed(true), 15_000);
      m.on("load", () => {
        clearTimeout(giveUp);
        setReady(true);
      });
      // first style and every swap: re-add our layers, then let the data effects refill them
      m.on("style.load", () => {
        if (m.getSource("route")) return;
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff6b3d";
        const runsColor = getComputedStyle(document.documentElement).getPropertyValue("--pace").trim() || "#5aaeff";
        m.addSource("runs", { type: "geojson", data: multi([]) });
        m.addLayer({ id: "runs", type: "line", source: "runs", paint: { "line-color": runsColor, "line-opacity": 0.35, "line-width": 2 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("route", { type: "geojson", data: line([]) });
        m.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#000", "line-opacity": 0.35, "line-width": 8 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": accent, "line-width": 4.5 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("surface", { type: "geojson", data: surfaceGeoJson(null) });
        m.addLayer({ id: "surface", type: "line", source: "surface", paint: { "line-color": SURFACE_COLOR_EXPR, "line-width": 4.5 }, layout: { "line-join": "round", "line-cap": "round" } });
        m.addSource("pending", { type: "geojson", data: multi([]) });
        m.addLayer({ id: "pending", type: "line", source: "pending", paint: { "line-color": accent, "line-width": 3, "line-opacity": 0.6, "line-dasharray": [1.5, 1.5] } });
        m.addSource("hover", { type: "geojson", data: points([]) });
        m.addLayer({ id: "hover", type: "circle", source: "hover", paint: { "circle-radius": 7, "circle-color": accent, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
        setStyleGen((g) => g + 1);
      });
      m.on("click", (e) => addPoint([round6(e.lngLat.lng), round6(e.lngLat.lat)]));
    })();
    return () => {
      cancelled = true;
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("runs") as GeoJSONSource | undefined)?.setData(multi(showRuns ? runs : []));
  }, [ready, showRuns, runs, styleGen]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const done = state.segments.filter((s) => !s.pending);
    (map.current.getSource("route") as GeoJSONSource | undefined)?.setData(multi(done.map((s) => s.coords)));
    (map.current.getSource("pending") as GeoJSONSource | undefined)?.setData(multi(state.segments.filter((s) => s.pending).map((s) => s.coords)));
  }, [ready, state.segments, styleGen]);

  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("surface") as GeoJSONSource | undefined)?.setData(surfaceGeoJson(surfaceOnMap ? surface.data?.segments : null));
  }, [ready, surfaceOnMap, surface.data, styleGen]);

  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("hover") as GeoJSONSource | undefined)?.setData(points(hover ? [hover] : []));
  }, [ready, hover, styleGen]);

  useEffect(() => {
    if (mapStyleRef.current === mapStyle) return;
    mapStyleRef.current = mapStyle;
    map.current?.setStyle(mapStyleUrl(mapStyle), { diff: false });
  }, [mapStyle]);

  // waypoint markers: draggable; tap to remove (except in loop mode)
  useEffect(() => {
    const maplibre = ml.current;
    const m = map.current;
    if (!ready || !maplibre || !m) return;
    markers.current.forEach((mk) => mk.remove());
    const wps = state.waypoints;
    const closed = wps.length > 2 && wps[0][0] === wps[wps.length - 1][0] && wps[0][1] === wps[wps.length - 1][1];
    markers.current = wps.map((w, i) => {
      const node = document.createElement("button");
      node.type = "button";
      const isStart = i === 0;
      const isEnd = i === wps.length - 1 && i > 0;
      if (closed && isEnd) node.style.display = "none";
      node.className = "route-wp";
      node.dataset.kind = isStart ? "start" : isEnd ? "end" : "via";
      node.setAttribute("aria-label", isStart ? "Start point" : isEnd ? "End point" : `Waypoint ${i}`);
      let dragging = false;
      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // a drag ends with a click on the marker: don't treat it as "remove"
        if (dragging) return void (dragging = false);
        if (modeRef.current === "draw" && !isStart) removeWaypoint(i);
      });
      const mk = new maplibre.Marker({ element: node, draggable: true }).setLngLat(w).addTo(m);
      mk.on("dragstart", () => (dragging = true));
      mk.on("dragend", () => {
        setTimeout(() => (dragging = false), 50);
        const ll = mk.getLngLat();
        const p: LngLat = [round6(ll.lng), round6(ll.lat)];
        if (closed && isStart) {
          // moving the start of a closed loop moves its end too
          const s = stateRef.current;
          const waypoints = s.waypoints.slice();
          waypoints[0] = p;
          waypoints[waypoints.length - 1] = p;
          const segments = s.segments.slice();
          segments[0] = makeSegment(p, waypoints[1], s.segments[0].snapped);
          segments[segments.length - 1] = makeSegment(waypoints[waypoints.length - 2], p, s.segments[segments.length - 1].snapped);
          commit({ waypoints, segments });
        } else moveWaypoint(i, p);
      });
      return mk;
    });
  }, [ready, state.waypoints, moveWaypoint, removeWaypoint, makeSegment, commit]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const res = await saveRouteAction({
      id: initial?.id ?? null,
      name: name || defaultName(distanceM, source),
      coords: simplified,
      elevations: elevations && elevations.length === simplified.length ? elevations : null,
      waypoints: state.waypoints,
      snapped: state.segments.map((s) => s.snapped),
      source,
    });
    setSaving(false);
    if (res.error) setNotice(res.error);
    else if (res.id) router.push(`/routes/${res.id}`);
  };

  const canSave = state.segments.length > 0 && !pending && !saving && distanceM >= 50;
  const hint =
    mode === "loop"
      ? state.waypoints.length === 0
        ? "Tap the map where the loop should start."
        : state.segments.length === 0
          ? "Pick a distance and generate a loop."
          : "Drag the dots to reshape it, or try another direction."
      : state.waypoints.length === 0
        ? "Tap the map to place your start."
        : "Tap to add points. Drag a dot to move it, tap it to remove it.";

  return (
    <div className="space-y-3">
      <div className="card relative overflow-hidden">
        <div className={clsx("relative h-[52dvh] min-h-80 w-full md:h-[60dvh]", mapStyle === "map" && "map-dim")}>
          <div className="absolute inset-0">
            <div ref={el} className="h-full w-full" data-testid="planner-map" />
          </div>
          {mapFailed && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-2/90 p-6 text-center text-sm text-muted">
              The map couldn&apos;t load. Check your connection and reload the page.
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-2">
            <div className="seg pointer-events-auto bg-surface/90 shadow-[var(--shadow-pop)] backdrop-blur">
              {(["draw", "loop"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === "draw" ? "Draw" : "Loop"}
                </button>
              ))}
            </div>
            <MapStyleSwitch value={mapStyle} onChange={setMapStyle} />
          </div>
          <MapTilerLogo style={mapStyle} className="right-2 bottom-12" />
          <p className="pointer-events-none absolute inset-x-3 bottom-3 w-fit max-w-[calc(100%-1.5rem)] rounded-full bg-surface/90 px-3 py-1.5 text-xs font-medium text-fg-2 shadow-[var(--shadow-pop)] backdrop-blur">
            {busy === "loop" ? "Finding a loop…" : pending ? "Following paths…" : hint}
          </p>
        </div>

        <div className="border-t border-[var(--hairline)] p-4">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Distance" value={distanceM ? (distanceM / 1000).toFixed(2) : "–"} unit="km" />
            <Metric label="Climb" value={ele ? `+${Math.round(ele.gainM)}` : eleState === "loading" ? "…" : "–"} unit="m" />
            <Metric label="Descent" value={ele ? `−${Math.round(ele.lossM)}` : eleState === "loading" ? "…" : "–"} unit="m" />
          </div>

          {mode === "draw" ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-3">
              <label className="mr-auto flex w-full cursor-pointer items-center gap-2 text-sm font-medium sm:w-auto">
                <input type="checkbox" className="switch" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                Follow paths
              </label>
              <ToolButton onClick={undo} disabled={!history.length} label="Undo">
                <Undo2 size={16} />
              </ToolButton>
              <ToolButton onClick={reverse} disabled={state.waypoints.length < 2} label="Reverse">
                <Repeat size={16} />
              </ToolButton>
              <ToolButton onClick={closeLoop} disabled={state.waypoints.length < 2} label="Back to start">
                <CornerUpLeft size={16} />
              </ToolButton>
              <ToolButton onClick={clear} disabled={!state.waypoints.length} label="Clear">
                <Trash2 size={16} />
              </ToolButton>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3">
                <label htmlFor="loop-km" className="text-sm font-medium">
                  Distance
                </label>
                <input
                  id="loop-km"
                  type="range"
                  min={2}
                  max={30}
                  step={0.5}
                  value={loopKm}
                  onChange={(e) => setLoopKm(Number(e.target.value))}
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="tabular w-16 text-right text-sm font-semibold">{loopKm} km</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {[5, 8, 10, 15].map((k) => (
                  <button key={k} type="button" onClick={() => setLoopKm(k)} className="chip" aria-pressed={loopKm === k}>
                    {k} km
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary flex-1" disabled={!state.waypoints.length || busy != null} onClick={() => generate()}>
                  {busy === "loop" ? <Loader2 size={16} className="animate-spin" /> : <RouteIcon size={16} />} Generate loop
                </button>
                <button type="button" className="btn btn-secondary" disabled={!state.segments.length || busy != null} onClick={another}>
                  <Shuffle size={16} /> Another
                </button>
              </div>
            </div>
          )}

          {runs.length > 0 && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="switch" checked={showRuns} onChange={(e) => setShowRuns(e.target.checked)} />
              <Waypoints size={15} /> Show where I&apos;ve run
            </label>
          )}

          {!pending && coords.length > 1 && (
            <div className="mt-3">
              <OpenInGoogleMaps coords={simplified} className="btn btn-secondary btn-sm" />
            </div>
          )}

          {notice && <p className="mt-3 rounded-xl bg-warn/10 px-3 py-2 text-[0.8125rem] leading-snug text-warn">{notice}</p>}
        </div>
      </div>

      {profile && <ElevationProfile data={profile} onHover={setHover} />}
      <SurfaceBreakdown data={surface.data} state={surface.state} onMap={surfaceOnMap} onToggleMap={setSurfaceOnMap} />
      {eleState === "failed" && state.segments.length > 0 && (
        <p className="px-1 text-xs text-muted">Elevation is unavailable right now; it will be looked up again when you save.</p>
      )}

      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="label">Name</span>
          <input
            className="input mt-1.5 w-full"
            value={name}
            maxLength={80}
            placeholder={defaultName(distanceM, source)}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-accent" disabled={!canSave} onClick={save}>
          {saving && <Loader2 size={16} className="animate-spin" />} {initial ? "Save changes" : "Save route"}
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="display tabular mt-1 text-[1.375rem]">
        {value}
        <span className="ml-1 text-[0.8125rem] font-medium tracking-normal text-muted">{unit}</span>
      </div>
    </div>
  );
}

function ToolButton({ children, label, ...rest }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} className="btn btn-secondary btn-sm" {...rest}>
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function defaultName(distanceM: number, source: "drawn" | "loop") {
  if (!distanceM) return "New route";
  return `${(distanceM / 1000).toFixed(1)} km ${source === "loop" ? "loop" : "route"}`;
}

const segKey = (a: LngLat, b: LngLat) => `${a[0]},${a[1]}>${b[0]},${b[1]}`;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function line(c: LngLat[]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } };
}
function multi(lines: LngLat[][]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: lines.filter((l) => l.length > 1).map(line) };
}
function points(cs: LngLat[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: cs.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })) };
}
