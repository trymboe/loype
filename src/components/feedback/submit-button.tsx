"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Text shown while the form is submitting, e.g. "Saving…". Defaults to the normal label. */
  pendingLabel?: ReactNode;
};

/**
 * Submit button for server-action forms: the moment it's tapped it shows a
 * spinner (via aria-busy, see globals.css) and locks the form's buttons until the action (and any redirect)
 * finishes. When a form has several buttons that share a `name`, only the one
 * that was tapped spins; the others just lock.
 */
export function SubmitButton({ children, pendingLabel, disabled, name, value, ...rest }: Props) {
  const { pending, data } = useFormStatus();
  // a form driving its own transition can pass aria-busy explicitly
  const mine = (pending && isSubmitter(data, name, value)) || rest["aria-busy"] === true;
  return (
    <button {...rest} type="submit" name={name} value={value} disabled={disabled || pending} aria-busy={mine || undefined}>
      {mine && pendingLabel ? pendingLabel : children}
    </button>
  );
}

function isSubmitter(data: FormData | null, name: string | undefined, value: Props["value"]): boolean {
  // Without a name there is nothing to tell buttons apart by: treat as the submitter.
  if (!name || value === undefined || !data) return true;
  return data.getAll(name).map(String).includes(String(value));
}
