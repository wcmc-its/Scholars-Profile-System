/**
 * Sponsor-match CSV export. The interesting cases are the two that bite in production:
 * a sponsor's pasted prose reaching a spreadsheet as a live formula, and the fused score
 * leaking into a column the contract deliberately withholds from the UI.
 */
import { describe, expect, it } from "vitest";

import {
  buildMatchaCsv,
  type MatchaCsvRow,
} from "@/lib/edit/matcha-export";

const ROW: MatchaCsvRow = {
  rank: 1,
  cwid: "aaa1001",
  name: "Alice Alpha",
  title: "Professor of Medicine",
  department: "Medicine",
  fit: "Strong fit",
  matchedConcepts: ["systemic sclerosis", "pulmonary fibrosis"],
  personType: "Full-time faculty",
  careerStage: "Senior",
  clinician: "Yes",
  technologyCount: 2,
  profileUrl: "https://example.org/alice-alpha",
};

const HEADER =
  "Rank,CWID,Name,Title,Department,Fit,Matched concepts,Person type,Career stage,Clinician,CTL technologies,Profile URL";

describe("buildMatchaCsv", () => {
  it("writes the header row and one row per researcher", () => {
    const lines = buildMatchaCsv([ROW]).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(
      '1,aaa1001,Alice Alpha,Professor of Medicine,Medicine,Strong fit,systemic sclerosis; pulmonary fibrosis,Full-time faculty,Senior,Yes,2,https://example.org/alice-alpha',
    );
  });

  it("joins matched concepts with '; ' — a comma would look like another column", () => {
    const csv = buildMatchaCsv([ROW]);
    expect(csv).toContain("systemic sclerosis; pulmonary fibrosis");
  });

  it("serializes a null title/department as empty, never the string 'null'", () => {
    const csv = buildMatchaCsv([{ ...ROW, title: null, department: null }]);
    expect(csv).not.toContain("null");
    expect(csv.split("\r\n")[1]).toBe(
      '1,aaa1001,Alice Alpha,,,Strong fit,systemic sclerosis; pulmonary fibrosis,Full-time faculty,Senior,Yes,2,https://example.org/alice-alpha',
    );
  });

  /**
   * THE ONE THAT MATTERS. Concept terms are extracted from a PASTED SPONSOR EMAIL — untrusted
   * text that lands in a spreadsheet a fundraising officer opens. A term beginning `=`, `+`,
   * `-` or `@` is a live formula to Excel (OWASP "CSV Injection"). `toCsv` neutralises it; this
   * pins that we route through it rather than joining strings by hand.
   */
  it("neutralises a formula-injection payload in an attacker-controlled concept term", () => {
    const csv = buildMatchaCsv([
      { ...ROW, matchedConcepts: ["=cmd|'/c calc'!A1"], name: "@SUM(1+1)" },
    ]);
    // Whatever the guard's exact form, the cell must not START a formula once parsed.
    const cells = csv.split("\r\n")[1];
    expect(cells).not.toContain(",=cmd");
    expect(cells).not.toContain(",@SUM");
  });

  it("has no fused-score column — the contract keeps that number out of the UI", () => {
    const csv = buildMatchaCsv([ROW]);
    expect(csv.split("\r\n")[0]).not.toMatch(/score/i);
    // `Fit` is the tier LABEL, not a number.
    expect(csv).toContain("Strong fit");
  });

  it("leaves the measure cells BLANK when absent — a blank is unknown, not 'no' (#1654)", () => {
    // The producer landed, but a candidate with no Scholar row still carries no measure.
    // Writing "No" there would assert she is not a clinician; we simply do not know.
    const unknown: MatchaCsvRow = {
      ...ROW,
      personType: "",
      careerStage: "",
      clinician: "",
    };
    const cells = buildMatchaCsv([unknown]).split("\r\n")[1];
    expect(cells).toContain("systemic sclerosis; pulmonary fibrosis,,,,2,");
    expect(cells).not.toMatch(/,No,/);
  });

  it("returns just the header for an empty result set", () => {
    expect(buildMatchaCsv([]).trim()).toBe(HEADER);
  });

  // ── Grant Matcha — the Eligible column (zero-results fix 3) ────────────────
  // The export deliberately carries the PRE-gate set (the officer's outreach list), so each
  // row must say whether the page's gate shows it — otherwise the CSV silently contradicts
  // the page it came from ("Top 0" on screen, 77 unmarked rows in the file).
  it("appends the Eligible column with per-row Yes/No when the build asks for it", () => {
    const lines = buildMatchaCsv(
      [
        { ...ROW, eligible: "Yes" },
        { ...ROW, cwid: "bbb2002", name: "Bob Beta", eligible: "No" },
      ],
      { eligibility: true },
    ).split("\r\n");
    expect(lines[0]).toBe(`${HEADER},Eligible`);
    expect(lines[1]).toBe(
      "1,aaa1001,Alice Alpha,Professor of Medicine,Medicine,Strong fit,systemic sclerosis; pulmonary fibrosis,Full-time faculty,Senior,Yes,2,https://example.org/alice-alpha,Yes",
    );
    expect(lines[2].endsWith(",No")).toBe(true);
  });

  it("an empty grant-path export still writes the Eligible header — an option, not row-inferred", () => {
    expect(buildMatchaCsv([], { eligibility: true }).trim()).toBe(`${HEADER},Eligible`);
  });

  it("without the option the file is unchanged — `/edit/matcha` states no rule, so no column", () => {
    // A stray `eligible` value must not smuggle a 13th cell into a 12-column file either.
    const lines = buildMatchaCsv([{ ...ROW, eligible: "Yes" }]).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1].split(",")).toHaveLength(12);
  });
});
