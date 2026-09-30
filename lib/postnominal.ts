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

import { isEnrolledDoctoralStudent } from "@/lib/eligibility";

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
 * Build the display name used by the mentee chip, the co-pubs pages and their
 * exports, the CV export, and the /edit news + honor queues. Applies postnominal
 * normalization so the rendered string is consistent across surfaces. Returns
 * `preferredName` alone when `postnominal` is null/empty/normalizes-away — or when
 * the scholar is an enrolled doctoral student.
 *
 * SEVEN CALL SITES, on these surfaces:
 *   - `lib/api/mentoring.ts` ×2 — `getMenteesForMentor` (the MENTEE CHIP) and
 *     `getMentorMenteePair` (the per-mentee `/scholars/<slug>/co-pubs/<menteeCwid>`
 *     page and its export route).
 *   - `app/(public)/scholars/[slug]/co-pubs/page.tsx` and `.../co-pubs/export/route.ts`
 *     — the rollup page's MENTOR name.
 *   - `lib/edit/news-queue.ts` and `lib/edit/honor-queue.ts` — the /edit queue rows.
 *   - `lib/api/profile.ts` — `publishedName` on the profile payload, which is the
 *     profile `<h1>`/metadata AND the WCM CV export's signature block and PI line.
 *
 * ENROLLED-STUDENT SUPPRESSION (#2599). ED overloads `weillCornellEduDegree`:
 * for the enrolled it holds the PROGRAMME of study as a full title ("Doctor of
 * Philosophy"), and for everyone else the EARNED credential as an abbreviation
 * ("PhD"). Measured on prod: 1,339 students carry a full title and 0 carry an
 * abbreviation; 0 postdocs carry a full title. `normalizePostnominal` (#201)
 * collapses "Doctor of Philosophy" → "PhD" for cross-surface consistency, which
 * erased exactly the distinction ED was encoding and rendered 1,339 enrolled
 * students as though they already held the doctorate.
 *
 * WHERE THAT WAS ANONYMOUSLY EXPOSED: the MENTEE CHIP (`getMenteesForMentor`,
 * `lib/api/mentoring.ts`), which reaches `components/scholar/mentoring-section.tsx`
 * on the public profile and the co-pubs rollup page. That surface is the #536 carve's
 * deliberate exception — a hidden identity class stays as a RELATIONAL mention there,
 * rendered as plain text — so it names doctoral students by design and nothing
 * upstream of it filters them out. The rollup page and its export route are NOT the
 * exposure: both resolve the mentor through `isPubliclyDisplayed` first (#2268), and
 * `isPubliclyDisplayed` is false for every role where `isEnrolledDoctoralStudent` is
 * true, so the suppression branch is unreachable from either. They pass `roleCategory`
 * for uniformity and defence-in-depth, not because a student can reach them.
 *
 * The suppression keys on `roleCategory`, NOT on the string form of the
 * postnominal. Keying on "is it a full title" would be right 99.6% of the time
 * and wrong in the way that matters: 4 faculty legitimately record an EARNED
 * degree in full-title form, and stripping a credential off a professor is a
 * worse failure than the one being fixed. `normalizePostnominal` is deliberately
 * left alone (it is #201's rule and this function is now its ONLY production
 * caller), so the earned full-title form still collapses to "PhD"/"MD".
 *
 * `roleCategory` is REQUIRED, not optional, so `tsc` names every call site. That is an
 * ARITY guard ONLY — its type admits `null`. A reviewer mutated all six then-existing
 * sites to a literal `null`: typecheck stayed clean and the whole ~10,700-test suite
 * stayed green, i.e. the feature could be made dark silently. Two sites now have call-site
 * tests that go red on exactly that mutation — the mentee chip
 * (`tests/unit/manual-mentees.test.ts`) and the news queue
 * (`tests/unit/news-queue.test.ts`). The other five are still arity-only; add a
 * call-site assertion before trusting one of them.
 *
 * Renders NOTHING after the name for the enrolled — no "PhD candidate" label.
 * That would assert candidacy (post-qualifying-exam status) inferred from a role
 * bucket rather than read from ED, which records no such thing.
 */
export function formatPublishedName(
  preferredName: string,
  postnominal: string | null | undefined,
  roleCategory: string | null | undefined,
): string {
  if (isEnrolledDoctoralStudent(roleCategory)) return preferredName;
  const normalized = normalizePostnominal(postnominal);
  return normalized ? `${preferredName}, ${normalized}` : preferredName;
}
