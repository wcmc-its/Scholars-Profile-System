/**
 * WCM faculty CV (.docx) builder — the core of the /edit "CV (WCM format)" tool.
 *
 * Fills the OFFICIAL WCM faculty-CV template (`lib/edit/assets/wcm-cv-template.docx`)
 * with the scholar's structured data, mirroring CViche's approach
 * (`stage_6_word_template.py`: load the template, inject into its own tables and
 * paragraphs). This inherits the template's exact headings, subsections, table
 * columns, fonts, and prompts — a true WCM-format document, not a reconstruction.
 * The OOXML engine lives in `cv-template.ts`; this module owns the section→data
 * mapping. Sections without data keep the template's blank prompts for the
 * scholar to complete ("pre-fill, then finish the rest").
 *
 * Sources (spec §5 coverage matrix, docs/scholar-cv-generator-spec.md):
 *   S = Scholars (`ProfilePayload`, suppression-honoring) · P = POPS (clinical
 *   only) · L = LLM research summary (M1).
 */
import type { ProfilePayload } from "@/lib/api/profile";
import type { MenteeChip } from "@/lib/api/mentoring";
import {
  appendToLabelParagraph,
  applyTableStyling,
  fillGrid,
  fillTablePerEntry,
  findTable,
  insertParagraphsAfter,
  loadTemplate,
  makeParagraph,
  serialize,
  setLabeledValue,
  tableAfterParagraph,
  type Run,
} from "./cv-template";
import type { PopsEnrichment } from "./pops";
export type {
  PopsEnrichment,
  PopsBoardCert,
  PopsTraining,
  PopsDegree,
  PopsAppointment,
  PopsHonor,
  PopsPractice,
} from "./pops";

/**
 * Full citation row for the bibliography. Mirrors the (module-private)
 * `PubForCitation` shape in `lib/api/word-bibliography.ts`.
 */
export type PubForCitation = {
  pmid: string;
  title: string;
  authorsString: string | null;
  fullAuthorsString: string | null;
  journal: string | null;
  journalAbbrev: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  pmcid: string | null;
};

/** Route ↔ builder contract. The route owns all I/O; the builder is pure-ish
 *  (reads the bundled template file, no DB/LLM/network). */
export interface CvInput {
  profile: ProfilePayload;
  mentees: MenteeChip[];
  researchSummary: string;
  pops: PopsEnrichment | null;
  bibliography: PubForCitation[];
}

/** EDIT_CV_EXPORT flag — gates the "CV (WCM format)" Tools rail item + route. */
export function isCvEnabled(): boolean {
  return process.env.EDIT_CV_EXPORT === "on";
}

const NA = "N/A";

// ── small formatting helpers ────────────────────────────────────────────────

function year(date: string | null | undefined): string {
  if (!date) return "";
  const m = /(\d{4})/.exec(date);
  return m ? m[1]! : "";
}

/** "YYYY–YYYY", "YYYY–Present", "YYYY", or "" — never fabricates a date. */
function dateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  isActive = false,
): string {
  const s = year(start);
  const e = isActive ? "Present" : year(end);
  if (!s && !e) return "";
  if (s && e) return `${s}–${e}`;
  return s || e;
}

function todayLong(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// ── bibliography citation (bold scholar surname) ────────────────────────────

const WCM_MARKER_TOKEN_RE = /^\(\((.+)\)\)$/;
function unwrapMarker(token: string): string {
  const m = WCM_MARKER_TOKEN_RE.exec(token);
  return m ? m[1]! : token;
}

/** Surname key for the bolding set: drop ", MD"-style postnominals, take the
 *  final whitespace token, lower-cased. */
export function lastNameKey(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return (tokens[tokens.length - 1] ?? "").toLowerCase();
}

/** Author list as runs, bolding the scholar's surname tokens. */
function authorRuns(authorsString: string | null, selected: ReadonlySet<string>): Run[] {
  if (!authorsString) return [{ text: "" }];
  const tokens = authorsString
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [{ text: authorsString }];
  const runs: Run[] = [];
  tokens.forEach((rawToken, idx) => {
    if (idx > 0) runs.push({ text: ", " });
    const display = unwrapMarker(rawToken);
    const surname = (display.split(/\s+/)[0] ?? "").replace(/[^\p{L}'-]/gu, "").toLowerCase();
    runs.push({ text: display, bold: selected.has(surname) });
  });
  return runs;
}

function volIssuePages(volume: string | null, issue: string | null, pages: string | null): string {
  if (!volume && !issue && !pages) return "";
  let s = "";
  if (volume) s += volume;
  if (issue) s += `(${issue})`;
  if (pages) s += `:${pages}`;
  return s;
}

/** A single Vancouver citation as runs (surname bold). Plain text — PMID/DOI are
 *  not hyperlinked (the template-fill path avoids relationship plumbing). */
function citationRuns(index: number, pub: PubForCitation, selected: ReadonlySet<string>): Run[] {
  const runs: Run[] = [{ text: `${index + 1}. ` }];
  runs.push(...authorRuns(pub.fullAuthorsString ?? pub.authorsString, selected));
  runs.push({ text: ". " });
  runs.push({ text: `${pub.title.replace(/\.+$/, "")}. ` });
  const journal = pub.journalAbbrev ?? pub.journal;
  if (journal) runs.push({ text: `${journal}. ` });
  const vip = volIssuePages(pub.volume, pub.issue, pub.pages);
  if (pub.year !== null) runs.push({ text: vip ? `${pub.year};${vip}. ` : `${pub.year}. ` });
  if (pub.doi) runs.push({ text: `doi: ${pub.doi}. ` });
  runs.push({ text: `PMID: ${pub.pmid}${pub.pmcid ? `; PMCID: ${pub.pmcid}` : ""}.` });
  return runs;
}

// ── data → rows ─────────────────────────────────────────────────────────────

function educationRows(p: ProfilePayload, pops: PopsEnrichment | null): string[][] {
  const rows: string[][] = [];
  const seen = new Set<string>();
  const add = (degree: string, institution: string, yr: string) => {
    const key = `${degree}|${institution}`.toLowerCase();
    if (!degree || seen.has(key)) return;
    seen.add(key);
    rows.push([degree, institution, "", yr]); // [Degree+field, Institution, Dates attended, Year]
  };
  for (const e of p.educations) {
    add(e.field ? `${e.degree} (${e.field})` : e.degree, e.institution, e.year ? String(e.year) : "");
  }
  for (const d of pops?.degrees ?? []) add(d.degree, d.institution, d.year ?? "");
  return rows;
}

function appointmentRows(
  p: ProfilePayload,
  pops: PopsEnrichment | null,
): { academic: string[][]; hospital: string[][] } {
  const isHospital = (org: string) => /presbyterian|hospital|\bnyp\b|medical center/i.test(org);
  const academic: string[][] = [];
  const hospital: string[][] = [];
  const seen = new Set<string>();
  const add = (title: string, org: string, dates: string) => {
    const key = `${title}|${org}`.toLowerCase();
    if ((!title && !org) || seen.has(key)) return;
    seen.add(key);
    (isHospital(org) ? hospital : academic).push([title, org, dates]);
  };
  for (const a of p.appointments) add(a.title, a.organization, dateRange(a.startDate, a.endDate, a.isActive));
  for (const a of pops?.appointments ?? []) add(a.title, a.institution, dateRange(a.start, a.end));
  return { academic, hospital };
}

function honorRows(pops: PopsEnrichment | null): string[][] {
  const rows = (pops?.honors ?? []).map((h) => [h.name || NA, "", h.date ?? ""]);
  if (pops?.castleConnolly) rows.push(["Castle Connolly Top Doctor", "Castle Connolly", ""]);
  return rows;
}

// ── public builder ──────────────────────────────────────────────────────────

/** Build the WCM CV by filling the official template, returning the .docx bytes. */
export async function buildWcmCvBuffer(input: CvInput): Promise<Buffer> {
  const { profile: p, pops } = input;
  const t = await loadTemplate();
  const doc = t.doc;

  // 1. Fill the signature block (the WCM instruction box is kept, per the
  //    template's own "delete this box on completion" guidance — left for the scholar).
  appendToLabelParagraph(doc, t, "Name:", p.publishedName);
  appendToLabelParagraph(doc, t, "Date of Preparation:", todayLong());

  // 2. Personal Data — only the work email when visible.
  if (p.email) {
    setLabeledValue(doc, findTable(t, (h) => (h[0] ?? "").startsWith("Office address")), "Work email:", p.email);
  }

  // 3. Education — Academic Degrees.
  fillGrid(doc, findTable(t, (h) => (h[0] ?? "").startsWith("Degree, include field")), educationRows(p, pops));

  // 4. Postdoctoral Training (POPS; dates unavailable → blank).
  fillGrid(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Title, include area of training")),
    (pops?.training ?? []).map((tr) => [tr.type || NA, tr.institution || NA, ""]),
  );

  // 5. Professional Positions — Academic vs Hospital (anchored by subheading, headers repeat).
  const appts = appointmentRows(p, pops);
  fillGrid(doc, tableAfterParagraph(t, (x) => x.startsWith("Academic Appointments")), appts.academic);
  fillGrid(doc, tableAfterParagraph(t, (x) => x.startsWith("Hospital Appointments")), appts.hospital);

  // 6. Licensure — NPI (no license #/dates fabricated); Board Certification.
  if (pops?.npi) {
    setLabeledValue(doc, findTable(t, (h) => (h[0] ?? "").startsWith("DEA number")), "NPI number:", pops.npi);
  }
  fillGrid(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Full Name of Board")),
    (pops?.boardCertifications ?? []).map((c) => [
      c.specialty ? `${c.board} (${c.specialty})` : c.board,
      "", // Certificate # — not available
      "", // Dates of Certification — not available
    ]),
  );

  // 7. Honors, Awards.
  fillGrid(doc, findTable(t, (h) => h[0] === "Name of award"), honorRows(pops));

  // 8. Research — Activities summary (M1) + Current Research Funding (one table per grant).
  if (input.researchSummary.trim()) {
    const paras = input.researchSummary
      .split(/\n{2,}/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => makeParagraph(doc, [{ text: s }]));
    insertParagraphsAfter(t, (x) => x.startsWith("Research Activities:"), paras);
  }
  fillTablePerEntry(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Award Source:")),
    p.grants,
    (clone, g) => {
      setLabeledValue(doc, clone, "Award Source:", g.funder || NA);
      setLabeledValue(doc, clone, "Project title:", g.title || NA);
      setLabeledValue(doc, clone, "Duration of support:", dateRange(g.startDate, g.endDate, g.isActive));
      setLabeledValue(doc, clone, "Name of Principal Investigator:", g.role === "Principal Investigator" ? p.publishedName : "");
      setLabeledValue(doc, clone, "Your role", g.role || "");
    },
  );

  // 9. Mentoring — Current Mentees (FERPA-filtered upstream), one table per mentee.
  fillTablePerEntry(
    doc,
    tableAfterParagraph(t, (x) => x.startsWith("Current Mentees")),
    input.mentees,
    (clone, m) => {
      const years = m.graduationYear
        ? String(m.graduationYear)
        : m.appointmentRange
          ? dateRange(
              String(m.appointmentRange.startYear),
              m.appointmentRange.endYear ? String(m.appointmentRange.endYear) : null,
              m.appointmentRange.endYear === null,
            )
          : "";
      setLabeledValue(doc, clone, "Name", m.fullName || NA);
      setLabeledValue(doc, clone, "Site/Position", m.programName ?? m.programType ?? "");
      setLabeledValue(doc, clone, "Expected Period", years);
    },
  );

  // 10. Institutional Leadership Activities.
  fillGrid(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Role(s)/Position")),
    p.leadershipTitles.map((title) => [title, "", ""]),
  );

  // 11. Bibliography — citation paragraphs with the scholar's surname bolded.
  if (input.bibliography.length > 0) {
    const selected = new Set([lastNameKey(p.preferredName)]);
    const paras = input.bibliography.map((pub, i) => makeParagraph(doc, citationRuns(i, pub, selected)));
    insertParagraphsAfter(t, (x) => x.startsWith("BIBLIOGRAPHY"), paras);
  }

  // 12. Style every table (incl. cloned ones) to match CViche's WCM output:
  //     D9D9D9 cell borders, shaded header row, vertical-centered, 4pt padding.
  applyTableStyling(t);

  return serialize(t);
}
