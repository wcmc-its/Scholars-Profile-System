import { describe, expect, it } from "vitest";
import { countMergingRows, parseSeedRows, statusOnUpdate } from "@/etl/honors/seed-rows";

// Synthetic rows only — the real seed file pairs named faculty with honors and
// never enters the repo (#1761 "Data handling").
const good = {
  cwid: "zzz9999",
  name: "Member",
  organization: "Synthetic Academy of Testing",
  year: 2001,
  category: "ACADEMY_MEMBERSHIP",
  status: "pending",
  showOnProfile: true,
  source: "TEST_SEED",
  sourceRef: "test|Synthetic Person|2001",
  enteredByCwid: "zzz0001",
};

describe("parseSeedRows", () => {
  it("accepts a valid row and defaults", () => {
    const { rows, errors } = parseSeedRows([
      good,
      { ...good, year: null, sourceRef: undefined, showOnProfile: undefined },
    ]);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ year: null, sourceRef: null, showOnProfile: true });
  });

  it("rejects bad category / status / year / missing cwid, keeps the good row", () => {
    const { rows, errors } = parseSeedRows([
      { ...good, category: "NAMED_CHAIR" },
      { ...good, status: "approved" },
      { ...good, year: 2001.5 },
      { ...good, cwid: " " },
      good,
    ]);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("row 0");
  });

  it("rejects a non-array payload", () => {
    expect(parseSeedRows({}).errors).toEqual(["seed file is not a JSON array"]);
  });
});

describe("countMergingRows — same-key input rows merge silently (#2010)", () => {
  const { rows } = parseSeedRows([
    good, // key A
    { ...good, year: 2004 }, // key A again — a "year correction" row, merges
    { ...good, year: 2007 }, // key A a third time — merges too
    { ...good, cwid: "zzz8888" }, // key B
    { ...good, organization: "Synthetic Society of Testing" }, // key C
    { ...good, name: "Fellow" }, // key D
  ]);

  it("counts occurrences-1 per duplicated key, not the key or the occurrences", () => {
    expect(rows).toHaveLength(6);
    // 3 rows share key A => 2 merges. Not 1 (keys affected), not 3 (occurrences).
    expect(countMergingRows(rows)).toBe(2);
    expect(rows.length - countMergingRows(rows)).toBe(4); // distinct keys written
  });

  it("is silent when every row has a distinct key", () => {
    expect(countMergingRows(rows.slice(2))).toBe(0);
    expect(countMergingRows([])).toBe(0);
  });

  // `honor` is utf8mb4_unicode_ci, so the upsert's WHERE already treats these as
  // the same row. A byte-exact key would report 0 here while the DB merged them.
  it("folds case and accents, matching the utf8mb4_unicode_ci upsert", () => {
    const { rows: variants } = parseSeedRows([
      { ...good, organization: "Sociéte Synthétique" },
      { ...good, organization: "SOCIETE SYNTHETIQUE" }, // accent + case fold => merges into row 0
      good,
      { ...good, name: "MEMBER" }, // case fold on name => merges into row 2
    ]);
    expect(variants).toHaveLength(4);
    expect(countMergingRows(variants)).toBe(2);
  });
});

describe("statusOnUpdate — a re-run never overwrites a curator decision", () => {
  it("pending accepts the incoming status", () => {
    expect(statusOnUpdate("pending", "published")).toBe("published");
    expect(statusOnUpdate("pending", "rejected")).toBe("rejected");
  });
  it("published and rejected are kept regardless of the file", () => {
    expect(statusOnUpdate("published", "pending")).toBe("published");
    expect(statusOnUpdate("rejected", "pending")).toBe("rejected");
    expect(statusOnUpdate("rejected", "published")).toBe("rejected");
  });
});
