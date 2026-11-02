"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { deleteUserData, type DeleteScope } from "@/lib/privacy/delete";

export interface DeleteState {
  ok?: boolean;
  error?: string;
  summary?: string;
}

const CONFIRM = "delete";

export async function deleteDataAction(_prev: DeleteState, form: FormData): Promise<DeleteState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in" };
  const scope = form.get("scope") === "everything" ? "everything" : ("training" as DeleteScope);
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== CONFIRM) return { error: `Type "${CONFIRM}" to confirm` };
  try {
    const r = await deleteUserData(createAdminClient(), user.id, scope);
    revalidatePath("/", "layout");
    const activities = r.rows.activities ?? 0;
    const summary = `Deleted ${activities} ${activities === 1 ? "activity" : "activities"} and ${r.files} original ${r.files === 1 ? "file" : "files"}.`;
    if (r.fileError) return { ok: true, summary: `${summary} Some files could not be removed yet; run this again to finish. (${r.fileError})` };
    return { ok: true, summary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
