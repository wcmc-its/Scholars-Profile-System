/**
 * Pure row logic for the #1761 honors seed import — parsing/validation and the
 * status-merge rule, split out so tests never need a DB.
 *
 * The status-merge rule is the load-bearing part: an import re-run must NEVER
 * overwrite a curator's decision. Only a `pending` row accepts the file's
 * status; `published`/`rejected` were set by a human (queue decision) and are
 * kept regardless of what the seed file says. `rejected is terminal` is a
 * documented-but-unenforced DB invariant (#1762) — this keeps the seed path on
 * the right side of it.
 */

export const HONOR_CATEGORIES = [
  "ACADEMY_MEMBERSHIP",
  "INVESTIGATORSHIP",
  "PRIZE",
  "OTHER",
] as const;
export const HONOR_STATUSES = ["published", "pending", "rejected"] as const;

export type SeedRow = {
  cwid: string;
  name: string;
  organization: string;
  year: number | null;
  category: (typeof HONOR_CATEGORIES)[number];
  status: (typeof HONOR_STATUSES)[number];
  showOnProfile: boolean;
  source: string;
  sourceRef: string | null;
  enteredByCwid: string;
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** Validate a parsed JSON array into SeedRows. Row-indexed errors, no throws. */
export function parseSeedRows(input: unknown): { rows: SeedRow[]; errors: string[] } {
  const rows: SeedRow[] = [];
  const errors: string[] = [];
  if (!Array.isArray(input)) return { rows, errors: ["seed file is not a JSON array"] };
  input.forEach((raw, i) => {
    const r = raw as Record<string, unknown>;
    const errorsBefore = errors.length;
    const at = (msg: string) => errors.push(`row ${i}: ${msg}`);
    for (const f of ["cwid", "name", "organization", "source", "enteredByCwid"] as const) {
      if (!isNonEmptyString(r[f])) at(`missing/empty ${f}`);
    }
    if (!(HONOR_CATEGORIES as readonly string[]).includes(r.category as string))
      at(`bad category ${JSON.stringify(r.category)}`);
    if (!(HONOR_STATUSES as readonly string[]).includes(r.status as string))
      at(`bad status ${JSON.stringify(r.status)}`);
    if (!(r.year === null || r.year === undefined || Number.isInteger(r.year)))
      at(`bad year ${JSON.stringify(r.year)}`);
    if (r.sourceRef !== null && r.sourceRef !== undefined && !isNonEmptyString(r.sourceRef))
      at("sourceRef present but empty");
    if (errors.length === errorsBefore) {
      rows.push({
        cwid: (r.cwid as string).trim(),
        name: (r.name as string).trim(),
        organization: (r.organization as string).trim(),
        year: (r.year as number | null | undefined) ?? null,
        category: r.category as SeedRow["category"],
        status: r.status as SeedRow["status"],
        showOnProfile: r.showOnProfile === undefined ? true : Boolean(r.showOnProfile),
        source: (r.source as string).trim(),
        sourceRef: isNonEmptyString(r.sourceRef) ? (r.sourceRef as string).trim() : null,
        enteredByCwid: (r.enteredByCwid as string).trim(),
      });
    }
  });
  return { rows, errors };
}

/**
 * Fold a key part the way the DB compares it. `honor` is utf8mb4_unicode_ci, so
 * the upsert's WHERE treats "Fellow"/"fellow" and "Société"/"Societe" as equal.
 * A byte-exact JS key would score those pairs 0 while the DB merges them —
 * exactly the undercount this gate exists to end. (Trailing space needs no
 * handling: parseSeedRows already trims.)
 *
 * ponytail: NFD + lowercase covers case and Latin accents, not every UCA
 * equivalence (utf8mb4_unicode_ci also folds ß = ss). If that ever matters, do
 * the dedup as a GROUP BY in the DB instead of in JS.
 */
const collationFold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Rows whose (cwid, organization, name) repeats an EARLIER row (#2010). The
 * upsert key excludes `year` on purpose (#1761), so two input rows sharing the
 * triple are not two honors — the second overwrites the first and is counted as
 * an ordinary "updated". Returns how many rows merge away: summed over each
 * duplicated key, (occurrences - 1). Zero means the file is one row per honor.
 */
export function countMergingRows(rows: SeedRow[]): number {
  const seen = new Set<string>();
  let merging = 0;
  for (const r of rows) {
    const key = JSON.stringify([r.cwid, r.organization, r.name].map(collationFold));
    if (seen.has(key)) merging += 1;
    else seen.add(key);
  }
  return merging;
}

/** The seed may set status only while the row is still pending. */
export function statusOnUpdate(
  existing: SeedRow["status"],
  incoming: SeedRow["status"],
): SeedRow["status"] {
  return existing === "pending" ? incoming : existing;
}
