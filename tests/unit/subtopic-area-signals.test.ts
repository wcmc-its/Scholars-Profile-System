/**
 * getSubtopicScholars with TOPIC_SUBAREA_RANK_AREA_SIGNALS: PI grants and PI
 * trials ReciterAI assigned to THIS subarea re-rank the subarea's paper pool at
 * W = 1, never add a scholar, never leak across subareas, and fail soft to the
 * papers-only order. Flag off must reproduce today's order exactly.
 *
 * The fake db honors the `where` clauses the code relies on the database for
 * (subarea on papers, cwid lists, area + subarea on area scores), so a grant in
 * another subarea, or a scholar outside the paper pool, genuinely cannot leak
 * in. Synthetic cwids and titles only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  areaTextKey: string | null;
};
type PersonTrial = {
  cwid: string;
  role: string;
  trial: {
    protocolNumber: string;
    nctNumber: string | null;
    startDate: string | null;
    status: string | null;
    areaTextKey: string | null;
  };
};
type PtRow = { cwid: string; primarySubtopicId: string } & Record<string, unknown>;

const state = vi.hoisted(() => ({
  ptRows: [] as PtRow[],
  grants: [] as Grant[],
  trials: [] as PersonTrial[],
  overrides: [] as { entityId: string; fieldName: string }[],
  /** textKey -> { topicId -> { score, sub } } (sub = primary_subtopic_id, null = unassigned) */
  scores: {} as Record<string, Record<string, { score: number; sub: string | null }>>,
  calls: { grant: 0, trial: 0, text: 0 },
  failTexts: false,
}));

vi.mock("@/lib/db", () => {
  const inList = (v: string, f?: { in: string[] }) => !f || f.in.includes(v);
  return {
    prisma: {
      topic: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
      publicationTopic: {
        findMany: async ({ where }: { where: { primarySubtopicId: string } }) =>
          state.ptRows.filter((r) => r.primarySubtopicId === where.primarySubtopicId),
        // Popover counts: 7 subarea pubs for everyone, so a test can see they
        // are publication counts, untouched by signal points.
        groupBy: async ({ where }: { where: { cwid: { in: string[] } } }) =>
          where.cwid.in.map((cwid) => ({ cwid, _count: { pmid: 7 } })),
      },
      publicationAuthor: { groupBy: async () => [] },
      fieldOverride: {
        findMany: async ({ where }: { where: { entityId: { in: string[] }; fieldName: { in: string[] } } }) =>
          state.overrides.filter((o) => inList(o.entityId, where.entityId) && inList(o.fieldName, where.fieldName)),
      },
      grant: {
        findMany: async ({ where }: { where: { cwid: { in: string[] } } }) => {
          state.calls.grant += 1;
          return state.grants.filter((g) => inList(g.cwid, where.cwid) && g.areaTextKey !== null);
        },
      },
      personClinicalTrial: {
        findMany: async ({ where }: { where: { cwid: { in: string[] }; role: string } }) => {
          state.calls.trial += 1;
          return state.trials.filter(
            (t) => inList(t.cwid, where.cwid) && t.role === where.role && t.trial.areaTextKey !== null,
          );
        },
      },
      // Grant suppressions (by entityId) and hidden authorships (by contributorCwid): none.
      suppression: { findMany: async () => [] },
      areaSignalText: {
        findMany: async ({
          where,
          select,
        }: {
          where: { textKey: { in: string[] } };
          select: { topics: { where: { parentTopicId: string; primarySubtopicId?: string } } };
        }) => {
          state.calls.text += 1;
          if (state.failTexts) throw new Error("table missing");
          const w = select.topics.where;
          return where.textKey.in
            .filter((k) => k in state.scores)
            .map((textKey) => {
              const row = state.scores[textKey][w.parentTopicId];
              const match = row && (w.primarySubtopicId === undefined || row.sub === w.primarySubtopicId);
              return { textKey, topics: match ? [{ score: row.score }] : [] };
            });
        },
      },
    },
  };
});

import { getSubtopicScholars } from "@/lib/api/topics";
import { loadAreaSignalPoints } from "@/lib/api/area-signal-points";

const NOW = new Date("2026-10-19T00:00:00Z");
const TOPIC = "cardio_example";
const SUB_X = "cardio_example_rhythm";
const SUB_Y = "cardio_example_failure";

function pt(cwid: string, pmid: number, score: number, sub = SUB_X): PtRow {
  return {
    pmid: String(pmid),
    cwid,
    parentTopicId: TOPIC,
    primarySubtopicId: sub,
    score,
    authorPosition: "first",
    year: 2024,
    scholar: {
      cwid,
      slug: `s-${cwid}`,
      preferredName: `S ${cwid}`,
      primaryTitle: null,
      primaryDepartment: null,
      roleCategory: "full_time_faculty",
      hasHeadshot: false,
    },
    publication: {
      pmid: String(pmid),
      publicationType: "Academic Article",
      dateAddedToEntrez: new Date("2025-06-01T00:00:00Z"),
    },
  };
}

let gid = 0;
function grant(cwid: string, key: string, over: Partial<Grant> = {}): Grant {
  gid += 1;
  return {
    id: `g${gid}`,
    cwid,
    externalId: `ext${gid}`,
    source: "InfoEd",
    role: "PI",
    title: `Synthetic project ${gid}`,
    awardNumber: null,
    mechanism: "R01",
    programType: "Grant",
    startDate: new Date("2025-01-01T00:00:00Z"),
    areaTextKey: key,
    ...over,
  };
}
function trial(cwid: string, key: string, over: Partial<PersonTrial["trial"]> = {}): PersonTrial {
  gid += 1;
  return {
    cwid,
    role: "Principal Investigator",
    trial: {
      protocolNumber: `P${gid}`,
      nctNumber: `NCT${gid}`,
      startDate: "2025-03",
      status: "OPEN TO ACCRUAL",
      areaTextKey: key,
      ...over,
    },
  };
}
const inX = (score: number) => ({ [TOPIC]: { score, sub: SUB_X } });

/**
 * Subarea X paper totals: s1 2.0 > s2 1.9 > s3 1.8 > s4 1.0 (full recency).
 * Subarea Y: s4 1.0 > s5 0.8 (s4 publishes in both).
 */
function baseline() {
  state.ptRows = [
    pt("s1", 1, 1.0),
    pt("s1", 2, 1.0),
    pt("s2", 3, 1.9),
    pt("s3", 4, 1.8),
    pt("s4", 5, 1.0),
    pt("s4", 6, 1.0, SUB_Y),
    pt("s5", 7, 0.8, SUB_Y),
  ];
}
const order = async (sub = SUB_X) => (await getSubtopicScholars(TOPIC, sub, NOW))!.map((r) => r.cwid);

beforeEach(() => {
  state.grants = [];
  state.trials = [];
  state.overrides = [];
  state.scores = {};
  state.calls = { grant: 0, trial: 0, text: 0 };
  state.failTexts = false;
  baseline();
  vi.stubEnv("TOPIC_SUBAREA_RANK_AREA_SIGNALS", "on");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TOPIC_SUBAREA_RANK_AREA_SIGNALS off", () => {
  it("reproduces today's papers-only order exactly and reads no signal tables", async () => {
    // A signal that WOULD reorder if read; the area-level flag on must not matter.
    state.grants = [grant("s4", "kA"), grant("s4", "kB")];
    state.scores = { kA: inX(1), kB: inX(1) };
    vi.stubEnv("TOPIC_RANK_AREA_SIGNALS", "on");
    vi.stubEnv("TOPIC_SUBAREA_RANK_AREA_SIGNALS", "off");
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    vi.stubEnv("TOPIC_SUBAREA_RANK_AREA_SIGNALS", "");
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(state.calls).toEqual({ grant: 0, trial: 0, text: 0 });
  });

  it("matches the flag-on order when no scholar has a signal (ties included)", async () => {
    state.ptRows = [pt("t1", 1, 1.0), pt("t2", 2, 1.0), pt("t3", 3, 1.0), pt("t4", 4, 0.5)];
    const on = await order();
    vi.stubEnv("TOPIC_SUBAREA_RANK_AREA_SIGNALS", "off");
    expect(await order()).toEqual(on);
  });
});

describe("TOPIC_SUBAREA_RANK_AREA_SIGNALS on", () => {
  it("adds W = 1 points: a 0.85 grant lifts s4 from 1.0 to 1.85 (W = 2 would put it first)", async () => {
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: inX(0.85) };
    expect(await order()).toEqual(["s1", "s2", "s4", "s3"]);
  });

  it("scores area score x 1 x recency, top 3 per kind", async () => {
    state.grants = [
      grant("s4", "kA"),
      grant("s4", "kB"),
      grant("s4", "kC"),
      grant("s4", "kD"), // fourth grant: over the cap
      grant("s3", "kE", { startDate: new Date("2022-03-01T00:00:00Z") }), // 55 months: 0.6
    ];
    state.trials = [trial("s3", "kT", { startDate: "2021-01" })]; // 69 months: 0.3
    state.scores = {
      kA: inX(1),
      kB: inX(0.5),
      kC: inX(0.25),
      kD: inX(0.2),
      kE: inX(0.5),
      kT: inX(0.4),
    };
    const points = await loadAreaSignalPoints(TOPIC, ["s3", "s4"], NOW, { subtopicId: SUB_X });
    expect(points.get("s4")).toBeCloseTo(1 + 0.5 + 0.25, 10);
    expect(points.get("s3")).toBeCloseTo(0.5 * 0.6 + 0.4 * 0.3, 10);
  });

  it("never adds a scholar who has no papers in the subarea", async () => {
    // s5 publishes in Y only; nopapers publishes nowhere.
    state.grants = [grant("nopapers", "kA"), grant("s5", "kB")];
    state.trials = [trial("nopapers", "kT")];
    state.scores = { kA: inX(1), kB: inX(1), kT: inX(1) };
    const result = await order();
    expect(result).toEqual(["s1", "s2", "s3", "s4"]);
    const points = await loadAreaSignalPoints(TOPIC, ["s1"], NOW, { subtopicId: SUB_X });
    expect(points.size).toBe(0);
  });

  it("isolates subareas: a grant in X lifts s4 in X but not in Y", async () => {
    state.ptRows.push(pt("s6", 8, 1.5, SUB_Y)); // Y: s6 1.5 > s4 1.0 > s5 0.8
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: inX(0.95) };
    expect(await order(SUB_X)).toEqual(["s1", "s4", "s2", "s3"]); // s4 1.0 + 0.95
    expect(await order(SUB_Y)).toEqual(["s6", "s4", "s5"]);
  });

  it("ignores items assigned to another subarea, unassigned, or scored in another area", async () => {
    state.grants = [grant("s4", "kOther"), grant("s4", "kNone"), grant("s4", "kArea2")];
    state.trials = [trial("s4", "kTrialOther")];
    state.scores = {
      kOther: { [TOPIC]: { score: 1, sub: SUB_Y } },
      kNone: { [TOPIC]: { score: 1, sub: null } },
      kArea2: { other_area: { score: 1, sub: SUB_X } },
      kTrialOther: { [TOPIC]: { score: 1, sub: SUB_Y } },
    };
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    const points = await loadAreaSignalPoints(TOPIC, ["s4"], NOW, { subtopicId: SUB_X });
    expect(points.size).toBe(0);
  });

  it("respects a hidden Funding section", async () => {
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: inX(1) };
    state.overrides = [{ entityId: "s4", fieldName: "hideFunding" }];
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("keeps the popover counts as publication counts", async () => {
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: inX(1) };
    const rows = (await getSubtopicScholars(TOPIC, SUB_X, NOW))!;
    expect(rows.map((r) => r.pubCountInSubtopic)).toEqual([7, 7, 7, 7]);
  });

  it("fails soft to the papers-only order when a signal read throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: inX(1) };
    state.failTexts = true;
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("area_signal_points_failed"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SUB_X));
  });
});
