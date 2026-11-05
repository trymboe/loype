/**
 * Who may sign in. ALLOWED_EMAIL holds one address or several separated by
 * commas, semicolons or whitespace, e.g. "me@x.no, friend@y.no". Each person
 * gets their own account and sees only their own data (RLS + user-scoped
 * server code). Pure module: also used by the edge middleware.
 */
export function parseAllowedEmails(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

export function isAllowedEmail(email: string | undefined | null, raw: string | undefined | null = process.env.ALLOWED_EMAIL): boolean {
  if (!email) return false;
  return parseAllowedEmails(raw).has(email.trim().toLowerCase());
}
