/**
 * Report 12 (Output over time) — the pure pieces of
 * `lib/edit/core-output-report.ts`: the evidence precedence (`evidenceBucket`:
 * Manually added > Acknowledgment > Core-staff co-author > Other signals, a
 * JSON-null / empty co-author list is NOT a co-author signal), and the
 * per-year roll-up (`buildCoreOutput`: each paper once, the basis, the
 * evidence filter, zero-filled years, papers with no year on the basis).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import {
  buildCoreOutput,
  coreOutputQuery,
  evidenceBucket,
  parseCoreOutputParams,
  type CoreOutputPub,
} from "@/lib/edit/core-output-report";

describe("evidenceBucket — one bucket per paper, in precedence order", () => {
  it("no publication_core row (an active claim alone) is Manually added", () => {
    expect(evidenceBucket(null)).toBe("manual");
  });
  it("acknowledgment beats a co-author list", () => {
    expect(evidenceBucket({ signalAck: true, signalCoauthors: ["abc1234"] })).toBe("ack");
  });
  it("a real non-empty array is a core-staff co-author", () => {
    expect(evidenceBucket({ signalAck: false, signalCoauthors: ["abc1234"] })).toBe("coauthor");
    expect(evidenceBucket({ signalAck: false, signalCoauthors: [{ cwid: "abc1234" }] })).toBe(
      "coauthor",
    );
  });
  it.each([
    ["JSON null / SQL NULL", null],
    ["empty array", []],
    ["an object", { cwid: "abc1234" }],
    ["a string", "abc1234"],
  ])("%s is Other signals, not a co-author", (_label, v) => {
    expect(evidenceBucket({ signalAck: false, signalCoauthors: v })).toBe("other");
  });
});

function pub(pmid: string, year: number | null, over: Partial<CoreOutputPub> = {}): CoreOutputPub {
  return {
    pmid,
    title: `T${pmid}`,
    journal: "J",
    year,
    dateAdded: null,
    evidence: "other",
    ...over,
  };
}

const NOW = new Date("2026-09-28T12:00:00Z");

describe("parseCoreOutputParams", () => {
  it("defaults to the last nine calendar years, every evidence group", () => {
    expect(parseCoreOutputParams(new URLSearchParams(), NOW)).toEqual({
      basis: "cy",
      from: 2018,
      to: 2026,
      evid: ["ack", "coauthor", "other", "manual"],
      view: "year",
    });
  });
  it("no fiscal basis: an unknown basis falls back to calendar", () => {
    expect(parseCoreOutputParams(new URLSearchParams("basis=fy"), NOW).basis).toBe("cy");
    expect(parseCoreOutputParams(new URLSearchParams("basis=added"), NOW).basis).toBe("added");
  });
  it("round-trips its query", () => {
    const p = parseCoreOutputParams(
      new URLSearchParams("basis=added&from=2020&to=2022&evid=manual&evid=ack"),
      NOW,
    );
    expect(parseCoreOutputParams(coreOutputQuery(p), NOW)).toEqual(p);
  });
});

describe("buildCoreOutput", () => {
  const p = parseCoreOutputParams(new URLSearchParams("from=2020&to=2022"), NOW);

  it("counts each paper once, zero-fills the window, and splits by evidence", () => {
    const r = buildCoreOutput(
      [
        pub("1", 2020, { evidence: "ack" }),
        pub("1", 2020, { evidence: "ack" }),
        pub("2", 2022, { evidence: "manual" }),
        pub("3", 2022, { evidence: "coauthor" }),
        pub("4", 2019),
      ],
      p,
    );
    expect(r.years.map((y) => [y.year, y.total])).toEqual([
      [2020, 1],
      [2021, 0],
      [2022, 2],
    ]);
    expect(r.years[2].byEvidence).toEqual({ manual: 1, ack: 0, coauthor: 1, other: 0 });
    expect(r.total).toBe(3);
    expect(r.publications.map((x) => x.pmid)).toEqual(["3", "2", "1"]);
  });

  it("the evidence filter narrows the chart; the rail counts still cover every group", () => {
    const r = buildCoreOutput(
      [pub("1", 2020, { evidence: "ack" }), pub("2", 2020, { evidence: "other" })],
      {
        ...p,
        evid: ["ack"],
      },
    );
    expect(r.total).toBe(1);
    expect(r.evidenceCounts).toEqual({ manual: 0, ack: 1, coauthor: 0, other: 1 });
  });

  it("date-added basis reads the PubMed add date; a paper without one is undated, not charted", () => {
    const r = buildCoreOutput(
      [pub("1", 2019, { dateAdded: "2021-01-05" }), pub("2", 2021, { dateAdded: null })],
      { ...p, basis: "added" },
    );
    expect(r.years.find((y) => y.year === 2021)?.total).toBe(1);
    expect(r.undated).toBe(1);
    expect(r.total).toBe(1);
  });
});
