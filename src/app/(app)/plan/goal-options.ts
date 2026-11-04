/** Shared by the plan form (client) and the goal page (server). */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const GOALS: { kind: string; label: string; hint: string }[] = [
  { kind: "5k", label: "5 km", hint: "Get faster over 5 km" },
  { kind: "10k", label: "10 km", hint: "Get faster over 10 km" },
  { kind: "half", label: "Half marathon", hint: "21.1 km" },
  { kind: "marathon", label: "Marathon", hint: "42.2 km" },
  { kind: "race", label: "Other race", hint: "Any distance and date" },
  { kind: "general", label: "General fitness", hint: "Fitter all round" },
  { kind: "endurance", label: "Endurance", hint: "Run longer, comfortably" },
  { kind: "consistency", label: "Consistency", hint: "Run regularly, mostly easy" },
  { kind: "volume", label: "More volume", hint: "Build weekly km safely" },
  { kind: "maintain", label: "Maintain", hint: "Keep what you have" },
];
