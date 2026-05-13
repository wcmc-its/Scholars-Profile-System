/**
 * Postnominal normalization (issue #201).
 *
 * `scholar.postnominal` originates upstream from ED's `weillCornellEduDegree`
 * LDAP attribute (see `etl/ed/index.ts`), which stores the full degree title
 * for some scholars ("Doctor of Philosophy", "Doctor of Medicine") and the
 * abbreviation for others ("PhD", "MD"). The published-name builder
 * concatenates this as `${preferredName}, ${postnominal}` across the
 * mentoring chip, the co-pubs rollup page, and the CSV/Word exports — so
 * the same mentee renders as both "Ashna Singh, PhD" and
 * "Ashna Singh, Doctor of Philosophy" depending on which scholar record
 * happens to hold the full-title form.
 *
 * `normalizePostnominal` collapses the full-title forms to their canonical
 * abbreviation so the rendered name is consistent across surfaces. The
 * normalization is intentionally conservative: only the two forms actually
 * observed in production (Doctor of Philosophy → PhD, Doctor of Medicine →
 * MD) are rewritten. Anything else passes through unchanged.
 *
 * If a future ETL run surfaces an unrecognized "Doctor of …" form, dev
 * builds log a warning so we can decide whether to extend the map.
 */

const FULL_TITLE_TO_ABBREV: ReadonlyMap<string, string> = new Map([
  ["doctor of philosophy", "PhD"],
  ["doctor of medicine", "MD"],
]);

function normalizeSegment(seg: string): string {
  const trimmed = seg.trim();
  if (trimmed.length === 0) return trimmed;
  const mapped = FULL_TITLE_TO_ABBREV.get(trimmed.toLowerCase());
  if (mapped) return mapped;
  if (
    process.env.NODE_ENV !== "production" &&
    /^doctor of\b/i.test(trimmed)
  ) {
    // Surface unrecognized "Doctor of …" variants during dev/test so we
    // can decide whether to extend FULL_TITLE_TO_ABBREV.
    // eslint-disable-next-line no-console
    console.warn(
      `[postnominal] unrecognized full-title postnominal: ${JSON.stringify(trimmed)} — leaving unchanged`,
    );
  }
  return trimmed;
}

export function normalizePostnominal(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const segments = raw
    .split(",")
    .map(normalizeSegment)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return segments.join(", ");
}

/**
 * Build the display name used by the mentee chip, co-pubs page, and
 * exports. Applies postnominal normalization so the rendered string is
 * consistent across surfaces. Returns `preferredName` alone when
 * `postnominal` is null/empty/normalizes-away.
 */
export function formatPublishedName(
  preferredName: string,
  postnominal: string | null | undefined,
): string {
  const normalized = normalizePostnominal(postnominal);
  return normalized ? `${preferredName}, ${normalized}` : preferredName;
}
