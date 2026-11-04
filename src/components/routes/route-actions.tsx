"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Download, Pencil, Star, Trash2 } from "lucide-react";
import { OpenInGoogleMaps } from "./google-maps";
import type { LngLat } from "@/lib/routes/geometry";
import { deleteRouteAction, renameRouteAction, toggleFavoriteAction } from "@/app/(app)/routes/actions";

export function RouteActions({ id, name, favorite, editable, coords }: { id: string; name: string; favorite: boolean; editable: boolean; coords: LngLat[] }) {
  const [pending, start] = useTransition();
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
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => start(() => toggleFavoriteAction(id, !favorite))} aria-pressed={favorite}>
          <Star size={16} className={favorite ? "fill-[var(--warn)] text-warn" : undefined} /> {favorite ? "Favourite" : "Add to favourites"}
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
          onClick={() => (confirmDelete ? start(() => deleteRouteAction(id)) : setConfirmDelete(true))}
        >
          <Trash2 size={16} /> {confirmDelete ? "Tap again to delete" : "Delete"}
        </button>
      </div>
      {renaming && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
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
          <button className="btn btn-primary btn-sm" disabled={pending}>
            Save
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
