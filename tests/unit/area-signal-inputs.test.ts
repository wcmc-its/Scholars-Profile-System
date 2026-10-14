import { describe, expect, it } from "vitest";
import type { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { isEligibleAreaGrant, isEligibleAreaTrial, type AreaGrantCandidate } from "@/lib/area-signals";
import {
  AREA_INPUT_PK,
  areaTextKey,
  buildInputPlan,
  grantTextKey,
  normalizeAreaText,
  planKeyColumn,
  splitList,
  type GrantInputRow,
  type TrialInputRow,
} from "@/etl/area-signal-inputs/plan";
import { listQueuedInputKeys, putNewInputs, type AreaInputDdbClient } from "@/etl/area-signal-inputs/dynamo";

const grant = (over: Partial<AreaGrantCandidate> = {}): AreaGrantCandidate => ({
  source: "InfoEd",
  role: "PI",
  startDate: new Date("2022-07-01T00:00:00Z"),
  title: "Mechanisms of synthetic protein folding in model tissue",
  mechanism: "R01",
  programType: "Grant",
  ...over,
});

describe("isEligibleAreaGrant (pilot filters, ported verbatim)", () => {
  it("keeps an InfoEd PI R01 started 2020 or later", () => {
    expect(isEligibleAreaGrant(grant())).toBe(true);
    expect(isEligibleAreaGrant(grant({ role: "Co-PI" }))).toBe(true);
    expect(isEligibleAreaGrant(grant({ role: "PI-Subaward" }))).toBe(true);
    expect(isEligibleAreaGrant(grant({ startDate: new Date("2020-01-01T00:00:00Z") }))).toBe(true);
  });

  it("drops non-InfoEd rows (#3071 wrong-person RePORTER rows)", () => {
    expect(isEligibleAreaGrant(grant({ source: "RePORTER" }))).toBe(false);
  });

  it("drops non-leadership roles and pre-2020 starts", () => {
    expect(isEligibleAreaGrant(grant({ role: "Co-I" }))).toBe(false);
    expect(isEligibleAreaGrant(grant({ role: "Key Personnel" }))).toBe(false);
    expect(isEligibleAreaGrant(grant({ startDate: new Date("2019-12-31T00:00:00Z") }))).toBe(false);
  });

  it("needs a mechanism or a qualifying program type", () => {
    expect(isEligibleAreaGrant(grant({ mechanism: null, programType: "Grant" }))).toBe(true);
    expect(isEligibleAreaGrant(grant({ mechanism: null, programType: "Career" }))).toBe(true);
    expect(isEligibleAreaGrant(grant({ mechanism: null, programType: "Contract with funding" }))).toBe(false);
    expect(isEligibleAreaGrant(grant({ mechanism: null, programType: "BioPharma Alliance Agreement" }))).toBe(
      false,
    );
  });

  it.each(["F32", "T32", "TL1", "K12", "KL2", "R25", "D43", "R90", "f31"])(
    "drops training mechanism %s",
    (mechanism) => {
      expect(isEligibleAreaGrant(grant({ mechanism }))).toBe(false);
    },
  );

  it("keeps career and research mechanisms the training rule does not name", () => {
    for (const mechanism of ["K23", "K08", "R21", "U01", "P30"]) {
      expect(isEligibleAreaGrant(grant({ mechanism }))).toBe(true);
    }
  });

  it("drops Training and Fellowship program types even with a mechanism", () => {
    expect(isEligibleAreaGrant(grant({ programType: "Training" }))).toBe(false);
    expect(isEligibleAreaGrant(grant({ mechanism: null, programType: "Fellowship" }))).toBe(false);
  });

  it.each([
    "Postdoctoral Fellowship in Imaging",
    "Institutional Training Grant in Synthetic Biology",
    "Junior Faculty Development Program",
    "Emerging Scholars Program 2024",
    "Annual Meeting of the Example Society",
    "International Conference on Model Systems",
    "Summit on Example Care",
    "Example Symposium 2023",
    "Methods Workshop",
    "World Congress of Examples",
    "PSDP 2025 (Scholar: A. Example)",
  ])("drops training / conference / scholar-award title %j", (title) => {
    expect(isEligibleAreaGrant(grant({ title }))).toBe(false);
  });

  it("drops R13/U13 conference mechanisms", () => {
    expect(isEligibleAreaGrant(grant({ mechanism: "R13" }))).toBe(false);
    expect(isEligibleAreaGrant(grant({ mechanism: "U13" }))).toBe(false);
  });

  it("keeps a plain 'meeting' title: the pilot regex names only 'annual meeting'", () => {
    expect(isEligibleAreaGrant(grant({ title: "Meeting the needs of example patients" }))).toBe(true);
  });
});

describe("isEligibleAreaTrial", () => {
  const t = { nctNumber: "NCT00000001", startDate: "2021-03", status: "OPEN TO ACCRUAL" };
  it("keeps an NCT trial started 2020 or later", () => {
    expect(isEligibleAreaTrial(t)).toBe(true);
    expect(isEligibleAreaTrial({ ...t, startDate: "2020-01-15" })).toBe(true);
  });
  it("needs an NCT id and a 2020+ start", () => {
    expect(isEligibleAreaTrial({ ...t, nctNumber: null })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, nctNumber: "  " })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, startDate: "2019-12" })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, startDate: null })).toBe(false);
  });
  it("drops statuses the profile hides", () => {
    expect(isEligibleAreaTrial({ ...t, status: "Withdrawn" })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, status: "SUSPENDED" })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, status: "No longer available" })).toBe(false);
    expect(isEligibleAreaTrial({ ...t, status: null })).toBe(true);
  });
});

describe("text keys", () => {
  it("ignores case and whitespace, but not content", () => {
    expect(normalizeAreaText("  Example\n  TITLE ")).toBe("example title");
    expect(grantTextKey({ title: "Example Title", abstract: "Some  text" })).toBe(
      grantTextKey({ title: "example   title", abstract: "some text" }),
    );
    expect(grantTextKey({ title: "Example Title", abstract: "Some text" })).not.toBe(
      grantTextKey({ title: "Example Title", abstract: "Other text" }),
    );
  });
  it("separates kinds and part boundaries", () => {
    expect(areaTextKey("grant", ["a", "b"])).not.toBe(areaTextKey("trial", ["a", "b"]));
    expect(areaTextKey("grant", ["ab", ""])).not.toBe(areaTextKey("grant", ["a", "b"]));
    expect(areaTextKey("grant", ["a", null])).toBe(areaTextKey("grant", ["a", ""]));
    expect(areaTextKey("grant", ["a"])).toMatch(/^[0-9a-f]{32}$/);
  });
  it("splits upstream '; '-joined lists", () => {
    expect(splitList("Drug: A; Procedure: B;  ")).toEqual(["Drug: A", "Procedure: B"]);
    expect(splitList(null)).toEqual([]);
  });
});

const LONG = "x".repeat(250);
const g = (over: Partial<GrantInputRow> = {}): GrantInputRow => ({
  id: "g1",
  title: "Synthetic project title",
  abstract: LONG,
  startDate: new Date("2023-01-01T00:00:00Z"),
  primeSponsor: "NIH",
  directSponsor: "NIH",
  nihIc: "NCI",
  mechanism: "R01",
  ...over,
});
const tr = (over: Partial<TrialInputRow> = {}): TrialInputRow => ({
  protocolNumber: "P-1",
  title: "Synthetic trial title",
  briefSummary: "A synthetic summary.",
  startDate: "2022-05",
  principalSponsor: "Example Sponsor",
  phase: "Phase 2",
  studyType: "Interventional",
  conditions: "Condition A; Condition B",
  interventions: "Drug: Example",
  ...over,
});

describe("buildInputPlan", () => {
  const NOW = new Date("2026-10-15T07:00:00Z");

  it("collapses rows sharing a text onto one item, keyed on the earliest start", () => {
    const plan = buildInputPlan(
      [
        g({ id: "late", startDate: new Date("2024-01-01T00:00:00Z"), mechanism: "R01" }),
        g({ id: "early", startDate: new Date("2021-01-01T00:00:00Z"), mechanism: "R56" }),
      ],
      [],
      NOW,
    );
    expect(plan.grantKeys.get("late")).toBe(plan.grantKeys.get("early"));
    expect(plan.items.size).toBe(1);
    const item = [...plan.items.values()][0];
    expect(item.start_year).toBe(2021);
    expect(item.mechanism).toBe("R56");
  });

  it("writes the contract shape: full mode at >= 200 chars, no person or award ids", () => {
    const plan = buildInputPlan([g()], [tr()], NOW);
    const grantItem = [...plan.items.values()].find((i) => i.kind === "grant")!;
    expect(grantItem).toEqual({
      PK: AREA_INPUT_PK,
      SK: `grant#${grantItem.text_key}`,
      kind: "grant",
      text_key: grantItem.text_key,
      mode: "full",
      title: "Synthetic project title",
      text: LONG,
      funder: "NIH NCI",
      mechanism: "R01",
      phase: null,
      study_type: null,
      conditions: [],
      interventions: [],
      start_year: 2023,
      status: "pending",
      created_at: NOW.toISOString(),
    });
    const trialItem = [...plan.items.values()].find((i) => i.kind === "trial")!;
    expect(trialItem).toMatchObject({
      SK: `trial#${trialItem.text_key}`,
      mode: "full",
      text: "A synthetic summary.",
      funder: "Example Sponsor",
      phase: "Phase 2",
      study_type: "Interventional",
      conditions: ["Condition A", "Condition B"],
      interventions: ["Drug: Example"],
      start_year: 2022,
    });
    const serialized = JSON.stringify([...plan.items.values()]);
    expect(serialized).not.toContain("g1");
    expect(serialized).not.toContain("P-1");
  });

  it("sends a short abstract as title mode, carrying the short text", () => {
    const plan = buildInputPlan([g({ abstract: "Short funder text." })], [], NOW);
    expect([...plan.items.values()][0]).toMatchObject({ mode: "title", text: "Short funder text." });
    const none = buildInputPlan([g({ abstract: null })], [], NOW);
    expect([...none.items.values()][0]).toMatchObject({ mode: "title", text: "" });
  });

  it("gives a trial with no summary title mode", () => {
    const plan = buildInputPlan([], [tr({ briefSummary: null })], NOW);
    expect([...plan.items.values()][0]).toMatchObject({ mode: "title", text: "" });
  });

  it("maps every protocol sharing a CT.gov record to one key", () => {
    const plan = buildInputPlan([], [tr({ protocolNumber: "P-1" }), tr({ protocolNumber: "P-2" })], NOW);
    expect(plan.trialKeys.get("P-1")).toBe(plan.trialKeys.get("P-2"));
    expect(plan.items.size).toBe(1);
  });
});

describe("planKeyColumn", () => {
  const m = (n: number, key = "k") => new Map(Array.from({ length: n }, (_, i) => [`id${i}`, key]));

  it("sets new and changed keys and clears rows that left the eligible set", () => {
    const current = new Map([...m(100), ["b", "old"], ["gone", "k3"]]);
    const desired = new Map([...m(100), ["b", "k2"], ["c", "k4"]]);
    const p = planKeyColumn(desired, current);
    expect([...p.set]).toEqual([
      ["b", "k2"],
      ["c", "k4"],
    ]);
    expect(p.clear).toEqual(["gone"]);
    expect(p.clearSkipped).toBeNull();
  });

  it("withholds the clear when the eligible set collapses (a truncated read cannot strip every key)", () => {
    const p = planKeyColumn(new Map(), m(400));
    expect(p.clear).toEqual([]);
    expect(p.clearSkipped).toMatch(/below the floor/);
  });

  it("allows a first load (nothing keyed yet)", () => {
    const p = planKeyColumn(m(3, "x"), new Map());
    expect(p.set.size).toBe(3);
    expect(p.clearSkipped).toBeNull();
  });
});

describe("AREAINPUT queue writes", () => {
  class FakeQuery {
    constructor(public input: Record<string, unknown>) {}
  }
  class FakePut {
    constructor(public input: { Item: { SK: string }; ConditionExpression: string }) {}
  }
  const cmd = { Put: FakePut, Query: FakeQuery } as unknown as {
    Put: typeof PutCommand;
    Query: typeof QueryCommand;
  };

  it("pages the queue's keys under the AREAINPUT partition", async () => {
    const pages = [
      { Items: [{ SK: "grant#a" }], LastEvaluatedKey: { PK: "AREAINPUT", SK: "grant#a" } },
      { Items: [{ SK: "trial#b" }] },
    ];
    const sent: FakeQuery[] = [];
    const ddb: AreaInputDdbClient = {
      send: async (c) => {
        sent.push(c as unknown as FakeQuery);
        return pages.shift()!;
      },
    };
    const keys = await listQueuedInputKeys(ddb, "reciterai", cmd);
    expect([...keys]).toEqual(["grant#a", "trial#b"]);
    expect(sent[0].input).toMatchObject({
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "AREAINPUT" },
    });
    expect(sent[1].input.ExclusiveStartKey).toEqual({ PK: "AREAINPUT", SK: "grant#a" });
  });

  it("puts only unqueued keys, conditionally, and treats a lost race as already queued", async () => {
    const plan = buildInputPlan(
      [g({ id: "1", title: "One" }), g({ id: "2", title: "Two" }), g({ id: "3", title: "Three" })],
      [],
      new Date("2026-10-15T07:00:00Z"),
    );
    const [first, second, third] = [...plan.items.values()];
    const puts: FakePut[] = [];
    const ddb: AreaInputDdbClient = {
      send: async (c) => {
        const p = c as unknown as FakePut;
        if (p.input.Item.SK === third.SK) {
          throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        }
        puts.push(p);
        return {};
      },
    };
    const res = await putNewInputs(ddb, "reciterai", cmd, plan.items.values(), new Set([first.SK]));
    expect(res).toEqual({ put: 1, alreadyQueued: 2 });
    expect(puts.map((p) => p.input.Item.SK)).toEqual([second.SK]);
    expect(puts[0].input.ConditionExpression).toBe("attribute_not_exists(SK)");
  });

  it("rethrows any other DynamoDB failure", async () => {
    const plan = buildInputPlan([g()], [], new Date());
    const ddb: AreaInputDdbClient = {
      send: async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    };
    await expect(putNewInputs(ddb, "reciterai", cmd, plan.items.values(), new Set())).rejects.toThrow(
      "denied",
    );
  });
});
