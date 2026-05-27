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

/** Canonical public base URL — mirrors `lib/seo/jsonld.ts`. */
export function publicSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
}

/** The canonical public profile URL for a slug (`/scholars/<slug>`). */
export function publicProfileUrl(slug: string): string {
  return `${publicSiteUrl()}/scholars/${slug}`;
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
