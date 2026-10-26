/**
 * `history_match` for etl/orcid-evidence (ORCID queue v2 spec, item 1): an
 * ORCID employment or education organization names an institution in the
 * scholar's OWN history — an ASMS degree (`education.institution`), an
 * external position (`profile_appointment.organization`, category EXTERNAL),
 * or a ReCiter Identity `institutions` entry (prior employers).
 *
 * Matching is on normalized names. Each name becomes one or more token lists:
 *   - folded (diacritics off), lowercased, `&` → "and", punctuation dropped,
 *     a leading "the" dropped, common abbreviations expanded ("Univ" →
 *     university, "Ctr" / "Centre" → center, "St" → saint, …), a few well-known
 *     acronyms expanded whole ("MIT", "UCSF", "MSKCC", …);
 *   - "University of X" also reads as "X University", and back, for a whole-name
 *     comparison only (never as the start of a longer name), and never for an X
 *     where the two forms are different places (`SWAP_EXCEPTIONS`: University
 *     of Washington is Seattle, Washington University is St. Louis);
 *   - a name made of several comma / semicolon separated institutions
 *     ("Massachusetts General Hospital, Harvard Medical School") also yields
 *     each part, but only when every distinctive part is itself an institution
 *     (has a head word: university, college, hospital, …), so the campus in
 *     "University of California, San Francisco" is never split off; a part with
 *     no distinctive word ("Department of Medicine, …") is ignored, and a part
 *     that is a multi-campus system's name ("State University of New York")
 *     never matches on its own (`SYSTEM_NAMES`).
 * Two token lists match when they are equal, or the shorter is the start of
 * the longer and what follows is either an "of" / "at" clause after a complete
 * institution name ("Albany Medical College" ↔ "Albany Medical College of Union
 * University"; never "University of Texas" ↔ "… at Austin") or only generic
 * words ("University of Rochester" ↔ "University of Rochester Medical
 * Center"). Either way the shorter must carry a distinctive word that is
 * not a weak descriptor: generic words alone ("University Hospital", "Medical
 * Center") never match, nor do they with only words like children's, state,
 * memorial or city ("Children's Hospital", "State University"; `WEAK`).
 *
 * ROR: the spec allows a ROR match "when we can resolve ours"; none of the
 * three history sources carries a ROR id, so names are the only key today.
 *
 * Pure; no I/O.
 */

export type HistorySource = "education" | "appointment" | "identity";
export type HistoryInstitution = { name: string; source: HistorySource };

/** One ORCID employment / education entry, as the evidence detail shows it. */
export type OrcidAffiliation = {
  name: string | null;
  ror: string | null;
  kind: "employment" | "education";
  start: number | null;
  end: number | null;
};

export type InstitutionPair = {
  orcid: {
    name: string;
    kind: "employment" | "education";
    start: number | null;
    end: number | null;
  };
  ours: { name: string; source: HistorySource | "wcm" };
};

/** Words that name a kind of institution, not which one. */
const GENERIC = new Set([
  "the",
  "of",
  "and",
  "at",
  "in",
  "for",
  "university",
  "universitat",
  "universite",
  "universidad",
  "universita",
  "universidade",
  "college",
  "hospital",
  "hospitals",
  "medical",
  "medicine",
  "center",
  "centers",
  "school",
  "schools",
  "institute",
  "institutes",
  "health",
  "healthcare",
  "sciences",
  "science",
  "research",
  "clinic",
  "clinics",
  "foundation",
  "faculty",
  "department",
  "division",
  "graduate",
  "system",
  "campus",
  "program",
  "laboratory",
  "laboratories",
  "academy",
  "national",
  "international",
  "general",
  "network",
]);

/** Not generic, but too common to tell one institution from another on their
 *  own: a name needs a distinctive word outside GENERIC and WEAK to match. */
const WEAK = new Set([
  "children",
  "childrens",
  "state",
  "memorial",
  "city",
  "cancer",
  "royal",
  "community",
  "regional",
  "county",
  "veterans",
  "women",
  "womens",
  "public",
  "central",
  "north",
  "south",
  "east",
  "west",
  "northern",
  "southern",
  "eastern",
  "western",
  "new",
  "saint",
  "mount",
  "eye",
  "heart",
  "technology",
  "polytechnic",
  "technical",
  "teaching",
  "rehabilitation",
  "presbyterian",
  "methodist",
  "baptist",
  "lutheran",
  "catholic",
  "jewish",
  "christian",
]);

/** X where "University of X" and "X University" are different places, so the
 *  swap never applies (Seattle vs St. Louis, Florida vs Ohio, …). */
const SWAP_EXCEPTIONS = new Set([
  "washington",
  "miami",
  "ohio",
  "indiana",
  "saint louis",
  "boston",
  "rochester",
  "new york",
  "pennsylvania",
  "texas",
  "california",
  "michigan",
  "kansas",
  "iowa",
  "oklahoma",
  "oregon",
  "georgia",
  "florida",
  "illinois",
  "kentucky",
  "mississippi",
  "missouri",
  "montana",
  "arizona",
  "colorado",
  "columbia",
  "virginia",
  "wisconsin",
]);

/** Multi-campus systems: one as a comma-separated part never matches alone. */
const SYSTEM_NAMES = new Set([
  "state university of new york",
  "city university of new york",
  "university of california",
  "university of texas",
  "university of texas system",
  "university of north carolina",
  "university of massachusetts",
  "university of wisconsin",
  "university of colorado",
  "university of illinois",
  "university of maryland",
  "university of missouri",
  "university of nebraska",
  "university of hawaii",
  "university of london",
  "university of alabama system",
  "university system of georgia",
  "university system of maryland",
  "california state university",
  "pennsylvania state university",
]);

/** Words that make a phrase an institution in its own right. */
const HEAD = new Set([
  "university",
  "universitat",
  "universite",
  "universidad",
  "universita",
  "universidade",
  "college",
  "hospital",
  "hospitals",
  "institute",
  "institutes",
  "school",
  "center",
  "clinic",
  "foundation",
  "laboratory",
  "academy",
]);

const ABBREVIATIONS: Record<string, string> = {
  univ: "university",
  inst: "institute",
  med: "medical",
  ctr: "center",
  cntr: "center",
  centre: "center",
  centres: "centers",
  hosp: "hospital",
  coll: "college",
  sch: "school",
  natl: "national",
  intl: "international",
  st: "saint",
  mt: "mount",
  dept: "department",
  hlth: "health",
};

/** Whole-name acronyms. Only unambiguous ones: "UNC" or "SUNY" name systems,
 *  "USC" is Southern California or South Carolina. */
const ACRONYMS: Record<string, string> = {
  mit: "massachusetts institute of technology",
  caltech: "california institute of technology",
  ucla: "university of california los angeles",
  ucsf: "university of california san francisco",
  ucsd: "university of california san diego",
  nyu: "new york university",
  upenn: "university of pennsylvania",
  jhu: "johns hopkins university",
  cuny: "city university of new york",
  mskcc: "memorial sloan kettering cancer center",
  mgh: "massachusetts general hospital",
  nih: "national institutes of health",
};

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** One phrase → its tokens (see the module doc). Pure. */
export function institutionTokens(phrase: string): string[] {
  const flat = fold(phrase)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/'s\b/g, "s")
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, "$1") // "U.S.A." → "usa"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (ACRONYMS[flat]) return ACRONYMS[flat]!.split(" ");
  const tokens = flat
    .split(" ")
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t);
  return tokens[0] === "the" ? tokens.slice(1) : tokens;
}

const distinctive = (tokens: readonly string[]) => tokens.some((t) => !GENERIC.has(t));
const strong = (tokens: readonly string[]) => tokens.some((t) => !GENERIC.has(t) && !WEAK.has(t));
const headed = (tokens: readonly string[]) => tokens.some((t) => HEAD.has(t));

/** One comparison unit: its tokens, and whether it is a swapped form (which
 *  matches only a whole name, never as a prefix). */
export type InstitutionVariant = { tokens: string[]; swapped: boolean };

/** Every token list a name is compared by (module doc). Pure. */
export function institutionVariants(name: string): InstitutionVariant[] {
  const units: string[][] = [institutionTokens(name)];
  const pieces = name.split(/[,;|]|\s[-–—/]\s/).map(institutionTokens);
  const parts = pieces.filter(distinctive);
  if (pieces.length > 1 && parts.length > 0 && parts.every(headed))
    units.push(...parts.filter((p) => !SYSTEM_NAMES.has(p.join(" "))));
  const out: InstitutionVariant[] = [];
  for (const u of units) {
    if (u.length === 0) continue;
    out.push({ tokens: u, swapped: false });
    let x: string[] | null = null;
    let swapped: string[] | null = null;
    if (u[0] === "university" && u[1] === "of" && u.length > 2) {
      x = u.slice(2);
      swapped = [...x, "university"];
    } else if (u.length >= 2 && u[u.length - 1] === "university") {
      x = u.slice(0, -1);
      swapped = ["university", "of", ...x];
    }
    if (x && swapped && !SWAP_EXCEPTIONS.has(x.join(" ")))
      out.push({ tokens: swapped, swapped: true });
  }
  return out;
}

function unitsMatch(a: InstitutionVariant, b: InstitutionVariant): boolean {
  const [short, long] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  const s = short.tokens;
  const l = long.tokens;
  if (!strong(s)) return false;
  if (s.some((t, i) => l[i] !== t)) return false;
  if (s.length === l.length) return true;
  // A swapped form is only ever compared whole.
  if (short.swapped || long.swapped) return false;
  const rest = l.slice(s.length);
  // An "of" / "at" clause only after a complete institution name ("Albany Medical
  // College of …"), never after a system name ("University of Texas at Austin").
  const clause = (rest[0] === "of" || rest[0] === "at") && HEAD.has(s[s.length - 1]!);
  return clause || !distinctive(rest);
}

/** Two institution names name the same place (module doc). Pure. */
export function institutionsMatch(a: string, b: string): boolean {
  const va = institutionVariants(a);
  const vb = institutionVariants(b);
  return va.some((x) => vb.some((y) => unitsMatch(x, y)));
}

/** Every (ORCID affiliation, history institution) pair that matches, once each. Pure. */
export function historyMatches(
  orgs: readonly OrcidAffiliation[],
  history: readonly HistoryInstitution[],
): InstitutionPair[] {
  const out: InstitutionPair[] = [];
  const seen = new Set<string>();
  for (const o of orgs) {
    if (!o.name?.trim()) continue;
    for (const h of history) {
      if (!h.name.trim() || !institutionsMatch(o.name, h.name)) continue;
      const k = `${o.name}|${o.kind}|${o.start}|${h.name}|${h.source}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        orcid: { name: o.name.trim(), kind: o.kind, start: o.start, end: o.end },
        ours: { name: h.name.trim(), source: h.source },
      });
    }
  }
  return out;
}
