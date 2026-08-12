/**
 * `/edit/reports/4` — "Grants". Placeholder stub for this PR; the real report
 * is a separate follow-up. Same session/authz/center-resolution flow as
 * `/edit/reports` (see that page's doc comment) — kept tiny since there is no
 * data logic here yet.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadReportsContext, resolveReportsCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grants — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function EditReportsGrantsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/4");
  }

  const { center } = (await searchParams) ?? {};
  const code = await resolveReportsCenterCode(db.read, center);
  const ctx = await loadReportsContext(code, session, db.read);
  if (ctx === null) {
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab={0}
    >
      <Link
        href={`/edit/reports?center=${encodeURIComponent(code)}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      <h1 className="mb-4 text-xl font-semibold">4. Grants</h1>
      <p className="text-muted-foreground text-sm">Coming soon.</p>
    </ConsoleShell>
  );
}
