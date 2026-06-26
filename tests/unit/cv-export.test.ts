/**
 * Unit coverage for the WCM CV docx builder (spec §12).
 *
 * Builds the CV for two in-test fixtures — a research-only scholar (no POPS) and
 * a clinical scholar (with a POPS payload incl. one board certification) — packs
 * each to a real .docx, unzips `word/document.xml`, and asserts:
 *   (a) all 23 WCM section headings present, in order;
 *   (b) every empty section renders the literal "N/A" placeholder;
 *   (c) the bibliography contains the scholar surname inside a BOLD run;
 *   (d) the clinical fixture's board certification appears in the F2 section.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import {
  buildWcmCv,
  WCM_CV_SECTION_HEADINGS,
  type CvInput,
  type PopsEnrichment,
} from "@/lib/edit/cv-export";
import type { ProfilePayload } from "@/lib/api/profile";
import type { MenteeChip } from "@/lib/api/mentoring";

// ── docx-xml extraction helpers ─────────────────────────────────────────────

async function documentXml(input: CvInput): Promise<string> {
  const buffer = await Packer.toBuffer(buildWcmCv(input));
  const zip = await JSZip.loadAsync(buffer);
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

/** Ordered trimmed text of every `<w:p>` (table-cell paragraphs included). */
function paragraphTexts(xml: string): string[] {
  const out: string[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml))) {
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    let s = "";
    while ((t = tRe.exec(m[1]!))) s += decodeXml(t[1]!);
    out.push(s.trim());
  }
  return out;
}

/** Text of every run carrying an explicit `<w:b/>` (bold, not val=false). */
function boldRunTexts(xml: string): string[] {
  const out: string[] = [];
  const rRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = rRe.exec(xml))) {
    const inner = m[1]!;
    const rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(inner);
    const props = rpr ? rpr[1]! : "";
    const boldOn = /<w:b\/>|<w:b\s+w:val="(?:true|1|on)"\s*\/>/.test(props);
    const boldOff = /<w:b\s+w:val="(?:false|0|none)"\s*\/>/.test(props);
    if (!boldOn || boldOff) continue;
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    let s = "";
    while ((t = tRe.exec(inner))) s += decodeXml(t[1]!);
    out.push(s);
  }
  return out;
}

// ── minimal typed fixtures ──────────────────────────────────────────────────

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
    {
      title: "Attending Physician",
      institution: "NewYork-Presbyterian Hospital",
      start: "2012-07-01",
      end: null,
    },
  ],
  honors: [{ name: "Top Doctor, New York Magazine", date: "2021" }],
  specialties: ["Cardiology"],
  practices: [
    { name: "Heart Failure Program", type: "Service" },
    { name: "Englander Department of Cardiology", type: "Location" },
  ],
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
    clinicalProfileUrl: null,
    email: "rj9001@med.cornell.edu",
    educations: [{ degree: "MD", institution: "Columbia University", year: 2005, field: null }],
    leadershipTitles: ["Chief, Division of General Internal Medicine"],
    grants: [
      {
        title: "Hospital readmissions cohort",
        role: "Co-Investigator",
        funder: "AHRQ",
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

// ── (a) all 23 headings, in order ───────────────────────────────────────────

describe("buildWcmCv — section coverage & order", () => {
  it("emits exactly 23 canonical WCM headings", () => {
    expect(WCM_CV_SECTION_HEADINGS).toHaveLength(23);
  });

  for (const [name, input] of [
    ["research-only", researchInput],
    ["clinical", clinicalInput],
  ] as const) {
    it(`renders all 23 WCM headings in template order (${name})`, async () => {
      const paras = paragraphTexts(await documentXml(input));
      const indices = WCM_CV_SECTION_HEADINGS.map((h) => paras.indexOf(h));
      // every heading present
      WCM_CV_SECTION_HEADINGS.forEach((h, i) =>
        expect(indices[i], `heading "${h}" missing`).toBeGreaterThanOrEqual(0),
      );
      // strictly increasing → in order
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i], `"${WCM_CV_SECTION_HEADINGS[i]}" out of order`).toBeGreaterThan(
          indices[i - 1]!,
        );
      }
    });
  }
});

// ── (b) empty sections show N/A ─────────────────────────────────────────────

describe("buildWcmCv — empty sections render N/A", () => {
  // Sections with NO data in the research-only fixture (no POPS, no clinical).
  const RESEARCH_NA = [
    "OTHER EDUCATIONAL EXPERIENCES",
    "POSTDOCTORAL TRAINING",
    "EMPLOYMENT STATUS",
    "LICENSURE AND BOARD CERTIFICATION",
    "HOSPITAL AFFILIATION",
    "HONORS AND AWARDS",
    "PROFESSIONAL MEMBERSHIPS",
    "PERCENT EFFORT",
    "EDUCATIONAL CONTRIBUTIONS",
    "CLINICAL ACTIVITIES",
    "INSTITUTIONAL ADMINISTRATIVE AND COMMITTEE SERVICE",
    "EXTRAMURAL PROFESSIONAL ACTIVITIES",
    "INVITATIONS TO SPEAK",
    "APPENDIX",
  ];
  // Clinical fixture fills §5/§8/§9/§10 but has no mentees → §17 N/A too.
  const CLINICAL_NA = [
    "OTHER EDUCATIONAL EXPERIENCES",
    "EMPLOYMENT STATUS",
    "PROFESSIONAL MEMBERSHIPS",
    "PERCENT EFFORT",
    "EDUCATIONAL CONTRIBUTIONS",
    "MENTORING",
    "INSTITUTIONAL ADMINISTRATIVE AND COMMITTEE SERVICE",
    "EXTRAMURAL PROFESSIONAL ACTIVITIES",
    "INVITATIONS TO SPEAK",
    "APPENDIX",
  ];

  for (const [name, input, expected] of [
    ["research-only", researchInput, RESEARCH_NA],
    ["clinical", clinicalInput, CLINICAL_NA],
  ] as const) {
    it(`places "N/A" directly under each empty heading (${name})`, async () => {
      const paras = paragraphTexts(await documentXml(input));
      for (const h of expected) {
        const idx = paras.indexOf(h);
        expect(idx, `heading "${h}" missing`).toBeGreaterThanOrEqual(0);
        expect(paras[idx + 1], `section "${h}" should render N/A`).toBe("N/A");
      }
    });
  }
});

// ── (c) bibliography bolds the scholar surname ──────────────────────────────

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

// ── (d) clinical board certification renders in F2 ──────────────────────────

describe("buildWcmCv — clinical board certification (F2)", () => {
  it("renders the board cert within the LICENSURE AND BOARD CERTIFICATION section", async () => {
    const paras = paragraphTexts(await documentXml(clinicalInput));
    const start = paras.indexOf("LICENSURE AND BOARD CERTIFICATION");
    const end = paras.indexOf("HOSPITAL AFFILIATION");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const region = paras.slice(start, end);
    expect(region).toContain("Board Certification");
    expect(region.some((t) => t.includes("American Board of Internal Medicine"))).toBe(true);
    expect(region.some((t) => t.includes("Internal Medicine"))).toBe(true);
  });
});

// ── POPS practices/expertise (§14) + Castle Connolly honor ───────────────────

describe("buildWcmCv — clinical activities + Castle Connolly", () => {
  it("renders POPS practices and expertise in CLINICAL ACTIVITIES", async () => {
    const paras = paragraphTexts(await documentXml(clinicalInput));
    const start = paras.indexOf("CLINICAL ACTIVITIES");
    const end = paras.indexOf("RESEARCH ACTIVITIES");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const region = paras.slice(start, end);
    expect(region.some((t) => t.includes("Heart Failure Program"))).toBe(true);
    expect(region.some((t) => t.includes("Heart failure"))).toBe(true);
  });

  it("excludes practice_type 'Location' rows and orders expertise above Clinical Practice (§13.3)", async () => {
    const paras = paragraphTexts(await documentXml(clinicalInput));
    const start = paras.indexOf("CLINICAL ACTIVITIES");
    const end = paras.indexOf("RESEARCH ACTIVITIES");
    const region = paras.slice(start, end);
    // Location row dropped — it's the parent department, already in §9 Hospital Affiliation.
    expect(region.some((t) => t.includes("Englander Department of Cardiology"))).toBe(false);
    // "Areas of expertise" precedes the "Clinical Practice" subheading.
    const exp = region.findIndex((t) => t.startsWith("Areas of expertise"));
    const prac = region.indexOf("Clinical Practice");
    expect(exp).toBeGreaterThanOrEqual(0);
    expect(prac).toBeGreaterThan(exp);
  });

  it("renders the Castle Connolly badge in HONORS AND AWARDS", async () => {
    const paras = paragraphTexts(await documentXml(clinicalInput));
    const start = paras.indexOf("HONORS AND AWARDS");
    const end = paras.indexOf("PROFESSIONAL MEMBERSHIPS");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(paras.slice(start, end).some((t) => t.includes("Castle Connolly Top Doctor"))).toBe(
      true,
    );
  });
});
