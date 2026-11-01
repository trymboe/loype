import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/server";
import { env } from "@/lib/env";

/**
 * Email-link sign-in via token_hash (see docs/SETUP.md for the email template).
 * Unlike the PKCE `?code=` flow, this works when the link is opened in a
 * different browser or device than the one that requested it.
 */
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = (request.nextUrl.searchParams.get("type") ?? "email") as EmailOtpType;
  const supabase = await createUserClient();
  if (tokenHash) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error && data.user?.email?.toLowerCase() === env.allowedEmail()) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login?error=1", request.url));
}
