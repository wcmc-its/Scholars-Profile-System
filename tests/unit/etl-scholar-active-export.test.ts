import { describe, expect, it } from "vitest";

import { refuseReason } from "@/etl/scholar-active-export/index";

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
