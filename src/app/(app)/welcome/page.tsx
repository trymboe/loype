import Link from "@/components/link";
import { Check, CircleAlert, Sparkles, TrendingUp } from "lucide-react";
import clsx from "clsx";
import { BaselineCard, defaultsFor } from "@/components/plan/plan-start";
import { ButtonLink, Card, CardHeader, PageHeader } from "@/components/ui";
import { daysBetween, todayIn } from "@/lib/dates";
import { createAdminClient, getSessionUser } from "@/lib/db/server";
import { loadOnboardingFacts, loadPreferences } from "@/lib/onboarding/facts";
import { STEP_LABEL, STEP_SHORT, STEPS, canOpen, nextStep, readBackground, type StepKey } from "@/lib/onboarding/state";
import { summarizeBaseline, type Point } from "@/lib/onboarding/summary";
import { loadBaseline } from "@/lib/planning/service";
import { userTimezone } from "@/lib/user-tz";
import { GarminKeyForm } from "../more/integrations/garmin-key-form";
import { PlanForm } from "../plan/plan-form";
import { AboutForm } from "./about-form";
import { dismissSetupAction, markBaselineSeenAction } from "./actions";
import { ImportStep } from "./import-step";
import { SubmitButton } from "@/components/feedback/submit-button";

export const metadata = { title: "Set up Løype" };
export const dynamic = "force-dynamic";

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const user = await getSessionUser();
  if (!user) return null;
  const db = createAdminClient();
  const tz = await userTimezone();
  const today = todayIn(tz);
  const facts = await loadOnboardingFacts(db, user.id);
  const next = nextStep(facts);
  const asked = (await searchParams).step as StepKey | undefined;
  const step: StepKey | "done" = asked && STEPS.includes(asked) && canOpen(asked, facts) ? asked : next;

  return (
    <>
      <PageHeader eyebrow="Setup" title={step === "done" ? "You're all set" : STEP_LABEL[step]} />
      <Stepper current={step} facts={facts} />
      <div className="stagger mt-5 space-y-3">{await body(step, { db, userId: user.id, today, runCount: facts.runCount })}</div>
      {step !== "done" && (
        <form action={dismissSetupAction} className="mt-8 text-center">
          <SubmitButton className="inline-flex items-center gap-1.5 text-sm font-medium text-muted underline-offset-2 hover:underline">Skip setup for now</SubmitButton>
        </form>
      )}
    </>
  );
}

function Stepper({ current, facts }: { current: StepKey | "done"; facts: Parameters<typeof canOpen>[1] }) {
  const next = nextStep(facts);
  const doneIdx = next === "done" ? STEPS.length : STEPS.indexOf(next);
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const done = i < doneIdx;
        const here = s === current;
        const inner = (
          <>
            <span className={clsx("block h-1.5 rounded-full", done ? "bg-accent" : here ? "bg-accent/50" : "bg-surface-2")} />
            <span className={clsx("mt-1.5 block truncate text-[0.6875rem] font-medium", here ? "text-fg" : "text-muted")}>{STEP_SHORT[s]}</span>
          </>
        );
        return (
          <li key={s} aria-current={here ? "step" : undefined}>
            {canOpen(s, facts) ? <Link href={`/welcome?step=${s}`}>{inner}</Link> : inner}
          </li>
        );
      })}
    </ol>
  );
}

type Ctx = { db: ReturnType<typeof createAdminClient>; userId: string; today: string; runCount: number };

async function body(step: StepKey | "done", c: Ctx) {
  switch (step) {
    case "connect":
      return (
        <>
          <Card>
            <CardHeader title="Garmin watch" className="mb-3" />
            <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted marker:font-semibold marker:text-fg-2">
            <li>
              Open{" "}
              <a className="font-medium text-accent underline underline-offset-2" href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noreferrer">
                Garmin Connect → Personal API key
              </a>
              .
            </li>
            <li>Create a key (choose the longest expiry), accept the terms and copy it. It is only shown once.</li>
            <li>Paste it below.</li>
          </ol>
            <GarminKeyForm replacing={false} />
          </Card>
          <Card>
            <CardHeader title="Apple Watch or another watch" className="mb-2" />
            <div>
              <ButtonLink href="/more/integrations#strava" variant="secondary">
                Connect Strava
              </ButtonLink>
            </div>
          </Card>
          <p className="px-1 text-center">
            <Link href="/guide" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
              How Løype works
            </Link>
          </p>
        </>
      );
    case "import": {
      const { data: jobs } = await c.db
        .from("sync_jobs")
        .select("id, kind, status, range_start, discovered, processed, failed, unavailable, skipped, last_error, created_at, finished_at")
        .eq("user_id", c.userId)
        .order("created_at", { ascending: false })
        .limit(5);
      return <ImportStep initialJobs={jobs ?? []} />;
    }
    case "baseline":
      return <BaselineStep c={c} />;
    case "about": {
      const [{ data: profile }, { data: state }, prefs] = await Promise.all([
        c.db.from("athlete_profile").select("max_hr, max_hr_source, resting_hr, resting_hr_source, birth_year, sex").eq("user_id", c.userId).maybeSingle(),
        c.db.from("fitness_state").select("output").eq("user_id", c.userId).maybeSingle(),
        loadPreferences(c.db, c.userId),
      ]);
      const phys = state?.output?.physiology;
      return (
        <Card>
          <AboutForm
            initial={{
              max_hr: profile?.max_hr_source === "manual" ? profile.max_hr : null,
              resting_hr: profile?.resting_hr_source === "manual" ? profile.resting_hr : null,
              birth_year: profile?.birth_year ?? null,
              sex: profile?.sex ?? null,
            }}
            background={readBackground(prefs)}
            detected={{
              maxHr: phys?.maxHr && phys.maxHr.source !== "manual" ? `${phys.maxHr.value}` : null,
              restHr: phys?.restHr && phys.restHr.source !== "manual" ? `${phys.restHr.value}` : null,
            }}
          />
        </Card>
      );
    }
    case "goal": {
      const baseline = await loadBaseline(c.db, c.userId, c.today);
      const defaults = await defaultsFor(c.userId, c.today, baseline);
      return (
        <>
          <BaselineCard b={baseline} />
          <Card>
            <PlanForm defaults={defaults} />
          </Card>
        </>
      );
    }
    case "done":
      return (
        <Card>
          <div className="grid grid-cols-2 gap-2">
            <ButtonLink href="/">Go to Today</ButtonLink>
            <ButtonLink href="/more/calendar" variant="secondary">
              Add to calendar
            </ButtonLink>
          </div>
        </Card>
      );
  }
}

async function BaselineStep({ c }: { c: Ctx }) {
  const [baseline, { data: state }, { data: first }] = await Promise.all([
    loadBaseline(c.db, c.userId, c.today),
    c.db.from("fitness_state").select("output").eq("user_id", c.userId).maybeSingle(),
    c.db.from("activities").select("local_date").eq("user_id", c.userId).eq("sport", "running").is("duplicate_of", null).order("local_date").limit(1).maybeSingle(),
  ]);
  const o = state?.output;
  const summary = summarizeBaseline({
    baseline,
    efficiencyChangePer30dPct: o?.efficiency?.changePer30dPct ?? null,
    historyDays: first?.local_date ? daysBetween(first.local_date, c.today) : 0,
    runCount: c.runCount,
    maxHrSource: o?.physiology?.maxHr?.source ?? null,
  });
  return (
    <>
      <BaselineCard b={baseline} />
      {!o && <p className="px-1 text-xs text-muted">Fitness still calculating</p>}
      <PointList title="Strengths" icon={<Sparkles size={16} />} tone="text-good" points={summary.strengths} empty="Nothing yet" />
      <PointList title="Worth developing" icon={<TrendingUp size={16} />} tone="text-accent" points={summary.develop} empty="Nothing yet" />
      {summary.caveats.length > 0 && <PointList title="About the data" icon={<CircleAlert size={16} />} tone="text-warn" points={summary.caveats} />}
      <form action={markBaselineSeenAction}>
        <SubmitButton className="btn btn-primary btn-block min-h-12">
          <Check size={16} />
          Looks right, continue
        </SubmitButton>
      </form>
    </>
  );
}

function PointList({ title, icon, tone, points, empty }: { title: string; icon: React.ReactNode; tone: string; points: Point[]; empty?: string }) {
  return (
    <Card>
      <CardHeader title={<span className={clsx("inline-flex items-center gap-1.5", tone)}>{icon}<span className="text-fg">{title}</span></span>} />
      {points.length ? (
        <ul className="mt-3 space-y-3">
          {points.map((p) => (
            <li key={p.title}>
              <p className="text-[0.9375rem] font-semibold">{p.title}</p>
              <p className="mt-0.5 text-sm leading-snug text-muted">{p.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      )}
    </Card>
  );
}
