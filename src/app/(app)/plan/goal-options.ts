/** Shared by the plan form (client) and the goal page (server). */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const GOALS: { kind: string; label: string }[] = [
  { kind: "5k", label: "5 km" },
  { kind: "10k", label: "10 km" },
  { kind: "half", label: "Half marathon" },
  { kind: "marathon", label: "Marathon" },
  { kind: "race", label: "Other race" },
  { kind: "general", label: "General fitness" },
  { kind: "endurance", label: "Run longer" },
  { kind: "consistency", label: "Run regularly" },
  { kind: "volume", label: "Build weekly km" },
  { kind: "maintain", label: "Maintain fitness" },
];
