import { afterEach, describe, expect, it, vi } from "vitest";

import { accessSummary, LEADER_UNIT_AUDIENCE, UNIT_AUDIENCE } from "@/lib/edit/report-access-summary";
import { unitReportAccess } from "@/lib/edit/unit-leader-access";

describe("unitReportAccess", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names leaders while LEADER_REPORT_ACCESS is on", () => {
    vi.stubEnv("LEADER_REPORT_ACCESS", "on");
    expect(accessSummary(unitReportAccess()).text).toBe(LEADER_UNIT_AUDIENCE);
  });

  it("keeps the Owner/Curator default while the flag is off", () => {
    vi.stubEnv("LEADER_REPORT_ACCESS", "off");
    expect(unitReportAccess()).toEqual({ mode: "unit" });
    expect(accessSummary(unitReportAccess()).text).toBe(UNIT_AUDIENCE);
  });
});
