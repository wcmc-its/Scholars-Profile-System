import { describe, expect, it } from "vitest";

import { groupMatchLevel, highlight, matchSignals, parseEvidence } from "@/lib/edit/honor-match";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";

function row(over: Partial<HonorQueueRow>): HonorQueueRow {
  return {
    id: "r1",
    cwid: "zzz1001",
    slug: null,
    scholarName: "Ada Example, MD",
    roleLabel: null,
    roleCategory: null,
    title: null,
    department: null,
    category: "PRIZE",
    name: "Grand Prize",
    organization: "Invented Society",
    year: 2024,
    tier: 5,
    tierOverridden: false,
    source: "NEWSROOM",
    sourceRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decidedByName: null,
    rejectionReason: null,
    superseded: false,
    competingCwids: [],
    evidence: null,
    ...over,
  };
}

describe("parseEvidence", () => {
  it("splits a quote, a nickname prefix, and a roster note", () => {
    expect(parseEvidence("Nickname match. “She won.”")).toEqual({
      quote: "She won.",
      note: null,
      nickname: true,
    });
    expect(parseEvidence("Name and institution match: listed at Weill Cornell")).toMatchObject({
      quote: null,
      nickname: false,
    });
    // The ETL's 255-char clip drops the closing quote; it is still a quote.
    expect(parseEvidence("“Dr. Example of Weill Cornell won…").quote).toBe(
      "Dr. Example of Weill Cornell won…",
    );
    expect(parseEvidence(null)).toEqual({ quote: null, note: null, nickname: false });
  });
});

describe("matchSignals", () => {
  it("strong when the quote names her, Weill Cornell, and the award", () => {
    const r = row({ evidence: "“Dr. Ada Example of Weill Cornell Medicine won the Grand Prize.”" });
    expect(matchSignals(r, "Ada Example").level).toBe("strong");
  });

  it("likely with one miss, weak with two or more", () => {
    expect(
      matchSignals(row({ evidence: "“Dr. Example of Weill Cornell was honored.”" }), "Ada Example")
        .level,
    ).toBe("likely");
    expect(matchSignals(row({ evidence: "“A colleague was honored.”" }), "Ada Example").level).toBe(
      "weak",
    );
  });

  it("counts a nickname match and a differing listed name as misses", () => {
    const r = row({
      evidence: "Nickname match. “Dr. Example of Weill Cornell won the Grand Prize.”",
    });
    expect(matchSignals(r, "Ada Example").level).toBe("likely");
    expect(
      matchSignals(
        row({ evidence: "“Dr. Example of Weill Cornell won the Grand Prize.”" }),
        "Bo Example",
      ).level,
    ).toBe("likely");
  });

  it("grades a roster note on name and stated affiliation", () => {
    const note = "Name and institution match: listed at Weill Cornell Medicine";
    expect(matchSignals(row({ evidence: note }), "Ada Example").level).toBe("strong");
    expect(matchSignals(row({ evidence: "Listed with no institution" }), "Ada Example").level).toBe(
      "likely",
    );
  });
});

describe("groupMatchLevel", () => {
  it("is pick while contested", () => {
    const g: HonorQueueGroup = {
      key: "k",
      rows: [row({}), row({ id: "r2", cwid: "zzz2002" })],
      rosterMatchedName: "A. Example",
      contested: true,
    };
    expect(groupMatchLevel(g)).toBe("pick");
  });
});

describe("highlight", () => {
  it("marks whole words only, longest first on overlap", () => {
    const segs = highlight("Dr. Ada Example won; Examples abound.", [
      { t: "Example", k: "name" },
      { t: "Ada Example", k: "name" },
    ]);
    expect(segs.filter((s) => s.k).map((s) => s.t)).toEqual(["Ada Example"]);
    expect(segs.map((s) => s.t).join("")).toBe("Dr. Ada Example won; Examples abound.");
  });
});
