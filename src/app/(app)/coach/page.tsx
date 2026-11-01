import { NotYet } from "@/components/not-yet";

export const metadata = { title: "Coach" };

export default function CoachPage() {
  return (
    <NotYet
      title="Coach"
      what="A conversational coach that answers questions using your actual training data and proposes plan changes you can accept or reject."
      needs={["Fitness estimates and predictions", "Your training plan", "An LLM API key (server-side)"]}
    />
  );
}
