import { describe, expect, it } from "vitest";

import {
  buildMethodsDoc,
  DATA_SHARING_TERMS,
  methodsMarkdown,
  type MethodsDocReport,
} from "@/lib/edit/data-sharing-methods-doc";

/** Realistic magnitudes (thousands, so `toLocaleString` grouping actually
 *  fires) — the paragraph's word count must hold at ANY magnitude because
 *  every interpolated number is one whitespace-delimited token. */
const REPORT: MethodsDocReport = {
  overall: {
    datasets: 987,
    faculty: 456,
    shareRateDenominator: 12345,
    shareRateNumerator: 1234,
    pmcCoveredPubs: 9876,
    pmcDepositedPubs: 1100,
    openPubs: 800,
    controlledPubs: 300,
  },
  byRepository: Array.from({ length: 36 }, (_, i) => ({ repository: `R${i}` })),
  byDepartment: Array.from({ length: 26 }, (_, i) => ({ department: `D${i}` })),
};

const EMPTY_REPORT: MethodsDocReport = {
  overall: {
    datasets: 0,
    faculty: 0,
    shareRateDenominator: 0,
    shareRateNumerator: 0,
    pmcCoveredPubs: 0,
    pmcDepositedPubs: 0,
    openPubs: 0,
    controlledPubs: 0,
  },
  byRepository: [],
  byDepartment: [],
};

const OPTS = { shareRateYearFloor: 2020 };

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

describe("DATA_SHARING_TERMS", () => {
  it("covers every term the dashboard leans on", () => {
    for (const term of [
      "Country of concern",
      "Foreign-hosted",
      "Open access",
      "Controlled access",
      "Registry",
      "Strict floor",
      "Deposit instance",
      "PMC",
      "Share rate",
    ]) {
      expect(DATA_SHARING_TERMS[term], term).toBeTruthy();
    }
  });

  it("Country of concern is defined by HOST jurisdiction, never author nationality", () => {
    const def = DATA_SHARING_TERMS["Country of concern"];
    expect(def).toContain("HOST jurisdiction");
    expect(def).toContain("not by any author's nationality");
  });
});

describe("buildMethodsDoc — reporting paragraph", () => {
  it("lands in the 180–220 word window (the ~200-word reporting-paragraph contract)", () => {
    const { paragraph } = buildMethodsDoc(REPORT, OPTS);
    const words = wordCount(paragraph);
    expect(words).toBeGreaterThanOrEqual(180);
    expect(words).toBeLessThanOrEqual(220);
  });

  it("states the denominator explicitly, en-US formatted", () => {
    const { paragraph } = buildMethodsDoc(REPORT, OPTS);
    expect(paragraph).toContain("12,345");
    expect(paragraph).toContain("Between 2020 and the present");
  });

  it("carries every headline number and the strict-floor framing", () => {
    const { paragraph } = buildMethodsDoc(REPORT, OPTS);
    for (const n of ["1,234", "987", "36", "456", "26", "9,876", "1,100", "800", "300"]) {
      expect(paragraph).toContain(n);
    }
    expect(paragraph).toContain("strict floor");
    expect(paragraph).toContain("2% of PMC full text");
    // Registry separation must survive any rewording.
    expect(paragraph).toContain("ClinicalTrials.gov");
  });

  it("scopes its claims to what the code computes (v3 review findings)", () => {
    const { paragraph } = buildMethodsDoc(REPORT, OPTS);
    // The denominator has no FTE filter (see "Corpus and denominator" /
    // "Known gaps") — attributing it to full-time faculty was the finding.
    expect(paragraph).not.toContain("full-time");
    // Registry exclusion is scoped to the rates and the access split; the
    // record/repository/faculty totals in the same paragraph DO include
    // registry rows and are flagged inline — never a blanket
    // "excluded from every deposit count here" claim.
    expect(paragraph).not.toContain("every deposit count");
    expect(paragraph).toContain("trial registrations included");
    expect(paragraph).toContain("excluded from the share rate");
  });

  it("stays in the word window and NaN-free on an all-zero report (word count is magnitude-independent)", () => {
    const { paragraph } = buildMethodsDoc(EMPTY_REPORT, OPTS);
    expect(paragraph).not.toContain("NaN");
    const words = wordCount(paragraph);
    expect(words).toBeGreaterThanOrEqual(180);
    expect(words).toBeLessThanOrEqual(220);
  });
});

describe("buildMethodsDoc — sections", () => {
  it("emits the eight sections in order, each with a non-empty body", () => {
    const { sections } = buildMethodsDoc(REPORT, OPTS);
    expect(sections.map((s) => s.heading)).toEqual([
      "Corpus and denominator",
      "Extraction and attribution",
      "PMC coverage",
      "Access model and risk tier",
      "Registry separation",
      "Funding lens",
      "Known gaps",
      "Glossary",
    ]);
    for (const s of sections) expect(s.body.length).toBeGreaterThan(0);
  });

  it("PMC coverage interpolates the covered/total counts", () => {
    const pmc = buildMethodsDoc(REPORT, OPTS).sections.find((s) => s.heading === "PMC coverage")!;
    expect(pmc.body).toContain("9,876");
    expect(pmc.body).toContain("12,345");
    expect(pmc.body).toContain("80%"); // 9876/12345 rounded
  });

  it("never softens the tier-only 'concerning' caveat (SPEC Amended 08-13)", () => {
    const tier = buildMethodsDoc(REPORT, OPTS).sections.find(
      (s) => s.heading === "Access model and risk tier",
    )!;
    expect(tier.body).toContain("tier-derived ONLY");
    expect(tier.body).toContain("does NOT include sensitive-data-type detection");
    expect(tier.body).toContain("not yet built");
  });

  it("Registry separation states the precise boundary — rates exclude registry, headline totals include it (v3 review finding)", () => {
    const reg = buildMethodsDoc(REPORT, OPTS).sections.find((s) => s.heading === "Registry separation")!;
    expect(reg.body).toContain("share-rate numerator");
    expect(reg.body).toContain("DO remain inside the headline");
    expect(reg.body).not.toContain("separated everywhere");
  });

  it("renders the glossary as 'Term — definition' lines", () => {
    const glossary = buildMethodsDoc(REPORT, OPTS).sections.find((s) => s.heading === "Glossary")!;
    expect(glossary.body).toContain("Country of concern — ");
    expect(glossary.body).toContain("Share rate — ");
    expect(glossary.body.split("\n")).toHaveLength(Object.keys(DATA_SHARING_TERMS).length);
  });
});

describe("methodsMarkdown", () => {
  it("renders the title, data-as-of line, and one ## per section — glossary heading included", () => {
    const doc = buildMethodsDoc(REPORT, OPTS);
    const md = methodsMarkdown(doc, new Date("2026-08-01T12:00:00Z"));
    expect(md.startsWith("# Data sharing — methods\n")).toBe(true);
    expect(md).toContain("Data as of 2026-08-01.");
    for (const s of doc.sections) expect(md).toContain(`## ${s.heading}`);
    expect(md).toContain("## Glossary");
    expect(md).toContain("Country of concern — ");
  });

  it("renders a null dataAsOf as 'unknown' and uses no horizontal rules", () => {
    const md = methodsMarkdown(buildMethodsDoc(REPORT, OPTS), null);
    expect(md).toContain("Data as of unknown.");
    // Heading-separated only — a line of dashes would render as an <hr> (or
    // promote the previous line to a setext heading).
    expect(md).not.toMatch(/^---/m);
    expect(md).not.toMatch(/^\*\*\*/m);
  });
});
