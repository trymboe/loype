import { PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/db/server";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Password" };
export const dynamic = "force-dynamic";

export default async function PasswordPage() {
  const user = await getSessionUser();
  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Password" subtitle="Sign in without waiting for an email" />
      <div className="card space-y-4 p-5">
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          Each browser, and an app added to the iPhone home screen, keeps its own sign-in. Email links always open in Safari, not in the installed app, so a
          password is the reliable way to sign in there.
        </p>
        <PasswordForm email={user?.email ?? ""} />
      </div>
    </>
  );
}
