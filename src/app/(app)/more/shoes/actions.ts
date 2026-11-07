"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { setDefaultShoe } from "@/lib/shoes/service";

async function user() {
  const u = await getSessionUser();
  if (!u) throw new Error("Not signed in");
  return u;
}

const text = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : null), z.string().max(max).nullable());
const km = (min: number) => z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().min(min).max(10_000).nullable());

const ShoeForm = z.object({
  name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(80)),
  brand: text(60),
  model: text(60),
  starting_km: km(0),
  retire_km: km(1),
});

function parse(form: FormData) {
  const p = ShoeForm.parse(Object.fromEntries(["name", "brand", "model", "starting_km", "retire_km"].map((k) => [k, form.get(k)])));
  return {
    name: p.name,
    brand: p.brand,
    model: p.model,
    starting_distance_m: Math.round((p.starting_km ?? 0) * 1000),
    retire_at_distance_m: p.retire_km == null ? null : Math.round(p.retire_km * 1000),
  };
}

function done() {
  revalidatePath("/more/shoes");
  revalidatePath("/");
}

/** New shoe. Existing runs stay unassigned even when it becomes the default. */
export async function addShoeAction(form: FormData) {
  const u = await user();
  const db = createAdminClient();
  const makeDefault = form.get("is_default") === "on";
  const { data, error } = await db.from("shoes").insert({ user_id: u.id, ...parse(form) }).select("id").single();
  if (error || !data) throw new Error("Could not save the shoe");
  if (makeDefault) await setDefaultShoe(db, u.id, data.id);
  done();
}

export async function updateShoeAction(form: FormData) {
  const u = await user();
  const id = z.string().uuid().parse(form.get("shoeId"));
  const { error } = await createAdminClient().from("shoes").update(parse(form)).eq("id", id).eq("user_id", u.id);
  if (error) throw new Error("Could not save the shoe");
  done();
}

export async function setDefaultShoeAction(form: FormData) {
  const u = await user();
  const raw = String(form.get("shoeId") ?? "");
  await setDefaultShoe(createAdminClient(), u.id, raw ? z.string().uuid().parse(raw) : null);
  done();
}

/** Retire (or bring back) a shoe; a retired shoe is never the default. */
export async function setRetiredAction(form: FormData) {
  const u = await user();
  const id = z.string().uuid().parse(form.get("shoeId"));
  const retire = form.get("retire") === "1";
  const patch = retire ? { retired_at: new Date().toISOString(), is_default: false } : { retired_at: null };
  const { error } = await createAdminClient().from("shoes").update(patch).eq("id", id).eq("user_id", u.id);
  if (error) throw new Error("Could not save the shoe");
  done();
}

/** Shoe for one run; "" clears it. Reprocessing never changes it afterwards. */
export async function setActivityShoeAction(form: FormData) {
  const u = await user();
  const activityId = z.string().uuid().parse(form.get("activityId"));
  const raw = String(form.get("shoeId") ?? "");
  const shoeId = raw ? z.string().uuid().parse(raw) : null;
  const db = createAdminClient();
  if (shoeId) {
    const { data: own } = await db.from("shoes").select("id").eq("id", shoeId).eq("user_id", u.id).maybeSingle();
    if (!own) throw new Error("Shoe not found");
  }
  const { error } = await db.from("activities").update({ shoe_id: shoeId }).eq("id", activityId).eq("user_id", u.id);
  if (error) throw new Error("Could not save the shoe");
  revalidatePath(`/activities/${activityId}`);
  done();
}
