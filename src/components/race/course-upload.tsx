"use client";

import { useActionState, useRef } from "react";
import { Upload } from "lucide-react";
import { uploadCourseAction, type CourseFormState } from "@/app/(app)/plan/race/actions";

export function CourseUpload({ replacing }: { replacing?: boolean }) {
  const [state, action, pending] = useActionState<CourseFormState, FormData>(uploadCourseAction, {});
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={action} className="space-y-2">
      <label className={replacing ? "btn btn-secondary btn-sm cursor-pointer" : "btn btn-primary cursor-pointer"} aria-disabled={pending} aria-busy={pending}>
        {!pending && <Upload size={16} />}
        {pending ? "Reading course…" : replacing ? "Replace GPX" : "Upload course GPX"}
        <input
          type="file"
          name="gpx"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          className="sr-only"
          disabled={pending}
          onChange={() => form.current?.requestSubmit()}
        />
      </label>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm text-good">{state.ok}</p>}
    </form>
  );
}
