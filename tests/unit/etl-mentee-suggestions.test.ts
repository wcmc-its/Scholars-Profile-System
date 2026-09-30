/**
 * #2634 — mentee_suggestion builder: the pure ranking rule and the write
 * guards. `buildMenteeSuggestions` itself needs live ReCiterDB; the module's
 * entrypoint is `import.meta.url`-guarded, so importing it here runs nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { EtlGuardError } from "@/lib/etl-guard";
import {
  rankPairs,
  writeSuggestions,
  type PairStats,
  type SuggestionRow,
} from "@/etl/reciter/mentee-suggestions";

const pair = (
  menteeCwid: string,
  mentorCwid: string,
  nMentorLastAuthor: number,
  nCoPubs = nMentorLastAuthor,
): PairStats => ({
  menteeCwid,
  mentorCwid,
  nCoPubs,
  nMentorLastAuthor,
  nMenteeFirstAuthor: 0,
  firstYear: 2020,
  lastYear: 2024,
});

describe("rankPairs", () => {
  it("flags only the top mentor, and only with >=2 last-author pubs at >=2x the runner-up", () => {
    const { rows } = rankPairs([
      pair("stu1", "prof_a", 4),
      pair("stu1", "prof_b", 2),
      pair("stu2", "prof_a", 1, 6), // 1 last-author pub is never strong, whatever the co-pub count
      pair("stu3", "prof_c", 2), // no runner-up: 2 >= 2 * 0
    ]);
    const strong = rows.filter((r) => r.strong).map((r) => `${r.mentorCwid}:${r.menteeCwid}`);
    expect(strong.sort()).toEqual(["prof_a:stu1", "prof_c:stu3"]);
  });

  it("a runner-up tie (or anything above half the top) blocks the strong flag", () => {
    const { rows } = rankPairs([pair("stu1", "prof_a", 3), pair("stu1", "prof_b", 2)]);
    expect(rows.every((r) => !r.strong)).toBe(true);
    // the top mentor is still ordered first by (nLast desc, nCoPubs desc)
    const tied = rankPairs([pair("stu2", "prof_x", 2, 2), pair("stu2", "prof_y", 2, 5)]).rows;
    expect(tied.map((r) => r.strong)).toEqual([false, false]);
    expect(tied.find((r) => r.mentorCwid === "prof_y")).toBeDefined();
  });

  it("caps each mentor's list, strong rows first, and counts the drop", () => {
    const pairs: PairStats[] = [
      pair("stu0", "prof_a", 5),
      pair("stu0", "prof_b", 5), // tie: strong with neither, but prof_a's highest nLast
      pair("stu1", "prof_a", 1, 1),
      pair("stu2", "prof_a", 1, 2),
      pair("stu3", "prof_a", 1, 3),
      pair("stu4", "prof_a", 2), // strong (sole mentor) with fewer last-author pubs than stu0
    ];
    const { rows, droppedByCap } = rankPairs(pairs, 3);
    const profA = rows.filter((r) => r.mentorCwid === "prof_a");
    expect(profA.map((r) => r.menteeCwid)).toEqual(["stu4", "stu0", "stu3"]);
    expect(profA[0].strong).toBe(true);
    expect(droppedByCap).toBe(2);
    expect(rows.filter((r) => r.mentorCwid === "prof_b")).toHaveLength(1);
  });
});

describe("writeSuggestions guards", () => {
  const row = (mentorCwid: string, menteeCwid: string): SuggestionRow => ({
    mentorCwid,
    menteeCwid,
    menteeName: "Test Person",
    menteeTitle: null,
    menteeUnit: null,
    kind: "postdoc",
    tier: "presumptive",
    nCoPubs: 2,
    nMentorLastAuthor: 2,
    nMenteeFirstAuthor: 1,
    firstYear: 2020,
    lastYear: 2024,
    menteeFirstPublishedYear: 2019,
    strong: true,
    evidence: [],
    computedAt: new Date("2026-09-14T00:00:00Z"),
  });
  const fakeDb = (existing: Array<{ id: number; mentorCwid: string; menteeCwid: string }>) => {
    const menteeSuggestion = {
      findMany: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    return { menteeSuggestion };
  };
  type Client = Parameters<typeof writeSuggestions>[1];

  it("an empty fresh set throws before touching the table", async () => {
    const db = fakeDb([{ id: 1, mentorCwid: "prof_a", menteeCwid: "stu1" }]);
    await expect(writeSuggestions([], db as unknown as Client)).rejects.toThrow(
      /fresh set is empty/,
    );
    expect(db.menteeSuggestion.findMany).not.toHaveBeenCalled();
    expect(db.menteeSuggestion.deleteMany).not.toHaveBeenCalled();
  });

  it("a prune over 20% of existing rows throws before any upsert or delete", async () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      mentorCwid: "prof_a",
      menteeCwid: `stu${i}`,
    }));
    const db = fakeDb(existing);
    const fresh = [row("prof_a", "stu0"), row("prof_a", "stu1"), row("prof_a", "stu2")];
    await expect(writeSuggestions(fresh, db as unknown as Client)).rejects.toThrow(EtlGuardError);
    expect(db.menteeSuggestion.upsert).not.toHaveBeenCalled();
    expect(db.menteeSuggestion.deleteMany).not.toHaveBeenCalled();
  });

  it("upserts without a dismissed_* key in the update branch and prunes only the stale pair", async () => {
    const db = fakeDb([
      { id: 1, mentorCwid: "prof_a", menteeCwid: "stu1" },
      { id: 2, mentorCwid: "prof_a", menteeCwid: "gone" },
      { id: 3, mentorCwid: "prof_a", menteeCwid: "stu2" },
      { id: 4, mentorCwid: "prof_a", menteeCwid: "stu3" },
      { id: 5, mentorCwid: "prof_a", menteeCwid: "stu4" },
    ]);
    const fresh = ["stu1", "stu2", "stu3", "stu4", "new"].map((m) => row("prof_a", m));
    const out = await writeSuggestions(fresh, db as unknown as Client);
    expect(out).toEqual({ upserted: 5, pruned: 1 });
    const update = db.menteeSuggestion.upsert.mock.calls[0][0].update;
    // Each key individually — arrayContaining(all three) only failed when ALL
    // three leaked, so a single leaked key kept the suite green.
    for (const k of ["dismissedAt", "dismissedBy", "dismissReason"]) {
      expect(update).not.toHaveProperty(k);
    }
    expect(db.menteeSuggestion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [2] } } });
  });
});
