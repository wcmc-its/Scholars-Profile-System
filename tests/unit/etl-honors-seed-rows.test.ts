import { describe, expect, it } from "vitest";
import { parseSeedRows, statusOnUpdate } from "@/etl/honors/seed-rows";

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
