"use client";

import { useActionState, useState } from "react";
import Link from "@/components/link";
import { deleteDataAction, type DeleteState } from "./actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export function DeleteForm({ scope, label }: { scope: "training" | "everything"; label: string }) {
  const [state, action, pending] = useActionState<DeleteState, FormData>(deleteDataAction, {});
  const [text, setText] = useState("");
  if (state.ok) {
    return (
      <div className="rounded-2xl bg-good/10 p-4 text-sm ring-1 ring-good/25 ring-inset">
        <p>{state.summary}</p>
        <Link href="/welcome" className="mt-2 inline-block font-semibold text-accent">
          Start again →
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="scope" value={scope} />
      <label className="block">
        <span className="mb-1.5 block text-sm">
          Type <span className="font-mono font-semibold">delete</span> to confirm
        </span>
        <input name="confirm" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="off" className="input" />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      <SubmitButton disabled={pending || text.trim().toLowerCase() !== "delete"} className="btn btn-block min-h-12 bg-danger font-semibold text-white disabled:opacity-40">
        {pending ? "Deleting…" : label}
      </SubmitButton>
    </form>
  );
}
