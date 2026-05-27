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
import { loadEditRoster, type EditRosterStatusFilter } from "@/lib/api/edit-roster";
import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
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

export default async function EditScholarsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const session = await getEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/scholars");
  }
  // Superuser re-check on every GET (B2). Emits the `edit_authz_denied` line.
  const denial = requireSuperuserGet({ session, path: "/edit/scholars", targetId: "roster" });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }

  const { q, status, page } = (await searchParams) ?? {};
  const query = (q ?? "").trim();
  const statusFilter = parseStatus(status);
  const pageNum = Math.max(Number.parseInt(page ?? "0", 10) || 0, 0);

  const { entries, total } = await loadEditRoster(
    { query, status: statusFilter, limit: PAGE_SIZE, offset: pageNum * PAGE_SIZE },
    db.read,
  );

  // The "URL requests" admin tab + pending-count pill (#497 PR-3c); `null` when
  // the slug-request feature is off, which hides the tab.
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;

  return (
    <ProfilesRoster
      entries={entries}
      total={total}
      query={query}
      status={statusFilter}
      page={pageNum}
      pageSize={PAGE_SIZE}
      pendingSlugRequests={pendingSlugRequests}
    />
  );
}
