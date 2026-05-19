/**
 * Self-edit v1 — per-field validation (#356, `self-edit-spec.md` § The v1
 * editable-field set).
 *
 * Exactly two fields are editable — `overview` (the profile bio) and `slug`
 * (the profile URL segment). This module owns the validation `self-edit-spec.md`
 * and ADR-005 delegate to the feature layer:
 *
 *   - `sanitizeOverview()` — the server-side HTML sanitize that is the
 *     stored-XSS boundary. The public profile renders `overview` through
 *     `dangerouslySetInnerHTML` with NO render-time sanitizer, so the value
 *     must be safe BEFORE it is stored. The sanitize is done by DOMPurify
 *     (`isomorphic-dompurify`) — a vetted library, never a hand-rolled regex:
 *     entity, comment, CDATA, and mutation-XSS handling must not be improvised.
 *   - `validateSlugFormat()` — pure format / length / reserved-segment checks.
 *   - `checkSlugCollision()` — the DB-backed cross-scholar collision check. It
 *     is the *friendly* half of the slug guard; the *atomic* half is the
 *     `slug_guard` UNIQUE index (migration `add_slug_override_uniqueness_guard`),
 *     which catches a concurrent duplicate the application check cannot.
 *   - `publicationAuthorshipExists()` — "is this CWID a confirmed author of
 *     this pmid", the 400-gate for a per-author publication hide (edge case 18).
 *
 * Node-runtime only (`isomorphic-dompurify` pulls in a DOM implementation;
 * Prisma is Node-only).
 */
import DOMPurify from "isomorphic-dompurify";

import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The v1 `field_override.fieldName` allowlist (`self-edit-spec.md`). */
export const EDITABLE_FIELDS = ["overview", "slug"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Narrow an untrusted `fieldName` to the v1 allowlist. */
export function isEditableField(value: string): value is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

/**
 * The `overview` tag allowlist — seven structural tags plus `<a>` (added with
 * `self-edit-ui-spec.md`). Every other tag is stripped, its text kept.
 */
export const OVERVIEW_ALLOWED_TAGS = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "a",
] as const;

/** Length cap on the *sanitized HTML string* — `field_override.value` is a Text column. */
export const OVERVIEW_MAX_LENGTH = 20_000;

/** `<a href>` may only carry these schemes; any other has the `href` dropped. */
const OVERVIEW_URI_SCHEMES = /^(?:https?:|mailto:)/i;
/** Web schemes additionally get `target="_blank"`; `mailto:` does not. */
const WEB_SCHEME = /^https?:/i;

// Not `as const` — DOMPurify's `Config` type expects mutable `string[]`.
const OVERVIEW_CONFIG = {
  ALLOWED_TAGS: [...OVERVIEW_ALLOWED_TAGS],
  ALLOWED_ATTR: ["href"],
  // Restrict link schemes to exactly https / http / mailto. DOMPurify drops an
  // `href` that fails this, leaving the link text — `self-edit-spec.md` edge 8.
  ALLOWED_URI_REGEXP: OVERVIEW_URI_SCHEMES,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/**
 * Force `rel` / `target` onto every surviving `<a>`. Runs as an
 * `afterSanitizeAttributes` hook, so the attributes it adds are not themselves
 * re-sanitized away — the standard DOMPurify pattern for link hardening. An
 * `<a>` whose `href` was dropped (disallowed scheme) is left as inert text.
 */
function hardenLinks(node: Element): void {
  if (node.nodeName !== "A") return;
  const href = node.getAttribute("href");
  if (href) {
    node.setAttribute("rel", "noopener noreferrer nofollow");
    if (WEB_SCHEME.test(href)) node.setAttribute("target", "_blank");
    else node.removeAttribute("target");
  } else {
    node.removeAttribute("rel");
    node.removeAttribute("target");
  }
}

/**
 * Normalize `<b>`→`<strong>`, `<i>`→`<em>` before the sanitizer runs (the
 * sanitizer's allowlist has `strong`/`em`, not `b`/`i`, so an un-renamed `<b>`
 * would be stripped to plain text). This is a tag rename, not the security
 * boundary — DOMPurify still runs over the result; attributes on the old tag
 * are dropped, which is the intended outcome.
 */
function normalizeBoldItalic(html: string): string {
  return html
    .replace(/<(\/?)b(\s[^>]*)?>/gi, "<$1strong>")
    .replace(/<(\/?)i(\s[^>]*)?>/gi, "<$1em>");
}

/** Strip tags — used only to test whether a sanitized result is structurally empty. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; error: "too_long"; length: number };

/**
 * The core `overview` HTML sanitize — DOMPurify with the v1 tag/attribute
 * allowlist, scheme-restricted `href`, and `rel`/`target` link hardening.
 * `sanitizeOverview` wraps this with the write-path length / empty-result
 * checks; the read-merge (`lib/api/manual-layer.ts` `getEffectiveOverview`)
 * calls it bare, re-sanitizing a stored override as defense-in-depth before
 * the public profile's raw `dangerouslySetInnerHTML` render.
 */
export function sanitizeOverviewHtml(input: string): string {
  // Add the link-hardening hook only for the span of this synchronous call,
  // then remove it — no lasting global DOMPurify state. `sanitize()` is
  // synchronous, so no other call can interleave between add and remove.
  DOMPurify.addHook("afterSanitizeAttributes", hardenLinks);
  try {
    return DOMPurify.sanitize(normalizeBoldItalic(input), OVERVIEW_CONFIG);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

/**
 * Sanitize an `overview` submission to the v1 contract: the tag allowlist,
 * `href`-only-on-`<a>` with an `https`/`http`/`mailto` scheme, `rel`/`target`
 * link hardening, `b`→`strong` / `i`→`em` normalization, and the 20,000-char
 * cap on the stored HTML. A structurally-empty result (`<p></p>`, whitespace)
 * normalizes to `""` — a valid "no overview".
 */
export function sanitizeOverview(input: string): SanitizeResult {
  // Defensive cap before the sanitizer parses anything — a pathological
  // multi-MB payload should not reach the DOM implementation. The route also
  // bounds the request body; this is belt-and-braces.
  if (input.length > OVERVIEW_MAX_LENGTH * 8) {
    return { ok: false, error: "too_long", length: input.length };
  }

  const sanitized = sanitizeOverviewHtml(input);

  if (stripTags(sanitized).trim() === "") {
    return { ok: true, value: "" };
  }
  if (sanitized.length > OVERVIEW_MAX_LENGTH) {
    return { ok: false, error: "too_long", length: sanitized.length };
  }
  return { ok: true, value: sanitized };
}

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

/** A slug is at most 64 characters (`self-edit-spec.md`). */
export const SLUG_MAX_LENGTH = 64;

/** Lowercase alphanumerics and single hyphens, no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Static segments under `/scholars/*` a slug override must never shadow.
 * Keep in sync with `app/(public)/scholars/`; `self-edit-spec.md` names
 * `by-cwid` as the worked example.
 */
export const RESERVED_SLUGS = new Set<string>(["by-cwid"]);

export type SlugFormatResult =
  | { ok: true; value: string }
  | { ok: false; error: "format" | "too_long" | "reserved" };

/**
 * Validate a slug's *shape*: lowercase-normalized, trimmed, ≤ 64 chars,
 * matching `SLUG_PATTERN`, no `--` run, and not a reserved route segment.
 * Returns the normalized value on success — collision checking is separate
 * (`checkSlugCollision`).
 */
export function validateSlugFormat(input: string): SlugFormatResult {
  const value = input.trim().toLowerCase();
  if (value.length > SLUG_MAX_LENGTH) return { ok: false, error: "too_long" };
  if (!SLUG_PATTERN.test(value)) return { ok: false, error: "format" };
  if (value.includes("--")) return { ok: false, error: "format" };
  if (RESERVED_SLUGS.has(value)) return { ok: false, error: "reserved" };
  return { ok: true, value };
}

/** The Prisma surface `checkSlugCollision` needs — satisfied by a client or a tx. */
type SlugLookupClient = Pick<PrismaClient, "scholar" | "fieldOverride" | "slugHistory">;

export type SlugCollisionResult = { ok: true } | { ok: false; error: "collision" };

/**
 * Reject a slug already in use elsewhere (`self-edit-spec.md`): another live
 * scholar's `Scholar.slug`, another CWID's `field_override(slug)` value, or a
 * `SlugHistory.old_slug` pointing at a *different* scholar (the #29 identity-
 * bleed guard — claiming it would shadow that scholar's 301 redirect).
 *
 * A scholar reclaiming a slug from their *own* history is allowed — every
 * check excludes `forCwid` (edge case 21). This application check is not
 * atomic; the `slug_guard` UNIQUE index is the race-proof backstop.
 */
export async function checkSlugCollision(
  slug: string,
  forCwid: string,
  client: SlugLookupClient,
): Promise<SlugCollisionResult> {
  const liveScholar = await client.scholar.findFirst({
    where: { slug, cwid: { not: forCwid }, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  if (liveScholar) return { ok: false, error: "collision" };

  const otherOverride = await client.fieldOverride.findFirst({
    where: {
      entityType: "scholar",
      fieldName: "slug",
      value: slug,
      entityId: { not: forCwid },
    },
    select: { id: true },
  });
  if (otherOverride) return { ok: false, error: "collision" };

  const formerSlug = await client.slugHistory.findFirst({
    where: { oldSlug: slug, currentCwid: { not: forCwid } },
    select: { oldSlug: true },
  });
  if (formerSlug) return { ok: false, error: "collision" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// publication authorship (the 400-gate for a per-author hide)
// ---------------------------------------------------------------------------

/** The Prisma surface `publicationAuthorshipExists` needs. */
type AuthorLookupClient = Pick<PrismaClient, "publicationAuthor">;

/**
 * Whether `cwid` is a confirmed author of `pmid`. A per-author publication
 * hide with no such authorship has nothing to suppress → the write path
 * returns `400` (`self-edit-spec.md` edge case 18), distinct from the `403`
 * for hiding *someone else* as a contributor (edge case 17).
 */
export async function publicationAuthorshipExists(
  pmid: string,
  cwid: string,
  client: AuthorLookupClient,
): Promise<boolean> {
  const row = await client.publicationAuthor.findFirst({
    where: { pmid, cwid, isConfirmed: true },
    select: { id: true },
  });
  return row !== null;
}
