import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/server";

export async function POST(request: NextRequest) {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
