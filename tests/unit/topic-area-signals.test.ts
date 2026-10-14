/**
 * getTopScholarsForTopic with TOPIC_RANK_AREA_SIGNALS: grants and trials
 * re-rank scholars who already rank on papers, never add one, and respect
 * suppression, hidden sections, hidden trial statuses and the six-area grant
 * exclusion. Flag off must reproduce the papers-only order exactly.
 *
 * The fake db honors the `where` clauses the code relies on the database for
 * (cwid lists, the topic filter on area scores, suppression ids), so a scholar
 * outside the publication aggregation genuinely cannot leak in.
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

const state = vi.hoisted(() => ({
  ptRows: [] as unknown[],
  grants: [] as Grant[],
  trials: [] as PersonTrial[],
  overrides: [] as { entityId: string; fieldName: string }[],
  suppressedGrantIds: [] as string[],
  /** textKey -> { topicId -> score } */
  scores: {} as Record<string, Record<string, number>>,
  calls: { grant: 0, trial: 0, text: 0 },
  failTexts: false,
}));

vi.mock("@/lib/db", () => {
  const inList = (v: string, f?: { in: string[] }) => !f || f.in.includes(v);
  return {
    prisma: {
      topic: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
      publicationTopic: { findMany: async () => state.ptRows },
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
      suppression: {
        findMany: async ({ where }: { where: { entityId: { in: string[] } } }) =>
          state.suppressedGrantIds.filter((id) => where.entityId.in.includes(id)).map((entityId) => ({ entityId })),
      },
      areaSignalText: {
        findMany: async ({
          where,
          select,
        }: {
          where: { textKey: { in: string[] } };
          select: { topics: { where: { parentTopicId: string } } };
        }) => {
          state.calls.text += 1;
          if (state.failTexts) throw new Error("table missing");
          const topic = select.topics.where.parentTopicId;
          return where.textKey.in
            .filter((k) => k in state.scores)
            .map((textKey) => ({
              textKey,
              topics: topic in state.scores[textKey] ? [{ score: state.scores[textKey][topic] }] : [],
            }));
        },
      },
    },
  };
});

import { getTopScholarsForTopic } from "@/lib/api/topics";

const NOW = new Date("2026-10-15T00:00:00Z");
const TOPIC = "cardio_example";

function pt(cwid: string, pmid: number, score: number) {
  return {
    pmid: String(pmid),
    cwid,
    parentTopicId: TOPIC,
    score,
    authorPosition: "first",
    year: 2024,
    scholar: { cwid, slug: `s-${cwid}`, preferredName: `S ${cwid}`, primaryTitle: null, roleCategory: "full_time_faculty", hasHeadshot: false },
    publication: { pmid: String(pmid), publicationType: "Academic Article", dateAddedToEntrez: new Date("2025-06-01T00:00:00Z") },
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
    trial: { protocolNumber: `P${gid}`, nctNumber: `NCT${gid}`, startDate: "2025-03", status: "OPEN TO ACCRUAL", areaTextKey: key, ...over },
  };
}

/** Paper totals: s1 2.0 > s2 1.9 > s3 1.8 > s4 1.0 (one paper each, full recency). */
function baseline() {
  state.ptRows = [pt("s1", 1, 1.0), pt("s1", 2, 1.0), pt("s2", 3, 1.9), pt("s3", 4, 1.8), pt("s4", 5, 1.0)];
}
const order = async (topic = TOPIC) => (await getTopScholarsForTopic(topic, NOW))!.map((r) => r.cwid);

beforeEach(() => {
  state.ptRows = [];
  state.grants = [];
  state.trials = [];
  state.overrides = [];
  state.suppressedGrantIds = [];
  state.scores = {};
  state.calls = { grant: 0, trial: 0, text: 0 };
  state.failTexts = false;
  baseline();
  vi.stubEnv("TOPIC_RANK_AREA_SIGNALS", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("TOPIC_RANK_AREA_SIGNALS off", () => {
  it("reproduces today's papers-only order exactly and reads no signal tables", async () => {
    // Signals present that WOULD reorder if read.
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: { [TOPIC]: 0.9 } };
    vi.stubEnv("TOPIC_RANK_AREA_SIGNALS", "off");
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    vi.stubEnv("TOPIC_RANK_AREA_SIGNALS", "");
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(state.calls).toEqual({ grant: 0, trial: 0, text: 0 });
  });

  it("matches the flag-on order when no scholar has a signal (ties included)", async () => {
    state.ptRows = [pt("t1", 1, 1.0), pt("t2", 2, 1.0), pt("t3", 3, 1.0), pt("t4", 4, 0.5)];
    const on = await order();
    vi.stubEnv("TOPIC_RANK_AREA_SIGNALS", "off");
    expect(await order()).toEqual(on);
  });
});

describe("TOPIC_RANK_AREA_SIGNALS on", () => {
  it("lifts a scholar with PI grants and trials in the area", async () => {
    state.grants = [grant("s4", "kA")];
    state.trials = [trial("s3", "kT")];
    state.scores = { kA: { [TOPIC]: 0.6 }, kT: { [TOPIC]: 0.25 } };
    // s3: 1.8 + 0.25*2 = 2.3; s4: 1.0 + 0.6*2 = 2.2; then s1 2.0, s2 1.9
    expect(await order()).toEqual(["s3", "s4", "s1", "s2"]);
  });

  it("never adds a scholar who has no papers in the area", async () => {
    state.grants = [grant("nopapers", "kA"), grant("nopapers", "kB")];
    state.trials = [trial("nopapers", "kT")];
    state.scores = { kA: { [TOPIC]: 1 }, kB: { [TOPIC]: 1 }, kT: { [TOPIC]: 1 } };
    const result = await order();
    expect(result).not.toContain("nopapers");
    expect(result).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("counts only this area's scores", async () => {
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: { other_area: 0.9 } };
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("caps grants at three projects per scholar-area", async () => {
    state.grants = [1, 2, 3, 4, 5].map((i) => grant("s4", `k${i}`));
    state.scores = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`k${i}`, { [TOPIC]: 0.25 }]));
    // s4: 1.0 + 3 * 0.25 * 2 = 2.5 (five uncapped would be 3.5)
    state.ptRows.push(pt("s5", 6, 2.6), pt("s6", 7, 2.4));
    expect((await order()).slice(0, 3)).toEqual(["s5", "s4", "s6"]);
  });

  it("collapses renewal rows of one project into one", async () => {
    state.grants = [
      grant("s4", "kA", { title: "Same project", startDate: new Date("2024-01-01T00:00:00Z") }),
      grant("s4", "kB", { title: "Same project", startDate: new Date("2025-01-01T00:00:00Z") }),
    ];
    state.scores = { kA: { [TOPIC]: 0.3 }, kB: { [TOPIC]: 0.5 } };
    // One project: best score 0.5 -> 1.0 + 1.0 = 2.0, ties s1 (2.0) but s1 was seen first.
    state.ptRows.push(pt("s7", 8, 2.1), pt("s8", 9, 1.95));
    expect(await order()).toEqual(["s7", "s1", "s4", "s8", "s2", "s3"]);
  });

  it("drops suppressed grants", async () => {
    const g = grant("s4", "kA");
    state.grants = [g];
    state.suppressedGrantIds = [g.externalId];
    state.scores = { kA: { [TOPIC]: 0.9 } };
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("respects hideFunding and hideClinicalTrials", async () => {
    state.grants = [grant("s4", "kA")];
    state.trials = [trial("s3", "kT")];
    state.scores = { kA: { [TOPIC]: 0.9 }, kT: { [TOPIC]: 0.9 } };
    state.overrides = [
      { entityId: "s4", fieldName: "hideFunding" },
      { entityId: "s3", fieldName: "hideClinicalTrials" },
    ];
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    // A hidden Funding section does not hide trials.
    state.overrides = [{ entityId: "s3", fieldName: "hideFunding" }];
    expect((await order())[0]).toBe("s3");
  });

  it("drops trials in a hidden status and ineligible grants", async () => {
    state.trials = [trial("s4", "kT", { status: "Withdrawn" })];
    state.grants = [
      grant("s3", "kA", { mechanism: "T32" }),
      grant("s3", "kB", { source: "RePORTER" }),
      grant("s3", "kC", { role: "Co-I" }),
      grant("s3", "kD", { title: "Annual Meeting on Examples" }),
    ];
    state.scores = Object.fromEntries(["kT", "kA", "kB", "kC", "kD"].map((k) => [k, { [TOPIC]: 0.9 }]));
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("counts one trial per NCT per scholar", async () => {
    state.trials = [trial("s4", "kT", { nctNumber: "NCT1" }), trial("s4", "kT", { nctNumber: "NCT1" })];
    state.scores = { kT: { [TOPIC]: 0.25 } };
    // 1.0 + 0.5 = 1.5 (two would be 2.0 and pass s1)
    state.ptRows.push(pt("s9", 10, 1.6), pt("s10", 11, 1.4));
    const r = await order();
    expect(r.indexOf("s9")).toBeLessThan(r.indexOf("s4"));
    expect(r.indexOf("s4")).toBeLessThan(r.indexOf("s10"));
  });

  it("skips grants (not trials) in the six excluded areas", async () => {
    const excluded = "biomedical_informatics";
    state.ptRows = state.ptRows.map((r) => ({ ...(r as object), parentTopicId: excluded }));
    state.grants = [grant("s4", "kA")];
    state.trials = [trial("s3", "kT")];
    state.scores = { kA: { [excluded]: 0.9 }, kT: { [excluded]: 0.9 } };
    expect(await order(excluded)).toEqual(["s3", "s1", "s2", "s4"]);
    expect(state.calls.grant).toBe(0);
  });

  it("falls back to the papers-only order when the signal read fails", async () => {
    state.grants = [grant("s4", "kA")];
    state.scores = { kA: { [TOPIC]: 0.9 } };
    state.failTexts = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await order()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("area_signal_points_failed"))).toBe(true);
    warn.mockRestore();
  });
});
