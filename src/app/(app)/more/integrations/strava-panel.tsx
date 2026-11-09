"use client";

import { useActionState } from "react";
import { connectStravaAction, disconnectStravaAction, reconnectStravaAction, type StravaState } from "./strava-actions";
import { SubmitButton } from "@/components/feedback/submit-button";

export function StravaAppForm({ replacing }: { replacing: boolean }) {
  const [state, action, pending] = useActionState<StravaState, FormData>(connectStravaAction, {});
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">Client ID</span>
        <input name="clientId" inputMode="numeric" autoComplete="off" required className="input font-mono" placeholder="123456" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">Client Secret</span>
        <input name="clientSecret" type="password" autoComplete="off" required className="input font-mono" />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      <SubmitButton disabled={pending} className="btn btn-primary btn-block">
        {pending ? "Opening Strava…" : replacing ? "Save and reconnect" : "Connect Strava"}
      </SubmitButton>
    </form>
  );
}

export function StravaControls({ canReconnect }: { canReconnect: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {canReconnect && (
        <form action={reconnectStravaAction}>
          <SubmitButton className="btn btn-secondary btn-sm">Reconnect</SubmitButton>
        </form>
      )}
      <form action={disconnectStravaAction}>
        <SubmitButton className="btn btn-secondary btn-sm">Disconnect</SubmitButton>
      </form>
    </div>
  );
}
