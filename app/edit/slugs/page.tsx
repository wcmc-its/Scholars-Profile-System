/**
 * `/edit/slugs` — Profile URLs: the superuser surface for personalized profile
 * URLs (#497; design canvas "Profile URLs", 2026-09-25). One page for what
 * used to be two: the pending request queue ("Requests to review", formerly
 * `/edit/slug-requests`, which now redirects here) above the slug-namespace
 * registry — active scholars, historical (301/308) slugs, override-pinned
 * slugs, reserved route words, decided requests, and the derived `-N`
 * collision groups.
 *
 * The registry's one input (`q`) both checks a URL and narrows every tab:
 * the page resolves its verdict server-side — a CWID → where that scholar is,
 * else `resolveSlugStatus` (the same checks the write path runs) — and counts
 * each tab's matches for the tab pills.
 *
 * Superuser-gated at B2 (re-checked here on every GET, never cached — the query,
 * not the UI, is the boundary). Unauthenticated → SAML login. `force-dynamic` +
 * `noindex`, like the other `/edit/*` pages.
 *
 * NOT gated behind `SELF_EDIT_SLUG_REQUEST`: the registry exists regardless of
 * the request queue. When the feature is off the page does not 404 — it drops
 * the queue card and the `requested` tab, and routes a `?seg=requested` link
 * back to `active`.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SlugRegistry, type RegistryVerdict } from "@/components/edit/slug-registry";
import { SlugRequestQueue } from "@/components/edit/slug-request-queue";
import {
  countSlugRegistrySegments,
  isSlugRegistrySegment,
  loadSlugRegistry,
  loadSlugRegistryExtras,
  resolveSlugStatus,
  type SlugRegistrySegment,
} from "@/lib/api/slug-registry";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import {
  isSlugRequestEnabled,
  loadLastSlugDecision,
  loadSlugRequestQueue,
} from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profile URLs — Scholars Console",
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

/** The input takes a slug, `/scholars/<slug>`, a pasted profile URL or a
 *  CWID: keep only the slug part. */
function normalizeRegistryQuery(q: string | undefined): string {
  return (q ?? "")
    .trim()
    .replace(/^.*\/scholars\//i, "")
    .replace(/^\/+/, "")
    .replace(/[/?#].*$/, "")
    .trim();
}

/** The verdict beside the input: a CWID says where that scholar is; anything
 *  else gets the write path's own availability checks. A failed lookup shows
 *  no verdict rather than failing the page. */
async function resolveVerdict(query: string): Promise<RegistryVerdict | null> {
  if (!query) return null;
  try {
    const q = query.toLowerCase();
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: q },
      select: { cwid: true, slug: true, preferredName: true, fullName: true },
    });
    if (scholar) {
      return {
        kind: "cwid",
        cwid: scholar.cwid,
        name: scholar.preferredName ?? scholar.fullName ?? null,
        slug: scholar.slug,
      };
    }
    return { kind: "status", status: await resolveSlugStatus(q, db.read) };
  } catch {
    return null;
  }
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
    return (
      <ConsoleShell
        active="slugs"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const requestedEnabled = isSlugRequestEnabled();

  const { seg, q, page } = (await searchParams) ?? {};
  const segment = parseSegment(seg, requestedEnabled);
  const query = normalizeRegistryQuery(q);
  const pageNum = Math.max(Number.parseInt(page ?? "0", 10) || 0, 0);

  const [{ rows, total }, counts, verdict, requests, lastDecidedAt, pendingHonors] =
    await Promise.all([
      loadSlugRegistry(
        {
          segment,
          query,
          limit: PAGE_SIZE,
          offset: pageNum * PAGE_SIZE,
          decidedOnly: segment === "requested",
        },
        db.read,
      ),
      countSlugRegistrySegments(query, db.read, { requested: requestedEnabled }),
      resolveVerdict(query),
      // The "Requests to review" card; `null` when the slug-request feature is
      // off, which also drops the pending pill from the console's "Profile URLs" tab.
      requestedEnabled ? loadSlugRequestQueue(db.read) : Promise.resolve(null),
      requestedEnabled ? loadLastSlugDecision(db.read) : Promise.resolve(null),
      // #1762 — drives the "Honors" tab + its pending badge. `null` hides the
      // tab: flag off, or this viewer is neither superuser nor honors_curator.
      isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
    ]);
  const extras = await loadSlugRegistryExtras(segment, rows, db.read);

  return (
    <ConsoleShell
      active="slugs"
      session={session}
      pendingSlugRequests={requests ? requests.length : null}
      pendingHonors={pendingHonors}
    >
      <SlugRegistry
        segment={segment}
        rows={rows}
        total={total}
        query={query}
        page={pageNum}
        pageSize={PAGE_SIZE}
        requestedSegmentVisible={requestedEnabled}
        counts={counts}
        extras={extras}
        verdict={verdict}
        requests={
          requests ? (
            <SlugRequestQueue initialRequests={requests} lastDecidedAt={lastDecidedAt} />
          ) : null
        }
      />
    </ConsoleShell>
  );
}
