/**
 * Slug derivation per Q3' decision.
 *
 * Source: ED preferred_name. Steps:
 *   - NFKD normalize, strip combining marks (diacritics)
 *   - Replace any character outside [a-z0-9 -] with whitespace
 *   - Collapse whitespace runs into single hyphens
 *   - Trim leading/trailing hyphens
 *
 * Collisions are resolved at the call site via `nextAvailableSlug`, which appends
 * -2, -3, ... in CWID-creation order. Established profiles never get renamed by
 * a later collision; only the new arrival gets the suffix.
 */

import type { PrismaClient } from "@/lib/generated/prisma/client";

const COMBINING_MARKS = /\p{Mark}/gu;
const APOSTROPHES = /['‘’ʼ]/g; // straight, curly, modifier letter
const NON_SLUG_CHARS = /[^a-z0-9\s-]/g;
const WHITESPACE_RUN = /[\s-]+/g;

// Latin characters that NFKD doesn't decompose (no combining-mark form).
// Mapped to their conventional ASCII transliterations.
const NON_DECOMPOSABLE_LATIN: Record<string, string> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};
const NON_DECOMPOSABLE_REGEX = new RegExp(
  `[${Object.keys(NON_DECOMPOSABLE_LATIN).join("")}]`,
  "g",
);

/**
 * Convert a name to its base slug form.
 *
 * Algorithm:
 *   1. NFKD normalize to split accented letters into base + combining marks
 *   2. Strip combining marks
 *   3. Lowercase
 *   4. Drop apostrophes (so O'Brien -> obrien, not o-brien)
 *   5. Map non-decomposable Latin extensions (ø -> o, ß -> ss, etc.)
 *   6. Replace remaining non-[a-z0-9 -] with whitespace
 *   7. Collapse whitespace/hyphen runs into single hyphens
 *   8. Trim leading/trailing hyphens
 *
 * Examples:
 *   "Jane Smith" -> "jane-smith"
 *   "María José García-López" -> "maria-jose-garcia-lopez"
 *   "Mary-Anne O'Brien" -> "mary-anne-obrien"
 *   "Søren Kierkegaard" -> "soren-kierkegaard"
 *   "李明" -> "" (CJK falls outside ASCII; expects ED romanization to be supplied instead)
 */
export function deriveSlug(name: string): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(NON_DECOMPOSABLE_REGEX, (ch) => NON_DECOMPOSABLE_LATIN[ch] ?? "")
    .replace(NON_SLUG_CHARS, " ")
    .replace(WHITESPACE_RUN, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Reserved single-segment paths a slug must never equal — every current and
 * reserved-future top-level route word, plus the `/scholars/*` segments a slug
 * override must not shadow (#497 §6.1). A bare slug equal to one of these would
 * either shadow a real route (the PR-2 root-alias catch-all) or a `/scholars/*`
 * segment, so:
 *   - a *derived* slug landing here takes the numeric floor (`about` ->
 *     `about-2`), via `nextAvailableSlug` below; and
 *   - a *requested / override* slug here is rejected (`validateSlugFormat`).
 *
 * The single source of truth: `lib/edit/validators.ts` re-exports this set, and
 * the PR-2 root-alias route consults it. Keep this in lock-step with the route
 * tree under `app/` (top-level segments) and `app/(public)/scholars/`.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>([
  // top-level app route segments (current + reserved-future)
  "about",
  "browse",
  "centers",
  "departments",
  "scholars",
  "search",
  "topics",
  "edit",
  "api",
  "og",
  "healthz",
  "readiness",
  "robots",
  "sitemap",
  "llms",
  "not-found",
  "admin",
  "login",
  "logout",
  "auth",
  "static",
  "_next",
  "assets",
  "news",
  "help",
  "support",
  "contact",
  // `/scholars/*` sub-segment a slug override must not shadow (legacy entry)
  "by-cwid",
]);

/**
 * Given a base slug and a set of taken slugs, return the next available variant
 * with a numeric suffix. Used at scholar-creation time when ED reports a name
 * whose slug collides with an existing scholar.
 *
 * A base slug equal to a reserved word (#497 §6.1) is treated as taken so it
 * gets the numeric floor (`about` -> `about-2`) — a bare reserved-word slug
 * would shadow a real route.
 *
 * Returns the base slug unchanged if it isn't taken and isn't reserved.
 *
 * Example:
 *   nextAvailableSlug("jane-smith", new Set()) -> "jane-smith"
 *   nextAvailableSlug("jane-smith", new Set(["jane-smith"])) -> "jane-smith-2"
 *   nextAvailableSlug("jane-smith", new Set(["jane-smith", "jane-smith-2"])) -> "jane-smith-3"
 *   nextAvailableSlug("about", new Set()) -> "about-2"
 */
export function nextAvailableSlug(base: string, taken: Set<string> | ReadonlySet<string>): string {
  if (!taken.has(base) && !RESERVED_SLUGS.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Quick predicate for use in URL middleware: does this string look like a slug
 * (vs. a raw CWID, which is typically alphanumeric without hyphens)?
 */
export function looksLikeSlug(s: string): boolean {
  return /-/.test(s) || /^[a-z]+$/.test(s);
}

// ---------------------------------------------------------------------------
// reconcile-on-write — the shared Option B helper (#497 §5.1)
// ---------------------------------------------------------------------------

/**
 * The Prisma surface `reconcileScholarSlug` needs — a `$transaction`
 * interactive client (or the base client) satisfies it. Keeping it a `Pick`
 * lets the helper run inside any caller's transaction.
 */
type SlugReconcileClient = Pick<PrismaClient, "scholar" | "slugHistory">;

/**
 * Reconcile a scholar's canonical `Scholar.slug` to `newSlug`, recording the
 * outgoing slug in `slug_history` so the old URL keeps 301-redirecting (#497
 * §5.1 — Option B "reconcile on write").
 *
 * MUST be called inside a transaction: the `slug_history` upsert and the
 * `Scholar.slug` update commit atomically, so the 301 mapping can never lag the
 * canonical change. The caller owns the transaction (the `/api/edit` write path
 * wraps it with the `field_override` upsert + B03 audit row; the ETL wraps it in
 * its per-scholar update). Collision authority is unchanged and external:
 * `Scholar.slug @unique` + the `slug_guard` UNIQUE index both guard, and this
 * `update` fails closed on either — rolling back the whole transaction.
 *
 * Returns `true` when the slug actually changed (and a history row was written),
 * `false` on the no-op when `newSlug` already equals the current slug.
 *
 * This is the single implementation of the "set the slug, record the old one"
 * step; the ED ETL's `maybeUpdatedSlug` delegates here rather than duplicating
 * the upsert-then-update logic.
 */
export async function reconcileScholarSlug(
  tx: SlugReconcileClient,
  cwid: string,
  newSlug: string,
): Promise<boolean> {
  const current = await tx.scholar.findUnique({
    where: { cwid },
    select: { slug: true },
  });
  // No scholar row (e.g. an override pinned ahead of the ED record per ADR-005
  // edge 6), or the slug is already what we want — nothing to reconcile.
  if (!current || current.slug === newSlug) return false;

  await tx.slugHistory.upsert({
    where: { oldSlug: current.slug },
    update: { currentCwid: cwid },
    create: { oldSlug: current.slug, currentCwid: cwid },
  });
  await tx.scholar.update({
    where: { cwid },
    data: { slug: newSlug },
  });
  return true;
}

// ---------------------------------------------------------------------------
// name-basis check (#678) — custom slugs are policy-constrained to be a variant
// of the scholar's OWN name (first/last/middle, in any order, optionally with a
// middle/first initial and the numeric collision suffix), not free-choice
// handles. Until now that policy was enforced only by superuser / ServiceNow
// review (`validateRequestedSlug` checked format/reserved/numeric/profanity but
// NOT name-derivation). `isNameBasedSlug` is the code enforcement: it blocks
// vanity slugs ("cancer", "the-best-lab") the format check alone admits.
//
// It is deliberately a *guardrail*, not a proof system. Single-letter initial
// segments are allowed (so "j-smith" and "john-a-smith" pass), which makes it
// mildly over-permissive for degenerate initial-only slugs — acceptable because
// the human review remains the authoritative gate; the goal here is to stop an
// obviously non-name slug from being auto-accepted by the dormant self-serve
// queue. A glued form ("jsmith") and the hyphenated form ("j-smith") are judged
// identically (hyphens are removed before segmentation).
// ---------------------------------------------------------------------------

/**
 * Slug-normalized word tokens of a set of name strings (a scholar's preferred
 * name + full name). Reuses {@link deriveSlug}'s normalization (diacritics,
 * apostrophes, punctuation) then splits on the hyphen separators it produces.
 * "John A. Smith" → {"john", "a", "smith"}; a non-romanizable name → ∅.
 */
function nameSlugTokens(names: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of deriveSlug(name).split("-")) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Whether `core` (a slug with hyphens removed and the trailing numeric collision
 * suffix already stripped) segments end-to-end into name `tokens` and single-
 * letter `initials` — i.e. it is built only from pieces of the scholar's name.
 * O(n²) word-break over n ≤ 64 (the slug length cap).
 */
function segmentsFromName(
  core: string,
  tokens: ReadonlySet<string>,
  initials: ReadonlySet<string>,
): boolean {
  const n = core.length;
  if (n === 0) return false;
  // reachable[i] === true ⇒ core[0..i) is a valid name-derived prefix.
  const reachable = new Array<boolean>(n + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue;
    if (initials.has(core[i])) reachable[i + 1] = true; // a first/middle initial
    for (let j = i + 1; j <= n; j++) {
      if (tokens.has(core.slice(i, j))) reachable[j] = true; // a full name token
    }
  }
  return reachable[n];
}

/**
 * True when `slug` is derivable from the scholar's name. `names` is the
 * scholar's preferred name + full name (caller order irrelevant). Returns
 * `false` when no usable name is supplied (nothing to derive from), so the
 * enforced request path fails closed.
 *
 * Accepts: any ordering of the name's word tokens, glued or hyphenated, with
 * single-letter first/middle initials and an optional `-2`/`-3` collision
 * suffix. Rejects: a slug containing a token (or stray digit) that is not part
 * of the name.
 */
export function isNameBasedSlug(slug: string, names: readonly string[]): boolean {
  const tokens = nameSlugTokens(names);
  if (tokens.size === 0) return false;
  const initials = new Set<string>();
  for (const token of tokens) initials.add(token[0]);

  const parts = slug.split("-");
  // Drop a single trailing numeric collision suffix (`-2`, `-3`, …).
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
  const core = parts.join("");
  return segmentsFromName(core, tokens, initials);
}
