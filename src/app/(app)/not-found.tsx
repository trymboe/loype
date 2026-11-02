import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="card rise mt-8 p-6">
      <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">Not found</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">This page or activity doesn&apos;t exist. It may have been removed during a re-import.</p>
      <div className="mt-5">
        <ButtonLink href="/activities">Back to activities</ButtonLink>
      </div>
    </div>
  );
}
