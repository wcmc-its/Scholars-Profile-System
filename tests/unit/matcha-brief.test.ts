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
    },
  },
}));

import {
  BRIEF_MAX_TOPICS,
  briefFacts,
  briefMatchedConcepts,
  buildAskBlock,
  buildSourceTable,
  generateBrief,
  loadBriefRecords,
  matchaSubmissionScope,
  partitionUngrounded,
  postCheckBrief,
  topicsFromTexts,
  type BriefMatchedConcept,
  type BriefRecords,
  type BriefTopic,
} from "@/lib/api/matcha-brief";
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
};

const matched: BriefMatchedConcept[] = [
  { term: "vascular inflammation", weight: 0.9, matchedPubs: 12 },
  { term: "obesity", weight: 1, matchedPubs: null },
];
const sources = buildSourceTable(facts, records);

beforeEach(() => {
  vi.clearAllMocks();
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

  it("strips PMIDs from `why`", () => {
    const r = postCheckBrief({ why: "Shows barrier repair (PMID: 12345). Also PMID 6789 here.", topics: [] }, matched, sources);
    expect(r.why).toBe("Shows barrier repair. Also here.");
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
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "g-supp" }]);
    mockOverrideFindMany.mockResolvedValue([{ entityId: "b" }]);
    mockTechFindMany.mockResolvedValue([{ cwid: "a", title: "Modulator", patentStatus: "Filed", url: "https://ctl.example/t" }]);
    mockMembershipFindMany.mockResolvedValue([
      { cwid: "a", center: { name: "Cardiovascular Research Institute" } },
      { cwid: "a", center: { name: "Cardiovascular Research Institute" } },
    ]);
    mockAppointmentFindMany.mockResolvedValue([{ cwid: "a", title: "Professor", organization: "Physiology" }]);
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

describe("generateBrief", () => {
  beforeEach(() => {
    mockAssemble.mockResolvedValue(facts);
    mockGenerateObject.mockResolvedValue({
      object: {
        why: "Runs a lab on endothelial lipid signaling. Leads a clinical trial.",
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
    ]);
    mockRevise.mockResolvedValue("Runs a lab on endothelial lipid signaling.");
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
    expect(generated.removedCount).toBe(2);

    // The model saw the FILTERED PI award, never the overview's unfiltered one.
    const call = mockGenerateObject.mock.calls[0][0];
    const researcher = call.messages[1].content as string;
    expect(researcher).toContain("Endothelial sphingolipid synthesis");
    expect(researcher).not.toContain("SUPPRESSED OR NON-PI AWARD");
    // The shared ask block carries the cache point and the saved concepts.
    expect(call.messages[0].content).toContain("vascular inflammation");
    // The fact-check sees the ask's concepts as allowed.
    expect(mockVerify.mock.calls[0][2].extraReference).toContain("obesity");
    // Only `why`'s span is sent for revision.
    expect(mockRevise.mock.calls[0][1].map((u: { span: string }) => u.span)).toEqual(["Leads a clinical trial."]);
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
