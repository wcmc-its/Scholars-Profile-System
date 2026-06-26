/**
 * WCM faculty CV (.docx) builder — the core of the /edit "CV (WCM format)" tool.
 *
 * Reconstructs the WCM faculty CV layout (template
 * `wcm_cv_template_faculty_october_2022_final.docx`, matched 1:1 by CViche
 * `stage_6_word_template.py:972-993`) in code with the `docx` library — NO new
 * deps, NO docxtemplater. The 23 sections render in the official template order;
 * a section with no data emits the literal "N/A" placeholder (the template's own
 * rule: sections are never deleted, enter "N/A").
 *
 * Sources (see spec §5 coverage matrix, docs/scholar-cv-generator-spec.md):
 *   S = Scholars (`ProfilePayload`, suppression-honoring) · P = POPS (clinical
 *   only) · L = LLM research summary (M1) · NA = no source anywhere.
 *
 * The builder is PURE/deterministic (no DB/LLM/network): the route assembles
 * `CvInput` and calls `buildWcmCv(input)`, then `Packer.toBuffer(doc)`.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { buildPubmedRuns } from "@/lib/pubmed-runs";
import type { ProfilePayload } from "@/lib/api/profile";
import type { MenteeChip } from "@/lib/api/mentoring";
// POPS enrichment types live in `lib/edit/pops.ts` (alongside `fetchPops` +
// `POPS_BASE_URL`) — single source of truth. Re-exported so consumers that only
// touch the builder can import `PopsEnrichment` from here too.
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
 * Full citation row for the §22 bibliography. Mirrors the (module-private)
 * `PubForCitation` shape in `lib/api/word-bibliography.ts`; the route queries
 * the `Publication` table for these because `ProfilePublication` lacks
 * `fullAuthorsString`/`journalAbbrev`/`volume`/`issue`/`pages`.
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

/** Route ↔ builder contract. The route owns all I/O; the builder is pure. */
export interface CvInput {
  /** Full suppression-honoring public projection — drives Identity, Personal
   *  Data, Education, Appointments, Hospital Affiliation, Grants, Leadership,
   *  Bibliography. */
  profile: ProfilePayload;
  /** FERPA-filtered mentees — §17 Mentoring. */
  mentees: MenteeChip[];
  /** M1 plain-prose research-activities paragraph(s) — §15. */
  researchSummary: string;
  /** POPS enrichment, clinical faculty only; null otherwise. */
  pops: PopsEnrichment | null;
  /** Full `PubForCitation` rows for the §22 bibliography. */
  bibliography: PubForCitation[];
}

/** EDIT_CV_EXPORT flag — gates the "CV (WCM format)" Tools rail item + route. */
export function isCvEnabled(): boolean {
  return process.env.EDIT_CV_EXPORT === "on";
}

/**
 * The 23 WCM faculty-CV section headings, in official template order. Exported
 * so the unit test asserts presence + order without duplicating the list.
 */
export const WCM_CV_SECTION_HEADINGS = [
  "CURRICULUM VITAE", // 1  header / signature
  "PERSONAL DATA", // 2
  "EDUCATION", // 3  Degrees (B1)
  "OTHER EDUCATIONAL EXPERIENCES", // 4  (B2)
  "POSTDOCTORAL TRAINING", // 5  (C)
  "PROFESSIONAL POSITIONS AND EMPLOYMENT", // 6  (D1/D2/D3)
  "EMPLOYMENT STATUS", // 7
  "LICENSURE AND BOARD CERTIFICATION", // 8  (F1/F2)
  "HOSPITAL AFFILIATION", // 9
  "HONORS AND AWARDS", // 10 (H)
  "PROFESSIONAL MEMBERSHIPS", // 11 (I)
  "PERCENT EFFORT", // 12
  "EDUCATIONAL CONTRIBUTIONS", // 13 (K1-K5)
  "CLINICAL ACTIVITIES", // 14 (L1-L3)
  "RESEARCH ACTIVITIES", // 15 (M1)
  "RESEARCH SUPPORT", // 16 (M2A/B/C + patents)
  "MENTORING", // 17 (N3A/N3B)
  "INSTITUTIONAL LEADERSHIP", // 18 (O)
  "INSTITUTIONAL ADMINISTRATIVE AND COMMITTEE SERVICE", // 19 (P)
  "EXTRAMURAL PROFESSIONAL ACTIVITIES", // 20 (Q1-Q4)
  "INVITATIONS TO SPEAK", // 21 (R)
  "BIBLIOGRAPHY", // 22 (S1/S2...)
  "APPENDIX", // 23 (T)
] as const;

const NA = "N/A";

// ── small formatting helpers ────────────────────────────────────────────────

/** Pull a 4-digit year from an ISO/loose date string; "" when absent. */
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
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ── docx building blocks ────────────────────────────────────────────────────

const HANGING_INDENT_TWIPS = 360; // 0.25"

// ponytail: flat single-line gray borders approximate the WCM table styling
// (header shading + 50%-gray 1px rules). Upgrade path: port the cell-shading +
// vertical-centering from CViche `_apply_table_styling_to_all_tables`.
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "808080" } as const;
const TABLE_BORDERS = {
  top: TABLE_BORDER,
  bottom: TABLE_BORDER,
  left: TABLE_BORDER,
  right: TABLE_BORDER,
  insideHorizontal: TABLE_BORDER,
  insideVertical: TABLE_BORDER,
};

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text, bold: true })],
  });
}

function subHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 80, after: 40 },
    children: [new TextRun({ text, bold: true, italics: true })],
  });
}

function plain(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text })] });
}

function naParagraph(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: NA })] });
}

function cell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: text || "", bold })] })],
  });
}

function table(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h) => cell(h, true)),
  });
  const dataRows = rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...dataRows],
  });
}

type Block = Paragraph | Table;

/** Emit a section: heading then body — or the "N/A" placeholder when empty. */
function section(heading: string, body: Block[]): Block[] {
  return [sectionHeading(heading), ...(body.length > 0 ? body : [naParagraph()])];
}

// ── bibliography citation (bold scholar surname) ────────────────────────────
//
// ponytail: replicates the bold-author Vancouver helpers that are currently
// module-private in `lib/api/word-bibliography.ts` (`buildAuthorRuns`,
// `lastNameKey`, `buildCitationParagraph`, `unwrapMarker`, `formatVolIssuePages`).
// Upgrade path: once those are `export`ed, delete the four helpers below and
// import them so the CV and the search-export bibliography share one renderer.

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

function buildAuthorRuns(
  authorsString: string | null,
  selectedLastNames: ReadonlySet<string>,
): TextRun[] {
  if (!authorsString) return [new TextRun({ text: "" })];
  const tokens = authorsString
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [new TextRun({ text: authorsString })];

  const runs: TextRun[] = [];
  tokens.forEach((rawToken, idx) => {
    if (idx > 0) runs.push(new TextRun({ text: ", " }));
    const display = unwrapMarker(rawToken);
    // PubMed token format is "Lastname Initials" — surname is the first
    // whitespace-separated word; strip residual punctuation.
    const surname = (display.split(/\s+/)[0] ?? "").replace(/[^\p{L}'-]/gu, "").toLowerCase();
    runs.push(new TextRun({ text: display, bold: selectedLastNames.has(surname) }));
  });
  return runs;
}

function formatVolIssuePages(
  volume: string | null,
  issue: string | null,
  pages: string | null,
): string {
  if (!volume && !issue && !pages) return "";
  let s = "";
  if (volume) s += volume;
  if (issue) s += `(${issue})`;
  if (pages) s += `:${pages}`;
  return s;
}

function hyperlinkRun(text: string, href: string): ExternalHyperlink {
  return new ExternalHyperlink({
    link: href,
    children: [new TextRun({ text, style: "Hyperlink" })],
  });
}

function citationParagraph(
  index: number,
  pub: PubForCitation,
  selectedLastNames: ReadonlySet<string>,
): Paragraph {
  const authorsForCitation = pub.fullAuthorsString ?? pub.authorsString;
  const authorRuns = buildAuthorRuns(authorsForCitation, selectedLastNames);
  const journalForCitation = pub.journalAbbrev ?? pub.journal ?? "";
  const volIssuePages = formatVolIssuePages(pub.volume, pub.issue, pub.pages);
  const titleClean = pub.title.replace(/\.+$/, "");
  const titleRuns = buildPubmedRuns(titleClean);

  const idRuns: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: "PMID: " }),
    hyperlinkRun(pub.pmid, `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`),
  ];
  if (pub.pmcid) {
    idRuns.push(new TextRun({ text: "; PMCID: " }));
    idRuns.push(hyperlinkRun(pub.pmcid, `https://www.ncbi.nlm.nih.gov/pmc/articles/${pub.pmcid}/`));
  }
  idRuns.push(new TextRun({ text: "." }));

  const children: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: `${index + 1}. ` }),
    ...authorRuns,
    new TextRun({ text: ". " }),
    ...titleRuns,
    new TextRun({ text: ". " }),
    ...(journalForCitation ? [new TextRun({ text: journalForCitation + ". " })] : []),
    ...(pub.year !== null
      ? [new TextRun({ text: volIssuePages ? `${pub.year};${volIssuePages}. ` : `${pub.year}. ` })]
      : []),
    ...(pub.doi
      ? [
          new TextRun({ text: "doi: " }),
          hyperlinkRun(pub.doi, `https://doi.org/${pub.doi}`),
          new TextRun({ text: ". " }),
        ]
      : []),
    ...idRuns,
  ];

  return new Paragraph({
    children,
    indent: { left: HANGING_INDENT_TWIPS, hanging: HANGING_INDENT_TWIPS },
    spacing: { after: 120 },
  });
}

// ── per-section bodies ──────────────────────────────────────────────────────

function personalDataBody(p: ProfilePayload, pops: PopsEnrichment | null): Block[] {
  const out: Block[] = [plain(`Name: ${p.publishedName}`)];
  if (p.email) out.push(plain(`Work email: ${p.email}`));
  if (pops?.npi) out.push(plain(`NPI: ${pops.npi}`));
  return out;
}

function educationBody(p: ProfilePayload, pops: PopsEnrichment | null): Block[] {
  const rows: string[][] = [];
  const seen = new Set<string>();
  const add = (degree: string, institution: string, yr: string) => {
    const key = `${degree}|${institution}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([degree || NA, institution || NA, yr || ""]);
  };
  for (const e of p.educations) {
    add(
      e.field ? `${e.degree} (${e.field})` : e.degree,
      e.institution,
      e.year ? String(e.year) : "",
    );
  }
  // POPS degrees corroborate / supplement (dedup by degree+institution).
  for (const d of pops?.degrees ?? []) add(d.degree, d.institution, d.year ?? "");
  if (rows.length === 0) return [];
  return [table(["Degree", "Institution", "Year"], rows)];
}

function postdocTrainingBody(pops: PopsEnrichment | null): Block[] {
  // v1: POPS training rows (Residency/Fellowship/Internship; Medical School
  // excluded upstream). ponytail: ASMS training rows live (inconsistently) in
  // `Education`; merging them is deferred to keep the builder deterministic.
  const rows = (pops?.training ?? []).map((t) => [t.type || NA, t.institution || NA]);
  if (rows.length === 0) return [];
  return [table(["Type", "Institution"], rows)];
}

function positionsBody(p: ProfilePayload, pops: PopsEnrichment | null): Block[] {
  const rows: string[][] = [];
  const seen = new Set<string>();
  const add = (title: string, institution: string, dates: string) => {
    const key = `${title}|${institution}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([title || NA, institution || NA, dates || ""]);
  };
  for (const a of p.appointments) {
    add(a.title, a.organization, dateRange(a.startDate, a.endDate, a.isActive));
  }
  for (const a of pops?.appointments ?? []) {
    add(a.title, a.institution, dateRange(a.start, a.end));
  }
  if (rows.length === 0) return [];
  return [table(["Title", "Institution", "Dates"], rows)];
}

function licensureBoardBody(pops: PopsEnrichment | null): Block[] {
  const out: Block[] = [];
  // F1 Licensure — only the NPI is available; certificate numbers/dates are not
  // fabricated.
  if (pops?.npi) {
    out.push(subHeading("Licensure"));
    out.push(plain(`NPI: ${pops.npi}`));
  }
  // F2 Board Certification.
  const certs = pops?.boardCertifications ?? [];
  if (certs.length > 0) {
    out.push(subHeading("Board Certification"));
    out.push(
      table(
        ["Board", "Specialty"],
        certs.map((c) => [c.board || NA, c.specialty ?? NA]),
      ),
    );
  }
  return out;
}

function hospitalAffiliationBody(pops: PopsEnrichment | null): Block[] {
  // ponytail: v1 sources hospital appointments from POPS only. The ASMS
  // primary-affiliation field is unconfirmed (spec §13.1) — add it here once
  // the loader is identified.
  const rows = (pops?.appointments ?? []).map((a) => [
    a.institution || NA,
    dateRange(a.start, a.end),
  ]);
  if (rows.length === 0) return [];
  return [table(["Institution", "Dates"], rows)];
}

function honorsBody(pops: PopsEnrichment | null): Block[] {
  const rows = (pops?.honors ?? []).map((h) => [h.date ?? "", h.name || NA, NA]);
  // Castle Connolly "Top Doctor" — a recognition POPS carries as a flag, no date.
  if (pops?.castleConnolly) rows.push(["", "Castle Connolly Top Doctor", "Castle Connolly"]);
  if (rows.length === 0) return [];
  return [table(["Date", "Award", "Organization"], rows)];
}

function clinicalActivitiesBody(p: ProfilePayload, pops: PopsEnrichment | null): Block[] {
  const out: Block[] = [];
  const specialties = pops?.specialties ?? [];
  if (specialties.length > 0) {
    out.push(plain(`Clinical specialties: ${specialties.join("; ")}`));
  }
  // L1 Clinical Practice — named POPS practices/services.
  const practices = pops?.practices ?? [];
  if (practices.length > 0) {
    out.push(subHeading("Clinical Practice"));
    for (const pr of practices) {
      out.push(plain(pr.type ? `${pr.name} (${pr.type})` : pr.name));
    }
  }
  // Clinical expertise areas (problem_procedure).
  const expertise = pops?.expertise ?? [];
  if (expertise.length > 0) {
    out.push(plain(`Areas of expertise: ${expertise.join("; ")}`));
  }
  if (p.clinicalProfileUrl) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Clinical profile: " }),
          hyperlinkRun(p.clinicalProfileUrl, p.clinicalProfileUrl),
        ],
      }),
    );
  }
  return out;
}

function researchActivitiesBody(summary: string): Block[] {
  const paras = summary
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paras.length === 0) return [];
  return paras.map(
    (s) => new Paragraph({ children: [new TextRun({ text: s })], spacing: { after: 120 } }),
  );
}

function researchSupportBody(p: ProfilePayload): Block[] {
  if (p.grants.length === 0) return [];
  // No dollar amounts exist in either source — the column is intentionally absent.
  const rows = p.grants.map((g) => [
    g.title || NA,
    g.role || NA,
    g.funder || NA,
    g.awardNumber ?? "",
    dateRange(g.startDate, g.endDate, g.isActive),
  ]);
  return [table(["Title", "Role", "Funder", "Award No.", "Dates"], rows)];
}

function mentoringBody(mentees: MenteeChip[]): Block[] {
  if (mentees.length === 0) return [];
  const rows = mentees.map((m) => {
    const program = m.programName ?? m.programType ?? "";
    const years = m.graduationYear
      ? String(m.graduationYear)
      : m.appointmentRange
        ? dateRange(
            String(m.appointmentRange.startYear),
            m.appointmentRange.endYear ? String(m.appointmentRange.endYear) : null,
            m.appointmentRange.endYear === null,
          )
        : "";
    return [m.fullName || NA, program, years];
  });
  return [table(["Name", "Program", "Years"], rows)];
}

function leadershipBody(p: ProfilePayload): Block[] {
  if (p.leadershipTitles.length === 0) return [];
  return p.leadershipTitles.map((t) => new Paragraph({ children: [new TextRun({ text: t })] }));
}

function bibliographyBody(input: CvInput): Block[] {
  const pubs = input.bibliography;
  if (pubs.length === 0) return [];
  const selectedLastNames = new Set([lastNameKey(input.profile.preferredName)]);
  return [
    subHeading("Peer-reviewed Research Articles:"),
    ...pubs.map((pub, i) => citationParagraph(i, pub, selectedLastNames)),
  ];
}

// ── public builder ──────────────────────────────────────────────────────────

/** Build the WCM CV `docx.Document` from a fully-assembled `CvInput` (pure). */
export function buildWcmCv(input: CvInput): Document {
  const { profile: p, pops } = input;

  const headerBlock: Block[] = [
    sectionHeading(WCM_CV_SECTION_HEADINGS[0]),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: p.publishedName, bold: true, size: 28 })],
    }),
    plain(`Date: ${todayLong()}`),
    plain("Signature: ____________________________"),
  ];

  const children: Block[] = [
    ...headerBlock,
    ...section(WCM_CV_SECTION_HEADINGS[1], personalDataBody(p, pops)),
    ...section(WCM_CV_SECTION_HEADINGS[2], educationBody(p, pops)),
    ...section(WCM_CV_SECTION_HEADINGS[3], []), // Other Educational Experiences — no source
    ...section(WCM_CV_SECTION_HEADINGS[4], postdocTrainingBody(pops)),
    ...section(WCM_CV_SECTION_HEADINGS[5], positionsBody(p, pops)),
    ...section(WCM_CV_SECTION_HEADINGS[6], []), // Employment Status — no source
    ...section(WCM_CV_SECTION_HEADINGS[7], licensureBoardBody(pops)),
    ...section(WCM_CV_SECTION_HEADINGS[8], hospitalAffiliationBody(pops)),
    ...section(WCM_CV_SECTION_HEADINGS[9], honorsBody(pops)),
    ...section(WCM_CV_SECTION_HEADINGS[10], []), // Professional Memberships — no source
    ...section(WCM_CV_SECTION_HEADINGS[11], []), // Percent Effort — no source
    ...section(WCM_CV_SECTION_HEADINGS[12], []), // Educational Contributions — no source
    ...section(WCM_CV_SECTION_HEADINGS[13], clinicalActivitiesBody(p, pops)),
    ...section(WCM_CV_SECTION_HEADINGS[14], researchActivitiesBody(input.researchSummary)),
    ...section(WCM_CV_SECTION_HEADINGS[15], researchSupportBody(p)),
    ...section(WCM_CV_SECTION_HEADINGS[16], mentoringBody(input.mentees)),
    ...section(WCM_CV_SECTION_HEADINGS[17], leadershipBody(p)),
    ...section(WCM_CV_SECTION_HEADINGS[18], []), // Institutional Administrative — no source
    ...section(WCM_CV_SECTION_HEADINGS[19], []), // Extramural Professional Activities — no source
    ...section(WCM_CV_SECTION_HEADINGS[20], []), // Invitations to Speak — no source
    ...section(WCM_CV_SECTION_HEADINGS[21], bibliographyBody(input)),
    ...section(WCM_CV_SECTION_HEADINGS[22], []), // Appendix — skip (placeholder)
  ];

  return new Document({
    creator: "Scholars Profile System",
    title: `Curriculum Vitae — ${p.publishedName}`,
    sections: [{ children }],
  });
}

/** Build the CV and pack it to a `.docx` buffer (route download path). */
export async function buildWcmCvBuffer(input: CvInput): Promise<Buffer> {
  return Packer.toBuffer(buildWcmCv(input));
}
