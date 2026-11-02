"use server";

import { z } from "zod";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { loadProposals } from "@/lib/coach/service";
import type { ProposalRow } from "@/components/plan/proposal-card";

/** Proposal cards for plan changes the coach just suggested. */
export async function coachProposalsAction(ids: string[]): Promise<ProposalRow[]> {
  const user = await getSessionUser();
  if (!user) return [];
  const parsed = z.array(z.string().uuid()).max(20).safeParse(ids);
  if (!parsed.success) return [];
  return loadProposals(createAdminClient(), user.id, parsed.data);
}
