/**
 * Sponsor-match export rows. The fused score must not leak into a column the contract withholds
 * from the UI, and the brief note must never be exported. The formula guard and the workbook
 * shape are tested in matcha-xlsx.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  briefExportFields,
  buildMatchaRows,
  matchaExportFilename,
  type MatchaExportRow,
} from "@/lib/edit/matcha-export";
import { NO_LAB_ANGLE } from "@/lib/edit/matcha-brief-types";

const ROW: MatchaExportRow = {
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
  researcherType: "Physician-scientist",
  researchKind: "Laboratory research",
  technologyCount: 2,
  profileUrl: "https://example.org/alice-alpha",
};

const HEADER = [
  "Rank",
  "CWID",
  "Name",
  "Title",
  "Department",
  "Fit",
  "Matched concepts",
  "Person type",
  "Career stage",
  "Clinician",
  "Researcher type",
  "Research kind",
  "CTL technologies",
  "Profile URL",
];

describe("buildMatchaRows", () => {
  it("writes the header row and one row per researcher", () => {
    const t = buildMatchaRows([ROW]);
    expect(t.header).toEqual(HEADER);
    expect(t.body).toEqual([
      [
        1,
        "aaa1001",
        "Alice Alpha",
        "Professor of Medicine",
        "Medicine",
        "Strong fit",
        "systemic sclerosis; pulmonary fibrosis",
        "Full-time faculty",
        "Senior",
        "Yes",
        "Physician-scientist",
        "Laboratory research",
        2,
        "https://example.org/alice-alpha",
      ],
    ]);
  });

  it("serializes a null title/department as empty, never the string 'null'", () => {
    const [row] = buildMatchaRows([{ ...ROW, title: null, department: null }]).body;
    expect(row[3]).toBe("");
    expect(row[4]).toBe("");
  });

  it("has no fused-score column — the contract keeps that number out of the UI", () => {
    const t = buildMatchaRows([ROW]);
    expect(t.header.join(",")).not.toMatch(/score/i);
    expect(t.body[0]).toContain("Strong fit");
  });

  it("leaves the measure cells BLANK when absent — a blank is unknown, not 'no' (#1654)", () => {
    const unknown: MatchaExportRow = {
      ...ROW,
      personType: "",
      careerStage: "",
      clinician: "",
      researcherType: "",
      researchKind: "",
    };
    expect(buildMatchaRows([unknown]).body[0].slice(7, 12)).toEqual(["", "", "", "", ""]);
  });

  it("returns just the header for an empty result set", () => {
    expect(buildMatchaRows([])).toEqual({ header: HEADER, body: [] });
  });

  // ── Grant Matcha — the Eligible column (zero-results fix 3) ────────────────
  // The export carries the PRE-gate set, so each row says whether the page's gate shows it.
  it("appends the Eligible column with per-row Yes/No when the build asks for it", () => {
    const t = buildMatchaRows(
      [
        { ...ROW, eligible: "Yes" },
        { ...ROW, cwid: "bbb2002", name: "Bob Beta", eligible: "No" },
      ],
      { eligibility: true },
    );
    expect(t.header).toEqual([...HEADER, "Eligible"]);
    expect(t.body.map((r) => r.at(-1))).toEqual(["Yes", "No"]);
  });

  it("an empty grant-path export still writes the Eligible header — an option, not row-inferred", () => {
    expect(buildMatchaRows([], { eligibility: true }).header).toEqual([...HEADER, "Eligible"]);
  });

  it("without the option the file is unchanged — `/edit/matcha` states no rule, so no column", () => {
    const t = buildMatchaRows([{ ...ROW, eligible: "Yes" }]);
    expect(t.header).toEqual(HEADER);
    expect(t.body[0]).toHaveLength(14);
  });
});

describe("matchaExportFilename", () => {
  const d = new Date("2026-11-13T12:00:00Z");
  it("slugs the title and dates the file", () => {
    expect(matchaExportFilename("Acme Bio: CAR-T partners", false, d)).toBe(
      "matcha-acme-bio-car-t-partners-2026-11-13.xlsx",
    );
  });
  it("marks the shortlist so the two files never share a name", () => {
    expect(matchaExportFilename("Acme", true, d)).toBe("matcha-acme-shortlist-2026-11-13.xlsx");
  });
  it("falls back when there is no usable title, and never emits a quote or slash", () => {
    expect(matchaExportFilename(null, false, d)).toBe("matcha-researchers-2026-11-13.xlsx");
    expect(matchaExportFilename('"/../x', false, d)).toBe("matcha-x-2026-11-13.xlsx");
  });
});

describe("buildMatchaRows — Matcha Phase 3 brief columns", () => {
  const BRIEF = {
    generated: {
      why: "Generated why.",
      angle: "Generated angle.",
      topics: [
        {
          concept: "x",
          text: "Generated topic",
          sources: [{ kind: "pub" as const, pmid: "1", year: 2024, title: "Short paper title" }],
        },
      ],
      removedCount: 0,
    },
    edited: {
      why: "Edited why.",
      angle: "Edited angle.",
      topics: [{ concept: "", text: "My own topic", sources: [] }],
    },
    note: "CONFIDENTIAL-NOTE-TEXT",
  };

  it("omits the brief columns unless asked (flag off ⇒ master's file)", () => {
    expect(buildMatchaRows([ROW]).header).toEqual(HEADER);
  });

  it("writes the EDITED why and topics when present", () => {
    const t = buildMatchaRows([{ ...ROW, ...briefExportFields(BRIEF) }], { brief: true });
    expect(t.header).toEqual([...HEADER, "Why this PI", "Partnership angle", "Discussion topics"]);
    const line = t.body[0].join("|");
    expect(line).toContain("Edited why.");
    expect(line).toContain("Edited angle.");
    expect(line).not.toContain("Generated angle.");
    expect(line).toContain("My own topic [unsourced]");
    expect(line).not.toContain("Generated why.");
  });

  it("falls back to the generated text, with source labels", () => {
    const csv = JSON.stringify(
      buildMatchaRows([{ ...ROW, ...briefExportFields({ ...BRIEF, edited: null }) }], {
        brief: true,
      }),
    );
    expect(csv).toContain("Generated why.");
    expect(csv).toContain("Generated angle.");
    expect(csv).toContain("Generated topic [2024 · Short paper title]");
  });

  it("NEVER includes the note", () => {
    const fields = briefExportFields(BRIEF);
    expect(JSON.stringify(fields)).not.toContain("CONFIDENTIAL-NOTE-TEXT");
    const t = buildMatchaRows([{ ...ROW, ...fields }], { brief: true });
    expect(JSON.stringify(t)).not.toContain("CONFIDENTIAL-NOTE-TEXT");
    expect(t.header.join(",")).not.toMatch(/note/i);
  });

  it("writes a blank angle for a brief drafted before angles existed", () => {
    const { angle: _drop, ...legacy } = BRIEF.generated;
    void _drop;
    const fields = briefExportFields({ generated: legacy, edited: null });
    expect(fields.briefAngle).toBe("");
    expect(fields.briefWhy).toBe("Generated why.");
  });

  it("writes the no-laboratory-angle sentence as plain text", () => {
    const fields = briefExportFields({
      generated: { ...BRIEF.generated, angle: NO_LAB_ANGLE },
      edited: null,
    });
    expect(fields.briefAngle).toBe("No laboratory collaboration angle is evident.");
  });

  it("writes blanks for a row with no brief", () => {
    const t = buildMatchaRows([{ ...ROW, ...briefExportFields(undefined) }], { brief: true });
    expect(t.body[0].slice(-4)).toEqual(["https://example.org/alice-alpha", "", "", ""]);
  });
});
