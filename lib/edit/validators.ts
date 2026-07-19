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
import { CWID_PATTERN } from "@/lib/cwid";
import { containsProfanity } from "@/lib/edit/profanity";
import { isChairTitleFor } from "@/lib/leadership";
import { isNameBasedSlug, RESERVED_SLUGS } from "@/lib/slug";

/**
 * The eight per-scholar SECTION-VISIBILITY keys (`section-visibility-spec.md`).
 * Each is a boolean `field_override(scholar, <key>)`: value `"true"` hides the
 * whole profile section, absent (or `"false"`, or a revoked row) shows it. This
 * is the middle hide tier between per-record `suppression` and whole-profile
 * suppression.
 *
 * DISPLAY-ONLY: a hidden section stays fully searchable (no people-doc
 * reflection, unlike whole-profile suppression), and `hideMethods` hides only
 * the profile's Methods & Tools section — never the Overview generator's methods
 * facts (those stay driven by `family_suppression_overlay`). `hideTechnologies`
 * drops the CTL "Available technologies" section from the public profile; the
 * /edit read-only mirror stays visible so the scholar can un-hide it.
 *
 * COI/Disclosures is deliberately NOT hideable (compliance-mandated public), so
 * `hideDisclosures` is intentionally absent — the route rejects it `400`.
 */
export const SECTION_VISIBILITY_FIELDS = [
  "hideMentoring",
  "hideEducation",
  "hideFunding",
  "hideCenters",
  "hidePostdocMentor",
  "hideClinicalTrials",
  "hideMethods",
  "hideTechnologies",
  "hideNews",
] as const;
export type SectionVisibilityField = (typeof SECTION_VISIBILITY_FIELDS)[number];

/** Narrow an untrusted `fieldName` to the section-visibility allowlist. */
export function isSectionVisibilityField(value: string): value is SectionVisibilityField {
  return (SECTION_VISIBILITY_FIELDS as readonly string[]).includes(value);
}

/**
 * The scholar `field_override.fieldName` allowlist. `overview` + `slug` are the
 * v1 set (`self-edit-spec.md`); `selectedHighlightPmids` is the #836 opt-in
 * manual Highlights override (a JSON array of PMIDs), gated by the
 * `SELF_EDIT_MANUAL_HIGHLIGHTS` flag at the route; the eight
 * `SECTION_VISIBILITY_FIELDS` are the section-visibility booleans. The allowlist
 * only narrows the field name; per-field validation + flags govern acceptance.
 */
export const EDITABLE_FIELDS = [
  "overview",
  "slug",
  "selectedHighlightPmids",
  ...SECTION_VISIBILITY_FIELDS,
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Narrow an untrusted `fieldName` to the allowlist. */
export function isEditableField(value: string): value is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(value);
}

export type SectionVisibilityResult =
  | { ok: true; value: "true" | "false" }
  | { ok: false; error: "invalid_value" };

/**
 * Validate a section-visibility override value — exactly `"true"` (hidden) or
 * `"false"` (shown). Any other value is `400 invalid_value`. The value is stored
 * as the string; the profile read (`lib/api/profile.ts`) treats `"true"` as
 * hidden and everything else — a `"false"` row or no row at all — as shown.
 */
export function validateSectionVisibilityValue(input: string): SectionVisibilityResult {
  if (input === "true" || input === "false") return { ok: true, value: input };
  return { ok: false, error: "invalid_value" };
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
 * Reserved single-segment paths a slug override / request must never equal —
 * every current and reserved-future top-level route word plus the `/scholars/*`
 * segments (#497 §6.1). The canonical set lives in `lib/slug.ts` (the low-
 * dependency module the ETL mint path also consults); re-exported here so the
 * write-path validators, the PR-2 root-alias route, and PR-3 request validation
 * all share one source of truth.
 */
export { RESERVED_SLUGS };

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

/** Minimum length for a *requested* slug (#497 §6.2 — a 1-char vanity URL is
 *  rejected; the override path has no minimum, but a request should not propose
 *  a single character). */
export const SLUG_REQUEST_MIN_LENGTH = 2;

export type RequestedSlugResult =
  | { ok: true; value: string }
  | {
      ok: false;
      error: "format" | "too_long" | "too_short" | "reserved" | "numeric" | "profanity" | "not_name_based";
    };

/**
 * The scholar's name, passed to {@link validateRequestedSlug} to enforce the
 * name-basis policy (#678). `names` is the scholar's preferred name + full name;
 * order is irrelevant. Omit it (legacy / pure-format callers) to skip the
 * name check — the self-serve request route always supplies it.
 */
export type SlugNameContext = { names: readonly string[] };

/**
 * Validate a slug a *scholar requested* (#497 §6.2/§6.3 — the PR-3 request path).
 *
 * Layered on {@link validateSlugFormat} (the same format/length/reserved rule the
 * superuser override path enforces, so an approved request always yields a valid
 * `field_override(slug)`), plus the request-only guards from the SPEC:
 *   - **min length 2** (`too_short`) — no single-character vanity URL.
 *   - **not purely numeric** (`numeric`) — a digits-only slug could shadow a
 *     future `/123` route and is indistinguishable from a CWID (`looksLikeSlug`).
 *   - **best-effort profanity** (`profanity`) — token-exact, name-safe
 *     (`containsProfanity`); the superuser review is the real gate.
 *   - **name-basis** (`not_name_based`, #678) — when `nameContext` is supplied,
 *     the slug must be derivable from the scholar's own name
 *     ({@link isNameBasedSlug}). This codifies the previously review-only policy
 *     that custom slugs are name variants, not free-choice handles, so the
 *     dormant self-serve queue can no longer accept "cancer" / "the-best-lab".
 *
 * Note (deviation, deliberate): the SPEC §6.2 wrote "length 2–255" and
 * "must equal deriveSlug(input)". We reconcile to the already-shipped
 * `validateSlugFormat` (≤ 64 chars, `SLUG_PATTERN`) so a request can never be
 * approved into an override the rest of the system would consider invalid;
 * `SLUG_PATTERN` is stricter than (and subsumes) the deriveSlug-equality intent
 * for the allowed charset.
 */
export function validateRequestedSlug(
  input: string,
  nameContext?: SlugNameContext,
): RequestedSlugResult {
  const format = validateSlugFormat(input);
  if (!format.ok) return format;
  if (format.value.length < SLUG_REQUEST_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (/^[0-9]+$/.test(format.value)) return { ok: false, error: "numeric" };
  if (containsProfanity(format.value)) return { ok: false, error: "profanity" };
  if (nameContext && !isNameBasedSlug(format.value, nameContext.names)) {
    return { ok: false, error: "not_name_based" };
  }
  return { ok: true, value: format.value };
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
// selectedHighlightPmids — #836 opt-in manual Highlights override
// ---------------------------------------------------------------------------

/**
 * The number of Highlights the profile shows — the manual set is bounded to the
 * same count the read path slices the AI ranking to (`lib/api/profile.ts`,
 * `rankForSelectedHighlights(...).slice(0, MAX_SELECTED_HIGHLIGHTS)`). Keep the
 * two in lockstep: a manual array longer than this would surface more cards than
 * the AI default and break the surface's fixed shape.
 */
export const MAX_SELECTED_HIGHLIGHTS = 3;

/** A PMID is a non-empty run of digits, no leading zero (PubMed never mints one). */
const PMID_PATTERN = /^[1-9][0-9]*$/;

export type SelectedHighlightsResult =
  | { ok: true; value: string[] }
  | { ok: false; error: "invalid_value" | "too_many" | "duplicate" | "invalid_pmid" };

/**
 * Validate a `selectedHighlightPmids` payload — the scholar's hand-picked,
 * ordered Highlights set (#836). The stored shape is a JSON array of PMID
 * strings; the array's ORDER is meaningful (it is the display order).
 *
 * Shape rules, in order:
 *   - the parsed value must be a JSON array of strings (anything else →
 *     `invalid_value`); an empty array is accepted and means "I have no manual
 *     picks" — the read path then falls back to the AI selection, identical to
 *     having no override row at all (the UI clears via the clear path instead,
 *     but an empty array is a benign no-op, not an error);
 *   - at most {@link MAX_SELECTED_HIGHLIGHTS} entries (`too_many`);
 *   - each entry a numeric PMID string (`invalid_pmid`);
 *   - no duplicate PMIDs (`duplicate`).
 *
 * Membership-in-the-scholar's-publication-set is NOT checked here (it needs a
 * DB read of the scholar's confirmed authorships); the read path
 * (`pickManualHighlights`) enforces it by silently dropping any stored PMID the
 * scholar is not a confirmed author of, so a stale or out-of-set PMID can never
 * surface. The edit UI only offers the scholar's own publications, so a
 * well-behaved client never sends an out-of-set PMID.
 *
 * Accepts either an already-parsed array (the route hands the raw body value) or
 * a JSON string. Returns the normalized `string[]` on success.
 */
export function validateSelectedHighlightPmids(input: unknown): SelectedHighlightsResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: "invalid_value" };
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "invalid_value" };
  if (parsed.length > MAX_SELECTED_HIGHLIGHTS) return { ok: false, error: "too_many" };

  const seen = new Set<string>();
  const value: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || !PMID_PATTERN.test(entry)) {
      return { ok: false, error: "invalid_pmid" };
    }
    if (seen.has(entry)) return { ok: false, error: "duplicate" };
    seen.add(entry);
    value.push(entry);
  }
  return { ok: true, value };
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

// ---------------------------------------------------------------------------
// whole-entity suppression targets — grant / education / appointment (#160)
// ---------------------------------------------------------------------------

/** The Prisma surface the whole-entity owner lookup needs. */
type EntityOwnerClient = Pick<PrismaClient, "grant" | "education" | "appointment">;

/** Owner cwid (+ title, for the appointment chair guard) of a suppressible
 *  whole entity. */
export type SuppressibleEntityOwner = { ownerCwid: string; title: string | null };

/**
 * Resolve the owning scholar (and, for an appointment, its title) of a
 * grant / education / appointment / mentee by stable `externalId` (#352). The
 * suppress endpoint uses this as the 400 existence gate AND to feed the pure
 * `authorizeSuppress` owner check (#160). No matching row → `null` → 400.
 *
 * A `mentee` is the special case: the relationship is derived (no FK; the
 * reporting DB is truncate-rebuilt nightly), so there is no DB row to look up.
 * Its `externalId` is `"{mentorCwid}:{menteeCwid}"` and the OWNER is the mentor
 * (the substring before the colon) — "this mentor hides this mentee from their
 * profile." A malformed id with no mentor segment returns `null` → 400.
 */
export async function findSuppressibleEntityOwner(
  entityType: "grant" | "education" | "appointment" | "mentee",
  externalId: string,
  client: EntityOwnerClient,
): Promise<SuppressibleEntityOwner | null> {
  if (entityType === "mentee") {
    // No DB lookup — mentees are derived. Owner = the mentor segment of
    // `{mentorCwid}:{menteeCwid}`. Require BOTH segments non-empty so a bare
    // `"aog2001"` or `"aog2001:"` (no mentee) is rejected.
    const [mentorCwid, menteeCwid] = externalId.split(":");
    if (!mentorCwid || !menteeCwid) return null;
    return { ownerCwid: mentorCwid, title: null };
  }
  if (entityType === "grant") {
    const r = await client.grant.findUnique({
      where: { externalId },
      select: { cwid: true },
    });
    return r ? { ownerCwid: r.cwid, title: null } : null;
  }
  if (entityType === "education") {
    const r = await client.education.findUnique({
      where: { externalId },
      select: { cwid: true },
    });
    return r ? { ownerCwid: r.cwid, title: null } : null;
  }
  const r = await client.appointment.findUnique({
    where: { externalId },
    select: { cwid: true, title: true },
  });
  return r ? { ownerCwid: r.cwid, title: r.title } : null;
}

/** The Prisma surface the chair-appointment guard needs. */
type ChairLookupClient = Pick<PrismaClient, "department">;

/**
 * True when this appointment confers a *current* department chair role — its
 * owner is some `Department.chairCwid` AND the title matches that department's
 * chair phrase (`isChairTitleFor`, the same predicate the ETL uses to populate
 * `chairCwid`). The suppress endpoint refuses to hide such an appointment
 * (409, #160 D-leader) so the profile can't contradict the column-driven
 * leader card. Other appointments of a chair stay suppressible.
 */
export async function isChairAppointment(
  ownerCwid: string,
  title: string,
  client: ChairLookupClient,
): Promise<boolean> {
  const dept = await client.department.findFirst({
    where: { chairCwid: ownerCwid },
    select: { name: true },
  });
  if (!dept) return false;
  return isChairTitleFor(title, dept.name);
}

// ---------------------------------------------------------------------------
// unit-curation fields (#540 Phase 5 / SPEC § 1)
//
// Department and division `field_override` rows curate five fields:
//   `description`, `url`, `slug`, `leaderCwid`, `leaderInterim`.
// Each has its own validator. The route picks the validator by `fieldName`.
//
// Centers do NOT use `field_override` — they edit in-row through
// `/api/edit/unit op:"update"` (Phase 5b). The validators below are reused by
// that endpoint for the same field semantics.
// ---------------------------------------------------------------------------

/** The dept/div `field_override.fieldName` allowlist. */
export const EDITABLE_UNIT_FIELDS = [
  "description",
  "url",
  "slug",
  "leaderCwid",
  "leaderInterim",
] as const;
export type EditableUnitField = (typeof EDITABLE_UNIT_FIELDS)[number];

/** Narrow an untrusted `fieldName` to the unit allowlist. */
export function isEditableUnitField(value: string): value is EditableUnitField {
  return (EDITABLE_UNIT_FIELDS as readonly string[]).includes(value);
}

/** Max length of a unit `description` blurb — SPEC § 1. */
export const UNIT_DESCRIPTION_MAX_LENGTH = 4_000;

/** Max length of a unit `url` — matches `@db.VarChar(512)` on all three models. */
export const UNIT_URL_MAX_LENGTH = 512;

export type UnitFieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate a unit `description`.
 *
 * Plain-text only — the description is rendered as text on the unit page, never
 * as HTML, so the validator does not sanitize HTML; it just trims trailing
 * whitespace and bounds the length. An empty string is accepted (the curator
 * clears the blurb); `op:"clear"` deletes the override row, which is a
 * different write path.
 */
export function validateUnitDescription(input: string): UnitFieldResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_value" };
  const trimmed = input.replace(/[ \t]+$/gm, "").trim();
  if (trimmed.length > UNIT_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: "description_too_long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a unit `url` (#1021) — the optional outbound website link rendered
 * beside the unit name on the public page.
 *
 * Rules:
 *  - `""`         → accepted; clears the link (the curator removes it). The
 *                   stored value is `""`; the read-merge surfaces null-vs-value
 *                   via `mergeUnitFields`, and the center in-row path coerces
 *                   `""` → NULL on the column (mirroring `description`).
 *  - https only   → mirrors `Scholar.clinicalProfileUrl`, which is normalized
 *                   to https:// at ETL time. A curated link is public-facing, so
 *                   we reject `http:`/`mailto:`/`javascript:` and any other
 *                   scheme rather than silently upgrade it.
 *  - well-formed  → must parse as a URL (host required); garbage → error.
 *  - ≤ 512 chars  → matches the `@db.VarChar(512)` column.
 *
 * Whitespace is trimmed before validation. The value is stored verbatim (the
 * `URL`-parsed canonical form is intentionally NOT used — a curator's exact
 * URL, including path/query, round-trips unchanged).
 */
export function validateUnitUrl(input: string): UnitFieldResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_value" };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: "" };
  if (trimmed.length > UNIT_URL_MAX_LENGTH) {
    return { ok: false, error: "url_too_long" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "invalid_url" };
  return { ok: true, value: trimmed };
}

/** Format of a CWID — 3-9 lowercase letters/digits. Single source of truth in
 *  `@/lib/cwid` (imported above); re-exported here so existing
 *  `lib/edit/validators` consumers keep working and the importer backfills share
 *  the exact same rule. */
export { CWID_PATTERN };

/**
 * Validate a unit `leaderCwid` override value — the three-state model
 * (SPEC § 1):
 *  - `""`        → explicit vacancy (the curator's "no leader"); accepted
 *  - `"<cwid>"`  → explicit leader; CWID format required
 *  - anything else → `400`
 *
 * The override is stored verbatim; the read-merge surfaces `null`-vs-`""`-vs-
 * value via `mergeUnitFields` (`lib/api/manual-layer.ts`). The CWID is NOT
 * cross-checked against the scholar table here — an override pinned ahead of
 * an incoming hire (SPEC edge 19) must not be rejected; the read-side resolves
 * a missing scholar gracefully.
 */
export function validateUnitLeaderCwid(input: string): UnitFieldResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_value" };
  if (input === "") return { ok: true, value: "" };
  if (!CWID_PATTERN.test(input)) return { ok: false, error: "invalid_cwid" };
  return { ok: true, value: input };
}

/**
 * Validate a unit `leaderInterim` override — exactly `"true"` or `"false"`
 * (the column-less qualifier; SPEC § 1). Any other value is `400`. The
 * read-side coerces `"true"`/`"false"` → boolean (`mergeUnitFields`); the
 * store-as-string shape lets the same `field_override.value VARCHAR` carry
 * every dept/div curated field.
 */
export function validateUnitLeaderInterim(input: string): UnitFieldResult {
  if (input === "true" || input === "false") return { ok: true, value: input };
  return { ok: false, error: "invalid_leader_interim" };
}

/** Per-field unit-value validation. The route dispatches on `fieldName`. */
export function validateUnitFieldValue(
  fieldName: EditableUnitField,
  value: string,
): UnitFieldResult {
  if (fieldName === "description") return validateUnitDescription(value);
  if (fieldName === "url") return validateUnitUrl(value);
  if (fieldName === "slug") return validateSlugFormat(value);
  if (fieldName === "leaderCwid") return validateUnitLeaderCwid(value);
  return validateUnitLeaderInterim(value);
}

// ---------------------------------------------------------------------------
// unit existence + parent-dept lookup (#540 Phase 5)
//
// Every `/api/edit/*` POST targeting a unit needs the unit row exists (a 400
// `unit_not_found` precedes the 403 — SPEC § Authorization), AND for a
// division it needs the parent `deptCode` to feed the authz cascade
// (`getEffectiveUnitRole`, `UnitRef` for kind `"division"`).
// ---------------------------------------------------------------------------

/** Prisma surface for the unit existence/parent lookup. */
type UnitLookupClient = Pick<PrismaClient, "department" | "division" | "center">;

export type UnitLookupResult =
  | { ok: true; kind: "department"; code: string; slug: string }
  | {
      ok: true;
      kind: "division";
      code: string;
      slug: string;
      parentDeptCode: string | null;
      parentDeptSlug: string | null;
    }
  | { ok: true; kind: "center"; code: string; slug: string }
  | { ok: false };

/**
 * Look up a unit row by `(entityType, code)`. Returns the kind + code + slug
 * (and the parent `deptCode`/slug for a division) on hit; `{ ok: false }` if
 * the row does not exist. The lookup is by primary key (`code`) — slug
 * overrides only flip the URL, not the canonical id.
 *
 * `slug` is returned so the route's post-commit `revalidatePath` knows which
 * unit page to bust (`reflectUnitChange`); the parent dept slug feeds the
 * division case (the parent dept page lists the chief).
 */
export async function findUnit(
  entityType: "department" | "division" | "center",
  code: string,
  client: UnitLookupClient,
): Promise<UnitLookupResult> {
  if (entityType === "department") {
    const r = await client.department.findUnique({
      where: { code },
      select: { code: true, slug: true },
    });
    return r ? { ok: true, kind: "department", code: r.code, slug: r.slug } : { ok: false };
  }
  if (entityType === "division") {
    const r = await client.division.findUnique({
      where: { code },
      select: {
        code: true,
        slug: true,
        deptCode: true,
        department: { select: { slug: true } },
      },
    });
    return r
      ? {
          ok: true,
          kind: "division",
          code: r.code,
          slug: r.slug,
          parentDeptCode: r.deptCode,
          parentDeptSlug: r.department?.slug ?? null,
        }
      : { ok: false };
  }
  const r = await client.center.findUnique({
    where: { code },
    select: { code: true, slug: true },
  });
  return r ? { ok: true, kind: "center", code: r.code, slug: r.slug } : { ok: false };
}

// ---------------------------------------------------------------------------
// unit creation + center in-row update (#540 Phase 5b / SPEC § Manual unit creation)
// ---------------------------------------------------------------------------

/** Max length of a unit `name` — half the slug column for headroom. */
export const UNIT_NAME_MAX_LENGTH = 255;

/**
 * Validate a unit `name` — non-empty, trimmed, bounded by the column. The
 * name is rendered as text on the unit page; HTML sanitization is unnecessary
 * because the value never reaches `dangerouslySetInnerHTML`.
 */
export function validateUnitName(input: string): UnitFieldResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_name" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "invalid_name" };
  if (trimmed.length > UNIT_NAME_MAX_LENGTH) {
    return { ok: false, error: "name_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** The two allowed `Center.centerType` values (Phase 1 schema). */
export const CENTER_TYPES = ["center", "institute"] as const;
export type CenterType = (typeof CENTER_TYPES)[number];

export function isCenterType(value: string): value is CenterType {
  return (CENTER_TYPES as readonly string[]).includes(value);
}

/**
 * Validate an N-code for the Superuser-only coded-division create path
 * (SPEC § Manual unit creation). The LDAP convention at WCM is an
 * uppercase `N` followed by 3-5 digits (e.g. `N1280`, `N101`); we accept
 * a slightly wider shape — `N` + 2-8 alphanumeric — so an LDAP code we
 * have not yet seen is not over-rejected. The "is it real LDAP?" guard
 * is impossible to enforce at write time and is deferred to the audit-
 * query C unadopted-division watch (SPEC § Edge case 24).
 */
export const LDAP_CODE_PATTERN = /^N[A-Z0-9]{2,8}$/;

export function validateLdapCode(input: string): UnitFieldResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_code" };
  const trimmed = input.trim();
  if (!LDAP_CODE_PATTERN.test(trimmed)) {
    return { ok: false, error: "invalid_code" };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// unit-slug uniqueness checks (#540 Phase 5b)
//
// Each unit kind has its own uniqueness scope:
//   - center.slug                  — globally unique (`Center.slug @unique`)
//   - division.(deptCode, slug)    — unique per parent dept
//                                    (`@@unique([deptCode, slug])`)
//   - department.slug              — globally unique (not used here; Phase 5b
//                                    does not create departments)
// The checks below are the *friendly* application-level guards; the DB
// `@unique` constraints are the atomic backstops that catch a concurrent
// duplicate the application check cannot.
// ---------------------------------------------------------------------------

type SlugCheckClient = Pick<PrismaClient, "center" | "division" | "department">;

export type UnitSlugCheckResult =
  | { ok: true }
  | { ok: false; error: "slug_taken" | "reserved_slug" };

export async function checkUnitSlugAvailable(
  params:
    | { kind: "center"; slug: string; excludeCode?: string }
    | { kind: "division"; slug: string; deptCode: string; excludeCode?: string }
    | { kind: "department"; slug: string; excludeCode?: string },
  client: SlugCheckClient,
): Promise<UnitSlugCheckResult> {
  if (RESERVED_SLUGS.has(params.slug)) {
    return { ok: false, error: "reserved_slug" };
  }
  if (params.kind === "center") {
    const row = await client.center.findUnique({
      where: { slug: params.slug },
      select: { code: true },
    });
    if (row && row.code !== params.excludeCode) {
      return { ok: false, error: "slug_taken" };
    }
    return { ok: true };
  }
  if (params.kind === "division") {
    const row = await client.division.findFirst({
      where: { deptCode: params.deptCode, slug: params.slug },
      select: { code: true },
    });
    if (row && row.code !== params.excludeCode) {
      return { ok: false, error: "slug_taken" };
    }
    return { ok: true };
  }
  const row = await client.department.findFirst({
    where: { slug: params.slug },
    select: { code: true },
  });
  if (row && row.code !== params.excludeCode) {
    return { ok: false, error: "slug_taken" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// unit_admin grant role  (#540 Phase 5b / SPEC § /api/edit/grant)
// ---------------------------------------------------------------------------

/** The two `unit_admin.role` values (Phase 1 enum). */
export const UNIT_ADMIN_ROLES = ["owner", "curator"] as const;
export type UnitAdminRole = (typeof UNIT_ADMIN_ROLES)[number];

export function isUnitAdminRole(value: string): value is UnitAdminRole {
  return (UNIT_ADMIN_ROLES as readonly string[]).includes(value);
}

/** The two `grant` action values. */
export const GRANT_ACTIONS = ["grant", "revoke"] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

export function isGrantAction(value: string): value is GrantAction {
  return (GRANT_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// roster action  (#540 Phase 5b / SPEC § /api/edit/roster)
// ---------------------------------------------------------------------------

export const ROSTER_ACTIONS = ["add", "remove", "set"] as const;
export type RosterAction = (typeof ROSTER_ACTIONS)[number];

export function isRosterAction(value: string): value is RosterAction {
  return (ROSTER_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Center membership extended fields (#552 Phase 2). membershipType + programCode
// + dates apply to CenterMembership only; the roster route rejects them for a
// division (DivisionMembership has no such columns).
// ---------------------------------------------------------------------------

export const CENTER_MEMBERSHIP_TYPES = ["research", "clinical"] as const;
export type CenterMembershipTypeValue = (typeof CENTER_MEMBERSHIP_TYPES)[number];

export function isCenterMembershipType(value: string): value is CenterMembershipTypeValue {
  return (CENTER_MEMBERSHIP_TYPES as readonly string[]).includes(value);
}

const ROSTER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type RosterDateResult = { ok: true; value: Date | null } | { ok: false; error: string };

/**
 * Parse a roster date payload value: `null` (clear), or an ISO `YYYY-MM-DD`
 * string → a UTC-midnight `Date` for the `@db.Date` column. Any other shape is
 * `invalid_date`.
 */
export function validateRosterDate(input: unknown): RosterDateResult {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "string" || !ROSTER_DATE_PATTERN.test(input)) {
    return { ok: false, error: "invalid_date" };
  }
  const d = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "invalid_date" };
  return { ok: true, value: d };
}

/** `end >= start` when both are present; either-null is an open-ended range. */
export function isValidDateRange(start: Date | null, end: Date | null): boolean {
  if (start === null || end === null) return true;
  return end.getTime() >= start.getTime();
}
