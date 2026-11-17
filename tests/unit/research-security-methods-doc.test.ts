/**
 * `lib/edit/research-security-methods-doc.ts` — the workbook's "Query &
 * Assumptions" content, adapted to the standing dashboard. Pins the statements
 * that must not be softened or dropped.
 */
import { describe, expect, it } from "vitest";

import {
  SCREENING_NOTICE,
  buildResearchSecurityMethodsDoc,
  researchSecurityMethodsMarkdown,
} from "@/lib/edit/research-security-methods-doc";

const doc = buildResearchSecurityMethodsDoc();
const text = doc.sections.map((s) => `${s.heading}\n${s.body}`).join("\n");
const section = (heading: string) => doc.sections.find((s) => s.heading === heading)?.body ?? "";

describe("research security methods doc", () => {
  it("leads with: screening results, not determinations", () => {
    expect(doc.notice).toBe(SCREENING_NOTICE);
    expect(doc.notice).toContain("screening results, not determinations");
    expect(section("What this is")).toContain("screening results, not determinations");
    expect(section("Before acting")).toContain("screening results, not determinations");
  });

  it("carries every Query & Assumptions topic", () => {
    expect(doc.sections.map((s) => s.heading)).toEqual([
      "What this is",
      "Lists",
      "Publications screened",
      "WCM and Cornell University",
      "Matching method",
      "Known false-positive guards",
      "Confirmed and not yet attributed",
      "Our author also lists the entity",
      "Large consortia",
      "Funding flags",
      "Known limits",
      "Before acting",
    ]);
    for (const s of doc.sections) expect(s.body.length).toBeGreaterThan(80);
  });

  it("describes the four lists and keeps country of concern a separate tier", () => {
    const lists = section("Lists");
    expect(lists).toContain("134 entities");
    expect(lists).toContain("nominations, not designations");
    expect(lists).toContain("Usual suspects");
    expect(lists).toContain("China (including Hong Kong and Macau), Russia, Iran, North Korea, Cuba or Venezuela");
    expect(lists).toContain("never added to an entity total");
    expect(lists).toContain("China Scholarship Council");
  });

  it("states the date default, the campus rule and the cohort exclusion", () => {
    expect(section("Publications screened")).toContain("2021-01-01");
    expect(section("WCM and Cornell University")).toContain("'cornell-ithaca'");
    expect(section("WCM and Cornell University")).toContain("External validation cohorts");
  });

  it("states the confirmed / not-yet-attributed rules and the 1-4 priority", () => {
    const s = section("Confirmed and not yet attributed");
    expect(s).toContain("never part of a confirmed count");
    expect(s).toContain("is not counted as not yet attributed");
    expect(s).toContain("1 = the candidate also lists the entity");
    expect(s).toContain("ReCiter score of 90 or more, or an open review-queue row, including a suggestion under 90 that also has one");
    expect(s).toContain("4 = 50+ author consortium");
  });

  it("lists the known limits from the plan", () => {
    const s = section("Known limits");
    expect(s).toContain("only author-supplied affiliations");
    expect(s).toContain("only the first author's");
    expect(s).toContain("Grant metadata is incomplete");
    expect(s).toContain("DOI being present and in OpenAlex");
    expect(s).toContain("namesake");
    expect(section("Funding flags")).toContain("does not identify which");
  });

  it("names the false-positive guards", () => {
    const s = section("Known false-positive guards");
    for (const g of ["National Tsing Hua", "Soochow University in Taipei", "Xi'an Jiaotong-Liverpool", "Nanjing"])
      expect(s).toContain(g);
  });

  it("names no person and no count of people", () => {
    expect(text).not.toMatch(/\b[a-z]{2,3}\d{4}\b/); // a cwid
    expect(text).not.toMatch(/Requested by/);
  });

  it("renders as markdown with the data date and the caution first", () => {
    const md = researchSecurityMethodsMarkdown(doc, new Date("2026-11-17T08:00:00Z"));
    expect(md.startsWith("# Research security: methods\n\nData as of 2026-11-17.\n\n" + SCREENING_NOTICE)).toBe(true);
    expect(md).toContain("## Known limits");
    expect(researchSecurityMethodsMarkdown(doc, null)).toContain("Data as of unknown.");
  });
});
