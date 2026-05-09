/**
 * Shared publication-type exclusion lists. Single source of truth referenced
 * by every read path that surfaces publications to end users.
 *
 * Issue #63 — Retraction notices and Errata are not original scholarship and
 * should never appear on user-facing surfaces (profile, topic, dept, search,
 * autocomplete). Letters and Editorial Articles are out-of-scope for the
 * topic / home feeds by product decision but stay visible on profile pages.
 *
 * Out of scope here: flagging *Academic Articles that have been retracted*
 * (i.e. an article whose later retraction notice exists on a separate row).
 * That's a distinct product decision tracked separately.
 */

/** Types that must never be displayed anywhere — no list, no count, no
 *  search hit, no autocomplete suggestion. Apply on every read path. */
export const NEVER_DISPLAY_TYPES = ["Retraction", "Erratum"] as const;

/** Stricter list for feeds (home, topic) that also exclude lighter-weight
 *  pieces. Profile pages use NEVER_DISPLAY_TYPES alone so Letters and
 *  Editorial Articles authored by a scholar still appear in their record. */
export const FEED_EXCLUDED_TYPES = [
  ...NEVER_DISPLAY_TYPES,
  "Letter",
  "Editorial Article",
] as const;
