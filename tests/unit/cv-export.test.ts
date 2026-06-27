/**
 * Unit coverage for the WCM CV builder — which now FILLS the official template
 * (`lib/edit/assets/wcm-cv-template.docx`) rather than reconstructing it.
 *
 * Builds the CV for a research-only scholar (no POPS) and a clinical scholar
 * (with POPS), unzips `word/document.xml`, and asserts:
 *   (a) the WCM instruction box is removed;
 *   (b) the template's real section headings survive;
 *   (c) each datum lands in the template (board cert, honor, grant, email, …);
 *   (d) the scholar surname is bold in the bibliography;
 *   (e) a research-only scholar builds without crashing on the clinical sections.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  buildWcmCvBuffer,
  cvOutline,
  OUTLINE_ITEM_CAP,
  type CvInput,
  type PopsEnrichment,
} from "@/lib/edit/cv-export";
import type { ProfilePayload } from "@/lib/api/profile";
import type { MenteeChip } from "@/lib/api/mentoring";

async function documentXml(input: CvInput): Promise<string> {
  const zip = await JSZip.loadAsync(await buildWcmCvBuffer(input));
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("word/document.xml missing from packed docx");
  return file.async("string");
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Concatenated visible text of the whole document (table cells included). */
function allText(xml: string): string {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  let s = "";
  while ((m = tRe.exec(xml))) s += decodeXml(m[1]!) + " ";
  return s;
}

/** Text of every run carrying an explicit `<w:b/>` (bold). */
function boldRunTexts(xml: string): string[] {
  const out: string[] = [];
  const rRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = rRe.exec(xml))) {
    const inner = m[1]!;
    const rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(inner);
    if (!rpr || !/<w:b\/>/.test(rpr[1]!)) continue;
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    let s = "";
    while ((t = tRe.exec(inner))) s += decodeXml(t[1]!);
    out.push(s);
  }
  return out;
}

// ── fixtures ────────────────────────────────────────────────────────────────

function baseProfile(over: Partial<ProfilePayload>): ProfilePayload {
  const p: Partial<ProfilePayload> = {
    cwid: "abc1001",
    slug: "jane-smith",
    preferredName: "Jane Smith",
    roleCategory: "faculty",
    postnominal: "PhD",
    publishedName: "Jane Smith, PhD",
    fullName: "Jane Smith",
    primaryTitle: "Professor of Cell Biology",
    primaryDepartment: "Cell & Developmental Biology",
    departmentSlug: null,
    departmentOfficialName: null,
    division: null,
    leadershipTitles: [],
    email: null,
    contactEmailRevealable: false,
    identityImageEndpoint: "",
    hasClinicalProfile: false,
    clinicalProfileUrl: null,
    orcid: null,
    overview: null,
    appointments: [],
    educations: [],
    grants: [],
    clinicalTrials: [],
    keywords: { totalAcceptedPubs: 0, keywords: [] } as ProfilePayload["keywords"],
    families: [],
    disclosures: [],
    highlights: [],
    publications: [],
    postdoctoralMentor: null,
    ...over,
  };
  return p as ProfilePayload;
}

function mentee(over: Partial<MenteeChip>): MenteeChip {
  return {
    cwid: "stu1001",
    fullName: "Pat Lee",
    programType: "PhD",
    programName: "Immunology & Microbial Pathogenesis",
    graduationYear: 2022,
    appointmentRange: null,
    copublicationCount: 0,
    copublicationPreview: [],
    identityImageEndpoint: "",
    scholar: null,
    ...over,
  };
}

const researchInput: CvInput = {
  profile: baseProfile({
    educations: [{ degree: "PhD", institution: "MIT", year: 2008, field: "Biology" }],
    appointments: [
      {
        title: "Professor",
        organization: "Weill Cornell Medicine",
        startDate: "2018-07-01",
        endDate: null,
        isPrimary: true,
        isInterim: false,
        isActive: true,
      },
    ],
    grants: [
      {
        title: "Klotho signaling in aging",
        role: "Principal Investigator",
        funder: "National Institutes of Health",
        source: "InfoEd",
        startDate: "2021-04-01",
        endDate: "2026-03-31",
        isActive: true,
        awardNumber: "R01 AG067497",
        programType: "Grant",
        primeSponsor: "NIH",
        primeSponsorRaw: null,
        directSponsor: null,
        directSponsorRaw: null,
        mechanism: "R01",
        nihIc: "NIA",
        isSubaward: false,
        coreProjectNum: "AG067497",
        applId: 123456,
        abstract: null,
        abstractSource: null,
        publications: [],
      },
    ],
    leadershipTitles: ["Director, Center for Aging Research"],
  }),
  mentees: [mentee({})],
  researchSummary:
    "Dr. Smith studies the molecular biology of aging.\n\nHer lab focuses on Klotho signaling.",
  pops: null,
  bibliography: [
    {
      pmid: "38670054",
      title: "Klotho and clinical outcomes in chronic kidney disease",
      authorsString: "Smith J, Doe A, Roe B",
      fullAuthorsString: "Smith J, Doe A, Roe B",
      journal: "American Journal of Kidney Diseases",
      journalAbbrev: "Am J Kidney Dis",
      year: 2024,
      volume: "83",
      issue: "4",
      pages: "500-510",
      doi: "10.1053/j.ajkd.2023.10.015",
      pmcid: "PMC11098699",
      publicationType: "Academic Article",
    },
  ],
};

const clinicalPops: PopsEnrichment = {
  npi: "1234567890",
  boardCertifications: [
    { board: "American Board of Internal Medicine", specialty: "Internal Medicine" },
  ],
  training: [{ type: "Residency", institution: "NewYork-Presbyterian Hospital" }],
  degrees: [{ degree: "MD", year: "2005", institution: "Columbia University" }],
  appointments: [
    {
      title: "Attending Physician",
      institution: "NewYork-Presbyterian Hospital",
      start: "2012-07-01",
      end: null,
    },
  ],
  honors: [{ name: "Top Doctor, New York Magazine", date: "2021" }],
  specialties: ["Cardiology"],
  practices: [{ name: "Heart Failure Program", type: "Service" }],
  expertise: ["Heart failure", "Cardiac transplantation"],
  castleConnolly: true,
};

const clinicalInput: CvInput = {
  profile: baseProfile({
    cwid: "rj9001",
    slug: "robert-jones",
    preferredName: "Robert Jones",
    postnominal: "MD",
    publishedName: "Robert Jones, MD",
    fullName: "Robert Jones",
    primaryTitle: "Associate Professor of Medicine",
    primaryDepartment: "Medicine",
    hasClinicalProfile: true,
    email: "rj9001@med.cornell.edu",
    educations: [{ degree: "MD", institution: "Columbia University", year: 2005, field: null }],
    leadershipTitles: ["Chief, Division of General Internal Medicine"],
    grants: [
      {
        title: "Hospital readmissions cohort",
        role: "Co-Investigator",
        funder: "AHRQ",
        source: "InfoEd",
        startDate: "2020-01-01",
        endDate: "2023-12-31",
        isActive: false,
        awardNumber: null,
        programType: "Grant",
        primeSponsor: "AHRQ",
        primeSponsorRaw: null,
        directSponsor: null,
        directSponsorRaw: null,
        mechanism: null,
        nihIc: null,
        isSubaward: false,
        coreProjectNum: null,
        applId: null,
        abstract: null,
        abstractSource: null,
        publications: [],
      },
    ],
  }),
  mentees: [],
  researchSummary: "Dr. Jones investigates hospital readmissions and care transitions.",
  pops: clinicalPops,
  bibliography: [
    {
      pmid: "30000001",
      title: "Care transitions and 30-day readmission",
      authorsString: "Jones R, Smith K",
      fullAuthorsString: "Jones R, Smith K",
      journal: "JAMA Internal Medicine",
      journalAbbrev: "JAMA Intern Med",
      year: 2022,
      volume: "182",
      issue: "2",
      pages: "100-108",
      doi: null,
      pmcid: null,
      publicationType: "Review",
    },
  ],
};

// ── (a) instruction box removed + (b) real headings survive ──────────────────

describe("buildWcmCv — fills the official template", () => {
  it("keeps the WCM instruction box (template's own delete-on-completion guidance)", async () => {
    const xml = await documentXml(clinicalInput);
    expect(allText(xml)).toContain("When preparing the WCM CV template");
  });

  it("styles tables like CViche (D9D9D9 cell borders, shaded header, centered)", async () => {
    const xml = await documentXml(clinicalInput);
    expect(xml).toContain("<w:tcBorders>");
    expect(xml).toContain('w:color="D9D9D9"'); // cell border color
    expect(xml).toContain('w:fill="D9D9D9"'); // header-row shading
    expect(xml).toContain('<w:vAlign w:val="center"/>'); // vertical-centered cells
  });

  it("preserves the template's real section headings", async () => {
    const text = allText(await documentXml(clinicalInput));
    for (const h of [
      "PERSONAL DATA",
      "EDUCATION",
      "PROFESSIONAL POSITIONS",
      "LICENSURE, BOARD CERTIFICATION",
      "HONORS, AWARDS",
      "RESEARCH",
      "MENTORING",
      "BIBLIOGRAPHY",
    ]) {
      expect(text, `heading "${h}" missing`).toContain(h);
    }
  });
});

// ── (c) data lands in the template ───────────────────────────────────────────

describe("buildWcmCv — scholar data is injected", () => {
  it("fills the signature block, personal data, and credentials (clinical)", async () => {
    const text = allText(await documentXml(clinicalInput));
    expect(text).toContain("Robert Jones, MD"); // Name:
    expect(text).toContain("rj9001@med.cornell.edu"); // Work email
    expect(text).toContain("1234567890"); // NPI
    expect(text).toContain("American Board of Internal Medicine"); // Board cert
    expect(text).toContain("Top Doctor, New York Magazine"); // Honor
    expect(text).toContain("Castle Connolly Top Doctor"); // Castle Connolly honor
    expect(text).toContain("Columbia University"); // Education
    expect(text).toContain("Chief, Division of General Internal Medicine"); // Leadership
    expect(text).toContain("Hospital readmissions cohort"); // Grant (funding table)
    expect(text).toContain("Dr. Jones investigates hospital readmissions"); // M1 summary
  });

  it("fills research-only data without touching clinical sections (no crash)", async () => {
    const text = allText(await documentXml(researchInput));
    expect(text).toContain("Jane Smith, PhD"); // Name
    expect(text).toContain("Klotho signaling in aging"); // Grant
    expect(text).toContain("MIT"); // Education institution
    expect(text).toContain("Pat Lee"); // Current mentee
    expect(text).toContain("Director, Center for Aging Research"); // Leadership
  });
});

// ── (d) bibliography bolds the scholar surname ───────────────────────────────

describe("buildWcmCv — bibliography bolds the scholar surname", () => {
  it("bolds 'Smith' in the research fixture bibliography", async () => {
    const bold = boldRunTexts(await documentXml(researchInput));
    expect(bold.some((t) => t.includes("Smith"))).toBe(true);
  });

  it("bolds 'Jones' in the clinical fixture bibliography", async () => {
    const bold = boldRunTexts(await documentXml(clinicalInput));
    expect(bold.some((t) => t.includes("Jones"))).toBe(true);
  });
});

// ── bibliography subsections + clinical practice land in the .docx ("Both") ──

describe("buildWcmCv — pubs are binned and POPS clinical practice is written", () => {
  it("places an article under 'Peer-reviewed Research Articles'", async () => {
    const text = allText(await documentXml(researchInput));
    const head = text.indexOf("Peer-reviewed Research Articles");
    const pubAt = text.indexOf("Klotho and clinical outcomes");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(pubAt).toBeGreaterThan(head); // citation sits under its category prompt
  });

  it("places a review under 'Reviews and Editorials' and writes POPS clinical practice (L1)", async () => {
    const text = allText(await documentXml(clinicalInput));
    const revHead = text.indexOf("Reviews and Editorials");
    const revAt = text.indexOf("Care transitions and 30-day readmission");
    expect(revAt).toBeGreaterThan(revHead);
    // Section L1 — POPS specialties / practices / expertise as prose.
    expect(text).toContain("Specialties: Cardiology");
    expect(text).toContain("Heart Failure Program");
    expect(text).toContain("Areas of expertise: Heart failure");
  });

  it("routes completed grants to Past (Completed) Funding, active to Current", async () => {
    // clinicalInput's grant is isActive:false → Past (prose under that heading).
    const ctext = allText(await documentXml(clinicalInput));
    expect(ctext.indexOf("Hospital readmissions cohort")).toBeGreaterThan(
      ctext.indexOf("Past (Completed) Funding"),
    );
    // researchInput's grant is isActive:true → the Current Research Funding table,
    // i.e. above the Past heading.
    const rtext = allText(await documentXml(researchInput));
    const activeAt = rtext.indexOf("Klotho signaling in aging");
    expect(activeAt).toBeGreaterThan(rtext.indexOf("Current Research Funding"));
    expect(activeAt).toBeLessThan(rtext.indexOf("Past (Completed) Funding"));
  });
});

// ── cvOutline — the live /edit preview (spec §8) ─────────────────────────────

type Pub = ProfilePayload["publications"][number];
function pub(over: Partial<Pub>): Pub {
  return {
    pmid: "1",
    title: "A paper",
    journal: "Some Journal",
    year: 2020,
    publicationType: "Academic Article",
    ...over,
  } as Pub;
}

function group(groups: ReturnType<typeof cvOutline>, code: string) {
  const g = groups.find((x) => x.code === code);
  if (!g) throw new Error(`group ${code} missing from outline`);
  return g;
}
/** An entry by sub-code, or the sole entry of a simple section. */
function entryOf(groups: ReturnType<typeof cvOutline>, groupCode: string, entryCode = "") {
  const g = group(groups, groupCode);
  const e =
    g.entries.find((x) => x.code === entryCode) ??
    (g.entries.length === 1 ? g.entries[0] : undefined);
  if (!e) throw new Error(`entry ${groupCode}/${entryCode || "(sole)"} missing`);
  return e;
}

describe("cvOutline — document-ordered CV preview", () => {
  it("returns every WCM top-level section A–S in download order", () => {
    const codes = cvOutline({ profile: researchInput.profile, mentees: [], pops: null }).map(
      (g) => g.code,
    );
    expect(codes).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
    ]);
  });

  it("counts the research spine and marks no-source entries to-complete", () => {
    const o = cvOutline({
      profile: researchInput.profile,
      mentees: researchInput.mentees,
      pops: null,
    });
    expect(entryOf(o, "B", "B1").count).toBe(1); // PhD, MIT
    expect(entryOf(o, "D", "D1").count).toBe(1); // Professor @ WCM (academic)
    expect(entryOf(o, "M", "M2").count).toBe(1); // one active grant → Current
    expect(entryOf(o, "M", "M3").count).toBe(0); // none completed
    expect(entryOf(o, "N", "N3").count).toBe(1); // one mentee
    expect(entryOf(o, "O").count).toBe(1); // one leadership line
    expect(entryOf(o, "M", "M1").status).toBe("generated"); // drafted at download
    // No POPS ⇒ clinical entries have a source but no data ("empty"), not "filled".
    expect(entryOf(o, "C").status).toBe("empty");
    expect(entryOf(o, "F", "F2").status).toBe("empty");
    // Truly source-less entries are "todo".
    expect(entryOf(o, "E").status).toBe("todo");
    expect(entryOf(o, "K", "K1").status).toBe("todo");
  });

  it("fills clinical entries from POPS, including Clinical Practice (L1)", () => {
    const o = cvOutline({ profile: clinicalInput.profile, mentees: [], pops: clinicalInput.pops });
    expect(entryOf(o, "C")).toMatchObject({ status: "filled", source: "pops", count: 1 });
    expect(entryOf(o, "F", "F1").items.map((i) => i.text)).toContain("NPI 1234567890");
    expect(entryOf(o, "F", "F2").count).toBe(1); // board cert
    expect(entryOf(o, "H").count).toBe(2); // honor + Castle Connolly
    expect(entryOf(o, "M", "M2").count).toBe(0); // its one grant is completed…
    expect(entryOf(o, "M", "M3").count).toBe(1); // …so it lands in Past, not Current
    // POPS specialties/practices/expertise now surface in L1.
    const l1 = entryOf(o, "L", "L1");
    expect(l1.status).toBe("filled");
    expect(l1.items.map((i) => i.text).join(" ")).toContain("Cardiology");
    expect(l1.items.every((i) => i.source === "pops")).toBe(true);
  });

  it("bins publications into their WCM bibliography subsections", () => {
    const profile = baseProfile({
      publications: [
        pub({ pmid: "a", publicationType: "Academic Article" }),
        pub({ pmid: "b", publicationType: "Academic Article" }),
        pub({ pmid: "r", publicationType: "Review" }),
        pub({ pmid: "c", publicationType: "Case Report" }),
      ],
    });
    const s = group(cvOutline({ profile, mentees: [], pops: null }), "S");
    expect(s.entries.find((e) => e.code === "S1")!.count).toBe(2); // articles
    expect(s.entries.find((e) => e.code === "S2")!.count).toBe(1); // reviews
    expect(s.entries.find((e) => e.code === "S6")!.count).toBe(1); // case reports
  });

  it("personal data (A) lists name + visible email and has no count", () => {
    const a = entryOf(cvOutline({ profile: clinicalInput.profile, mentees: [], pops: null }), "A");
    expect(a.count).toBeNull();
    expect(a.items).toEqual([
      { text: "Robert Jones, MD", source: "name-title" },
      { text: "rj9001@med.cornell.edu", source: "name-title" },
    ]);
  });

  it("tags merged Academic Degrees (B1) per-record — ED/ASMS vs POPS", () => {
    const profile = baseProfile({
      educations: [{ degree: "PhD", institution: "MIT", year: 2008, field: "Biology" }],
    });
    const pops: PopsEnrichment = {
      npi: null,
      boardCertifications: [],
      training: [],
      degrees: [{ degree: "MD", year: "2012", institution: "Columbia University" }],
      appointments: [],
      honors: [],
      specialties: [],
      practices: [],
      expertise: [],
      castleConnolly: false,
    };
    const b1 = entryOf(cvOutline({ profile, mentees: [], pops }), "B", "B1");
    expect(b1.count).toBe(2); // both rows survive (different degree|institution)
    const textsBySource = (s: string) =>
      b1.items
        .filter((i) => i.source === s)
        .map((i) => i.text)
        .join(" ");
    expect(textsBySource("education")).toContain("MIT"); // p.educations → ASMS/ED
    expect(textsBySource("pops")).toContain("Columbia University"); // pops.degrees → POPS
  });

  it("badges uniform sections with their system of record", () => {
    const profile = baseProfile({
      grants: researchInput.profile.grants, // one active grant → M2
      leadershipTitles: ["Director, Center for Aging Research"],
      publications: [pub({ pmid: "x", publicationType: "Academic Article" })],
    });
    const o = cvOutline({ profile, mentees: [mentee({})], pops: null });
    expect(entryOf(o, "M", "M2").items[0]!.source).toBe("funding");
    expect(entryOf(o, "N", "N3").items[0]!.source).toBe("mentees");
    expect(entryOf(o, "O").items[0]!.source).toBe("org-unit");
    const s1 = group(o, "S").entries.find((e) => e.code === "S1")!;
    expect(s1.items[0]!.source).toBe("publications");
  });

  it("caps the item preview at 10 but reports the true count", () => {
    const profile = baseProfile({
      publications: Array.from({ length: OUTLINE_ITEM_CAP + 5 }, (_, i) =>
        pub({ pmid: String(i), title: `Paper ${i}`, publicationType: "Academic Article" }),
      ),
    });
    const s1 = group(cvOutline({ profile, mentees: [], pops: null }), "S").entries.find(
      (e) => e.code === "S1",
    )!;
    expect(s1.count).toBe(OUTLINE_ITEM_CAP + 5);
    expect(s1.items).toHaveLength(OUTLINE_ITEM_CAP);
  });
});
