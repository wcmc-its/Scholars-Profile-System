/**
 * `/edit/scholars` — the Profiles roster (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster). The admin entry point to
 * *find* a profile before editing it.
 *
 * Superuser-gated at B2 (org-unit-admin scope is the separate B3 workstream —
 * when it lands, this handler resolves `managedUnits` and passes
 * `unitCodeScope` to `loadEditRoster`, and the gate allows an in-scope admin).
 * Authorization is re-checked here on every GET, never cached; the query — not
 * the UI — is the scope boundary. `force-dynamic` + `noindex`, mirroring the
 * other `/edit/*` pages.
 */
import { redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ProfilesRoster } from "@/components/edit/profiles-roster";
import {
  loadEditRoster,
  loadRosterFacets,
  type EditRosterStatusFilter,
  type EditRosterUnitFilter,
} from "@/lib/api/edit-roster";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession, impersonationEnabled } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profiles — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 50;

function parseStatus(v: string | undefined): EditRosterStatusFilter {
  return v === "visible" || v === "hidden" ? v : "all";
}

/** Decode the org-unit select value (`dept:CODE` | `div:CODE` | `center:CODE`)
 *  into a roster unit filter. Unknown/empty ⇒ no filter. */
function parseUnit(v: string | undefined): EditRosterUnitFilter | undefined {
  if (!v) return undefined;
  const sep = v.indexOf(":");
  if (sep < 0) return undefined;
  const kind = v.slice(0, sep);
  const code = v.slice(sep + 1);
  if (!code) return undefined;
  if (kind === "dept") return { kind: "department", code };
  if (kind === "div") return { kind: "division", code };
  if (kind === "center") return { kind: "center", code };
  return undefined;
}

export default async function EditScholarsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    q?: string;
    status?: string;
    page?: string;
    unit?: string;
    type?: string;
  }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/scholars");
  }
  // Roster access on every GET: a comms_steward is a global profile editor
  // (comms-steward-profile-editing-spec.md §4b), so they browse + open any
  // profile. A non-steward goes through the superuser re-check, which also emits
  // the `edit_authz_denied` line for a non-superuser (mirrors /edit/scholar/[cwid]).
  if (!session.isCommsSteward) {
    const denial = requireSuperuserGet({ session, path: "/edit/scholars", targetId: "roster" });
    if (denial !== null) {
      return <ForbiddenEditPage />;
    }
  }
  // The superuser-only admin surfaces (URL requests / Slug registry /
  // Administrators) stay gated to a superuser; a steward sees only Profiles +
  // Method Families.
  const superuserSurfaces = session.isSuperuser;

  const { q, status, page, unit: unitParam, type } = (await searchParams) ?? {};
  const query = (q ?? "").trim();
  const statusFilter = parseStatus(status);
  const unit = parseUnit(unitParam);
  const roleCategory = (type ?? "").trim() || undefined;
  const pageNum = Math.max(Number.parseInt(page ?? "0", 10) || 0, 0);

  const [{ entries, total }, facets] = await Promise.all([
    loadEditRoster(
      {
        query,
        status: statusFilter,
        roleCategory,
        unit,
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
      },
      db.read,
    ),
    loadRosterFacets(db.read),
  ]);

  // The "URL requests" admin tab + pending-count pill (#497 PR-3c); `null` when
  // the slug-request feature is off, which hides the tab.
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;


  return (
    <ProfilesRoster
      entries={entries}
      total={total}
      query={query}
      status={statusFilter}
      unit={unitParam ?? ""}
      roleCategory={roleCategory ?? ""}
      facets={facets}
      page={pageNum}
      pageSize={PAGE_SIZE}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      administratorsTab={superuserSurfaces && isAdministratorsTabEnabled() ? 0 : null}
      methodsTab={isMethodsTabVisible(session) ? 0 : null}
      dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      canImpersonate={impersonationEnabled() && session.isSuperuser}
      viewerCwid={session.cwid}
      superuserSurfaces={superuserSurfaces}
      profilesTab
      unitsTab={session.isSuperuser || session.isCommsSteward}
    />
  );
}
