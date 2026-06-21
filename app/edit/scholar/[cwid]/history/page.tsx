/**
 * `/edit/scholar/[cwid]/history` — the read-only scholar profile audit view
 * (#955 finding #11). A sub-route of the scholar editor (`/edit/scholar/[cwid]`)
 * and the sibling of `/edit/center/[code]/history`, surfacing the per-scholar
 * slice of the B03 audit log to anyone who may edit that scholar.
 *
 * Server Component. Authorization MIRRORS the editor route exactly — history
 * visibility == edit access — because both call the SAME resolver,
 * `resolveScholarEditAccess` (self → proxy → unit-admin → comms_steward /
 * superuser → else a logged 403). So a viewer who can reach `/edit/scholar/[cwid]`
 * can reach its history and no one else can. After the gate clears, the existence
 * + #536 hidden-class guards (scholar absent / soft-deleted / non-public class →
 * 404) run here as in the editor, then the page reads the audit history
 * (`loadScholarAuditHistory`, scoped to this cwid). The audit table is
 * append-only; this surface never mutates it.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ScholarHistoryView } from "@/components/edit/scholar-history-view";
import { loadScholarAuditHistory, SCHOLAR_AUDIT_WINDOW_DAYS } from "@/lib/api/scholar-audit";
import { db } from "@/lib/db";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { resolveScholarEditAccess } from "@/lib/edit/scholar-edit-access";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profile change history",
  robots: { index: false, follow: false },
};

export default async function EditScholarHistoryPage({
  params,
}: {
  params: Promise<{ cwid: string }>;
}) {
  const { cwid: targetCwid } = await params;

  // Authorization — the shared five-gate scholar-editor rule, identical to the
  // editor route (history visibility == edit access). `pathSuffix="/history"`
  // makes the login `?return=` and the `edit_authz_denied` log path match this
  // sub-route exactly. History reads only the verdict (the editor additionally
  // resolves the unit banner from `access.unit`).
  const access = await resolveScholarEditAccess(targetCwid, "/history");
  if (access.kind === "redirect") {
    redirect(access.to);
  }
  if (access.kind === "forbidden") {
    return <ForbiddenEditPage targetCwid={targetCwid} />;
  }
  const { session } = access;

  // Scholar existence + the #536 hidden-class guard, mirroring the editor: an
  // absent or soft-deleted scholar 404s for everyone; a hidden identity class
  // (doctoral student) 404s for any non-superuser, including the scholar
  // themselves.
  const scholar = await db.read.scholar.findUnique({
    where: { cwid: targetCwid },
    select: { preferredName: true, roleCategory: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt !== null) {
    notFound();
  }
  if (!session.isSuperuser && !isPubliclyDisplayed(scholar.roleCategory)) {
    notFound();
  }

  // The audit log lives in the separate `scholars_audit` database; the read role
  // (`db.read` / `app_ro`) needs a SELECT grant on `manual_edit_audit` there.
  // Until that grant is provisioned (a DBA step — `app_ro` is managed out-of-band,
  // not by the bootstrap seeder), the SELECT is denied (MySQL errno 1142). Fail
  // SOFT: render an honest "unavailable" notice instead of 500ing the whole page.
  let entries: Awaited<ReturnType<typeof loadScholarAuditHistory>> = [];
  let unavailable = false;
  try {
    entries = await loadScholarAuditHistory(targetCwid, db.read);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "scholar_history_read_failed",
        path: "/edit/scholar/[cwid]/history",
        cwid: targetCwid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <ScholarHistoryView
      cwid={targetCwid}
      scholarName={scholar.preferredName}
      entries={entries}
      windowDays={SCHOLAR_AUDIT_WINDOW_DAYS}
      unavailable={unavailable}
    />
  );
}
