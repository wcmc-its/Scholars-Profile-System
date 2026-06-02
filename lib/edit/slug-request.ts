/**
 * Shared helpers for the slug-request queue (#497 PR-3,
 * docs/slug-personalization-spec.md § 5.4): the feature flag, the public-URL
 * helper, and the requester-notification email bodies.
 *
 * The endpoints themselves live under `app/api/edit/slug-request/`. The
 * authoritative override is still the `FieldOverride(slug)` row written on
 * approval (via `reconcileScholarSlug`); the `SlugRequest` table is the queue.
 */
import type { PrismaClient, SlugRequestStatus } from "@/lib/generated/prisma/client";
import { checkSlugCollision, RESERVED_SLUGS } from "@/lib/edit/validators";
import { canonicalProfilePath } from "@/lib/profile-url";

/** Canonical public base URL — mirrors `lib/seo/jsonld.ts`. */
export function publicSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
}

/**
 * The canonical public profile URL for a slug — `/scholars/<slug>` or the root
 * `/<slug>` form per PROFILE_CANONICAL (#671). Server-side helper (email
 * bodies / approval flow), so the flag read is authoritative.
 */
export function publicProfileUrl(slug: string): string {
  return `${publicSiteUrl()}${canonicalProfilePath(slug)}`;
}

/**
 * Whether the slug-request feature is enabled (#497 PR-3). Off by default;
 * the endpoints 404 and the request card is not rendered until ops flip it on
 * (mirrors `SELF_EDIT_REQUEST_CHANGE_SEND` for the request-change mailer).
 */
export function isSlugRequestEnabled(): boolean {
  return process.env.SELF_EDIT_SLUG_REQUEST === "on";
}

/**
 * The scholar's latest `SlugRequest`, shaped for the self request card
 * (`components/edit/slug-request-card.tsx`). `createdAt` is serialized to an ISO
 * string so it crosses the server→client boundary as a plain prop.
 */
export type SlugRequestSummary = {
  id: string;
  status: SlugRequestStatus;
  requestedSlug: string;
  reason: string | null;
  decisionNote: string | null;
  createdAt: string;
};

/** The Prisma surface `loadLatestSlugRequest` needs — satisfied by a client or tx. */
type SlugRequestReadClient = Pick<PrismaClient, "slugRequest">;

/**
 * Load a scholar's most-recent `SlugRequest` (any status), or `null` if they
 * have never filed one. The `/edit` self surface seeds the request card with
 * this so it opens in the right state (Pending / Rejected / Just-approved)
 * without a client round-trip. Shared by `/edit` and the self-view branch of
 * `/edit/scholar/[cwid]` so the two never drift.
 */
export async function loadLatestSlugRequest(
  cwid: string,
  client: SlugRequestReadClient,
): Promise<SlugRequestSummary | null> {
  const row = await client.slugRequest.findFirst({
    where: { cwid },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      requestedSlug: true,
      reason: true,
      decisionNote: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * One pending request as the superuser approval queue (U3) renders it: the
 * request, the target scholar's resolved name + current slug, and a warning
 * computed live at load (a slug free at request time may be taken now). All
 * Date fields serialized to ISO for the client island.
 */
export type SlugRequestQueueRow = {
  id: string;
  cwid: string;
  requestedSlug: string;
  reason: string | null;
  createdAt: string;
  /** The target scholar's live slug (override-aware), or `null` if no row. */
  currentSlug: string | null;
  /** Resolved display name (`preferredName ?? fullName`), or `null`. */
  name: string | null;
  /** The target's primary department, for the row header; `null` if unset. */
  department: string | null;
  /** Live warning blocking approval; `null` when clean. */
  warning: "collision" | "reserved" | null;
  /** When `warning === "collision"` and the conflict is a live scholar, that
   *  scholar's cwid (so the reviewer knows who holds it); `null` otherwise
   *  (clean, reserved, or an override/history-only conflict). */
  collidesWith: string | null;
};

/** The Prisma surface the queue load needs (`checkSlugCollision` adds the rest). */
type SlugRequestQueueClient = Pick<
  PrismaClient,
  "slugRequest" | "scholar" | "fieldOverride" | "slugHistory"
>;

/**
 * Load the pending slug-request queue, oldest-first (`@@index([status,
 * createdAt])`), each row carrying the target's name + current slug and a
 * live collision/reserved warning. Shared by the `GET /api/edit/slug-request`
 * endpoint and the `/edit/slug-requests` page so the two never drift. The
 * pending queue is small; the per-row lookups are acceptable.
 */
export async function loadSlugRequestQueue(
  client: SlugRequestQueueClient,
): Promise<SlugRequestQueueRow[]> {
  const rows = await client.slugRequest.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, cwid: true, requestedSlug: true, reason: true, createdAt: true },
  });

  return Promise.all(
    rows.map(async (r) => {
      const scholar = await client.scholar.findUnique({
        where: { cwid: r.cwid },
        select: { slug: true, preferredName: true, fullName: true, primaryDepartment: true },
      });
      let warning: "collision" | "reserved" | null = null;
      let collidesWith: string | null = null;
      if (RESERVED_SLUGS.has(r.requestedSlug)) {
        warning = "reserved";
      } else {
        const collision = await checkSlugCollision(r.requestedSlug, r.cwid, client);
        if (!collision.ok) {
          warning = "collision";
          // Resolve the live holder for the warning copy. An override/history-
          // only conflict yields no live scholar → `collidesWith` stays null.
          const holder = await client.scholar.findFirst({
            where: { slug: r.requestedSlug, cwid: { not: r.cwid }, deletedAt: null, status: "active" },
            select: { cwid: true },
          });
          collidesWith = holder?.cwid ?? null;
        }
      }
      return {
        id: r.id,
        cwid: r.cwid,
        requestedSlug: r.requestedSlug,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        currentSlug: scholar?.slug ?? null,
        name: scholar?.preferredName ?? scholar?.fullName ?? null,
        department: scholar?.primaryDepartment ?? null,
        warning,
        collidesWith,
      };
    }),
  );
}

/** Count pending slug requests — the rail pending-count pill (U3 + roster). */
export function countPendingSlugRequests(
  client: Pick<PrismaClient, "slugRequest">,
): Promise<number> {
  return client.slugRequest.count({ where: { status: "pending" } });
}

export type ComposedEmail = { subject: string; text: string };

/** Notification to the requester when a slug request is approved. */
export function composeApprovedEmail(slug: string): ComposedEmail {
  return {
    subject: "Your profile URL request was approved",
    text: [
      `Your personalized profile URL is now live:`,
      ``,
      `  ${publicProfileUrl(slug)}`,
      ``,
      `Your previous address redirects to it automatically, so existing links keep working.`,
      ``,
      `— Weill Cornell Medicine Scholars`,
    ].join("\n"),
  };
}

/** Notification to the requester when a slug request is rejected. */
export function composeRejectedEmail(requestedSlug: string, note?: string | null): ComposedEmail {
  const lines = [
    `Your request for the profile URL "/scholars/${requestedSlug}" was not approved.`,
  ];
  if (note && note.trim().length > 0) {
    lines.push(``, `Note from the reviewer:`, `  ${note.trim()}`);
  }
  lines.push(
    ``,
    `You can request a different address from the "Profile URL" section of your profile editor.`,
    ``,
    `— Weill Cornell Medicine Scholars`,
  );
  return { subject: "About your profile URL request", text: lines.join("\n") };
}
