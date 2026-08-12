/**
 * Journal-abbreviation normalization, shared by `etl/journal-impact-factor`
 * (writes `JournalImpactFactor.journalAbbrev`) and
 * `lib/edit/cancer-center-publications-report.ts` (reads
 * `Publication.journalAbbrev` at query time) so both sides of the join
 * normalize identically — a drift here would silently break every match.
 *
 * Trim + uppercase, nothing else. `Publication.journalAbbrev` is NLM/Index
 * Medicus style ("N Engl J Med"); reciterdb's `journal_impact_alternative
 * .journalAbbrName` is Web-of-Science style ("NEW ENGL J MED") — two
 * DIFFERENT abbreviation conventions, not just different casing, so
 * normalizing case does not make every publication's journal matchable. See
 * the `ponytail:` comment on the report module for the resulting match rate
 * and the accepted upgrade path.
 */
export function normalizeJournalAbbrev(raw: string): string {
  return raw.trim().toUpperCase();
}
