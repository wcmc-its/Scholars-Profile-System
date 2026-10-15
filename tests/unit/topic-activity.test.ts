/**
 * getTopicActivity (TOPIC_FEED_GRANTS_TRIALS): a research area's grants and
 * trials as feed items. Covers the display cut (the papers' displayThreshold
 * rule, default 0.5, with the 0.3 floor under "also"), the exclusions
 * (suppressed, hidden sections, inactive scholars, RePORTER rows, the six
 * grant-excluded areas, hidden trial statuses), project grouping (a multi-PI
 * award is one item, with every InfoEd investigator as a chip), ended grants
 * included, the scholar filter, the per-kind counts, sorts and paging.
 *
 * The fake db honors the `where` clauses the service relies on the database
 * for (area scores by topic and floor, text keys, sibling arms, override ids
 * and value, suppression ids, entity type and revocation, active scholars), so
 * a row the query excludes cannot leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Scholar = {
  slug: string;
  preferredName: string;
  primaryDepartment: string | null;
  primaryOrgCode: string | null;
  roleCategory: string | null;
  hasHeadshot: boolean;
  status: string;
  deletedAt: Date | null;
};
type Grant = {
  id: string;
  cwid: string;
  externalId: string;
  source: string;
  role: string;
  title: string;
  awardNumber: string | null;
  mechanism: string | null;
  programType: string;
  startDate: Date;
  endDate: Date;
  areaTextKey: string | null;
};
type Trial = {
  protocolNumber: string;
  nctNumber: string | null;
  title: string;
  status: string | null;
  startDate: string | null;
  areaTextKey: string | null;
};
type PersonTrial = { cwid: string; role: string; trial: Trial };

const state = vi.hoisted(() => ({
  topics: {} as Record<string, { displayThreshold: number | null }>,
  scholars: {} as Record<string, Scholar>,
  grants: [] as Grant[],
  trials: [] as PersonTrial[],
  overrides: [] as { entityId: string; fieldName: string; value: string }[],
  suppressions: [] as { entityType: string; entityId: string; revokedAt: Date | null }[],
  /** `${textKey}|${topic}` -> score */
  scores: {} as Record<string, number>,
}));

vi.mock("@/lib/db", () => {
  const active = (cwid: string) => {
    const s = state.scholars[cwid];
    return !!s && s.status === "active" && s.deletedAt === null;
  };
  const scholarOut = (cwid: string) => {
    const s = state.scholars[cwid];
    return {
      slug: s.slug,
      preferredName: s.preferredName,
      primaryDepartment: s.primaryDepartment,
      primaryOrgCode: s.primaryOrgCode,
      roleCategory: s.roleCategory,
      hasHeadshot: s.hasHeadshot,
    };
  };
  const grantOut = (g: Grant) => ({
    ...g,
    primeSponsor: "NIH",
    primeSponsorRaw: "National Institutes of Health",
    directSponsor: null,
    directSponsorRaw: null,
    nihIc: null,
    isSubaward: false,
    abstract: null,
    abstractSource: null,
    applId: null,
    keywords: [],
    meshDescriptorUis: [],
    publications: [],
    scholar: scholarOut(g.cwid),
  });
  type Arm = { id?: { in: string[] }; externalId?: { startsWith: string }; awardNumber?: { contains: string } };
  const armHit = (g: Grant, a: Arm) =>
    (a.id && a.id.in.includes(g.id)) ||
    (a.externalId && g.externalId.startsWith(a.externalId.startsWith)) ||
    (a.awardNumber && (g.awardNumber ?? "").includes(a.awardNumber.contains));
  return {
    prisma: {
      topic: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id in state.topics ? { id: where.id, ...state.topics[where.id] } : null,
      },
      scholar: {
        findFirst: async ({ where }: { where: { cwid: string } }) =>
          active(where.cwid) ? { roleCategory: state.scholars[where.cwid].roleCategory } : null,
      },
      areaSignalTopic: {
        findMany: async ({ where }: { where: { parentTopicId: string; score: { gte: number } } }) =>
          Object.entries(state.scores)
            .map(([k, score]) => ({ textKey: k.split("|")[0], topic: k.split("|")[1], score }))
            .filter((r) => r.topic === where.parentTopicId && r.score >= where.score.gte)
            .map((r) => ({ textKey: r.textKey, score: r.score })),
      },
      grant: {
        findMany: async ({
          where,
        }: {
          where: {
            areaTextKey?: { in: string[] };
            source?: string;
            role?: { in: string[] };
            startDate?: { gte: Date };
            AND?: [unknown, { source: string }, { OR: Arm[] }];
          };
        }) => {
          if (where.areaTextKey) {
            return state.grants
              .filter(
                (g) =>
                  active(g.cwid) &&
                  g.areaTextKey !== null &&
                  where.areaTextKey!.in.includes(g.areaTextKey) &&
                  g.source === where.source &&
                  where.role!.in.includes(g.role) &&
                  g.startDate >= where.startDate!.gte,
              )
              .map(grantOut);
          }
          const [, src, or] = where.AND!;
          return state.grants
            .filter((g) => active(g.cwid) && g.source === src.source && or.OR.some((a) => armHit(g, a)))
            .map(grantOut);
        },
      },
      personClinicalTrial: {
        findMany: async ({ where }: { where: { role: string; trial: { areaTextKey: { in: string[] } } } }) =>
          state.trials
            .filter(
              (t) =>
                active(t.cwid) &&
                t.role === where.role &&
                t.trial.areaTextKey !== null &&
                where.trial.areaTextKey.in.includes(t.trial.areaTextKey),
            )
            .sort((a, b) => a.trial.protocolNumber.localeCompare(b.trial.protocolNumber) || a.cwid.localeCompare(b.cwid))
            .map((t) => ({
              cwid: t.cwid,
              scholar: { preferredName: state.scholars[t.cwid].preferredName, slug: state.scholars[t.cwid].slug },
              trial: {
                phase: "PHASE2",
                studyType: "INTERVENTIONAL",
                sponsorClass: "OTHER",
                principalSponsor: null,
                conditions: "Synthetic condition",
                ctgovStatus: null,
                startDateType: null,
                primaryCompletionDate: null,
                primaryCompletionDateType: null,
                hasResults: false,
                interventions: null,
                firstOtaDate: null,
                ...t.trial,
              },
            })),
      },
      fieldOverride: {
        findMany: async ({
          where,
        }: {
          where: {
            entityType: string;
            entityId: { in: string[] };
            fieldName: string;
            value?: string;
          };
        }) =>
          state.overrides.filter(
            (o) =>
              where.entityType === "scholar" &&
              where.entityId.in.includes(o.entityId) &&
              o.fieldName === where.fieldName &&
              (where.value === undefined || o.value === where.value),
          ),
      },
      suppression: {
        findMany: async ({
          where,
        }: {
          where: { entityType?: string; entityId: { in: string[] }; revokedAt?: null };
        }) =>
          state.suppressions
            .filter(
              (s) =>
                where.entityId.in.includes(s.entityId) &&
                (where.entityType === undefined || s.entityType === where.entityType) &&
                (!("revokedAt" in where) || s.revokedAt === null),
            )
            .map((s) => ({ entityId: s.entityId })),
      },
    },
  };
});

import { coreProjectNum } from "@/lib/award-number";
import { getTopicActivity, type TopicGrantActivityHit, type TopicTrialActivityHit } from "@/lib/api/topic-activity";

const NOW = new Date("2026-10-15T00:00:00Z");
const AREA = "cardio_example";
const EXCLUDED_AREA = "biomedical_informatics";

function scholar(cwid: string, over: Partial<Scholar> = {}) {
  state.scholars[cwid] = {
    slug: `s-${cwid}`,
    preferredName: `Scholar ${cwid}`,
    primaryDepartment: "Synthetic Dept",
    primaryOrgCode: "WCMC",
    roleCategory: "full_time_faculty",
    hasHeadshot: false,
    status: "active",
    deletedAt: null,
    ...over,
  };
}

let n = 0;
/** One InfoEd row; its account number is unique unless `account` is passed. */
function grant(cwid: string, key: string | null, over: Partial<Grant> & { account?: string } = {}): Grant {
  n += 1;
  const { account = `A${n}`, ...rest } = over;
  const g: Grant = {
    id: `g${n}`,
    cwid,
    externalId: `INFOED-${account}-${cwid}`,
    source: "InfoEd",
    role: "PI",
    title: `Synthetic project ${n}`,
    awardNumber: null,
    mechanism: "R01",
    programType: "Grant",
    startDate: new Date("2024-01-01T00:00:00Z"),
    endDate: new Date("2029-01-01T00:00:00Z"),
    areaTextKey: key,
    ...rest,
  };
  state.grants.push(g);
  return g;
}
function trial(cwid: string, key: string | null, over: Partial<Trial> = {}): PersonTrial {
  n += 1;
  const t = {
    cwid,
    role: "Principal Investigator",
    trial: {
      protocolNumber: `P${n}`,
      nctNumber: `NCT0000${n}`,
      title: `Synthetic trial ${n}`,
      status: "OPEN TO ACCRUAL",
      startDate: "2024-03",
      areaTextKey: key,
      ...over,
    },
  };
  state.trials.push(t);
  return t;
}
/** A hide-section override; `value` "true" is the only one that hides. */
const hide = (cwid: string, fieldName: string, value = "true") => {
  state.overrides.push({ entityId: cwid, fieldName, value });
};
/** An active grant suppression unless `over` says otherwise. */
const suppress = (
  externalId: string,
  over: Partial<{ entityType: string; revokedAt: Date | null }> = {},
) => {
  state.suppressions.push({ entityType: "grant", entityId: externalId, revokedAt: null, ...over });
};
const score = (key: string, s: number, topic = AREA) => {
  state.scores[`${key}|${topic}`] = s;
};

const grants = async (opts: Parameters<typeof getTopicActivity>[1] | object = {}, topic = AREA) =>
  (await getTopicActivity(topic, { kind: "grant", ...opts }, NOW))!;
const trials = async (opts: object = {}, topic = AREA) =>
  (await getTopicActivity(topic, { kind: "trial", ...opts }, NOW))!;
const grantTitles = async (opts: object = {}, topic = AREA) =>
  ((await grants(opts, topic)).hits as TopicGrantActivityHit[]).map((h) => h.title);

beforeEach(() => {
  state.topics = { [AREA]: { displayThreshold: null }, [EXCLUDED_AREA]: { displayThreshold: null } };
  state.scholars = {};
  state.grants = [];
  state.trials = [];
  state.overrides = [];
  state.suppressions = [];
  state.scores = {};
  n = 0;
  for (const c of ["tst001", "tst002", "tst003", "tst004"]) scholar(c);
});

describe("getTopicActivity", () => {
  it("returns null for an unknown area", async () => {
    expect(await getTopicActivity("no_such_area", { kind: "grant" }, NOW)).toBeNull();
  });

  it("lists a scored InfoEd grant as a FundingHit with its area score", async () => {
    grant("tst001", "k1", { title: "Heart failure cohort" });
    score("k1", 0.8);
    const r = await grants();
    expect(r.total).toBe(1);
    const hit = r.hits[0] as TopicGrantActivityHit;
    expect(hit).toMatchObject({ title: "Heart failure cohort", areaScore: 0.8, isActive: true });
    expect(hit.people.map((p) => p.cwid)).toEqual(["tst001"]);
    expect(hit.people[0].identityImageEndpoint).toEqual(expect.any(String));
  });

  it("excludes suppressed grants, hidden Funding, inactive scholars and RePORTER rows", async () => {
    score("k1", 0.9);
    score("k2", 0.9);
    score("k3", 0.9);
    score("k4", 0.9);
    score("k5", 0.9);
    const sup = grant("tst001", "k1", { title: "suppressed" });
    suppress(sup.externalId);
    grant("tst002", "k2", { title: "hidden funding" });
    hide("tst002", "hideFunding");
    scholar("tstgone", { status: "suppressed" });
    grant("tstgone", "k3", { title: "inactive scholar" });
    grant("tst003", "k4", { title: "reporter row", source: "RePORTER", externalId: "reporter:s3:R01XX000001" });
    grant("tst004", "k5", { title: "kept" });
    expect(await grantTitles()).toEqual(["kept"]);
    // Excluded from the counts too, not just dropped at hydration.
    expect((await grants()).counts.grant).toEqual({ strongly: 1, also: 0 });
  });

  it("hidden Clinical Trials does not hide grants, and hidden Funding does not hide trials", async () => {
    score("g", 0.9);
    score("t", 0.9);
    grant("tst001", "g", { title: "grant" });
    trial("tst002", "t", { title: "trial" });
    hide("tst001", "hideClinicalTrials");
    hide("tst002", "hideFunding");
    expect(await grantTitles()).toEqual(["grant"]);
    expect(((await trials()).hits as TopicTrialActivityHit[]).map((h) => h.title)).toEqual(["trial"]);
  });

  it("a multi-PI award is ONE item carrying every investigator, a hider left off the chips", async () => {
    score("k1", 0.9);
    // Same NIH core project on two accounts (each PI's own row) plus a Co-I
    // row with no area key, and an MPI who hid Funding.
    grant("tst001", "k1", { account: "A100", awardNumber: "1R01HL123456-01", title: "MPI award" });
    grant("tst002", "k1", { account: "A101", awardNumber: "5R01HL123456-02", role: "Co-PI", title: "MPI award" });
    grant("tst003", null, { account: "A100", awardNumber: "1R01HL123456-01", role: "Co-I", title: "MPI award" });
    grant("tst004", "k1", { account: "A100", awardNumber: "1R01HL123456-01", role: "Co-PI", title: "MPI award" });
    hide("tst004", "hideFunding");
    const r = await grants();
    expect(r.total).toBe(1);
    expect(r.counts.grant).toEqual({ strongly: 1, also: 0 });
    const hit = r.hits[0] as TopicGrantActivityHit;
    expect(hit.isMultiPi).toBe(true);
    expect(hit.people.map((p) => p.cwid)).toEqual(["tst001", "tst002", "tst003"]);
  });

  it("a suppressed sibling row on a qualifying project is left off the chips", async () => {
    score("k1", 0.9);
    grant("tst001", "k1", { account: "A200", title: "sibling suppression" });
    // Not a qualifying row (no area key, Co-I): it only enters at hydration.
    const sib = grant("tst002", null, {
      account: "A200",
      role: "Co-I",
      title: "sibling suppression",
    });
    suppress(sib.externalId);
    const hit = (await grants()).hits[0] as TopicGrantActivityHit;
    expect(hit.people.map((p) => p.cwid)).toEqual(["tst001"]);
  });

  it("projectId is the project's grouping key, as in the funding index", async () => {
    score("k1", 0.9);
    grant("tst001", "k1", { account: "A300", awardNumber: "5R01HL654321-03" });
    grant("tst002", "k1", { account: "A301", awardNumber: "1R01HL654321-01", role: "Co-PI" });
    score("k2", 0.9);
    grant("tst003", "k2", { account: "A302" });
    const ids = ((await grants()).hits as TopicGrantActivityHit[]).map((h) => h.projectId).sort();
    expect(ids).toEqual([coreProjectNum("1R01HL654321-01"), "A302"].sort());
  });

  it("a project's canonical fields come from a qualifying row, not a sibling", async () => {
    score("k1", 0.9);
    grant("tst002", null, { account: "A400", role: "Co-I", title: "sibling title" });
    grant("tst001", "k1", { account: "A400", title: "qualifying title" });
    expect(await grantTitles()).toEqual(["qualifying title"]);
  });

  it("only an active, grant-typed suppression and a 'true' override exclude a grant", async () => {
    for (const k of ["a", "b", "c", "d"]) score(k, 0.9);
    grant("tst001", "a", { title: "override false" });
    hide("tst001", "hideFunding", "false");
    const other = grant("tst002", "b", { title: "other entity type" });
    suppress(other.externalId, { entityType: "publication" });
    const revoked = grant("tst003", "c", { title: "revoked" });
    suppress(revoked.externalId, { revokedAt: new Date("2026-01-01T00:00:00Z") });
    grant("tst004", "d", { title: "plain" });
    expect((await grantTitles()).sort()).toEqual([
      "other entity type",
      "override false",
      "plain",
      "revoked",
    ]);
  });

  it("a project's score is its best text's score", async () => {
    score("lo", 0.35);
    score("hi", 0.75);
    grant("tst001", "lo", { account: "A1", title: "one project" });
    grant("tst001", "hi", { account: "A1", title: "one project" });
    const r = await grants();
    expect(r.total).toBe(1);
    expect((r.hits[0] as TopicGrantActivityHit).areaScore).toBe(0.75);
  });

  it("never lists grants in the six grant-excluded areas, but does list trials there", async () => {
    score("g", 0.9, EXCLUDED_AREA);
    score("t", 0.9, EXCLUDED_AREA);
    grant("tst001", "g");
    trial("tst001", "t");
    const g = await grants({}, EXCLUDED_AREA);
    expect(g.total).toBe(0);
    expect(g.counts).toEqual({ grant: { strongly: 0, also: 0 }, trial: { strongly: 1, also: 0 } });
    expect((await trials({}, EXCLUDED_AREA)).total).toBe(1);
  });

  it("drops ineligible grants (training mechanism, pre-2020 start, non-PI role)", async () => {
    for (const k of ["a", "b", "c", "d"]) score(k, 0.9);
    grant("tst001", "a", { mechanism: "T32", title: "training" });
    grant("tst001", "b", { startDate: new Date("2019-06-01T00:00:00Z"), title: "old" });
    grant("tst001", "c", { role: "Co-I", title: "co-i" });
    grant("tst001", "d", { title: "kept" });
    expect(await grantTitles()).toEqual(["kept"]);
  });

  it("includes ended grants", async () => {
    score("k1", 0.9);
    grant("tst001", "k1", {
      startDate: new Date("2020-07-01T00:00:00Z"),
      endDate: new Date("2022-06-30T00:00:00Z"),
      title: "ended",
    });
    const hit = (await grants()).hits[0] as TopicGrantActivityHit;
    expect(hit.title).toBe("ended");
    expect(hit.status).toBe("ended");
    expect(hit.isActive).toBe(false);
  });

  describe("tier cut (the papers' rule)", () => {
    beforeEach(() => {
      score("a", 0.8);
      score("b", 0.5);
      score("c", 0.45);
      score("d", 0.3);
      score("e", 0.29); // below the floor: never listed
      for (const k of ["a", "b", "c", "d", "e"]) grant("tst001", k, { title: k });
    });

    it("defaults displayThreshold to 0.5: strongly >= 0.5, also in [0.3, 0.5)", async () => {
      expect(await grantTitles({ tier: "strongly", sort: "best_match" })).toEqual(["a", "b"]);
      expect(await grantTitles({ tier: "also", sort: "best_match" })).toEqual(["c", "d"]);
      const all = await grants({ sort: "best_match" });
      expect(all.total).toBe(4);
      expect(all.tierTotals).toEqual({ strongly: 2, also: 2 });
      expect(all.displayThreshold).toBe(0.5);
    });

    it("uses the area's own displayThreshold when set", async () => {
      state.topics[AREA].displayThreshold = 0.7;
      expect(await grantTitles({ tier: "strongly" })).toEqual(["a"]);
      const also = await grants({ tier: "also", sort: "best_match" });
      expect((also.hits as TopicGrantActivityHit[]).map((h) => h.title)).toEqual(["b", "c", "d"]);
      expect(also.total).toBe(3);
      expect(also.tierTotals).toEqual({ strongly: 1, also: 3 });
    });
  });

  it("sorts newest start first by default, best match on request", async () => {
    score("old", 0.9);
    score("new", 0.4);
    grant("tst001", "old", { startDate: new Date("2021-01-01T00:00:00Z"), title: "old" });
    grant("tst001", "new", { startDate: new Date("2025-01-01T00:00:00Z"), title: "new" });
    expect(await grantTitles()).toEqual(["new", "old"]);
    expect(await grantTitles({ sort: "best_match" })).toEqual(["old", "new"]);
  });

  it("pages in memory and counts the whole scope", async () => {
    for (let i = 0; i < 25; i += 1) {
      score(`k${i}`, 0.9);
      grant("tst001", `k${i}`, { startDate: new Date(Date.UTC(2021, 0, 1 + i)) });
    }
    const p0 = await grants();
    const p1 = await grants({ page: 1 });
    expect(p0.hits).toHaveLength(20);
    expect(p1.hits).toHaveLength(5);
    expect(p0.total).toBe(25);
    expect((await grants({ pageSize: 40 })).hits).toHaveLength(25);
  });

  it("the scholar filter narrows rows and counts; a non-public cwid gets an empty result", async () => {
    score("a", 0.9);
    score("b", 0.9);
    score("t", 0.9);
    grant("tst001", "a", { title: "tst001 grant" });
    grant("tst002", "b", { title: "tst002 grant" });
    trial("tst002", "t");
    const r = await grants({ cwid: "tst001" });
    expect((r.hits as TopicGrantActivityHit[]).map((h) => h.title)).toEqual(["tst001 grant"]);
    expect(r.counts).toEqual({ grant: { strongly: 1, also: 0 }, trial: { strongly: 0, also: 0 } });
    scholar("tsthid", { status: "suppressed" });
    const refused = await grants({ cwid: "tsthid" });
    expect(refused.total).toBe(0);
    expect(refused.counts.grant).toEqual({ strongly: 0, also: 0 });
  });

  it("accepts subtopic but does not apply it yet", async () => {
    score("a", 0.9);
    grant("tst001", "a");
    const r = await grants({ subtopic: "some_subarea" });
    expect(r.total).toBe(1);
    expect(r.subtopicApplied).toBe(false);
  });

  describe("trials", () => {
    it("groups PI rows by NCT into one TrialHit with every PI", async () => {
      score("t1", 0.9);
      trial("tst001", "t1", { protocolNumber: "P-A", nctNumber: "NCT01", title: "shared" });
      trial("tst002", "t1", { protocolNumber: "P-A", nctNumber: "NCT01", title: "shared" });
      trial("tst003", "t1", { protocolNumber: "P-B", nctNumber: "NCT01", title: "shared" });
      const r = await trials();
      expect(r.total).toBe(1);
      const hit = r.hits[0] as TopicTrialActivityHit;
      expect(hit).toMatchObject({ trialId: "NCT01", nctNumber: "NCT01", statusKey: "recruiting", areaScore: 0.9 });
      expect(hit.pis.map((p) => p.cwid)).toEqual(["tst001", "tst002", "tst003"]);
    });

    it("excludes hidden statuses, hidden Clinical Trials, non-PI roles and non-NCT trials", async () => {
      for (const k of ["a", "b", "c", "d", "e"]) score(k, 0.9);
      trial("tst001", "a", { status: "WITHDRAWN", title: "withdrawn" });
      trial("tst002", "b", { title: "hidden section" });
      hide("tst002", "hideClinicalTrials");
      trial("tst003", "c", { title: "investigator" }).role = "Investigator";
      trial("tst003", "d", { nctNumber: null, title: "no nct" });
      trial("tst004", "e", { title: "kept" });
      expect(((await trials()).hits as TopicTrialActivityHit[]).map((h) => h.title)).toEqual(["kept"]);
    });

    it("cuts trials at the same display threshold", async () => {
      score("hi", 0.6);
      score("lo", 0.4);
      trial("tst001", "hi", { title: "hi" });
      trial("tst001", "lo", { title: "lo" });
      const r = await trials({ tier: "also" });
      expect((r.hits as TopicTrialActivityHit[]).map((h) => h.title)).toEqual(["lo"]);
      expect(r.tierTotals).toEqual({ strongly: 1, also: 1 });
    });
  });
});
