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

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ProfilesRoster } from "@/components/edit/profiles-roster";
import {
  loadEditRoster,
  loadRosterFacets,
  type EditRosterStatusFilter,
  type EditRosterUnitFilter,
} from "@/lib/api/edit-roster";
import { getEffectiveEditSession, impersonationEnabled } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import {
  isDataQualityDashboardEnabled,
  isEmptyScope,
  loadDataQualityScope,
} from "@/lib/edit/data-quality";
import { isUnitAdminCenterProxyEnabled } from "@/lib/edit/unit-admin-center-proxy";
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
  // Roster access on every GET (B3 — the org-unit-admin tier this page shipped
  // without). Three outcomes:
  //   - superuser / comms_steward → global profile editors, `{ all: true }`,
  //     unchanged: browse and open any profile.
  //   - unit Owner/Curator → a NON-EMPTY unit scope: admitted, and the query
  //     below is filtered to it. This is the same membership rule the per-scholar
  //     editor already enforces (Amendment 4, `resolveEditableUnitViaUnitAdmin`),
  //     so the roster can no longer list a profile they'd be refused on open.
  //   - anyone else (a plain scholar) → empty scope, falls through to the
  //     superuser re-check, which emits the `edit_authz_denied` line and 403s.
  //
  // ponytail: `loadDataQualityScope` is reused verbatim as THE unit-scope source
  // — it already resolves grants + the dept→division cascade + center codes, and
  // sharing it is what makes Profiles and Data quality show the same people. Its
  // name is dashboard-flavoured for historical reasons only (it reads no flag);
  // move it to a neutral module if a third consumer appears.
  const scope = await loadDataQualityScope(session, db.read);
  if (isEmptyScope(scope)) {
    const denial = requireSuperuserGet({ session, path: "/edit/scholars", targetId: "roster" });
    if (denial !== null) {
      return <ForbiddenEditPage />;
    }
  }
  // A non-global editor is scope-filtered; a global editor passes `undefined`
  // (no scope clause) and sees everyone, exactly as before.
  const unitScope = scope.all === false ? scope : null;
  const { q, status, page, unit: unitParam, type } = (await searchParams) ?? {};
  const query = (q ?? "").trim();
  const statusFilter = parseStatus(status);
  const unit = parseUnit(unitParam);
  const roleCategory = (type ?? "").trim() || undefined;
  const pageNum = Math.max(Number.parseInt(page ?? "0", 10) || 0, 0);

  const [{ entries, total }, allFacets] = await Promise.all([
    loadEditRoster(
      {
        query,
        status: statusFilter,
        roleCategory,
        unit,
        unitCodeScope: unitScope ? unitScope.unitCodes : undefined,
        // Centers only when Amendment 4 actually grants center-based edit access
        // (#1104). The roster must never be BROADER than the per-scholar
        // predicate — a listed row whose editor 403s on click is worse than an
        // absent row. `loadDataQualityScope` returns centers unconditionally
        // because a read-only gap report has no such coupling.
        scopeCenterCodes:
          unitScope && isUnitAdminCenterProxyEnabled() ? unitScope.centerCodes : undefined,
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
      },
      db.read,
    ),
    loadRosterFacets(db.read),
  ]);

  // Narrow the org-unit filter dropdowns to the viewer's own scope. Without this
  // a curator is offered every department in the institution and any pick but
  // their own returns zero rows (scope AND filter) — an empty list that reads as
  // "no such people" rather than "not yours". Person-type stays global: those
  // categories are not unit-specific.
  const facets = unitScope
    ? {
        ...allFacets,
        departments: allFacets.departments.filter((d) => unitScope.unitCodes.includes(d.code)),
        divisions: allFacets.divisions.filter((d) => unitScope.unitCodes.includes(d.code)),
        centers: allFacets.centers.filter((c) => unitScope.centerCodes.includes(c.code)),
      }
    : allFacets;

  // The "URL requests" admin tab + pending-count pill (#497 PR-3c); `null` when
  // the slug-request feature is off, which hides the tab.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;


  return (
    <ConsoleShell
      active="profiles"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      // The unit-admin escape hatches (`console-tabs.ts`: a page that admits unit
      // admins ORs its own grant signal onto the session-derived base). Without
      // these a curator who lands here has no tab back to their units or their
      // gap report — the strip would render only the tab they are standing on.
      profilesTab={unitScope !== null}
      unitsTab={unitScope !== null ? true : undefined}
      dataQualityTab={
        unitScope !== null && isDataQualityDashboardEnabled() ? 0 : undefined
      }
    >
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
        canImpersonate={impersonationEnabled() && session.isSuperuser}
        viewerCwid={session.cwid}
      />
    </ConsoleShell>
  );
}
