// POPS physician-directory enrichment for the WCM CV generator (spec §6).
// Fetch-at-generation, zero-persist: one GET keyed by cwid, clinical faculty only.
// Best-effort — fetchPops returns null on 404/no-profile/unreachable and NEVER throws
// into the CV path; the mapper coerces POPS's string-booleans and honors row-level is_hidden.

export const POPS_BASE_URL = process.env.POPS_BASE_URL ?? "http://pops.weillcornell.org";

export interface PopsBoardCert {
  board: string;
  specialty: string | null;
}
// Residency/Fellowship/Internship; "Medical School" rows are dropped (redundant with degrees).
export interface PopsTraining {
  type: string;
  institution: string;
}
export interface PopsDegree {
  degree: string;
  year: string | null;
  institution: string;
}
export interface PopsAppointment {
  title: string;
  institution: string;
  start: string | null;
  end: string | null;
}
export interface PopsHonor {
  name: string;
  date: string | null;
}
// A named clinical practice/service (e.g. "Vitreoretinal and Macular Diseases").
export interface PopsPractice {
  name: string;
  type: string | null;
}
export interface PopsEnrichment {
  npi: string | null;
  boardCertifications: PopsBoardCert[];
  training: PopsTraining[];
  degrees: PopsDegree[];
  appointments: PopsAppointment[];
  honors: PopsHonor[];
  specialties: string[];
  /** Named clinical practices/services — WCM §14 Clinical Activities (Practice). */
  practices: PopsPractice[];
  /** Clinical expertise areas (problem_procedure) — WCM §14 Clinical Activities. */
  expertise: string[];
  /** Castle Connolly "Top Doctor" recognition — surfaced as an honor when true. */
  castleConnolly: boolean;
}

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const asArray = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(asObj) : []);

// POPS encodes booleans as the strings 'True' | 'False' | 'None' (or real booleans/null).
function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

// Trim to a clean string, treating empty / 'None' as absent.
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== "none" ? s : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&bull;|&#8226;|&#x2022;/gi, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Leading month-year ("January 2010"), m/yyyy, or bare year → Date column.
const HONOR_DATE_RE =
  /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s+(.+)$/;

// honors_and_awards is unstructured HTML in three real shapes: <p>-wrapped honors, bare <li>
// lists with no <p>, and Word-paste lists that smuggle CSS into a sibling <p>/<style>. Prefer
// <li> items when present (each = one honor — 27% of live entries are list-shaped with no <p>),
// else <p> blocks, else split on <br>; an entry with none of these stays a single block.
function honorBlocks(html: string): string[] {
  const lis = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi);
  const ps = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
  return lis ?? ps ?? html.split(/<br\s*\/?>/i);
}

// Microsoft-Word paste leaks <style> CSS ("table.MsoNormalTable {…}", "Normal 0 false …").
const WORD_JUNK_RE = /mso-|MsoNormal|panose|Normal\s+0\s+false|Style Definitions/i;

function parseHonors(html: unknown): PopsHonor[] {
  if (typeof html !== "string" || !html.trim()) return [];
  return honorBlocks(html)
    .map(stripTags)
    .filter((text) => Boolean(text) && !WORD_JUNK_RE.test(text))
    .map((text) => {
      const m = HONOR_DATE_RE.exec(text);
      // ponytail: leading month-year / year only; comma-led/trailing/range dates and a single-line
      // bullet list keep the whole text as the name (residual ceiling, spec §13.2).
      return m ? { name: m[2].trim(), date: m[1].trim() } : { name: text, date: null };
    });
}

function mapProfile(p: Obj): PopsEnrichment {
  return {
    npi: str(p.npi_number),
    boardCertifications: asArray(p.board_certifications)
      .map((c) => ({
        board: str(c.board_name) ?? "",
        specialty: str(asObj(c.mapped_specialty).name),
      }))
      .filter((c) => c.board),
    training: asArray(p.training)
      .map((t) => ({ type: str(t.training_type) ?? "", institution: str(t.institution) ?? "" }))
      .filter((t) => t.type && t.type.toLowerCase() !== "medical school"),
    degrees: asArray(p.degrees)
      .filter((d) => !coerceBool(d.is_hidden))
      .map((d) => ({
        degree: str(d.degree_type) ?? "",
        year: str(d.year_obtained),
        institution: str(d.institution) ?? "",
      }))
      .filter((d) => d.degree),
    appointments: asArray(p.appointments)
      .filter((a) => !coerceBool(a.is_hidden))
      .map((a) => ({
        title: str(a.title) ?? "",
        institution: str(a.institution) ?? "",
        start: str(a.termstartdate),
        end: str(a.termenddate),
      }))
      .filter((a) => a.title || a.institution),
    honors: parseHonors(p.honors_and_awards),
    specialties: asArray(p.primary_specialties)
      .map((s) => str(s.name))
      .filter((s): s is string => !!s),
    practices: asArray(p.practices)
      .map((pr) => ({ name: str(pr.name) ?? "", type: str(pr.practice_type) }))
      .filter((pr) => pr.name),
    expertise: asArray(p.problem_procedure)
      .map((pp) => str(pp.name))
      .filter((s): s is string => !!s),
    castleConnolly: coerceBool(p.has_castle_connolly_badge),
  };
}

export async function fetchPops(cwid: string): Promise<PopsEnrichment | null> {
  try {
    const res = await fetch(
      `${POPS_BASE_URL}/providerbyshortname/${encodeURIComponent(cwid)}.json`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { providerProfile?: unknown } | null;
    const profile = json?.providerProfile;
    // ponytail: key on the verified `providerProfile` wrapper; absence ⇒ no profile.
    if (!profile || typeof profile !== "object") return null;
    return mapProfile(profile as Obj);
  } catch {
    // Best-effort enrichment: never throw into the CV path.
    return null;
  }
}
