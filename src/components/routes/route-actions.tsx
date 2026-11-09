"use client";

import { useOptimistic, useState, useTransition } from "react";
import Link from "@/components/link";
import { Download, Pencil, Star, Trash2 } from "lucide-react";
import { OpenInGoogleMaps } from "./google-maps";
import type { LngLat } from "@/lib/routes/geometry";
import { deleteRouteAction, renameRouteAction, toggleFavoriteAction } from "@/app/(app)/routes/actions";

export function RouteActions({ id, name, favorite, editable, coords }: { id: string; name: string; favorite: boolean; editable: boolean; coords: LngLat[] }) {
  const [favPending, startFav] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [saving, startSave] = useTransition();
  const pending = favPending || deleting || saving;
  // the star flips the moment it's tapped; the server catches up behind it
  const [fav, setFav] = useOptimistic(favorite);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <section className="card p-4">
      <div className="flex flex-wrap gap-2">
        <a href={`/api/routes/${id}/gpx`} className="btn btn-primary btn-sm" download>
          <Download size={16} /> Export GPX
        </a>
        <OpenInGoogleMaps coords={coords} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() =>
            startFav(async () => {
              setFav(!fav);
              await toggleFavoriteAction(id, !fav);
            })
          }
          aria-pressed={fav}
        >
          <Star size={16} className={fav ? "fill-[var(--warn)] text-warn" : undefined} /> {fav ? "Favourite" : "Add to favourites"}
        </button>
        {editable && (
          <Link href={`/routes/${id}/edit`} className="btn btn-secondary btn-sm">
            <Pencil size={16} /> Edit on map
          </Link>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenaming((r) => !r)}>
          Rename
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm text-danger"
          disabled={pending}
          aria-busy={deleting}
          onClick={() => (confirmDelete ? startDelete(() => deleteRouteAction(id)) : setConfirmDelete(true))}
        >
          {!deleting && <Trash2 size={16} />} {deleting ? "Deleting…" : confirmDelete ? "Tap again to delete" : "Delete"}
        </button>
      </div>
      {renaming && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            startSave(async () => {
              const res = await renameRouteAction(id, value);
              if (res.error) setError(res.error);
              else {
                setError(null);
                setRenaming(false);
              }
            });
          }}
        >
          <input className="input" value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} aria-label="Route name" autoFocus />
          <button className="btn btn-primary btn-sm" disabled={pending} aria-busy={saving}>
            Save
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
