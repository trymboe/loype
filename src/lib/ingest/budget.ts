/** Time left for import (50 s of the 60 s limit, minus outbound headroom), split over the users still to go. */
export function userBudgetMs(started: number, now: number, usersLeft: number, totalMs = 45_000): number {
  const left = Math.max(0, totalMs - (now - started));
  return Math.floor(left / Math.max(1, usersLeft));
}
