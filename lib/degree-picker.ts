/**
 * Degree picker — pure, client-safe.
 *
 * `Scholar.postnominal` defaults to the Enterprise Directory string, which
 * directory-sync builds from ASMS keeping only terminal/doctoral degrees in
 * graduation-year order ("PhD, MD", no MPH). A scholar may replace it with a
 * pick drawn from their own ASMS `education` rows. Never free text: every
 * token must be one of `degreeOptions()` for that scholar, so nothing can be
 * displayed that ASMS does not hold, and no approval step is needed.
 *
 * Stored as a `field_override` row (`fieldName = "postnominal"`) whose value
 * is a JSON array of tokens. Display order is always `degreeOptions()` order
 * (fixed rank), never the order the client sent.
 *
 * Shared by the /edit UI, the write route, and the ED ETL so all three agree.
 */

/** `Scholar.postnominal` column width. */
export const POSTNOMINAL_MAX = 64;

/** `field_override.fieldName` for a scholar's degree pick. */
export const DEGREE_OVERRIDE_FIELD = "postnominal";

/** `SCHOLAR_DEGREE_PICKER` — wired per-env in BOTH `cdk/lib/app-stack.ts` (the
 *  picker + route) and `cdk/lib/etl-stack.ts` (the ED ETL applies the pick).
 *  OFF ⇒ no picker, the route rejects the field, and the ETL writes the ED
 *  value, so flipping it back self-heals on the next nightly. */
export function isDegreePickerEnabled(): boolean {
  return process.env.SCHOLAR_DEGREE_PICKER === "on";
}

/** Non-degrees ASMS uses as placeholders. Compared after normalization. */
const NOT_A_DEGREE = new Set([
  "Other",
  "Degree Info Pending",
  "Diploma",
  "HSC",
  "(unspecified degree)",
]);

/** Bachelor-named first-professional degrees: UK / Commonwealth medicine,
 *  dentistry, veterinary. ASMS flags these terminal and they are what such a
 *  scholar's MD is, so they are NOT excluded as bachelor's. */
const PROFESSIONAL_SINGLE = new Set(["BM", "BDS", "BVSc", "BAO", "MBBS", "BMBS", "BMBCh"]);
/** Parts of a comma-joined medical degree ("MB,BS", "BM,BCh", "MB,BCh,BAO"). A
 *  bare "BS" is a bachelor's; only inside such a compound is it professional. */
const PROFESSIONAL_PART = new Set(["MB", "BM", "BS", "BCh", "BChir", "BAO"]);
const MEDICAL = /^(MD|DO|MDCM|MB|BM|MBBS|BMBS|BMBCh|MBChB|MBBCh|Dr Med)$|^(MB|BM),/i;

/** Bachelor's and below. `B…`, Latin-order `AB` / `SB` / `ScB`, `LLB`,
 *  `PharmB`, `BsC`, associate `AA` / `AS` / `AAS`, intermediate `ISc` / `FA`. */
const BACHELOR = /^(B|AB$|SB$|ScB$|AA$|AS$|AAS$|ISc$|FA$|LLB$|PharmB$|BsC$)/;

/** "M.P.H." → "MPH". Same period strip directory-sync applies, so a pick reads
 *  like the ED value it replaces. */
export function normalizeDegree(raw: string): string {
  return raw.replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/**
 * One ASMS title can hold several degrees ("M.D., Ph.D."). Split on comma +
 * space only: "M.B.,B.S." (no space) is ONE degree, MBBS. A professional
 * compound like "MB,BCh" stays whole; its parts are checked individually.
 */
export function splitTitle(raw: string): string[] {
  return raw
    .split(/,\s+/)
    .map(normalizeDegree)
    .filter((t) => t.length > 0);
}

function isBachelor(token: string): boolean {
  if (PROFESSIONAL_SINGLE.has(token)) return false;
  const parts = token.split(",").map((p) => p.trim());
  if (parts.length > 1 && MEDICAL.test(token) && parts.every((p) => PROFESSIONAL_PART.has(p))) {
    return false;
  }
  return BACHELOR.test(parts[0]);
}

/** Fixed display rank: medicine, then PhD, then other doctorates, then
 *  master's, then anything else. Ties break on graduation year. */
function rank(token: string): number {
  if (MEDICAL.test(token)) return 0;
  if (/^(PhD|DPhil)$/.test(token)) return 1;
  // DDS, DMD, DVM, PharmD, PsyD, EdD, ScD, DSc, JD, AuD, DrPH, DNP, …
  if (/D$|^D/.test(token) || PROFESSIONAL_SINGLE.has(token)) return 2;
  // MPH, MS, MSc, MBA, MA, … and Latin-order AM / SM / ScM / EdM.
  if (/^M|^(AM|SM|ScM|EdM)$/.test(token) || /^Pharm ?M$/.test(token)) return 3;
  return 4;
}

export type EducationDegreeRow = { degree: string; year: number | null };

/**
 * The scholar's selectable degrees, deduped, bachelor's and placeholders
 * removed, in display order. Empty ⇒ no picker (nothing to choose from).
 */
export function degreeOptions(rows: ReadonlyArray<EducationDegreeRow>): string[] {
  const firstYear = new Map<string, number>();
  for (const row of rows) {
    for (const token of splitTitle(row.degree)) {
      if (NOT_A_DEGREE.has(token) || /^Laurea/i.test(token) || isBachelor(token)) continue;
      const y = row.year ?? Number.MAX_SAFE_INTEGER;
      const prev = firstYear.get(token);
      if (prev === undefined || y < prev) firstYear.set(token, y);
    }
  }
  return [...firstYear.keys()].sort(
    (a, b) => rank(a) - rank(b) || firstYear.get(a)! - firstYear.get(b)! || a.localeCompare(b),
  );
}

/**
 * The ASMS-derived default for a scholar whose directory entry carries no
 * degree (postdocs, fellows, non-faculty academics: ED never sends one). Every
 * selectable degree in display order, master's included, with trailing tokens
 * dropped until it fits `Scholar.postnominal`. Null when nothing is selectable.
 */
export function defaultPostnominal(options: ReadonlyArray<string>): string | null {
  const tokens = [...options];
  while (tokens.length > 0 && tokens.join(", ").length > POSTNOMINAL_MAX) tokens.pop();
  return tokens.length > 0 ? tokens.join(", ") : null;
}

/**
 * Validate a pick against the options. Returns the tokens in display order,
 * or null when the pick is empty, malformed, or names anything not on offer.
 */
export function validateDegreePick(pick: unknown, options: ReadonlyArray<string>): string[] | null {
  if (!Array.isArray(pick) || pick.length === 0) return null;
  if (!pick.every((t): t is string => typeof t === "string" && options.includes(t))) return null;
  const chosen = new Set(pick);
  const tokens = options.filter((o) => chosen.has(o));
  // `Scholar.postnominal` is VARCHAR(64); a longer pick would fail the write.
  return tokens.join(", ").length <= POSTNOMINAL_MAX ? tokens : null;
}

/** The stored override value (JSON array) → display string, or null when the
 *  stored pick is unreadable or no longer valid against current ASMS rows. */
export function resolveDegreeOverride(
  stored: string,
  options: ReadonlyArray<string>,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const tokens = validateDegreePick(parsed, options);
  return tokens ? tokens.join(", ") : null;
}
