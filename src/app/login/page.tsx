import { isConfigured } from "@/lib/env";
import { LogoMark } from "@/components/logo";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 opacity-60"
        style={{ background: "radial-gradient(60% 60% at 50% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent)" }}
      />
      <LogoMark size={56} />
      <h1 className="mt-6 text-[2.75rem] leading-none font-bold tracking-[-0.045em]">Løype</h1>
      <p className="mt-2 mb-10 text-[1.0625rem] text-muted">Every run becomes useful data.</p>
      {!isConfigured() ? (
        <div className="card p-5 text-sm">
          <p className="font-semibold">Not configured yet</p>
          <p className="mt-1 text-muted">Set the Supabase environment variables described in docs/SETUP.md, then redeploy.</p>
        </div>
      ) : (
        <>
          {error && <p className="mb-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">That sign-in link was invalid, already used or expired. Request a new email, or use the code from it.</p>}
          <LoginForm />
        </>
      )}
    </main>
  );
}
