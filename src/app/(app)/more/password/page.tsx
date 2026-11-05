import { PageHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/db/server";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Change password" };
export const dynamic = "force-dynamic";

export default async function PasswordPage() {
  const user = await getSessionUser();
  return (
    <>
      <PageHeader back={{ href: "/more", label: "More" }} title="Change password" />
      <div className="card p-5">
        <PasswordForm email={user?.email ?? ""} />
      </div>
    </>
  );
}
