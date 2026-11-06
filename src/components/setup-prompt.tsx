import Link from "next/link";
import { ChevronRight, Compass } from "lucide-react";
import { IconTile } from "@/components/ui";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { loadOnboardingFacts } from "@/lib/onboarding/facts";
import { STEP_LABEL, needsSetup, nextStep } from "@/lib/onboarding/state";

/** "Finish setting up" row on Today while guided setup has steps left (until skipped). */
export async function SetupPrompt() {
  const user = await getSessionUser();
  if (!user) return null;
  const facts = await loadOnboardingFacts(createAdminClient(), user.id).catch(() => null);
  if (!facts || !needsSetup(facts)) return null;
  const next = nextStep(facts);
  if (next === "done") return null;
  return (
    <Link href="/welcome" className="card flex items-center gap-3.5 p-4 transition-colors hover:bg-surface-2/50">
      <IconTile color="var(--accent)">
        <Compass size={18} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Finish setup</p>
        <p className="mt-0.5 text-[0.9375rem] font-semibold">{STEP_LABEL[next]}</p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-subtle" />
    </Link>
  );
}
