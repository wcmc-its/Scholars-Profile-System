import { describe, expect, it } from "vitest";

import {
  detectLeadershipSite,
  isFullTimeFaculty,
  leadershipTierLabel,
  leadershipTierRank,
  parseFunctions,
  parseLeadershipTitle,
  serializeFunctions,
} from "@/lib/unit-leadership";

/** [title, department, tier, functions, areaText, site] — titles from the Nov 2026 web audit. */
const CASES: [string, string, string, string[], string | null, string | null][] = [
  ["Executive Vice Chair for Academic Affairs", "Anesthesiology", "executive", ["faculty_affairs"], null, null],
  ["Executive Vice Chair for Clinical Affairs", "Anesthesiology", "executive", ["clinical_operations"], null, null],
  ["Vice Chair for Patient Safety & Quality Improvement", "Anesthesiology", "vice", ["quality_safety"], null, null],
  ["Vice Chair for Professional Affairs", "Anesthesiology", "vice", ["faculty_affairs"], null, null],
  ["Vice Chair for Operations and Informatics", "Anesthesiology", "vice", ["clinical_operations", "informatics"], null, null],
  ["Vice Chair of Clinical Services", "Emergency Medicine", "vice", ["clinical_operations"], null, null],
  ["Associate Vice Chair of Research", "Emergency Medicine", "associate", ["research"], null, null],
  ["Vice Chair of Clinical and Faculty Affairs", "Emergency Medicine", "vice", ["faculty_affairs", "clinical_operations"], null, null],
  ["Vice Chair for Faculty", "Medicine", "vice", ["faculty_affairs"], null, null],
  ["Vice Chair for Mentoring and Faculty Development", "Medicine", "vice", ["faculty_affairs"], null, null],
  ["Associate Vice Chair for Compliance", "Medicine", "associate", ["compliance"], null, null],
  ["Assistant Vice Chair of Operations", "Medicine", "assistant", ["clinical_operations"], null, null],
  ["Vice Chair, Weill Department of Medicine", "Medicine", "vice", [], null, null],
  ["Executive Vice Chair, Neurological Surgery", "Neurological Surgery", "executive", [], null, null],
  ["Vice Chair, Department of Neurological Surgery", "Neurological Surgery", "vice", [], null, null],
  ["Vice Chair for Clinical Research", "Neurology", "vice", ["research"], null, null],
  ["Vice Chair, Neurology Hospital Services", "Neurology", "vice", ["clinical_operations"], null, null],
  ["Vice Chair of Clinical Research in Obstetrics and Gynecology", "Obstetrics and Gynecology", "vice", ["research"], null, null],
  [
    "Vice Chair of Obstetrics and Gynecology NewYork-Presbyterian Queens Hospital",
    "Obstetrics and Gynecology",
    "vice",
    [],
    null,
    "nyp_queens",
  ],
  ["Vice Chair (Department of Obstetrics and Gynecology)", "Obstetrics and Gynecology", "vice", [], null, null],
  ["Vice-chair of gynecology", "Obstetrics and Gynecology", "vice", ["clinical_area"], "gynecology", null],
  ["Vice Chairman", "Otolaryngology - Head and Neck Surgery", "vice", [], null, null],
  ["Vice Chair of Ophthalmology", "Ophthalmology", "vice", [], null, null],
  [
    "Vice Chair for Clinical Operations and Quality, Weill Cornell Medicine",
    "Pathology and Laboratory Medicine",
    "vice",
    ["clinical_operations", "quality_safety"],
    null,
    null,
  ],
  ["Vice Chair for Hematopathology", "Pathology and Laboratory Medicine", "vice", ["clinical_area"], "Hematopathology", null],
  [
    "Vice Chair for the Division of Cell and Cancer Pathobiology",
    "Pathology and Laboratory Medicine",
    "vice",
    ["clinical_area"],
    "Division of Cell and Cancer Pathobiology",
    null,
  ],
  ["Vice Chair of Education and Faculty Development", "Pathology and Laboratory Medicine", "vice", ["education", "faculty_affairs"], null, null],
  ["Executive Vice Chair, Faculty and Academics", "Pediatrics", "executive", ["faculty_affairs"], null, null],
  ["Senior Vice Chair of Finance and Administration", "Pediatrics", "senior", ["finance_admin"], null, null],
  ["Vice Chair in Basic Science Research", "Pediatrics", "vice", ["research"], null, null],
  ["Vice Chair, Behavioral Health Integration and Innovation", "Pediatrics", "vice", ["innovation", "integrated_care"], null, null],
  ["Vice Chair, Academic Opportunity and Engagement", "Pediatrics", "vice", ["engagement_equity"], null, null],
  ["Vice Chair, Inpatient Operations", "Pediatrics", "vice", ["clinical_operations"], null, null],
  ["Vice Chair, NewYork-Presbyterian Queens", "Pediatrics", "vice", [], null, "nyp_queens"],
  ["Executive Vice Chair", "Population Health Sciences", "executive", [], null, null],
  ["Vice Chair for Entrepreneurship", "Population Health Sciences", "vice", ["strategy"], null, null],
  ["Vice Chair for Development and Strategy", "Population Health Sciences", "vice", ["strategy"], null, null],
  ["Vice Chair, Weill Cornell Medicine Department of Psychiatry", "Psychiatry", "vice", [], null, null],
  ["Vice Chair, Collaborative and Integrated Care", "Psychiatry", "vice", ["integrated_care"], null, null],
  ["Vice Chair, Child and Adolescent Psychiatry", "Psychiatry", "vice", ["clinical_area"], "Child and Adolescent Psychiatry", null],
  ["Vice Chair for Treatment Innovation", "Psychiatry", "vice", ["innovation"], null, null],
  ["Vice Chair of the Department of Radiation Oncology", "Radiation Oncology", "vice", [], null, null],
  ["Vice Chair, AI and Engineering Research", "Radiology", "vice", ["research"], null, null],
  ["Executive Vice Chairman", "Radiology", "executive", [], null, null],
  ["Vice Chair of Diversity, Equity, and Inclusion", "Radiology", "vice", ["engagement_equity"], null, null],
];

describe("parseLeadershipTitle", () => {
  it.each(CASES)("%s", (title, dept, tier, functions, areaText, site) => {
    const parsed = parseLeadershipTitle(title, dept);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ displayTitle: title, tier, functions, areaText, site });
  });

  it("splits only when Vice Chair appears twice", () => {
    expect(parseLeadershipTitle("Vice Chair, Ambulatory Services; Vice Chair, Health Justice", "Psychiatry")).toEqual([
      { displayTitle: "Vice Chair, Ambulatory Services", tier: "vice", functions: ["clinical_operations"], areaText: null, site: null },
      { displayTitle: "Vice Chair, Health Justice", tier: "vice", functions: ["engagement_equity"], areaText: null, site: null },
    ]);
    expect(
      parseLeadershipTitle("Vice Chair, Research; Vice Chair for Faculty and Academic Affairs").map((p) => p.functions),
    ).toEqual([["research"], ["faculty_affairs"]]);
  });

  it.each([
    ["Deputy Vice Chair for Research", "deputy"],
    ["Interim Executive Vice Chair", "interim executive"],
    ["Co-Vice Chair of Education", "co"],
    ["Professor and Executive Vice Chair for Academic Affairs", "executive"],
    ["Professor of Medicine, Vice Chair for Research", "vice"],
    ["Vice-Chairman", "vice"],
  ])("reads an open-ended modifier: %s", (title, tier) => {
    expect(parseLeadershipTitle(title)[0].tier).toBe(tier);
  });

  it("returns nothing for a title with no Vice Chair in it", () => {
    expect(parseLeadershipTitle("Chair of Surgery")).toEqual([]);
    expect(parseLeadershipTitle("")).toEqual([]);
  });
});

describe("modifier rank and label", () => {
  it("orders by the first known word; an unknown modifier ranks with plain Vice Chairs", () => {
    const ranked = ["assistant", "deputy", "interim executive", "vice", "senior", "associate"]
      .map((t) => [t, leadershipTierRank(t)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([t]) => t);
    expect(ranked).toEqual(["interim executive", "senior", "deputy", "vice", "associate", "assistant"]);
  });

  it("labels any modifier", () => {
    expect(leadershipTierLabel("vice")).toBe("Vice Chair");
    expect(leadershipTierLabel("interim executive")).toBe("Interim Executive Vice Chair");
  });
});

describe("functions column", () => {
  it("round-trips in vocabulary order and drops unknown codes", () => {
    expect(serializeFunctions(["informatics", "research"])).toBe("research,informatics");
    expect(parseFunctions("informatics,bogus,research")).toEqual(["research", "informatics"]);
    expect(parseFunctions("")).toEqual([]);
  });
});

describe("isFullTimeFaculty", () => {
  it("needs the full-time class AND no adjunct-style title", () => {
    expect(isFullTimeFaculty("full_time_faculty", "Professor of Medicine", null)).toBe(true);
    expect(isFullTimeFaculty("part_time_faculty", "Professor of Medicine")).toBe(false);
    expect(isFullTimeFaculty(null)).toBe(false);
    // The directory classes some adjuncts as full-time; the title wins.
    expect(isFullTimeFaculty("full_time_faculty", "Adjunct Professor of Immunology in Medicine")).toBe(false);
    expect(isFullTimeFaculty("full_time_faculty", "Chief, Newborn Medicine", "Clinical Professor (Voluntary)")).toBe(false);
    expect(isFullTimeFaculty("full_time_faculty", "Professor Emeritus of Surgery")).toBe(false);
  });
});

describe("detectLeadershipSite", () => {
  it("finds a site in an audit note", () => {
    expect(detectLeadershipSite("Chair of Surgery at NYP Brooklyn Methodist")).toBe("nyp_brooklyn_methodist");
    expect(detectLeadershipSite("Unqualified title")).toBeNull();
  });
});
