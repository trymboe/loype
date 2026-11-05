import { describe, expect, it } from "vitest";
import { isAllowedEmail, parseAllowedEmails } from "@/lib/auth/allowlist";
import { userBudgetMs } from "@/lib/ingest/budget";

describe("sign-in allowlist", () => {
  it("accepts one address, as before", () => {
    expect(isAllowedEmail("Me@Example.no", "me@example.no")).toBe(true);
    expect(isAllowedEmail("other@example.no", "me@example.no")).toBe(false);
  });
  it("accepts several addresses separated by commas, semicolons or spaces", () => {
    const raw = " me@example.no, Friend@Other.com ;third@x.io\nfourth@y.no ";
    expect([...parseAllowedEmails(raw)]).toEqual(["me@example.no", "friend@other.com", "third@x.io", "fourth@y.no"]);
    expect(isAllowedEmail("friend@other.com", raw)).toBe(true);
    expect(isAllowedEmail("fourth@y.no", raw)).toBe(true);
  });
  it("denies everyone when unset or empty, and never matches an empty email", () => {
    expect(isAllowedEmail("me@example.no", undefined)).toBe(false);
    expect(isAllowedEmail("me@example.no", "")).toBe(false);
    expect(isAllowedEmail("", "me@example.no,")).toBe(false);
    expect(isAllowedEmail(null, "me@example.no")).toBe(false);
  });
});

describe("scheduled sync budget", () => {
  it("splits the time left over the users still to go", () => {
    expect(userBudgetMs(0, 0, 1)).toBe(45_000);
    expect(userBudgetMs(0, 0, 3)).toBe(15_000);
    expect(userBudgetMs(0, 30_000, 1)).toBe(15_000);
    expect(userBudgetMs(0, 60_000, 2)).toBe(0);
  });
});
