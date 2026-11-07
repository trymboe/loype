import type { SupabaseClient } from "@supabase/supabase-js";
import type { DerivedActivity } from "../analytics/summarize";
import type { NormalizedActivity } from "../fit/types";
import { VERSIONS } from "../analytics/versions";
import { fetchAll } from "../db/paginate";
import { defaultShoeIdFor } from "../shoes/service";
import type { IngestRepo, JobCounters, JobKind, RawSourceRow, SyncJob, WellnessObservation } from "./types";

export const RAW_BUCKET = "raw-activity-files";

/* eslint-disable @typescript-eslint/no-explicit-any */
function check<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(`Database error: ${res.error.message ?? res.error}`);
  return res.data;
}

const toJob = (r: any): SyncJob => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  rangeStart: r.range_start,
  rangeEnd: r.range_end,
  cursor: r.cursor ?? {},
  createdAt: new Date(r.created_at),
});

const toRaw = (r: any): RawSourceRow => ({
  id: r.id,
  externalId: r.external_id,
  activityType: r.activity_type,
  startTime: r.start_time ? new Date(r.start_time) : null,
  name: r.summary?.activityName ?? r.summary?.name ?? null,
  status: r.status,
  attempts: r.attempts,
  filePath: r.file_path,
  syncJobId: r.sync_job_id,
});

/** Douglas-Peucker-free, even-stride downsample for list thumbnails. */
export function routePreview(a: NormalizedActivity, maxPoints = 150): [number, number][] | null {
  const pts: [number, number][] = [];
  for (let i = 0; i < a.streams.t.length; i++) {
    const lat = a.streams.lat[i];
    const lng = a.streams.lng[i];
    if (lat != null && lng != null) pts.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  }
  if (pts.length < 2) return null;
  const stride = Math.max(1, Math.ceil(pts.length / maxPoints));
  const out = pts.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

function localDate(start: Date, offsetS: number | null, tz: string): string {
  if (offsetS != null) return new Date(start.getTime() + offsetS * 1000).toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
}

export class SupabaseIngestRepo implements IngestRepo {
  constructor(
    private readonly db: SupabaseClient,
    private readonly userId: string,
    private readonly timezone = "Europe/Oslo",
    private readonly provider: "garmin" | "upload" | "strava" = "garmin",
  ) {}

  async getActiveJob() {
    const rows = check(
      await this.db
        .from("sync_jobs")
        .select("*")
        .eq("user_id", this.userId)
        .eq("provider", this.provider)
        .in("status", ["queued", "discovering", "processing"])
        .order("created_at", { ascending: true })
        .limit(1),
    );
    return rows?.[0] ? toJob(rows[0]) : null;
  }

  async getLastJob(kind: JobKind) {
    const rows = check(
      await this.db.from("sync_jobs").select("*").eq("user_id", this.userId).eq("provider", this.provider).eq("kind", kind).order("created_at", { ascending: false }).limit(1),
    );
    return rows?.[0] ? toJob(rows[0]) : null;
  }

  async createJob(kind: JobKind, rangeStart: string | null, rangeEnd: string | null) {
    const row = check(
      await this.db
        .from("sync_jobs")
        .insert({ user_id: this.userId, kind, range_start: rangeStart, range_end: rangeEnd, provider: this.provider })
        .select("*")
        .single(),
    );
    return toJob(row);
  }

  async updateJob(id: string, patch: Parameters<IngestRepo["updateJob"]>[1]) {
    const upd: Record<string, unknown> = {};
    if (patch.status) upd.status = patch.status;
    if (patch.cursor) upd.cursor = patch.cursor;
    if (patch.lastError !== undefined) upd.last_error = patch.lastError;
    if (patch.counters) {
      const { pending: _pending, ...c } = patch.counters;
      void _pending;
      Object.assign(upd, c);
    }
    if (patch.finished) upd.finished_at = new Date().toISOString();
    if (patch.started) upd.started_at = new Date().toISOString();
    check(await this.db.from("sync_jobs").update(upd).eq("id", id).eq("user_id", this.userId));
  }

  async countForJob(jobId: string): Promise<JobCounters> {
    // fetchAll: a long historical import can exceed PostgREST's 1000-row page.
    const rows = await fetchAll<{ status: string }>((from, to) =>
      this.db
        .from("raw_activity_sources")
        .select("status")
        .eq("user_id", this.userId)
        .eq("sync_job_id", jobId)
        .order("id")
        .range(from, to),
    );
    const c = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
    return {
      discovered: rows.length,
      processed: c(["processed"]),
      failed: c(["failed"]),
      unavailable: c(["unavailable"]),
      skipped: c(["skipped_type", "duplicate"]),
      pending: c(["discovered", "downloaded"]),
    };
  }

  async insertDiscovered(items: Parameters<IngestRepo["insertDiscovered"]>[0], jobId: string) {
    if (items.length === 0) return 0;
    const rows = items.map((it) => ({
      user_id: this.userId,
      provider: this.provider,
      external_id: it.externalId,
      activity_type: it.activityType,
      start_time: it.startTime?.toISOString() ?? null,
      summary: it.raw,
      status: it.status,
      sync_job_id: jobId,
    }));
    const inserted = check(
      await this.db
        .from("raw_activity_sources")
        .upsert(rows, { onConflict: "user_id,provider,external_id", ignoreDuplicates: true })
        .select("id"),
    );
    return inserted?.length ?? 0;
  }

  async claimPending(limit: number, now: Date, maxAttempts: number) {
    const rows = check(
      await this.db
        .from("raw_activity_sources")
        .select("*")
        .eq("user_id", this.userId)
        .eq("provider", this.provider)
        .lte("next_attempt_at", now.toISOString())
        .or(`status.in.(discovered,downloaded),and(status.eq.failed,attempts.lt.${maxAttempts})`)
        .order("start_time", { ascending: false })
        .limit(limit),
    );
    return (rows ?? []).map(toRaw);
  }

  async updateRaw(id: string, p: Parameters<IngestRepo["updateRaw"]>[1]) {
    const upd: Record<string, unknown> = {};
    if (p.status) upd.status = p.status;
    if (p.attempts != null) upd.attempts = p.attempts;
    if (p.nextAttemptAt) upd.next_attempt_at = p.nextAttemptAt.toISOString();
    if (p.lastError !== undefined) upd.last_error = p.lastError;
    if (p.filePath) upd.file_path = p.filePath;
    if (p.fileSha256) upd.file_sha256 = p.fileSha256;
    if (p.fileBytes != null) upd.file_bytes = p.fileBytes;
    if (p.fetchedAt) upd.fetched_at = p.fetchedAt.toISOString();
    if (p.processedAt) upd.processed_at = p.processedAt.toISOString();
    check(await this.db.from("raw_activity_sources").update(upd).eq("id", id).eq("user_id", this.userId));
  }

  private path(p: string) {
    return `${this.userId}/${p}`;
  }

  async storeFile(path: string, bytes: Uint8Array) {
    const { error } = await this.db.storage
      .from(RAW_BUCKET)
      .upload(this.path(path), bytes, { contentType: "application/octet-stream", upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async loadFile(path: string) {
    const { data, error } = await this.db.storage.from(RAW_BUCKET).download(this.path(path));
    if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? "no data"}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async latestActivityStart() {
    const rows = check(
      await this.db.from("activities").select("start_time").eq("user_id", this.userId).order("start_time", { ascending: false }).limit(1),
    );
    return rows?.[0] ? new Date(rows[0].start_time) : null;
  }

  async findDuplicateCandidates(start: Date, excludeRawId: string) {
    const lo = new Date(start.getTime() - 10 * 60_000).toISOString();
    const hi = new Date(start.getTime() + 10 * 60_000).toISOString();
    const rows = check(
      await this.db
        .from("activities")
        .select("id, start_time, elapsed_s, distance_m, raw_source_id")
        .eq("user_id", this.userId)
        .gte("start_time", lo)
        .lte("start_time", hi)
        .neq("raw_source_id", excludeRawId),
    );
    return (rows ?? []).map((r: any) => ({ id: r.id, startTime: new Date(r.start_time), elapsedS: r.elapsed_s, distanceM: r.distance_m }));
  }

  async saveActivity(raw: RawSourceRow, a: NormalizedActivity, d: DerivedActivity) {
    const s = d.summary;
    const row: Record<string, unknown> = {
      user_id: this.userId,
      raw_source_id: raw.id,
      name: raw.name,
      sport: a.sport,
      sub_sport: a.subSport,
      start_time: a.startTime.toISOString(),
      utc_offset_s: a.utcOffsetS,
      local_date: localDate(a.startTime, a.utcOffsetS, this.timezone),
      distance_m: s.distanceM,
      elapsed_s: s.elapsedS,
      timer_s: s.timerS,
      moving_s: s.movingS,
      avg_speed_moving: s.avgSpeedMoving,
      avg_hr: s.avgHr,
      max_hr: s.maxHr,
      avg_cadence: s.avgCadence,
      elevation_gain_m: s.elevationGainM,
      elevation_loss_m: s.elevationLossM,
      has_gps: s.hasGps,
      is_indoor: s.isIndoor,
      device_manufacturer: a.device.manufacturer,
      device_product: a.device.product,
      provenance: s.provenance,
      quality: { ...d.quality, parserWarnings: a.warnings },
      quality_score: d.quality.score,
      usable_for_fitness: d.quality.usableForFitness,
      parser_version: VERSIONS.fitParser,
      derivation_versions: VERSIONS,
      route_preview: routePreview(a),
    };
    // A run saved for the first time gets the default shoe; on reprocess shoe_id stays out of the payload.
    const existing = check(await this.db.from("activities").select("id").eq("raw_source_id", raw.id).maybeSingle());
    if (!existing) {
      const shoeId = await defaultShoeIdFor(this.db, this.userId, a.startTime);
      if (shoeId) row.shoe_id = shoeId;
    }
    // Upsert on raw_source_id; manual_overrides is not in the payload, so user edits survive reprocessing.
    const saved = check(
      await this.db.from("activities").upsert(row, { onConflict: "raw_source_id" }).select("id").single(),
    ) as { id: string };
    const activityId = saved.id;

    const st = a.streams;
    const motionStates = d.motion.intervals.map((iv) => iv.state[0]).join("");
    check(
      await this.db.from("activity_streams").upsert(
        {
          activity_id: activityId,
          user_id: this.userId,
          sample_count: st.t.length,
          t: st.t,
          distance: d.motion.distance,
          speed: st.speed,
          hr: st.hr,
          cadence: st.cadence,
          altitude: st.altitude,
          lat: st.lat,
          lng: st.lng,
          motion_states: motionStates,
        },
        { onConflict: "activity_id" },
      ),
    );

    check(await this.db.from("activity_laps").delete().eq("activity_id", activityId));
    if (a.laps.length) {
      check(
        await this.db.from("activity_laps").insert(
          a.laps.map((l) => ({
            activity_id: activityId,
            user_id: this.userId,
            lap_index: l.index,
            start_offset_s: l.startOffsetS,
            elapsed_s: l.elapsedS,
            timer_s: l.timerS,
            distance_m: l.distanceM,
            avg_speed: l.avgSpeed,
            max_speed: l.maxSpeed,
            avg_hr: l.avgHr,
            max_hr: l.maxHr,
            avg_cadence: l.avgCadence,
            total_ascent_m: l.totalAscentM,
            intensity: l.intensity,
            trigger: l.trigger,
            workout_step_index: l.workoutStepIndex,
          })),
        ),
      );
    }

    check(await this.db.from("activity_splits").delete().eq("activity_id", activityId));
    if (d.splits.length) {
      check(
        await this.db.from("activity_splits").insert(
          d.splits.map((sp) => ({
            activity_id: activityId,
            user_id: this.userId,
            split_index: sp.index,
            split_length_m: 1000,
            distance_m: sp.distanceM,
            elapsed_s: sp.elapsedS,
            moving_s: sp.movingS,
            pace_s_per_km: sp.paceSecPerKm,
            avg_hr: sp.avgHr,
            avg_cadence: sp.avgCadence,
            elevation_gain_m: sp.elevationGainM,
            elevation_loss_m: sp.elevationLossM,
            partial: sp.partial,
            method_version: VERSIONS.splits,
          })),
        ),
      );
    }
    return activityId;
  }

  async saveWellness(obs: WellnessObservation[]) {
    if (!obs.length) return 0;
    check(
      await this.db.from("wellness_daily").upsert(
        obs.map((o) => ({
          user_id: this.userId,
          provider: "garmin",
          calendar_date: o.calendarDate,
          metric: o.metric,
          value: o.value,
          unit: o.unit,
          raw: o.raw,
          fetched_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,provider,calendar_date,metric" },
      ),
    );
    return obs.length;
  }
}
