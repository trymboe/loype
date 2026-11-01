import { isConfigured } from "@/lib/env";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="font-display text-6xl font-bold tracking-tight">Løype</h1>
      <p className="mb-10 mt-1 text-muted">Every run becomes useful data.</p>
      {!isConfigured() ? (
        <div className="card p-5 text-sm">
          <p className="font-semibold">Not configured yet</p>
          <p className="mt-1 text-muted">Set the Supabase environment variables described in docs/SETUP.md, then redeploy.</p>
        </div>
      ) : (
        <>
          {error && <p className="mb-4 text-sm text-hr">That sign-in link was invalid or expired. Request a new one.</p>}
          <LoginForm />
        </>
      )}
    </main>
  );
}
