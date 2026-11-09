import { setActivityShoeAction } from "@/app/(app)/more/shoes/actions";
import { createUserClient, getSessionUser } from "@/lib/db/server";
import { listShoes } from "@/lib/shoes/service";
import type { ShoeRow } from "@/lib/shoes/mileage";
import { SubmitButton } from "@/components/feedback/submit-button";

/** Shoe picker for one run on the activity page. Hidden until the athlete has a shoe. */
export async function ShoeSelect({ activityId, shoeId }: { activityId: string; shoeId: string | null }) {
  let shoes: ShoeRow[];
  try {
    const user = await getSessionUser();
    if (!user) return null;
    shoes = (await listShoes(await createUserClient(), user.id)).filter((s) => !s.retired_at || s.id === shoeId);
  } catch {
    return null;
  }
  if (!shoes.length) return null;
  return (
    <section className="card mb-3 p-4">
      <form action={setActivityShoeAction} className="flex items-center gap-2">
        <input type="hidden" name="activityId" value={activityId} />
        <label htmlFor="shoe" className="section-title shrink-0 pr-1">
          Shoe
        </label>
        <select id="shoe" name="shoeId" defaultValue={shoeId ?? ""} className="input input-sm min-w-0 flex-1">
          <option value="">None</option>
          {shoes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <SubmitButton className="btn btn-secondary btn-sm">Save</SubmitButton>
      </form>
    </section>
  );
}
