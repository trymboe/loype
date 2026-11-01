import { NotYet } from "@/components/not-yet";

export const metadata = { title: "Plan" };

export default function PlanPage() {
  return (
    <NotYet
      title="Plan"
      what="The training calendar, goal and race setup, structured workouts and adaptive plan changes live here."
      needs={["Your imported run history (working now)", "Fitness baseline and training zones", "Your goal, race date and available days"]}
    />
  );
}
