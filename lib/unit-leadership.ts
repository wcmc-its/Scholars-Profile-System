/**
 * Vice Chair roles (`UnitLeadershipRole`): the closed vocabularies and the
 * title normalizer.
 *
 * A department publishes its own Vice Chair titles, so the title is stored and
 * shown verbatim. `tier`, `functions` and `site` are derived for ordering,
 * filtering and the cross-department report; they are never shown as a title.
 *
 * IMPORT-FREE ON PURPOSE, like `lib/org-unit-roles.ts`: the `/edit` add form
 * suggests tier and areas as the title is typed, so this reaches the client
 * bundle and must never import `@/lib/db`.
 */

/** Display order: Executive first. */
export const LEADERSHIP_TIERS = ["executive", "senior", "vice", "associate", "assistant"] as const;
export type LeadershipTier = (typeof LEADERSHIP_TIERS)[number];

export const LEADERSHIP_TIER_LABELS: Record<LeadershipTier, string> = {
  executive: "Executive Vice Chair",
  senior: "Senior Vice Chair",
  vice: "Vice Chair",
  associate: "Associate Vice Chair",
  assistant: "Assistant Vice Chair",
};

/**
 * Function codes. Order is the match order AND the stored order. A pattern is
 * tested against the area text left after the tier, "Vice Chair", the
 * connector, the department name and the site are stripped.
 * `clinical_area` has no pattern: it is the fallback for an unmatched area.
 */
const FUNCTION_DEFS = [
  ["research", "Research", /research/],
  ["education", "Education", /education/],
  ["faculty_affairs", "Faculty affairs", /faculty|mentor|academic affairs|professional affairs|academics/],
  [
    "clinical_operations",
    "Clinical operations",
    /clinical(?: and \w+)? (?:operations|services|affairs)|inpatient|ambulatory|hospital services|operations/,
  ],
  ["quality_safety", "Quality and safety", /quality|safety/],
  ["informatics", "Informatics", /informatics/],
  ["innovation", "Innovation", /innovation/],
  ["strategy", "Strategy", /strategy|entrepreneur/],
  ["engagement_equity", "Engagement and equity", /diversity|equity|inclusion|health justice|engagement/],
  ["finance_admin", "Finance and administration", /finance|administration/],
  ["compliance", "Compliance", /compliance/],
  ["integrated_care", "Integrated care", /integrat|collaborative/],
  ["clinical_area", "Clinical area", null],
] as const;

export type LeadershipFunction = (typeof FUNCTION_DEFS)[number][0];
export const LEADERSHIP_FUNCTIONS = FUNCTION_DEFS.map((d) => d[0]) as LeadershipFunction[];
export const LEADERSHIP_FUNCTION_LABELS = Object.fromEntries(
  FUNCTION_DEFS.map((d) => [d[0], d[1]]),
) as Record<LeadershipFunction, string>;

const SITE_DEFS = [
  ["nyp_queens", "NewYork-Presbyterian Queens", /queens/],
  ["nyp_lower_manhattan", "NewYork-Presbyterian Lower Manhattan", /lower manhattan/],
  ["nyp_brooklyn_methodist", "NewYork-Presbyterian Brooklyn Methodist", /brooklyn methodist/],
  ["nyp_westchester", "NewYork-Presbyterian Westchester", /westchester/],
] as const;

export type LeadershipSite = (typeof SITE_DEFS)[number][0];
export const LEADERSHIP_SITES = SITE_DEFS.map((d) => d[0]) as LeadershipSite[];
export const LEADERSHIP_SITE_LABELS = Object.fromEntries(
  SITE_DEFS.map((d) => [d[0], d[1]]),
) as Record<LeadershipSite, string>;

/** The site named in free text (a title, or an audit note), if any. */
export function detectLeadershipSite(text: string): LeadershipSite | null {
  const t = text.toLowerCase();
  return SITE_DEFS.find((d) => d[2].test(t))?.[0] ?? null;
}

/** `functions` column <-> array. Stored comma-joined, vocabulary order. */
export function serializeFunctions(codes: readonly LeadershipFunction[]): string {
  return LEADERSHIP_FUNCTIONS.filter((c) => codes.includes(c)).join(",");
}
export function parseFunctions(stored: string): LeadershipFunction[] {
  const have = new Set(stored.split(","));
  return LEADERSHIP_FUNCTIONS.filter((c) => have.has(c));
}

export type ParsedLeadershipTitle = {
  /** The (sub)title exactly as written, trimmed. */
  displayTitle: string;
  tier: LeadershipTier;
  functions: LeadershipFunction[];
  /** Set only with `clinical_area`: the subspecialty the title names. */
  areaText: string | null;
  site: LeadershipSite | null;
};

const VICE_CHAIR = /vice[- ]?chair(?:man|woman|person)?/i;
const TIER_WORD = /\b(executive|senior|associate|assistant)\s+$/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Suggest tier / functions / site for a published title. A SUGGESTION: the
 * steward can change every field, and `displayTitle` is never rewritten.
 *
 *  - "for", "of", "in" and a comma after "Vice Chair" are equivalent.
 *  - "Vice Chairman" / "Vice-Chair" parse as Vice Chair.
 *  - The tier is the word before "Vice Chair" (none = `vice`).
 *  - The department's own name is not an area: "Vice Chair, Department of
 *    Surgery" has no function. Pass `departmentName` so "Vice Chair of
 *    Ophthalmology" reads the same way.
 *  - One role per "Vice Chair": "Vice Chair, Research; Vice Chair, Innovation"
 *    is two roles, "Vice Chair of Education and Faculty Development" is one
 *    role with two functions.
 *
 * Returns `[]` when the text has no "Vice Chair" in it.
 */
export function parseLeadershipTitle(title: string, departmentName?: string): ParsedLeadershipTitle[] {
  const parts = (title.match(/vice[- ]?chair/gi)?.length ?? 0) > 1 ? title.split(";") : [title];
  const dept = departmentName ? norm(departmentName) : "";
  const out: ParsedLeadershipTitle[] = [];
  for (const raw of parts) {
    const displayTitle = raw.trim();
    const m = VICE_CHAIR.exec(displayTitle);
    if (!m) continue;
    const tier = (TIER_WORD.exec(displayTitle.slice(0, m.index))?.[1].toLowerCase() ?? "vice") as LeadershipTier;
    const rest = displayTitle.slice(m.index + m[0].length);
    const site = detectLeadershipSite(rest);

    let area = norm(rest)
      .replace(/^(?:for|of|in)\b\s*/, "")
      .replace(/^the\b\s*/, "")
      // Site and institution names are not an area.
      .replace(/\b(?:newyork presbyterian|nyp|weill cornell medicine)\b.*$/, "")
      // "... in Obstetrics and Gynecology" / "... Department of X" trail the area.
      .replace(/\b(?:weill )?department of\b.*$/, "")
      .trim();
    if (dept) {
      if (area === dept) area = "";
      else if (area.endsWith(` in ${dept}`)) area = area.slice(0, -dept.length - 4).trim();
    }

    const functions: LeadershipFunction[] = [];
    for (const [code, , pattern] of FUNCTION_DEFS) {
      if (pattern?.test(area)) functions.push(code);
    }
    let areaText: string | null = null;
    if (area && functions.length === 0) {
      functions.push("clinical_area");
      // Keep the published casing for the subspecialty where we can find it.
      const i = norm(rest).indexOf(area);
      areaText = i >= 0 ? originalSlice(rest, area) : area;
    }
    out.push({ displayTitle, tier, functions, areaText, site });
  }
  return out;
}

/** The stretch of `original` whose normalized form is `area`, original casing. */
function originalSlice(original: string, area: string): string {
  const words = original.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j > i; j--) {
      if (norm(words.slice(i, j).join(" ")) === area) {
        return words
          .slice(i, j)
          .join(" ")
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      }
    }
  }
  return area;
}

/**
 * Vice Chairs are normally full-time faculty. Anyone else can still be added,
 * with a required note. `scholar.role_category` value.
 */
export function isFullTimeFaculty(roleCategory: string | null | undefined): boolean {
  return roleCategory === "full_time_faculty";
}
