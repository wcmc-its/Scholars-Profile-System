import { describe, expect, it } from "vitest";

import { insertFor, refuseReason } from "@/etl/scholar-active-export/index";

describe("scholar-active-export shrink guard", () => {
  it("refuses an empty set, even with --force", () => {
    expect(refuseReason(0, 0, false)).toMatch(/0 active/);
    expect(refuseReason(0, 100, true)).toMatch(/0 active/);
  });
  it("refuses a shrink past 10% unless forced; a first run or growth is fine", () => {
    expect(refuseReason(89, 100, false)).toMatch(/shrank/);
    expect(refuseReason(89, 100, true)).toBeNull();
    expect(refuseReason(90, 100, false)).toBeNull();
    expect(refuseReason(500, 0, false)).toBeNull();
    expect(refuseReason(120, 100, false)).toBeNull();
  });
});

describe("scholar-active-export insert", () => {
  const now = new Date(0);
  const confirmed = {
    cwid: "abc1234",
    hasConfirmedOrcid: true,
    orcid: "0000-0002-1825-0097",
    campus: "wcm",
  };
  it("writes the iD and campus once reciterdb has the v3.16 columns", () => {
    const { sql, values } = insertFor(true);
    expect(sql).toContain("(cwid, has_confirmed_orcid, orcid, campus, refreshed_at)");
    expect(values(confirmed, now)).toEqual(["abc1234", 1, "0000-0002-1825-0097", "wcm", now]);
    expect(values({ ...confirmed, hasConfirmedOrcid: false, orcid: null }, now)[2]).toBeNull();
  });
  it("writes the v3.1 columns when they are absent", () => {
    const { sql, values } = insertFor(false);
    expect(sql).toContain("(cwid, has_confirmed_orcid, refreshed_at)");
    expect(values(confirmed, now)).toEqual(["abc1234", 1, now]);
  });
});
