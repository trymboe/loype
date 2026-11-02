// MapLibre 6 locates its web worker relative to `import.meta.url`, which is not
// an http(s) URL once webpack has bundled it, so the worker never loads and no
// GeoJSON (the route line) is drawn. We serve the worker from /public instead
// and point MapLibre at it with setWorkerUrl (see components/activity/route-map).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve("maplibre-gl/package.json")), "dist", "maplibre-gl-worker.mjs");
mkdirSync("public", { recursive: true });
copyFileSync(src, path.join("public", "maplibre-gl-worker.mjs"));
