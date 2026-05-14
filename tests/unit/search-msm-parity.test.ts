/**
 * Issue #259 — msm parity between the people-tab and pub-tab queries.
 *
 * `PEOPLE_RESTRUCTURED_MSM` (§1.1) and `PUBLICATIONS_RESTRUCTURED_MSM`
 * (§1.2) are defined as separate constants so the two surfaces can
 * diverge later if abstract noise on one or the other forces a tune.
 * Today they're the same value; this test locks that fact so a future
 * divergence is intentional and loud.
 *
 * No module-level mocks here — we want the real values from lib/search.ts.
 */
import { describe, expect, it } from "vitest";
import {
  PEOPLE_RESTRUCTURED_MSM,
  PUBLICATIONS_RESTRUCTURED_MSM,
} from "@/lib/search";

describe("PEOPLE_RESTRUCTURED_MSM / PUBLICATIONS_RESTRUCTURED_MSM parity", () => {
  it("both msm strings are identical today; intentional divergence requires updating this test", () => {
    expect(PUBLICATIONS_RESTRUCTURED_MSM).toBe(PEOPLE_RESTRUCTURED_MSM);
  });

  it('both equal the spec value "2<-34%"', () => {
    expect(PEOPLE_RESTRUCTURED_MSM).toBe("2<-34%");
    expect(PUBLICATIONS_RESTRUCTURED_MSM).toBe("2<-34%");
  });
});
