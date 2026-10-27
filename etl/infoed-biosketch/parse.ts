/**
 * Pure parser: NIH biosketches out of the extracted text of an InfoEd proposal PDF.
 *
 * Two layouts are in the wild:
 *  - "common" — the NIH Biosketch Common Form (2026+): `NIH BIOGRAPHICAL SKETCH
 *    COMMON FORM Name: Last, First Persistent Identifier (PID)…: https://orcid.org/<iD>`,
 *    with the Personal Statement / Honors / Contributions in the NIH supplement.
 *    Carries the ORCID iD, almost never a MyNCBI link.
 *  - "legacy" — the pre-2026 form: `BIOGRAPHICAL SKETCH … NAME: Last, First eRA
 *    COMMONS USER NAME … A. Personal Statement … B. Positions … C. Contributions to
 *    Science`, ending in the MyNCBI "complete list of published work" link. No ORCID.
 *
 * Attribution, strongest first: the SF424 "PROFILE - Senior/Key Person" block lists
 * each person's First/Last name and E-Mail; for WCM people the email local part is
 * the CWID ("email"). Failing that, a unique last-name + first-initial match against
 * the proposal's InfoEd personnel ("name"). Packages also carry external
 * collaborators' biosketches — those match neither and are dropped.
 */

export type Person = { cwid: string; first: string; last: string };

export type ParsedBiosketch = {
  cwid: string;
  format: "common" | "legacy";
  attributedBy: "email" | "name";
  orcid: string | null;
  personalStatement: string | null;
  contributions: string | null;
  honors: string | null;
  myncbiUrl: string | null;
};

// TEXT is 65,535 bytes; utf8mb4 is up to 4 bytes a character.
const MAX_SECTION = 15_000;
const MIN_SECTION = 200;

const MYNCBI = /https?:\/\/www\.ncbi\.nlm\.nih\.gov\/(?:sites\/)?myncbi\/[^\s)>"'<]+/i;
const ORCID = /orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

export const normName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** ISO 7064 11,2 — the check digit ORCID defines. */
export function orcidChecksumOk(id: string): boolean {
  const d = id.replace(/-/g, "");
  if (!/^\d{15}[\dX]$/.test(d)) return false;
  let t = 0;
  for (const c of d.slice(0, 15)) t = (t + Number(c)) * 2;
  const r = (12 - (t % 11)) % 11;
  return (r === 10 ? "X" : String(r)) === d[15];
}

/** Text after `head` up to the next of `next`; null unless substantive. */
function section(sketch: string, head: RegExp, next: RegExp): string | null {
  const m = head.exec(sketch);
  if (!m) return null;
  const rest = sketch.slice(m.index + m[0].length, m.index + m[0].length + 40_000);
  const end = rest.search(next);
  const body = (end >= 0 ? rest.slice(0, end) : rest.slice(0, 6_000)).trim();
  return body.length > MIN_SECTION ? body.slice(0, MAX_SECTION) : null;
}

const nameKey = (last: string, first: string) => `${normName(last)}|${normName(first)[0] ?? ""}`;

export function parseBiosketches(text: string, personnel: readonly Person[]): ParsedBiosketch[] {
  const flat = text.replace(/\s+/g, " ");

  const byEmail = new Map<string, string>();
  for (const m of flat.matchAll(
    /First Name\*:\s*(\S+).{0,60}?Last Name\*:\s*(.+?)\s+Suffix:.{0,900}?E-Mail\*:\s*([\w.+-]+)@([\w.-]+)/g,
  )) {
    if (/cornell\.edu$/i.test(m[4])) byEmail.set(nameKey(m[2], m[1]), m[3].toLowerCase());
  }
  const byName = (last: string, first: string): string | null => {
    const key = nameKey(last, first);
    const hits = new Set(personnel.filter((p) => nameKey(p.last, p.first) === key).map((p) => p.cwid));
    return hits.size === 1 ? [...hits][0] : null;
  };

  const common = flat
    .split(/BIOGRAPHICAL SKETCH COMMON FORM/i)
    .slice(1)
    .filter((s) => /^\s*Name:/i.test(s))
    .map((s) => ({ s, name: /Name:\s*([^,]+),\s*(\S+)/.exec(s), format: "common" as const }));
  // A package is one layout or the other; the legacy split would re-find every
  // common-form sketch (its header contains "BIOGRAPHICAL SKETCH").
  const legacy = common.length
    ? []
    : flat
        .split(/BIOGRAPHICAL SKETCH/i)
        .slice(1)
        .map((s) => ({ s, name: /NAME\s*:\s*([^,]{2,40}),\s*(\S+).{0,80}?eRA COMMONS/i.exec(s), format: "legacy" as const }));

  const out: ParsedBiosketch[] = [];
  for (const { s, name, format } of [...common, ...legacy]) {
    if (!name) continue;
    const viaEmail = byEmail.get(nameKey(name[1], name[2]));
    const cwid = viaEmail ?? byName(name[1], name[2]);
    if (!cwid) continue;
    const body = s.slice(0, 80_000);
    const orcid = ORCID.exec(body.slice(0, 600))?.[1] ?? null;
    out.push({
      cwid,
      format,
      attributedBy: viaEmail ? "email" : "name",
      orcid: orcid && orcidChecksumOk(orcid) ? orcid : null,
      personalStatement: section(
        body,
        /(?:A\.\s*)?Personal Statement/i,
        /B\.\s*Positions|\bHonors\b|Contributions? to Science|Synergistic|PROFESSIONAL PREPARATION/i,
      ),
      contributions: section(
        body,
        /(?:C\.\s*)?Contributions? to Science/i,
        /D\.\s*(?:Additional|Research Support|Scholastic)|Complete List|BIOGRAPHICAL SKETCH|Research Support/i,
      ),
      honors: section(
        body,
        /B\.\s*Positions[^.]{0,60}Honors|\bHonors\b/i,
        /C\.\s*Contributions?|Contributions? to Science|Personal Statement/i,
      ),
      // Legacy only: the Common Form has no MyNCBI field, and a common-form
      // sketch's text runs on to the end of the package, so a link found there
      // is another person's (17 of 25 such links on staging matched someone else).
      myncbiUrl: format === "legacy" ? (MYNCBI.exec(body)?.[0]?.slice(0, 512) ?? null) : null,
    });
  }
  return out;
}
