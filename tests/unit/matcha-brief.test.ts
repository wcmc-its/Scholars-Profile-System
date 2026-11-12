/**
 * Matcha Phase 3 briefs — `lib/api/matcha-brief.ts`:
 *  - the deterministic post-check (topic anchoring, source keys, caps, PMID stripping);
 *  - the fact-check split (a flagged span revises `why`, drops a whole topic);
 *  - records: active PI awards only, minus suppressed grants and `hideFunding`;
 *  - generation reads the SAVED concepts and the candidate's matched set, and the model's
 *    grants are the filtered PI list (never the overview's unfiltered one).
 * Mocks Bedrock and the DB — never live.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGenerateObject,
  mockVerify,
  mockRevise,
  mockAssemble,
  mockGrantFindMany,
  mockTechFindMany,
  mockMembershipFindMany,
  mockAppointmentFindMany,
  mockOverrideFindMany,
  mockSuppressionFindMany,
  mockToolFindMany,
  mockTrialGroupBy,
} = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  mockVerify: vi.fn(),
  mockRevise: vi.fn(),
  mockAssemble: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockTechFindMany: vi.fn(),
  mockMembershipFindMany: vi.fn(),
  mockAppointmentFindMany: vi.fn(),
  mockOverrideFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockToolFindMany: vi.fn(),
  mockTrialGroupBy: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: mockGenerateObject,
}));
vi.mock("@/lib/llm/client", () => ({ bedrockClient: () => (id: string) => id, BEDROCK_CACHE_POINT: {} }));
vi.mock("@/lib/edit/overview-generator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/overview-generator")>()),
  verifyDraftGrounding: mockVerify,
  reviseDraftForGrounding: mockRevise,
}));
vi.mock("@/lib/edit/overview-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/overview-facts")>()),
  assembleOverviewFacts: mockAssemble,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      grant: { findMany: mockGrantFindMany },
      scholarTechnology: { findMany: mockTechFindMany },
      centerMembership: { findMany: mockMembershipFindMany },
      appointment: { findMany: mockAppointmentFindMany },
      fieldOverride: { findMany: mockOverrideFindMany },
      suppression: { findMany: mockSuppressionFindMany },
      scholarTool: { findMany: mockToolFindMany },
      personClinicalTrial: { groupBy: mockTrialGroupBy },
    },
  },
}));

import {
  BRIEF_METHODS_CAP,
  BRIEF_MAX_TOPICS,
  BRIEF_REVISE_SYSTEM_PROMPT,
  BRIEF_SYSTEM_PROMPT,
  dropMetaSentences,
  briefFacts,
  briefMatchedConcepts,
  buildAskBlock,
  buildResearcherBlock,
  buildSourceTable,
  checkDataSources,
  checkMethodPills,
  cleanAngleRole,
  stripRoleRestatement,
  generateBrief,
  loadBriefRecords,
  matchaSubmissionScope,
  partitionUngrounded,
  postCheckBrief,
  topicsFromTexts,
  withLiveSources,
  type BriefMatchedConcept,
  type BriefRecords,
  type BriefTopic,
} from "@/lib/api/matcha-brief";
import { MAX_METHOD_PILLS, NO_LAB_ANGLE, hasAngle } from "@/lib/edit/matcha-brief-types";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import type { MatchaCandidate, MatchaConcept } from "@/lib/api/matcha-contract";

const concept = (term: string, centrality: number): MatchaConcept => ({
  term,
  kind: "concept",
  members: [term],
  centrality,
  weightFactor: 1,
});
const CONCEPTS = [concept("vascular inflammation", 0.9), concept("obesity", 1), concept("sarcopenia", 0.4)];

const candidate: MatchaCandidate = {
  cwid: "abc1001",
  name: "Mara Ellison",
  profileSlug: "mara-ellison",
  title: "Professor",
  department: "Pathology",
  fusedScore: 0.1,
  contributions: [
    { term: "vascular inflammation", rank: 1 },
    { term: "obesity", rank: 40 },
  ],
  technologyCount: 0,
};

const facts: OverviewFacts = {
  name: "Mara Ellison",
  title: "Professor of Pathology",
  department: "Pathology",
  topics: [],
  representativePublications: [
    {
      pmid: "111",
      title: "Endothelial sphingolipids preserve barrier function",
      venue: null,
      year: 2024,
      impact: null,
      synopsis: null,
      impactJustification: null,
      topicRationale: null,
      authorPosition: "last",
    },
  ],
  publicationCount: 40,
  yearsActive: { first: 2005, last: 2025 },
  // The overview's UNFILTERED list — must never reach the model.
  activeGrants: [
    {
      role: "Co-I",
      roleLabel: "Co-Investigator",
      isPrincipalInvestigator: false,
      funderLabel: "NIH",
      title: "SUPPRESSED OR NON-PI AWARD",
      mechanism: "R01",
    },
  ],
  education: [],
  titles: [],
  methods: [],
  facultyMetrics: null,
  existingBio: null,
};

const records: BriefRecords = {
  funding: [
    {
      mechanism: "R01",
      funder: "NIH",
      title: "Endothelial sphingolipid synthesis",
      endYear: 2028,
      applId: 9876,
      roleLabel: "Principal Investigator",
    },
  ],
  translation: [],
  secondaryAppointments: [],
  centers: [],
  methods: [{ name: "Mouse models", category: "animal model", papers: 14 }],
  trialCount: 3,
};

const matched: BriefMatchedConcept[] = [
  { term: "vascular inflammation", weight: 0.9, matchedPubs: 12 },
  { term: "obesity", weight: 1, matchedPubs: null },
];
const sources = buildSourceTable(facts, records);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("angleRole and dataSources validation", () => {
  const given = [
    { name: "State Trauma Registry", category: null, papers: 6 },
    { name: "Mouse models", category: "animal model", papers: 14 },
  ];

  it("trims the role, drops a trailing period, and drops a role over 60 characters", () => {
    expect(cleanAngleRole("  Clinical-trial   lead. ")).toBe("Clinical-trial lead");
    expect(cleanAngleRole(null)).toBe("");
    expect(cleanAngleRole("   ")).toBe("");
    expect(cleanAngleRole("x".repeat(60))).toBe("x".repeat(60));
    expect(cleanAngleRole("x".repeat(61))).toBe("");
  });

  it("cleanAngleRole drops a consulting or advisory role, whatever the model returned", () => {
    expect(cleanAngleRole("Scientific consultant")).toBe("");
    expect(cleanAngleRole("Clinical consulting partner.")).toBe("");
    expect(cleanAngleRole("Scientific advisor")).toBe("");
    expect(cleanAngleRole("Trial-design ADVISER")).toBe("");
    expect(cleanAngleRole("Advisory board member")).toBe("");
    expect(cleanAngleRole("Disease-model validation partner")).toBe("Disease-model validation partner");
    // The post-check applies it: the angle then prints with no bold role.
    const r = postCheckBrief(
      { why: "x", angle: "Can test candidates in mouse models.", angleRole: "Scientific consultant" },
      matched,
      sources,
    );
    expect(r.angleRole).toBe("");
    expect(r.angle).toBe("Can test candidates in mouse models.");
  });

  it("keeps only data sources that name a given method, in that method's spelling", () => {
    expect(
      checkDataSources(
        ["state trauma registry", "National claims database", "State Trauma Registry"],
        given,
      ),
    ).toEqual(["State Trauma Registry"]);
    expect(checkDataSources(null, given)).toEqual([]);
    expect(checkDataSources(["State Trauma Registry"], [])).toEqual([]);
  });

  it("postCheckBrief carries both through, validated against the methods passed in", () => {
    const r = postCheckBrief(
      {
        why: "x",
        angle: "Could lead registry studies.",
        angleRole: " Registry-study lead ",
        dataSources: ["State Trauma Registry", "An invented biobank"],
      },
      matched,
      sources,
      given,
    );
    expect(r.angleRole).toBe("Registry-study lead");
    expect(r.dataSources).toEqual(["State Trauma Registry"]);
    // No methods given (the second, prose-only pass): nothing can be a data source.
    expect(
      postCheckBrief({ why: "x", dataSources: ["State Trauma Registry"] }, matched, sources)
        .dataSources,
    ).toEqual([]);
  });

  it("the draft prompt asks for the role and the method pills, copied from METHODS_AND_TOOLS", () => {
    expect(BRIEF_SYSTEM_PROMPT).toContain("`angleRole`");
    expect(BRIEF_SYSTEM_PROMPT).toContain("`methodPills`");
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/Only names that appear there/);
  });
});

describe("stripRoleRestatement", () => {
  const role = "Imaging biomarker validation partner";

  it("strips a near-restatement of the role up to a 'who' clause and capitalizes the rest", () => {
    expect(
      stripRoleRestatement(
        "Imaging biomarker development partner who has run five trials on tumour response.",
        role,
      ),
    ).toBe("Has run five trials on tumour response.");
  });

  it("strips up to a colon, a dash or a comma, and past a leading article", () => {
    expect(stripRoleRestatement("An imaging biomarker partner: five trials on record.", role)).toBe(
      "Five trials on record.",
    );
    expect(
      stripRoleRestatement("Imaging biomarker validation partner — can score scans at scale.", role),
    ).toBe("Can score scans at scale.");
    expect(
      stripRoleRestatement("Imaging biomarker validation partner, with a cohort of scans.", role),
    ).toBe("With a cohort of scans.");
  });

  it("strips the exact role text even for a short role", () => {
    expect(stripRoleRestatement("Trial site lead: runs three open trials.", "Trial site lead")).toBe(
      "Runs three open trials.",
    );
  });

  it("keeps an angle that does not restate the role", () => {
    const own = "Five trials on record, and a cohort of scans for response readouts.";
    expect(stripRoleRestatement(own, role)).toBe(own);
    const verb = "Can validate imaging biomarkers, using a cohort of scans.";
    expect(stripRoleRestatement(verb, role)).toBe(verb);
    // Sharing one word with the role is not a restatement.
    const one = "Imaging cores at two sites, with scans on file.";
    expect(stripRoleRestatement(one, role)).toBe(one);
  });

  it("keeps the angle when there is no break to cut at, or the rest would be too short", () => {
    const noBreak = "Imaging biomarker validation partner for oncology programs.";
    expect(stripRoleRestatement(noBreak, role)).toBe(noBreak);
    const short = "Imaging biomarker validation partner: yes.";
    expect(stripRoleRestatement(short, role)).toBe(short);
  });

  it("is a no-op with no role or no angle", () => {
    expect(stripRoleRestatement("Imaging biomarker partner: five trials on record.", "")).toBe(
      "Imaging biomarker partner: five trials on record.",
    );
    expect(stripRoleRestatement("", role)).toBe("");
  });

  it("postCheckBrief applies it to the angle against the cleaned role", () => {
    const r = postCheckBrief(
      { why: "x", angle: "Imaging biomarker partner who can score scans at scale.", angleRole: `${role}.` },
      matched,
      sources,
    );
    expect(r.angleRole).toBe(role);
    expect(r.angle).toBe("Can score scans at scale.");
  });
});

describe("checkMethodPills / derived dataSources", () => {
  const given = [
    { name: "State Kidney Registry", category: null, papers: 6 },
    { name: "State kidney registry (SKR)", category: null, papers: 3 },
    { name: "Magnetic resonance imaging (MRI) scanner", category: "imaging", papers: 9 },
    { name: "Mouse models", category: "animal model", papers: 14 },
  ];

  it("keeps only the given method names in `from`, canonicalized and deduplicated", () => {
    expect(
      checkMethodPills(
        [
          {
            label: "Kidney registry",
            kind: "data",
            from: ["state kidney registry", "State kidney registry (SKR)", "State Kidney Registry", "Invented db"],
          },
        ],
        given,
      ),
    ).toEqual([
      { label: "Kidney registry", kind: "data", from: ["State Kidney Registry", "State kidney registry (SKR)"] },
    ]);
  });

  it("drops a pill with no grounded name, an empty or over-long label, and a repeated label", () => {
    const pills = checkMethodPills(
      [
        { label: "Made-up biobank", kind: "data", from: ["A made-up biobank"] },
        { label: "No sources", kind: "method", from: null },
        { label: "   ", kind: "method", from: ["Mouse models"] },
        { label: "x".repeat(41), kind: "method", from: ["Mouse models"] },
        { label: `  ${"y".repeat(40)} `, kind: "method", from: ["Mouse models"] },
        { label: "MRI", kind: "method", from: ["Magnetic resonance imaging (MRI) scanner"] },
        { label: "mri", kind: "method", from: ["Mouse models"] },
      ],
      given,
    );
    expect(pills.map((p) => p.label)).toEqual(["y".repeat(40), "MRI"]);
  });

  it("reads any kind but 'data' as a method, and caps at 12 in the model's order", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      label: `Pill ${i + 1}`,
      kind: i === 0 ? "DATA" : i === 1 ? "registry" : "method",
      from: ["Mouse models"],
    }));
    const pills = checkMethodPills(many, given);
    expect(pills).toHaveLength(MAX_METHOD_PILLS);
    expect(pills[0]).toMatchObject({ label: "Pill 1", kind: "data" });
    expect(pills[1]).toMatchObject({ label: "Pill 2", kind: "method" });
    expect(pills[11].label).toBe("Pill 12");
    expect(checkMethodPills(null, given)).toEqual([]);
  });

  it("postCheckBrief derives dataSources from the data pills, ignoring the model's own list", () => {
    const r = postCheckBrief(
      {
        why: "x",
        dataSources: ["Mouse models"],
        methodPills: [
          { label: "MRI", kind: "method", from: ["Magnetic resonance imaging (MRI) scanner"] },
          { label: "Kidney registry", kind: "data", from: ["State Kidney Registry", "State kidney registry (SKR)"] },
        ],
      },
      matched,
      sources,
      given,
    );
    expect(r.methodPills.map((p) => p.label)).toEqual(["MRI", "Kidney registry"]);
    expect(r.dataSources).toEqual(["State Kidney Registry", "State kidney registry (SKR)"]);
  });

  it("with no valid pill, dataSources falls back to the model's list, grounded", () => {
    const r = postCheckBrief(
      {
        why: "x",
        dataSources: ["State Kidney Registry", "Invented db"],
        methodPills: [{ label: "Invented", kind: "data", from: ["Invented db"] }],
      },
      matched,
      sources,
      given,
    );
    expect(r.methodPills).toEqual([]);
    expect(r.dataSources).toEqual(["State Kidney Registry"]);
  });
});

describe("postCheckBrief", () => {
  it("keeps an anchored, sourced topic and resolves its keys to the facts", () => {
    const r = postCheckBrief(
      { why: "Works on X.", topics: [{ concept: "Vascular Inflammation", text: "S1P signaling", sources: ["p1", "G1"] }] },
      matched,
      sources,
    );
    expect(r.topics).toEqual([
      {
        concept: "vascular inflammation", // canonicalized to the saved search's spelling
        text: "S1P signaling",
        sources: [
          { kind: "pub", pmid: "111", year: 2024, title: "Endothelial sphingolipids preserve barrier function" },
          { kind: "grant", mechanism: "R01", funder: "NIH", endYear: 2028, applId: 9876 },
        ],
      },
    ]);
    expect(r.dropped).toBe(0);
  });

  it("drops a topic anchored to a concept this candidate did NOT match (even one in the ask)", () => {
    const r = postCheckBrief(
      { why: "w", topics: [{ concept: "sarcopenia", text: "muscle", sources: ["P1"] }] },
      matched,
      sources,
    );
    expect(r.topics).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("drops a topic citing ANY key not in the facts, and one with no sources", () => {
    const r = postCheckBrief(
      {
        why: "w",
        topics: [
          { concept: "obesity", text: "a", sources: ["P1", "P9"] },
          { concept: "vascular inflammation", text: "b", sources: [] },
          { concept: "vascular inflammation", text: "c", sources: null },
        ],
      },
      matched,
      sources,
    );
    expect(r.topics).toEqual([]);
    expect(r.dropped).toBe(3);
  });

  it("allows one topic per concept and at most BRIEF_MAX_TOPICS", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ term: `c${i}`, weight: 1, matchedPubs: null }));
    const r = postCheckBrief(
      {
        why: "w",
        topics: [
          { concept: "c0", text: "a", sources: ["P1"] },
          { concept: "c0", text: "dup", sources: ["P1"] },
          ...many.slice(1).map((m) => ({ concept: m.term, text: m.term, sources: ["P1"] })),
        ],
      },
      many,
      sources,
    );
    expect(r.topics.map((t) => t.concept)).toEqual(["c0", "c1", "c2"]);
    expect(r.topics).toHaveLength(BRIEF_MAX_TOPICS);
  });

  it("strips bracketed source keys from `why` but never real terms like G1 phase", () => {
    const r = postCheckBrief(
      { why: "Studies G1 phase arrest (P1, G1) and P53 loss [P2].", topics: [] },
      matched,
      sources,
    );
    expect(r.why).toBe("Studies G1 phase arrest and P53 loss.");
  });

  it("strips keys and PMIDs from `angle`, and defaults a missing angle to empty", () => {
    const out = postCheckBrief({ why: "x", angle: "Trial lead (P1) for PMID: 123 cohorts." }, matched, sources);
    expect(out.angle).toBe("Trial lead for cohorts.");
    expect(postCheckBrief({ why: "x", angle: null }, matched, sources).angle).toBe("");
  });

  it("strips PMIDs from `why`", () => {
    const r = postCheckBrief({ why: "Shows barrier repair (PMID: 12345). Also PMID 6789 here.", topics: [] }, matched, sources);
    expect(r.why).toBe("Shows barrier repair. Also here.");
  });

  it("drops a sentence about the inputs from `angle` and `why`, keeping the rest", () => {
    const r = postCheckBrief(
      {
        why: "Studies endpoint validation in liver disease. The provided facts do not mention imaging.",
        angle:
          "Could advise on endpoint selection, drawing on their publication evaluating such endpoints. No trial records are listed in the facts.",
        topics: [],
      },
      matched,
      sources,
    );
    expect(r.why).toBe("Studies endpoint validation in liver disease.");
    expect(r.angle).toBe(
      "Could advise on endpoint selection, drawing on their publication evaluating such endpoints.",
    );
  });
});

describe("dropMetaSentences", () => {
  it("drops narrow meta phrasings", () => {
    for (const bad of [
      "No trial records are listed in the facts.",
      "Imaging work is not listed.",
      "A device patent is not provided.",
      "Funding is not available in the record.",
      "Grants are listed in the inputs.",
    ]) {
      expect(dropMetaSentences(`Could lead an imaging substudy. ${bad}`)).toBe(
        "Could lead an imaging substudy.",
      );
    }
  });

  it("keeps legitimate sentences, including a trial count on record", () => {
    const ok =
      "Could serve as clinical-trial lead, given 11 trials on record. Has no prior industry projects in this area.";
    expect(dropMetaSentences(ok)).toBe(ok);
    expect(dropMetaSentences("Runs a registry of 400 patients.")).toBe("Runs a registry of 400 patients.");
  });
});

describe("no-meta rule in the prompts", () => {
  it("is in the draft prompt for both prose fields and in the fact-check reviser", () => {
    const [whyPart, anglePart] = BRIEF_SYSTEM_PROMPT.split("`angle`:");
    expect(whyPart).toMatch(/Never mention the facts, records or inputs/);
    expect(anglePart).toMatch(/Never mention the\s+facts, records or inputs/);
    expect(BRIEF_REVISE_SYSTEM_PROMPT).toMatch(/Never mention the facts, records, inputs/);
    expect(BRIEF_REVISE_SYSTEM_PROMPT).toMatch(/not listed/);
  });
});

describe("partitionUngrounded", () => {
  const topics: BriefTopic[] = [
    { concept: "obesity", text: "beige fat and blood pressure", sources: [] },
    { concept: "vascular inflammation", text: "S1P signaling", sources: [] },
  ];
  it("routes spans in `why` to revision and drops the topic that contains a span", () => {
    const r = partitionUngrounded("Runs a lab. Leads a clinical trial.", topics, [
      { span: "Leads a clinical trial.", category: "x", reason: "y" },
      { span: "beige fat", category: "x", reason: "y" },
    ]);
    expect(r.whySpans.map((u) => u.span)).toEqual(["Leads a clinical trial."]);
    expect(r.keptTopics.map((t) => t.text)).toEqual(["S1P signaling"]);
  });
  it("matches a span carrying the verifier's bullet prefix, or covering the whole bullet", () => {
    const r = partitionUngrounded("Runs a lab.", topics, [
      { span: "- S1P signaling", category: "x", reason: "y" },
      { span: "beige fat and blood pressure\n- S1P", category: "x", reason: "y" },
      { span: "   ", category: "x", reason: "y" },
    ]);
    expect(r.keptTopics).toEqual([]);
    expect(r.whySpans).toEqual([]);
  });
});

describe("withLiveSources", () => {
  it("drops grant sources no longer in live records; keeps pubs and the topic", () => {
    const live: BriefRecords = { ...records };
    const topic: BriefTopic = {
      concept: "obesity",
      text: "t",
      sources: [
        { kind: "grant", mechanism: "R01", funder: "NIH", endYear: 2028, applId: 9876 },
        { kind: "grant", mechanism: "R21", funder: "NIH", endYear: 2027, applId: 5555 },
        { kind: "grant", mechanism: null, funder: "AHA", endYear: 2026, applId: null },
        { kind: "pub", pmid: "111", year: 2024, title: "x" },
      ],
    };
    expect(withLiveSources([topic], live)[0].sources.map((s) => (s.kind === "pub" ? s.pmid : s.applId))).toEqual([
      9876,
      "111",
    ]);
  });
});

describe("topicsFromTexts (edit trust boundary)", () => {
  const generated: BriefTopic[] = [
    { concept: "obesity", text: "beige fat", sources: [{ kind: "pub", pmid: "1", year: 2025, title: "t" }] },
  ];
  it("an unchanged line keeps its concept and sources; any other line is unsourced", () => {
    expect(topicsFromTexts([" beige fat ", "my own idea", ""], generated)).toEqual([
      generated[0],
      { concept: "", text: "my own idea", sources: [] },
    ]);
  });
});

describe("briefMatchedConcepts / briefFacts / buildAskBlock / scope", () => {
  it("returns THIS candidate's matched concepts from the saved list, strongest first", () => {
    expect(briefMatchedConcepts(candidate, CONCEPTS).map((m) => m.term)).toEqual([
      "vascular inflammation",
      "obesity",
    ]);
  });
  it("replaces the overview's grants with the filtered PI list", () => {
    const f = briefFacts(facts, records);
    expect(f.activeGrants).toHaveLength(1);
    expect(f.activeGrants[0]).toMatchObject({ title: "Endothelial sphingolipid synthesis", isPrincipalInvestigator: true });
  });
  it("the ask block lists every saved concept, most central first", () => {
    const block = buildAskBlock("Northlake — vascular biology", CONCEPTS);
    expect(block.indexOf("obesity")).toBeLessThan(block.indexOf("vascular inflammation"));
    expect(block).toContain("sarcopenia");
  });
  it("superuser/developer see all submissions; anyone else only their own", () => {
    expect(matchaSubmissionScope({ cwid: "a", isSuperuser: true, isDeveloper: false })).toBeUndefined();
    expect(matchaSubmissionScope({ cwid: "a", isSuperuser: false, isDeveloper: true })).toBeUndefined();
    expect(matchaSubmissionScope({ cwid: "a", isSuperuser: false, isDeveloper: false })).toEqual({ submittedBy: "a" });
  });
});

describe("loadBriefRecords", () => {
  const future = new Date("2099-06-30T00:00:00Z");
  beforeEach(() => {
    mockGrantFindMany.mockResolvedValue([
      { cwid: "a", externalId: "g-pi", role: "PI", funder: "NIH", title: "Kept", mechanism: "R01", endDate: future, applId: 1 },
      { cwid: "a", externalId: "g-coi", role: "Co-I", funder: "NIH", title: "Not PI", mechanism: "R01", endDate: future, applId: 2 },
      { cwid: "a", externalId: "g-supp", role: "PI", funder: "NIH", title: "Suppressed", mechanism: "R21", endDate: future, applId: 3 },
      { cwid: "b", externalId: "g-hidden", role: "PI", funder: "AHA", title: "Hidden", mechanism: null, endDate: future, applId: null },
    ]);
    mockSuppressionFindMany.mockImplementation(async (args: { where: { entityType: string } }) =>
      args.where.entityType === "grant" ? [{ entityId: "g-supp" }] : [{ entityId: "ap-supp" }],
    );
    mockOverrideFindMany.mockResolvedValue([{ entityId: "b" }]);
    mockTechFindMany.mockResolvedValue([{ cwid: "a", title: "Modulator", patentStatus: "Filed", url: "https://ctl.example/t" }]);
    mockMembershipFindMany.mockResolvedValue([
      { cwid: "a", center: { name: "Cardiovascular Research Institute" } },
      { cwid: "a", center: { name: "Cardiovascular Research Institute" } },
    ]);
    mockAppointmentFindMany.mockResolvedValue([
      { cwid: "a", title: "Professor", organization: "Physiology", externalId: "ap-1" },
      { cwid: "a", title: "Adjunct", organization: "Hidden by curator", externalId: "ap-supp" },
    ]);
    // Already ordered by pmidCount desc (the query's orderBy); 45 for "a" => cut to the cap.
    mockToolFindMany.mockResolvedValue([
      ...Array.from({ length: 45 }, (_, i) => ({
        cwid: "a",
        toolName: `Tool ${i + 1}`,
        category: i === 0 ? "imaging" : null,
        pmidCount: 60 - i,
      })),
      { cwid: "b", toolName: "Flow cytometry", category: null, pmidCount: 1 },
    ]);
    mockTrialGroupBy.mockResolvedValue([{ cwid: "a", _count: { _all: 4 } }]);
  });

  it("loads every method per PI by papers up to the cap, unfiltered, and the distinct trial count", async () => {
    const out = await loadBriefRecords(["a", "b"]);
    expect(BRIEF_METHODS_CAP).toBe(40);
    expect(out.get("a")!.methods).toHaveLength(BRIEF_METHODS_CAP);
    expect(out.get("a")!.methods[0]).toEqual({ name: "Tool 1", category: "imaging", papers: 60 });
    // Uncategorized rows are kept: no category filter decides what the reader sees.
    expect(out.get("a")!.methods[1]).toEqual({ name: "Tool 2", category: null, papers: 59 });
    expect(out.get("a")!.methods.at(-1)!.name).toBe("Tool 40");
    expect(out.get("a")!.methods.map((m) => m.name)).not.toContain("Tool 41");
    expect(mockToolFindMany).toHaveBeenCalledTimes(1);
    expect(out.get("b")!.methods).toEqual([{ name: "Flow cytometry", category: null, papers: 1 }]);
    expect(out.get("a")!.trialCount).toBe(4);
    expect(out.get("b")!.trialCount).toBe(0);
    expect(mockToolFindMany.mock.calls[0][0].orderBy[0]).toEqual({ pmidCount: "desc" });
    expect(mockTrialGroupBy.mock.calls[0][0]).toMatchObject({ by: ["cwid"], where: { cwid: { in: ["a", "b"] } } });
  });

  it("keeps only active PI awards, minus suppressed grants and hideFunding scholars", async () => {
    const out = await loadBriefRecords(["a", "b"]);
    expect(out.get("a")!.funding.map((g) => g.title)).toEqual(["Kept"]);
    expect(out.get("a")!.funding[0]).toMatchObject({ endYear: 2099, applId: 1 });
    expect(out.get("b")!.funding).toEqual([]);
    expect(out.get("a")!.translation).toEqual([{ title: "Modulator", patentStatus: "Filed", url: "https://ctl.example/t" }]);
    expect(out.get("a")!.centers).toEqual(["Cardiovascular Research Institute"]);
    expect(out.get("a")!.secondaryAppointments).toEqual([{ title: "Professor", organization: "Physiology" }]);
    const gWhere = mockGrantFindMany.mock.calls[0][0].where;
    expect(gWhere.endDate.gte).toBeInstanceOf(Date);
    expect(mockAppointmentFindMany.mock.calls[0][0].where).toMatchObject({ isPrimary: false, endDate: null, showOnProfile: true });
  });

  it("does no reads for an empty list", async () => {
    expect((await loadBriefRecords([])).size).toBe(0);
    expect(mockGrantFindMany).not.toHaveBeenCalled();
  });
});

describe("laboratory partnership angle", () => {
  it("the prompt bans consulting and advisory roles and names what an angle may rest on", () => {
    const anglePart = BRIEF_SYSTEM_PROMPT.split("`angle`:")[1].split("`methodPills`")[0];
    expect(anglePart).toMatch(/Never propose a consulting, advisory or\s+biomarker-expertise role/);
    expect(anglePart).toMatch(/Never a consulting or advisory role/);
    // In order of preference: awards, then methods and tools, then first/last-author papers.
    const award = anglePart.indexOf("awardsAsPI");
    const methods = anglePart.indexOf("METHODS_AND_TOOLS");
    const papers = anglePart.indexOf("authorPosition is 'first' or 'last'");
    expect(award).toBeGreaterThan(-1);
    expect(methods).toBeGreaterThan(award);
    expect(papers).toBeGreaterThan(methods);
    expect(anglePart).toMatch(/Never base the angle on clinical-trial participation/);
    expect(anglePart).toMatch(/only when the ASK itself asks for\s+trials or patient data/);
    expect(anglePart).toMatch(/return `angle`\s+and `angleRole` as empty strings/);
    // No role example invites consulting, and no trial count is an allowed number.
    expect(anglePart).not.toMatch(/scientific consultant|Clinical-trial site lead|Five trials/i);
    expect(anglePart).not.toContain("other than the trial count");
    expect(BRIEF_REVISE_SYSTEM_PROMPT).toMatch(
      /Never replace a removed role with a consulting or advisory one/,
    );
  });

  it("puts awardsAsPI before publications, and middle-author papers last with their keys", () => {
    const pub = (pmid: string, authorPosition: "first" | "last" | "middle" | null) => ({
      ...facts.representativePublications[0],
      pmid,
      title: `Paper ${pmid}`,
      authorPosition,
    });
    const many: OverviewFacts = {
      ...facts,
      representativePublications: [
        pub("201", "middle"),
        pub("202", "last"),
        pub("203", null),
        pub("204", "first"),
      ],
    };
    const block = buildResearcherBlock(briefFacts(many, records), matched, records);
    const payload = JSON.parse(block.split("<RESEARCHER>")[1].split("</RESEARCHER>")[0]) as {
      publications: { key: string; pmid: string }[];
    };
    expect(Object.keys(payload).indexOf("awardsAsPI")).toBeLessThan(
      Object.keys(payload).indexOf("publications"),
    );
    // First- and last-author papers lead, in their original order; the rest follow in theirs.
    expect(payload.publications.map((p) => [p.key, p.pmid])).toEqual([
      ["P2", "202"],
      ["P4", "204"],
      ["P1", "201"],
      ["P3", "203"],
    ]);
    // Every key still resolves to the same paper in the source table.
    const table = buildSourceTable(many, records);
    for (const p of payload.publications) {
      expect(table.get(p.key)).toMatchObject({ kind: "pub", pmid: p.pmid });
    }
    expect(block).toContain("CLINICAL_TRIALS_ON_RECORD: 3");
  });

  it("hasAngle is false for an empty angle and for the no-angle sentence", () => {
    expect(hasAngle("")).toBe(false);
    expect(hasAngle(undefined)).toBe(false);
    expect(hasAngle(` ${NO_LAB_ANGLE} `)).toBe(false);
    expect(hasAngle("Can test candidates in mouse models.")).toBe(true);
  });
});

const generatedWhy = "Runs a lab on endothelial lipid signaling. Leads a clinical trial.";
// The post-checked angle (the bracketed key stripped) is what the fact-check and revise see.
const generatedAngle = "Could validate candidates in mouse models. Holds a patent on a device.";

describe("generateBrief", () => {
  beforeEach(() => {
    mockAssemble.mockResolvedValue(facts);
    mockGenerateObject.mockResolvedValue({
      object: {
        why: generatedWhy,
        angle: "Could validate candidates in mouse models (P1). Holds a patent on a device.",
        topics: [
          { concept: "vascular inflammation", text: "S1P signaling in vascular inflammation", sources: ["P1"] },
          { concept: "obesity", text: "beige fat and blood pressure", sources: ["G1"] },
          { concept: "sarcopenia", text: "not matched", sources: ["P1"] },
        ],
      },
    });
    mockVerify.mockResolvedValue([
      { span: "Leads a clinical trial.", category: "c", reason: "r" },
      { span: "beige fat", category: "c", reason: "r" },
      { span: "Holds a patent on a device.", category: "c", reason: "r" },
    ]);
    mockRevise.mockImplementation(async (prose: string) =>
      prose.startsWith("Runs")
        ? "Runs a lab on endothelial lipid signaling."
        : "Could validate candidates in mouse models.",
    );
  });

  it("drafts from the saved concepts, fact-checks, and returns only grounded, anchored content", async () => {
    const { generated, model } = await generateBrief({
      cwid: "abc1001",
      askTitle: "Northlake — vascular biology",
      concepts: CONCEPTS,
      candidate,
      records,
    });
    expect(model).toMatch(/sonnet/);
    expect(generated.why).toBe("Runs a lab on endothelial lipid signaling.");
    expect(generated.topics.map((t) => t.concept)).toEqual(["vascular inflammation"]);
    expect(generated.angle).toBe("Could validate candidates in mouse models.");
    expect(generated.removedCount).toBe(3);

    // The model saw the FILTERED PI award, never the overview's unfiltered one.
    const call = mockGenerateObject.mock.calls[0][0];
    const researcher = call.messages[1].content as string;
    expect(researcher).toContain("Endothelial sphingolipid synthesis");
    expect(researcher).not.toContain("SUPPRESSED OR NON-PI AWARD");
    // Methods and the trial count are grounding facts for the angle.
    expect(researcher).toContain("Mouse models");
    expect(researcher).toContain("CLINICAL_TRIALS_ON_RECORD: 3");
    // The shared ask block carries the cache point and the saved concepts.
    expect(call.messages[0].content).toContain("vascular inflammation");
    // The fact-check sees the ask's concepts as allowed.
    const extra = mockVerify.mock.calls[0][2].extraReference as string;
    const [askPart, matchedPart] = extra.split("THE RESEARCHER'S MATCHED CONCEPTS");
    expect(askPart).toContain("sarcopenia"); // naming any ask concept is allowed...
    expect(matchedPart).toContain("vascular inflammation");
    expect(matchedPart).not.toContain("sarcopenia"); // ...claiming the PI meets it is not
    // The angle is fact-checked with the methods and trial count as allowed facts.
    expect(mockVerify.mock.calls[0][1]).toContain(generatedAngle);
    expect(matchedPart).toContain("- Mouse models [animal model]");
    expect(matchedPart).toContain("CLINICAL TRIALS ON RECORD: 3");
    // Each prose field's own spans go to its own revision.
    const revised = Object.fromEntries(
      mockRevise.mock.calls.map((c) => [c[0], c[1].map((u: { span: string }) => u.span)]),
    );
    expect(revised[generatedWhy]).toEqual(["Leads a clinical trial."]);
    expect(revised[generatedAngle]).toEqual(["Holds a patent on a device."]);
    // Both revisions carry the brief's no-meta reviser, not the bare overview one.
    for (const c of mockRevise.mock.calls) expect(c[2].system).toBe(BRIEF_REVISE_SYSTEM_PROMPT);
  });

  it("hands the model and the fact-check the FULL methods list, not a top slice", async () => {
    mockVerify.mockResolvedValue([]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Assay ${i + 1}`,
      category: i % 2 ? null : "lab method",
      papers: 40 - i,
    }));
    await generateBrief({
      cwid: "abc1001",
      askTitle: null,
      concepts: CONCEPTS,
      candidate,
      records: { ...records, methods: many },
    });
    const researcher = mockGenerateObject.mock.calls[0][0].messages[1].content as string;
    const extra = mockVerify.mock.calls[0][2].extraReference as string;
    for (const m of many) {
      expect(researcher).toContain(`"${m.name}"`);
      expect(extra).toContain(`- ${m.name}`);
    }
  });

  it("returns the role and the validated data sources", async () => {
    mockVerify.mockResolvedValue([]);
    mockGenerateObject.mockResolvedValue({
      object: {
        why: "Works on lipids.",
        angle: "Could validate candidates in mouse models.",
        angleRole: "Animal-model validation partner",
        dataSources: ["Mouse models", "A made-up cohort"],
        topics: [],
      },
    });
    const { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(generated.angleRole).toBe("Animal-model validation partner");
    expect(generated.dataSources).toEqual(["Mouse models"]);
  });

  it("returns grounded method pills with dataSources derived, and strips a restated role", async () => {
    mockVerify.mockResolvedValue([]);
    mockGenerateObject.mockResolvedValue({
      object: {
        why: "Works on lipids.",
        angle: "Animal model validation partner who can test candidates in mouse models.",
        angleRole: "Animal-model validation partner",
        methodPills: [
          { label: "Mouse models", kind: "method", from: ["Mouse models"] },
          { label: "Made-up cohort", kind: "data", from: ["A made-up cohort"] },
        ],
        topics: [],
      },
    });
    let { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(generated.angle).toBe("Can test candidates in mouse models.");
    expect(generated.methodPills).toEqual([{ label: "Mouse models", kind: "method", from: ["Mouse models"] }]);
    expect(generated.dataSources).toEqual([]);

    // No valid pill: the field is omitted, so readers fall back to the old split.
    mockGenerateObject.mockResolvedValue({
      object: { why: "Works on lipids.", methodPills: [{ label: "X", kind: "data", from: ["Nope"] }], topics: [] },
    });
    ({ generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records }));
    expect(generated.methodPills).toBeUndefined();
  });

  it("drops the role when the fact-check flags it or revises the angle away", async () => {
    const object = {
      why: "Works on lipids.",
      angle: "Trial lead for statin studies.",
      angleRole: "Trial lead",
      topics: [],
    };
    mockGenerateObject.mockResolvedValue({ object });
    mockVerify.mockResolvedValue([{ span: "Trial lead for statin studies.", category: "c", reason: "r" }]);
    mockRevise.mockResolvedValue("Could advise on statin studies.");
    let { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(generated.angle).toBe("Could advise on statin studies.");
    expect(generated.angleRole).toBeUndefined();

    mockVerify.mockResolvedValue([{ span: "statin studies", category: "c", reason: "r" }]);
    mockRevise.mockResolvedValue("");
    ({ generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records }));
    expect(generated.angle).toBe("");
    expect(generated.angleRole).toBeUndefined();

    // A flag elsewhere in the angle leaves the role alone.
    mockVerify.mockResolvedValue([{ span: "statin studies", category: "c", reason: "r" }]);
    mockRevise.mockResolvedValue("Trial lead for lipid studies.");
    ({ generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records }));
    expect(generated.angleRole).toBe("Trial lead");
  });

  it("defaults a missing angle to empty (the model omitted it)", async () => {
    mockVerify.mockResolvedValue([]);
    mockGenerateObject.mockResolvedValue({ object: { why: "Works on lipids.", topics: [] } });
    const { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(generated.angle).toBe("");
    expect(mockVerify.mock.calls[0][1]).toBe("Works on lipids.");
  });

  it("stores the no-angle sentence for an explicitly empty angle, unverified and with no role", async () => {
    mockVerify.mockResolvedValue([]);
    mockGenerateObject.mockResolvedValue({
      object: { why: "Works on lipids.", angle: "  ", angleRole: "", topics: [] },
    });
    let { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(generated.angle).toBe(NO_LAB_ANGLE);
    expect(generated.angleRole).toBeUndefined();
    // The sentence is ours, not a claim about the researcher: the fact-check never sees it.
    expect(mockVerify.mock.calls[0][1]).toBe("Works on lipids.");
    expect(mockRevise).not.toHaveBeenCalled();

    // A stray role beside an empty angle is not kept.
    mockGenerateObject.mockResolvedValue({
      object: { why: "Works on lipids.", angle: "", angleRole: "Disease-model partner", topics: [] },
    });
    ({ generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records }));
    expect(generated.angle).toBe(NO_LAB_ANGLE);
    expect(generated.angleRole).toBeUndefined();

    // null is a missing field, not the model's statement.
    mockGenerateObject.mockResolvedValue({ object: { why: "Works on lipids.", angle: null, topics: [] } });
    ({ generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records }));
    expect(generated.angle).toBe("");
  });

  it("tells the fact-check a consulting role resting on clinical trials is unsupported", async () => {
    mockVerify.mockResolvedValue([]);
    await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    const extra = mockVerify.mock.calls[0][2].extraReference as string;
    expect(extra).toMatch(/consulting, advisory or biomarker role resting on clinical trials is unsupported/);
    expect(extra).not.toMatch(/\(consultant, trial lead/);
  });

  it("skips the revise call when the fact-check finds nothing", async () => {
    mockVerify.mockResolvedValue([]);
    const { generated } = await generateBrief({ cwid: "abc1001", askTitle: null, concepts: CONCEPTS, candidate, records });
    expect(mockRevise).not.toHaveBeenCalled();
    expect(generated.removedCount).toBe(0);
    expect(generated.topics).toHaveLength(2);
  });

  it("throws when the scholar has no facts (route records it as failed)", async () => {
    mockAssemble.mockResolvedValue(null);
    await expect(
      generateBrief({ cwid: "zzz", askTitle: null, concepts: CONCEPTS, candidate, records }),
    ).rejects.toThrow();
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});
