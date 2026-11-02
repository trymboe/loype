import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="card rise mt-8 p-6">
      <p className="font-semibold">Not found</p>
      <p className="mt-1 text-sm text-muted">This page or activity doesn&apos;t exist. It may have been removed during a re-import.</p>
      <div className="mt-4">
        <ButtonLink href="/activities">Back to activities</ButtonLink>
      </div>
    </div>
  );
}
