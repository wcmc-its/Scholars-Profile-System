/**
 * `/edit/slugs` — the superuser slug-namespace registry (#497, the "used /
 * unavailable slugs" view). Answers "is this slug free / who holds it / why is
 * it taken" across the whole namespace: active scholars, historical (301/308)
 * slugs, override-pinned slugs, reserved route words, requested slugs (any
 * status), and the derived `-N` collision groups.
 *
 * Superuser-gated at B2 (re-checked here on every GET, never cached — the query,
 * not the UI, is the boundary), mirroring `/edit/slug-requests`. Unauthenticated
 * → SAML login. `force-dynamic` + `noindex`, like the other `/edit/*` pages.
 *
 * NOT gated behind `SELF_EDIT_SLUG_REQUEST`: segments active/historical/
 * override/reserved exist regardless of the request queue. Only the `requested`
 * segment is hidden when the slug-request feature is off — the page does not
 * 404, it drops that one tab and silently routes a `?seg=requested` link back to
 * `active`.
 */
import { redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SlugRegistry } from "@/components/edit/slug-registry";
import {
  isSlugRegistrySegment,
  loadSlugRegistry,
  type SlugRegistrySegment,
} from "@/lib/api/slug-registry";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Slug registry — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 50;

/** Parse the `?seg=` param. Unknown → `active`. The `requested` segment is
 *  routed back to `active` when the slug-request feature is off (the tab is
 *  hidden, so the segment must not be reachable by URL either). */
function parseSegment(v: string | undefined, requestedEnabled: boolean): SlugRegistrySegment {
  if (!v || !isSlugRegistrySegment(v)) return "active";
  if (v === "requested" && !requestedEnabled) return "active";
  return v;
}

export default async function EditSlugsPage({
  searchParams,
}: {
  searchParams?: Promise<{ seg?: string; q?: string; page?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/slugs");
  }
  // Superuser re-check on every GET (B2). Emits the `edit_authz_denied` line.
  const denial = requireSuperuserGet({ session, path: "/edit/slugs", targetId: "slug-registry" });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }

  const requestedEnabled = isSlugRequestEnabled();

  const { seg, q, page } = (await searchParams) ?? {};
  const segment = parseSegment(seg, requestedEnabled);
  const query = (q ?? "").trim();
  const pageNum = Math.max(Number.parseInt(page ?? "0", 10) || 0, 0);

  const { rows, total } = await loadSlugRegistry(
    { segment, query, limit: PAGE_SIZE, offset: pageNum * PAGE_SIZE },
    db.read,
  );

  // The "URL requests" admin tab + pending-count pill (#497 PR-3c); `null` when
  // the slug-request feature is off, which hides THAT tab — the slug-registry
  // tab stays visible regardless.
  const pendingSlugRequests = requestedEnabled
    ? await countPendingSlugRequests(db.read)
    : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;


  return (
    <SlugRegistry
      segment={segment}
      rows={rows}
      total={total}
      query={query}
      page={pageNum}
      pageSize={PAGE_SIZE}
      requestedSegmentVisible={requestedEnabled}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
      methodsTab={isMethodsTabVisible(session) ? 0 : null}
      dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      unitsTab={session.isSuperuser}
    />
  );
}
