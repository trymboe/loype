import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/server";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const supabase = await createUserClient();
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user?.email?.toLowerCase() === env.allowedEmail()) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login?error=1", request.url));
}
