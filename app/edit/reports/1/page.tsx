/**
 * `/edit/reports/1` — "Optimize membership" (formerly the `?attr=reports` tab
 * inside `/edit/center/[code]`; Cancer Center collaboration-recommendations
 * v2, `2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-
 * relevance-plan.md`). Hosts `CancerCenterCollabReportCard` UNCHANGED — this
 * PR only moved how it's reached, from an in-page unit-editor tab to a
 * top-level console route. See `app/edit/reports/page.tsx` for the shared
 * session/authz/center-resolution flow this mirrors (duplicated per page
 * rather than a shared server component, matching every other `/edit/*`
 * console page's convention).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { CancerCenterCollabReportCard } from "@/components/edit/cancer-center-collab-report-card";
import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadReportsContext, resolveReportsCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Optimize membership — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function EditReportsOptimizeMembershipPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/1");
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
    >
      <Link
        href={`/edit/reports?center=${encodeURIComponent(code)}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      {/* ConsoleShell owns only the chrome — see app/edit/reports/page.tsx. */}
      <div className="apollo-card">
        <h1 className="mb-4 text-xl font-semibold">1. Optimize membership</h1>
        <CancerCenterCollabReportCard centerCode={code} />
      </div>
    </ConsoleShell>
  );
}
