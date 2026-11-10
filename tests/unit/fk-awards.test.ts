import { describe, expect, it } from "vitest";

import {
  awardCore,
  computeFkAwards,
  fkAwardsQuery,
  parseFkAwardsParams,
  type FkGrantRow,
} from "@/lib/edit/fk-awards";

const NOW = new Date("2026-11-10T12:00:00Z");
const params = (q = "") => parseFkAwardsParams(new URLSearchParams(q), NOW);

const g = (o: Partial<FkGrantRow> & { cwid: string; awardNumber: string }): FkGrantRow => ({
  role: "PI",
  mechanism: o.awardNumber.replace(/\s+/g, "").slice(1, 4),
  externalId: `INFOED-${o.cwid}-${o.awardNumber}`,
  title: "T",
  startDate: "2025-07-01",
  endDate: "2027-06-30",
  ...o,
});

const base = {
  memberships: [
    { cwid: "MEM1", programCode: "CB", startDate: null, endDate: null },
    { cwid: "mem2", programCode: null, startDate: "2020-01-01", endDate: "2025-12-31" }, // ended
  ],
  people: [
    { cwid: "mem1", name: "Member One", roleCategory: "full_time_faculty" },
    { cwid: "stu", name: "Student", roleCategory: "doctoral_student" },
    { cwid: "fac", name: "Junior Faculty", roleCategory: "full_time_faculty" },
  ],
  programs: [{ code: "CB", label: "Cancer Biology" }],
};

describe("awardCore", () => {
  it("strips the type prefix and year suffix", () => {
    expect(awardCore("5 F31 CA123456-02")).toBe("F31CA123456");
    expect(awardCore("1 K08 CA123456-01A1")).toBe("K08CA123456");
    expect(awardCore("R01 CA1")).toBeNull();
  });
});

describe("parseFkAwardsParams", () => {
  it("defaults to this year, today, everyone", () => {
    expect(params()).toEqual({ from: 2026, to: 2026, asOf: "2026-11-10", labOnly: false });
  });
  it("round-trips, clamps to >= from, rejects rolled-over dates", () => {
    const p = params("from=2022&to=2020&asOf=2025-02-31&labOnly=1");
    expect(p).toEqual({ from: 2022, to: 2022, asOf: "2026-11-10", labOnly: true });
    expect(params(fkAwardsQuery(p))).toEqual(p);
  });
});

describe("computeFkAwards", () => {
  it("classifies member, trainee, key personnel, no mentor; drops non-member mentees", () => {
    const r = computeFkAwards({
      ...base,
      grants: [
        g({ cwid: "mem1", awardNumber: "1 K08 CA000001-01" }),
        // two yearly rows of one trainee award collapse into one
        g({ cwid: "stu", awardNumber: "1 F31 CA000002-01", endDate: "2026-06-30" }),
        g({
          cwid: "stu",
          awardNumber: "5 F31 CA000002-02",
          startDate: "2026-07-01",
          endDate: "2028-06-30",
        }),
        // mentor is key personnel only
        g({ cwid: "kp1", awardNumber: "1 K99 CA000003-01" }),
        g({ cwid: "MEM1", awardNumber: "1 K99 CA000003-01", role: "Key Personnel" }),
        // no mentor rows anywhere
        g({ cwid: "lone", awardNumber: "1 K23 CA000004-01" }),
        // mentored by an ended member only: not the center's
        g({ cwid: "other", awardNumber: "1 F32 CA000005-01" }),
        // out of the window
        g({
          cwid: "old",
          awardNumber: "1 K01 CA000006-01",
          startDate: "2015-01-01",
          endDate: "2019-12-31",
        }),
        // not F/K
        g({ cwid: "mem1", awardNumber: "1 R01 CA000007-01", mechanism: "R01" }),
      ],
      links: [
        { mentorCwid: "mem1", menteeCwid: "STU", source: "PhD" },
        { mentorCwid: "mem1", menteeCwid: "stu", source: "FRT" },
        { mentorCwid: "mem2", menteeCwid: "other", source: "postdoc" },
      ],
      params: params(),
    });
    expect(r.awards.map((a) => [a.category, a.holderCwid, a.mechanism])).toEqual([
      ["member", "mem1", "K08"],
      ["trainee", "stu", "F31"],
      ["key_personnel", "kp1", "K99"],
      ["no_mentor", "lone", "K23"],
    ]);
    const stu = r.awards[1];
    expect(stu).toMatchObject({
      start: "2025-07-01",
      end: "2028-06-30",
      awardNumber: "5 F31 CA000002-02",
    });
    expect(stu.mentors).toEqual([
      { cwid: "mem1", name: "Member One", program: "Cancer Biology", sources: ["PhD", "FRT"] },
    ]);
    expect(r.awards[0].program).toBe("Cancer Biology");
    expect(r.notCenter).toBe(1);
    expect(r.counts.trainee).toEqual({ F: 1, K: 0 });
    expect(r.counts.member).toEqual({ F: 0, K: 1 });
  });

  it("marks faculty linked only by FRT, and labOnly drops them", () => {
    const input = {
      ...base,
      grants: [g({ cwid: "fac", awardNumber: "1 K23 CA000008-01" })],
      links: [{ mentorCwid: "mem1", menteeCwid: "fac", source: "FRT" as const }],
    };
    expect(computeFkAwards({ ...input, params: params() }).awards[0].careerMentorOnly).toBe(true);
    const lab = computeFkAwards({ ...input, params: params("labOnly=1") });
    expect(lab.awards).toEqual([]);
    expect(lab.careerMentorOnlyHidden).toBe(1);
  });
});
