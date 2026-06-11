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
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

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
  // Superuser re-check on every GET (B2). Emits the `edit_authz_denied` line.
  const denial = requireSuperuserGet({ session, path: "/edit/scholars", targetId: "roster" });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }

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
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;

  // Back-link to the admin's own self-edit surface — only when they actually
  // have a (non-deleted) profile, so a staff superuser without one never gets
  // a link that 404s.
  const self = await db.read.scholar.findUnique({
    where: { cwid: session.cwid },
    select: { deletedAt: true },
  });
  const selfEditHref = self && self.deletedAt === null ? "/edit" : null;

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
      administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
      methodsTab={isMethodsTabVisible(session) ? 0 : null}
      selfEditHref={selfEditHref}
      canImpersonate={impersonationEnabled() && session.isSuperuser}
      viewerCwid={session.cwid}
    />
  );
}
