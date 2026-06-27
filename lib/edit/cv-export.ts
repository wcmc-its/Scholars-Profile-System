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
import type { CvSourceKey } from "./field-sources";
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
  /** PubMed-style `publication_type`; bins the entry into a WCM bibliography
   *  category ({@link bibSubsectionKey}). Null ⇒ peer-reviewed research article. */
  publicationType: string | null;
};

/**
 * A historical (`ED-HISTORICAL`) faculty appointment, loaded SEPARATELY from the
 * public `ProfilePayload` (#1323). The payload's `appointments` are active-only,
 * and hidden historical rows are excluded from it — but the CV exports ALL
 * historical appointments regardless of `showOnProfile`, so the route loads them
 * directly and threads them here.
 */
export type HistoricalAppointment = {
  title: string;
  organization: string;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
};

/** Route ↔ builder contract. The route owns all I/O; the builder is pure-ish
 *  (reads the bundled template file, no DB/LLM/network). */
export interface CvInput {
  profile: ProfilePayload;
  mentees: MenteeChip[];
  researchSummary: string;
  pops: PopsEnrichment | null;
  bibliography: PubForCitation[];
  /** All historical appointments (any `showOnProfile`), loaded apart from the payload. */
  historicalAppointments?: HistoricalAppointment[];
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

/** A template-table row plus the system of record for THAT row. The merged
 *  education/appointment/honor helpers carry each row's true origin so the
 *  `/edit` outline can badge it per-record; the .docx builder reads `.cells`. */
type SourcedRow = { cells: string[]; source: CvSourceKey };

function educationRows(p: ProfilePayload, pops: PopsEnrichment | null): SourcedRow[] {
  const rows: SourcedRow[] = [];
  const seen = new Set<string>();
  const add = (degree: string, institution: string, yr: string, source: CvSourceKey) => {
    const key = `${degree}|${institution}`.toLowerCase();
    if (!degree || seen.has(key)) return;
    seen.add(key);
    // [Degree+field, Institution, Dates attended, Year]
    rows.push({ cells: [degree, institution, "", yr], source });
  };
  for (const e of p.educations) {
    add(
      e.field ? `${e.degree} (${e.field})` : e.degree,
      e.institution,
      e.year ? String(e.year) : "",
      "education",
    );
  }
  for (const d of pops?.degrees ?? []) add(d.degree, d.institution, d.year ?? "", "pops");
  return rows;
}

function appointmentRows(
  p: ProfilePayload,
  pops: PopsEnrichment | null,
  historical: HistoricalAppointment[] = [],
): { academic: SourcedRow[]; hospital: SourcedRow[] } {
  const isHospital = (org: string) => /presbyterian|hospital|\bnyp\b|medical center/i.test(org);
  const academic: SourcedRow[] = [];
  const hospital: SourcedRow[] = [];
  const seen = new Set<string>();
  const add = (title: string, org: string, dates: string, source: CvSourceKey) => {
    const key = `${title}|${org}`.toLowerCase();
    if ((!title && !org) || seen.has(key)) return;
    seen.add(key);
    (isHospital(org) ? hospital : academic).push({ cells: [title, org, dates], source });
  };
  for (const a of p.appointments)
    add(a.title, a.organization, dateRange(a.startDate, a.endDate, a.isActive), "appointments");
  // #1323 — all historical (`ED-HISTORICAL`) appointments, rendered as past (with
  // an end year) regardless of `showOnProfile`. The `seen` dedupe guards re-runs;
  // the payload's active `appointments` never carry historical rows.
  for (const a of historical)
    add(a.title, a.organization, dateRange(a.startDate, a.endDate, false), "appointments");
  for (const a of pops?.appointments ?? [])
    add(a.title, a.institution, dateRange(a.start, a.end), "pops");
  return { academic, hospital };
}

function honorRows(pops: PopsEnrichment | null): SourcedRow[] {
  const rows: SourcedRow[] = (pops?.honors ?? []).map((h) => ({
    cells: [h.name || NA, "", h.date ?? ""],
    source: "pops",
  }));
  if (pops?.castleConnolly)
    rows.push({ cells: ["Castle Connolly Top Doctor", "Castle Connolly", ""], source: "pops" });
  return rows;
}

// ── bibliography categories (Section S) ─────────────────────────────────────

/**
 * The WCM template's nine bibliography categories, in document order, each with
 * the `anchor` prefix used to locate its prompt paragraph in the .docx. Shared
 * by the builder (where to inject each group) and the outline (preview rows), so
 * the two cannot disagree on the taxonomy.
 */
export const BIB_SUBSECTIONS = [
  {
    code: "S1",
    key: "articles",
    label: "Peer-reviewed Research Articles",
    anchor: "Peer-reviewed Research Articles",
  },
  { code: "S2", key: "reviews", label: "Reviews and Editorials", anchor: "Reviews and Editorials" },
  { code: "S3", key: "books", label: "Books", anchor: "Books:" },
  { code: "S4", key: "chapters", label: "Chapters", anchor: "Chapters" },
  {
    code: "S5",
    key: "nonpeer",
    label: "Non-peer-reviewed Research Publications",
    anchor: "Non-peer-reviewed Research Publications",
  },
  { code: "S6", key: "cases", label: "Case Reports", anchor: "Case Reports" },
  { code: "S7", key: "inreview", label: "In review", anchor: "In review" },
  { code: "S8", key: "abstracts", label: "Abstracts", anchor: "Abstracts" },
  { code: "S9", key: "other", label: "Other", anchor: "Other (media" },
] as const;

export type BibSubsectionKey = (typeof BIB_SUBSECTIONS)[number]["key"];

/**
 * Bin a PubMed `publication_type` into a WCM bibliography category. Keyword
 * heuristic over the real corpus (Academic Article / Review / Case Report /
 * Letter / Comment / Editorial Article / Preprint / Conference Paper / Erratum /
 * Retraction / Guideline); unknown or null ⇒ peer-reviewed research article.
 */
export function bibSubsectionKey(type: string | null | undefined): BibSubsectionKey {
  const t = (type ?? "").toLowerCase();
  if (/case report/.test(t)) return "cases";
  if (/review|editorial/.test(t)) return "reviews";
  if (/letter|comment/.test(t)) return "nonpeer";
  if (/preprint/.test(t)) return "inreview";
  if (/erratum|retraction|correction/.test(t)) return "other";
  if (/conference|abstract|meeting|proceeding/.test(t)) return "abstracts";
  if (/chapter/.test(t)) return "chapters";
  if (/\bbook\b/.test(t)) return "books";
  return "articles";
}

/**
 * POPS clinical-practice prose lines for Section L1 (specialties / practices /
 * areas of expertise) — the WCM physician-directory data the CV otherwise drops.
 * Empty for non-clinical scholars.
 */
function clinicalPracticeLines(pops: PopsEnrichment | null): string[] {
  if (!pops) return [];
  const lines: string[] = [];
  if (pops.specialties.length > 0) lines.push(`Specialties: ${pops.specialties.join(", ")}`);
  if (pops.practices.length > 0) {
    lines.push(
      `Practices: ${pops.practices.map((pr) => (pr.type ? `${pr.name} (${pr.type})` : pr.name)).join("; ")}`,
    );
  }
  if (pops.expertise.length > 0) lines.push(`Areas of expertise: ${pops.expertise.join(", ")}`);
  return lines;
}

/** One-line "Source. Title. Dates. Role." summary for the Past (Completed)
 *  Funding section, which the WCM template prompts as free prose (no per-entry
 *  table, unlike Current Research Funding). */
function grantSummaryLine(g: ProfilePayload["grants"][number]): string {
  const range = dateRange(g.startDate, g.endDate, false);
  return [g.funder, g.title, range, g.role].filter(Boolean).join(". ") + ".";
}

// ── public builder ──────────────────────────────────────────────────────────

/** Build the WCM CV by filling the official template, returning the .docx bytes. */
export async function buildWcmCvBuffer(input: CvInput): Promise<Buffer> {
  const { profile: p, pops } = input;
  const t = await loadTemplate();
  const doc = t.doc;
  // A blank paragraph — inserted between a section/category header and its
  // injected content so entries don't butt up against the prompt.
  const blank = () => makeParagraph(doc, []);

  // 1. Fill the signature block (the WCM instruction box is kept, per the
  //    template's own "delete this box on completion" guidance — left for the scholar).
  appendToLabelParagraph(doc, t, "Name:", p.publishedName);
  appendToLabelParagraph(doc, t, "Date of Preparation:", todayLong());

  // 2. Personal Data — only the work email when visible.
  if (p.email) {
    setLabeledValue(doc, findTable(t, (h) => (h[0] ?? "").startsWith("Office address")), "Work email:", p.email);
  }

  // 3. Education — Academic Degrees.
  fillGrid(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Degree, include field")),
    educationRows(p, pops).map((r) => r.cells),
  );

  // 4. Postdoctoral Training (POPS; dates unavailable → blank).
  fillGrid(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Title, include area of training")),
    (pops?.training ?? []).map((tr) => [tr.type || NA, tr.institution || NA, ""]),
  );

  // 5. Professional Positions — Academic vs Hospital (anchored by subheading, headers repeat).
  const appts = appointmentRows(p, pops, input.historicalAppointments ?? []);
  fillGrid(
    doc,
    tableAfterParagraph(t, (x) => x.startsWith("Academic Appointments")),
    appts.academic.map((r) => r.cells),
  );
  fillGrid(
    doc,
    tableAfterParagraph(t, (x) => x.startsWith("Hospital Appointments")),
    appts.hospital.map((r) => r.cells),
  );

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
  fillGrid(
    doc,
    findTable(t, (h) => h[0] === "Name of award"),
    honorRows(pops).map((r) => r.cells),
  );

  // 7b. Clinical Practice (Section L1) — POPS specialties / practices / expertise
  //     as prose under the "Clinical Practice" prompt. Clinical faculty only.
  const clinicalLines = clinicalPracticeLines(pops);
  if (clinicalLines.length > 0) {
    insertParagraphsAfter(t, (x) => x.startsWith("Clinical Practice"), [
      blank(),
      ...clinicalLines.map((s) => makeParagraph(doc, [{ text: s }])),
    ]);
  }

  // 8. Research — Activities summary (M1) + Current Research Funding (one table per grant).
  if (input.researchSummary.trim()) {
    const paras = input.researchSummary
      .split(/\n{2,}/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => makeParagraph(doc, [{ text: s }]));
    insertParagraphsAfter(t, (x) => x.startsWith("Research Activities:"), [blank(), ...paras]);
  }
  // Current Research Funding gets the active grants (per-entry table); completed
  // grants go to Past (Completed) Funding below. Pending is intentionally NOT
  // populated — InfoEd's pending statuses are filtered out upstream and are too
  // sensitive to surface. ("In Process" awards are imported as awarded, not
  // pending, and sort here by date.)
  const activeGrants = p.grants.filter((g) => g.isActive);
  const pastGrants = p.grants.filter((g) => !g.isActive);
  fillTablePerEntry(
    doc,
    findTable(t, (h) => (h[0] ?? "").startsWith("Award Source:")),
    activeGrants,
    (clone, g) => {
      setLabeledValue(doc, clone, "Award Source:", g.funder || NA);
      setLabeledValue(doc, clone, "Project title:", g.title || NA);
      setLabeledValue(doc, clone, "Duration of support:", dateRange(g.startDate, g.endDate, g.isActive));
      setLabeledValue(doc, clone, "Name of Principal Investigator:", g.role === "Principal Investigator" ? p.publishedName : "");
      setLabeledValue(doc, clone, "Your role", g.role || "");
    },
  );
  // Past (Completed) Funding — the template prompts free prose here (no table),
  // so write one summary line per completed grant.
  if (pastGrants.length > 0) {
    insertParagraphsAfter(t, (x) => x.startsWith("Past (Completed) Funding"), [
      blank(),
      ...pastGrants.map((g) => makeParagraph(doc, [{ text: grantSummaryLine(g) }])),
    ]);
  }

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

  // 11. Bibliography — bin each entry into its WCM category (peer-reviewed
  //     articles, reviews, case reports, …) and inject under that subsection's
  //     prompt, numbered within the category, with the scholar's surname bolded.
  if (input.bibliography.length > 0) {
    const selected = new Set([lastNameKey(p.preferredName)]);
    for (const sub of BIB_SUBSECTIONS) {
      const pubs = input.bibliography.filter(
        (pub) => bibSubsectionKey(pub.publicationType) === sub.key,
      );
      if (pubs.length === 0) continue;
      const paras = pubs.map((pub, i) => makeParagraph(doc, citationRuns(i, pub, selected)));
      insertParagraphsAfter(t, (x) => x.startsWith(sub.anchor), [blank(), ...paras]);
    }
  }

  // 12. Style every table (incl. cloned ones) to match CViche's WCM output:
  //     D9D9D9 cell borders, shaded header row, vertical-centered, 4pt padding.
  applyTableStyling(t);

  return serialize(t);
}

// ── outline (live /edit preview) ────────────────────────────────────────────

/** Per-entry fill state: `filled` (we put data here), `empty` (we source this
 *  but you have none yet), `generated` (M1 — drafted at download), `todo` (no
 *  source; the template keeps a blank prompt to complete by hand). */
export type CvOutlineStatus = "filled" | "empty" | "generated" | "todo";

/** One preview record with its own system of record — so the outline can badge
 *  each row, including the merged sections (Academic Degrees, Appointments) whose
 *  rows come from different sources. */
export type CvOutlineItem = { text: string; source: CvSourceKey };

/** One leaf row of the outline — a subsection, or the sole entry of a simple
 *  section (then `code`/`label` are "", and the parent group carries them). */
export type CvOutlineEntry = {
  code: string;
  label: string;
  /** Coarse entry-level origin — drives the empty/`todo` status (an entry with a
   *  source but no data is "empty"; a source-less one is "todo"). Per-record
   *  provenance for the badge lives on each {@link CvOutlineItem}. */
  source: "scholars" | "pops" | "generated" | "none";
  status: CvOutlineStatus;
  /** Item count, or null for non-list entries (A personal data, M1 summary). */
  count: number | null;
  /** Up to {@link OUTLINE_ITEM_CAP} preview records; `count` is the true total. */
  items: CvOutlineItem[];
};

/** A top-level WCM section (A–S) and its subsection rows, in document order. */
export type CvOutlineGroup = { code: string; label: string; entries: CvOutlineEntry[] };

export type CvOutlineInput = {
  profile: ProfilePayload;
  mentees: MenteeChip[];
  pops: PopsEnrichment | null;
  /** All historical appointments (any `showOnProfile`), loaded apart from the payload. */
  historicalAppointments?: HistoricalAppointment[];
};

/** Cap preview items per entry; the UI shows "+N more" from the true `count`. */
export const OUTLINE_ITEM_CAP = 10;

function menteeYears(m: MenteeChip): string {
  if (m.graduationYear) return String(m.graduationYear);
  if (m.appointmentRange) {
    return dateRange(
      String(m.appointmentRange.startYear),
      m.appointmentRange.endYear ? String(m.appointmentRange.endYear) : null,
      m.appointmentRange.endYear === null,
    );
  }
  return "";
}

/**
 * Build the document-ordered outline of the WCM CV for the /edit preview — every
 * template section AND subsection (A–S), in download order, each tagged with what
 * Scholars/POPS fills. Pure; derived from the SAME helpers `buildWcmCvBuffer`
 * uses (incl. {@link bibSubsectionKey} for the S1–S9 bins and
 * {@link clinicalPracticeLines} for L1), so the preview mirrors the .docx.
 */
export function cvOutline(input: CvOutlineInput): CvOutlineGroup[] {
  const { profile: p, pops, mentees, historicalAppointments } = input;
  const cap = (items: CvOutlineItem[]): CvOutlineItem[] => items.slice(0, OUTLINE_ITEM_CAP);
  // Tag a uniform section's text lines with their single system of record.
  const tag = (source: CvSourceKey, texts: string[]): CvOutlineItem[] =>
    texts.map((text) => ({ text, source }));

  // A list-backed entry: filled when it has items, else empty (we source it) or
  // todo (no source). `count` is the true total; `items` is the capped slice.
  const entry = (
    code: string,
    label: string,
    source: CvOutlineEntry["source"],
    items: CvOutlineItem[],
  ): CvOutlineEntry => ({
    code,
    label,
    source,
    status: items.length > 0 ? "filled" : source === "none" ? "todo" : "empty",
    count: items.length,
    items: cap(items),
  });

  const eduRows = educationRows(p, pops);
  const appts = appointmentRows(p, pops, historicalAppointments ?? []);
  const honors = honorRows(pops);

  // Bibliography: classify each confirmed publication into its WCM category, so
  // the preview's S1–S9 bins match where the builder injects each entry.
  const pubLine = (pub: ProfilePayload["publications"][number]): string =>
    [pub.title?.replace(/\.+$/, ""), pub.journal, pub.year ? `(${pub.year})` : ""]
      .filter(Boolean)
      .join(" — ");
  const bibByKey = new Map<BibSubsectionKey, string[]>();
  for (const pub of p.publications) {
    const k = bibSubsectionKey(pub.publicationType);
    const arr = bibByKey.get(k);
    if (arr) arr.push(pubLine(pub));
    else bibByKey.set(k, [pubLine(pub)]);
  }

  // Grants split Current (active) / Past (completed) by date, mirroring the
  // builder. Pending stays a blank prompt (excluded upstream + sensitive).
  const fmtGrant = (g: ProfilePayload["grants"][number]): string => {
    const range = dateRange(g.startDate, g.endDate, g.isActive);
    return [g.funder, g.title, range ? `(${range})` : ""].filter(Boolean).join(" — ");
  };
  const currentGrantItems = p.grants.filter((g) => g.isActive).map(fmtGrant);
  const pastGrantItems = p.grants.filter((g) => !g.isActive).map(fmtGrant);

  // A simple (non-subsectioned) section's sole entry; the group carries the name.
  const simple = (source: CvOutlineEntry["source"], items: CvOutlineItem[]): CvOutlineEntry[] => [
    entry("", "", source, items),
  ];

  return [
    {
      code: "A",
      label: "Personal Data",
      entries: [
        {
          code: "",
          label: "",
          source: "scholars",
          status: "filled",
          count: null,
          items: tag("name-title", [p.publishedName, ...(p.email ? [p.email] : [])]),
        },
      ],
    },
    {
      code: "B",
      label: "Education",
      entries: [
        entry(
          "B1",
          "Academic Degrees",
          "scholars",
          eduRows.map((r) => ({
            text: [r.cells[0], r.cells[1], r.cells[3] ? `(${r.cells[3]})` : ""]
              .filter(Boolean)
              .join(" — "),
            source: r.source,
          })),
        ),
        entry("B2", "Other Educational Experiences", "none", []),
      ],
    },
    {
      code: "C",
      label: "Postdoctoral Training",
      entries: simple(
        "pops",
        tag(
          "pops",
          (pops?.training ?? []).map((t) => [t.type, t.institution].filter(Boolean).join(" — ")),
        ),
      ),
    },
    {
      code: "D",
      label: "Professional Positions & Employment",
      entries: [
        entry(
          "D1",
          "Academic Appointments",
          "scholars",
          appts.academic.map((r) => ({
            text: [r.cells[0], r.cells[1], r.cells[2] ? `(${r.cells[2]})` : ""]
              .filter(Boolean)
              .join(", "),
            source: r.source,
          })),
        ),
        entry(
          "D2",
          "Hospital Appointments",
          "scholars",
          appts.hospital.map((r) => ({
            text: [r.cells[0], r.cells[1], r.cells[2] ? `(${r.cells[2]})` : ""]
              .filter(Boolean)
              .join(", "),
            source: r.source,
          })),
        ),
        entry("D3", "Other Professional Positions", "none", []),
      ],
    },
    { code: "E", label: "Employment Status", entries: simple("none", []) },
    {
      code: "F",
      label: "Licensure, Board Certification",
      entries: [
        entry("F1", "Licensure", "pops", tag("pops", pops?.npi ? [`NPI ${pops.npi}`] : [])),
        entry(
          "F2",
          "Board Certification",
          "pops",
          tag(
            "pops",
            (pops?.boardCertifications ?? []).map((c) =>
              c.specialty ? `${c.board} (${c.specialty})` : c.board,
            ),
          ),
        ),
      ],
    },
    { code: "G", label: "Institutional / Hospital Affiliation", entries: simple("none", []) },
    {
      code: "H",
      label: "Honors, Awards",
      entries: simple(
        "pops",
        honors.map((r) => ({
          text: [r.cells[0], r.cells[2] ? `(${r.cells[2]})` : ""].filter(Boolean).join(" "),
          source: r.source,
        })),
      ),
    },
    {
      code: "I",
      label: "Professional Organizations & Society Memberships",
      entries: simple("none", []),
    },
    {
      code: "J",
      label: "Percent Effort & Institutional Responsibilities",
      entries: simple("none", []),
    },
    {
      code: "K",
      label: "Educational Contributions",
      entries: [
        entry("K1", "Didactic teaching", "none", []),
        entry("K2", "Clinical teaching", "none", []),
        entry("K3", "Administrative teaching", "none", []),
        entry("K4", "Continuing / professional education", "none", []),
        entry("K5", "Other education / outreach", "none", []),
      ],
    },
    {
      code: "L",
      label: "Clinical Practice, Innovation & Leadership",
      entries: [
        entry("L1", "Clinical Practice", "pops", tag("pops", clinicalPracticeLines(pops))),
        entry("L2", "Clinical Innovations", "none", []),
        entry("L3", "Clinical Leadership", "none", []),
      ],
    },
    {
      code: "M",
      label: "Research",
      entries: [
        {
          code: "M1",
          label: "Research Activities",
          source: "generated",
          status: "generated",
          count: null,
          items: [],
        },
        entry("M2", "Current Research Funding", "scholars", tag("funding", currentGrantItems)),
        entry("M3", "Past (Completed) Funding", "scholars", tag("funding", pastGrantItems)),
        entry("M4", "Pending Funding", "none", []),
        entry("M5", "Patents & Inventions", "none", []),
      ],
    },
    {
      code: "N",
      label: "Mentoring",
      entries: [
        entry("N1", "Leadership & mentoring in programs", "none", []),
        entry("N2", "Institutional Training & Mentored Trainee Grants", "none", []),
        entry(
          "N3",
          "Current Mentees",
          "scholars",
          tag(
            "mentees",
            mentees.map((m) => {
              const yrs = menteeYears(m);
              return [m.fullName, yrs ? `(${yrs})` : ""].filter(Boolean).join(" ");
            }),
          ),
        ),
        entry("N4", "Past Mentees", "none", []),
      ],
    },
    {
      code: "O",
      label: "Institutional Leadership Activities",
      // Chair/Chief lines come from the ED ETL, Center director / Program leader
      // from Scholars curation → the org-unit provenance label ("ED / Scholars").
      entries: simple("scholars", tag("org-unit", p.leadershipTitles)),
    },
    {
      code: "P",
      label: "Institutional Administrative Activities",
      entries: simple("none", []),
    },
    {
      code: "Q",
      label: "Extramural Professional Responsibilities",
      entries: [
        entry("Q1", "Leadership in Extramural Organizations", "none", []),
        entry("Q2", "Service on Boards / Committees", "none", []),
        entry("Q3", "Grant Reviewing / Study Sections", "none", []),
        entry("Q4", "Editorial Activities", "none", []),
      ],
    },
    {
      code: "R",
      label: "Invitations to Speak / Present",
      entries: [
        entry("R1", "Regional", "none", []),
        entry("R2", "National", "none", []),
        entry("R3", "International", "none", []),
      ],
    },
    {
      code: "S",
      label: "Bibliography",
      entries: BIB_SUBSECTIONS.map((sub) =>
        entry(sub.code, sub.label, "scholars", tag("publications", bibByKey.get(sub.key) ?? [])),
      ),
    },
  ];
}
