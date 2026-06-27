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
    { title: "Attending Physician", institution: "NewYork-Presbyterian Hospital", start: "2012-07-01", end: null },
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

// ── cvOutline — the live /edit preview (spec §8) ─────────────────────────────

type Pub = ProfilePayload["publications"][number];
function pub(over: Partial<Pub>): Pub {
  return { pmid: "1", title: "A paper", journal: "Some Journal", year: 2020, ...over } as Pub;
}

function find(sections: ReturnType<typeof cvOutline>, code: string) {
  const s = sections.find((x) => x.code === code);
  if (!s) throw new Error(`section ${code} missing from outline`);
  return s;
}

describe("cvOutline — document-ordered CV preview", () => {
  it("returns every WCM section A–S in download order", () => {
    const codes = cvOutline({ profile: researchInput.profile, mentees: [], pops: null }).map(
      (s) => s.code,
    );
    expect(codes).toEqual([
      "A", "B1", "B2", "C", "D1", "D2", "E", "F1", "F2", "G", "H", "I", "J", "K",
      "L", "M1", "M2", "N", "O", "P", "Q", "R", "S",
    ]);
  });

  it("counts the research spine and marks no-source sections to-complete", () => {
    const o = cvOutline({
      profile: researchInput.profile,
      mentees: researchInput.mentees,
      pops: null,
    });
    expect(find(o, "B1").count).toBe(1); // PhD, MIT
    expect(find(o, "D1").count).toBe(1); // Professor @ WCM (academic, not hospital)
    expect(find(o, "M2").count).toBe(1); // one grant
    expect(find(o, "N").count).toBe(1); // one mentee
    expect(find(o, "O").count).toBe(1); // one leadership line
    expect(find(o, "M1").status).toBe("generated"); // drafted at download
    // No POPS ⇒ clinical sections have a source but no data ("empty"), not "filled".
    expect(find(o, "C").status).toBe("empty");
    expect(find(o, "F2").status).toBe("empty");
    // Truly source-less sections are "todo".
    expect(find(o, "E").status).toBe("todo");
    expect(find(o, "K").status).toBe("todo");
  });

  it("fills clinical sections from POPS and tags them", () => {
    const o = cvOutline({
      profile: clinicalInput.profile,
      mentees: [],
      pops: clinicalInput.pops,
    });
    expect(find(o, "C")).toMatchObject({ status: "filled", source: "pops", count: 1 });
    expect(find(o, "F1").items).toContain("NPI 1234567890");
    expect(find(o, "F2").count).toBe(1); // board cert
    expect(find(o, "H").count).toBe(2); // honor + Castle Connolly
  });

  it("personal data (A) lists name + visible email and has no count", () => {
    const a = find(
      cvOutline({ profile: clinicalInput.profile, mentees: [], pops: null }),
      "A",
    );
    expect(a.count).toBeNull();
    expect(a.items).toEqual(["Robert Jones, MD", "rj9001@med.cornell.edu"]);
  });

  it("caps the item preview but reports the true count", () => {
    const profile = baseProfile({
      publications: Array.from({ length: OUTLINE_ITEM_CAP + 5 }, (_, i) =>
        pub({ pmid: String(i), title: `Paper ${i}` }),
      ),
    });
    const s = find(cvOutline({ profile, mentees: [], pops: null }), "S");
    expect(s.count).toBe(OUTLINE_ITEM_CAP + 5);
    expect(s.items).toHaveLength(OUTLINE_ITEM_CAP);
  });
});
