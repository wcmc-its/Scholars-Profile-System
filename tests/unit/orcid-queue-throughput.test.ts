/**
 * ORCID queue throughput helpers (pure): the Weak split, the tier label, and
 * the bulk-confirm rule's fixed and adjustable parts.
 */
import { describe, expect, it } from "vitest";

import {
  bulkEligible,
  ORCID_BULK_RULE_DEFAULT,
  onlyOnOrcid,
  tierLabel,
  weakKind,
  type OrcidQueueSummary,
} from "@/lib/edit/orcid-queue";

const cand = (over: Partial<OrcidQueueSummary["candidates"][number]> = {}) => ({
  orcid: "0000-0002-1825-0097",
  band: "strong" as const,
  shared: 8,
  worksTotal: 8,
  newWorks: 0,
  nameAgrees: true,
  competitor: false,
  sources: ["orcid_works", "rpm_inferred"] as OrcidQueueSummary["candidates"][number]["sources"],
  ...over,
});
const summary = (over: Partial<OrcidQueueSummary> = {}): OrcidQueueSummary => ({
  cwid: "jd0001",
  name: "Jane Doe",
  surname: "doe",
  department: null,
  candidates: [cand()],
  conflict: false,
  autoConfirmed: false,
  firstQueuedAt: null,
  lastQueuedAt: null,
  decisions: null,
  ...over,
});

describe("weakKind / tierLabel", () => {
  it("splits Weak into thin (nothing against it) and conflicting (a competitor or a name that differs)", () => {
    expect(weakKind({ band: "weak", competitor: false, nameAgrees: true })).toBe("thin");
    expect(weakKind({ band: "weak", competitor: true, nameAgrees: true })).toBe("conflicting");
    expect(weakKind({ band: "weak", competitor: false, nameAgrees: false })).toBe("conflicting");
    expect(weakKind({ band: "strong", competitor: false, nameAgrees: false })).toBeNull();
    expect(tierLabel({ band: "weak", competitor: false, nameAgrees: true })).toBe("Thin evidence");
    expect(tierLabel({ band: "moderate", competitor: false, nameAgrees: true })).toBe("Moderate");
  });
});

describe("bulkEligible", () => {
  it("takes a clean Strong match under the default rule", () => {
    expect(bulkEligible(summary(), ORCID_BULK_RULE_DEFAULT)).toBe(true);
  });

  it("never takes two candidates, a competitor, a differing name, an iD on file, Ithaca, or an earlier decision", () => {
    const r = ORCID_BULK_RULE_DEFAULT;
    expect(bulkEligible(summary({ candidates: [cand(), cand({ orcid: "x" })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ competitor: true })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ nameAgrees: false })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ band: "moderate" })] }), r)).toBe(false);
    expect(bulkEligible(summary({ conflict: true }), r)).toBe(false);
    expect(bulkEligible(summary({ campus: "ithaca" }), r)).toBe(false);
    expect(
      bulkEligible(
        summary({ decisions: { byScholar: true, byStaff: false, librarian: false, at: null } }),
        r,
      ),
    ).toBe(false);
  });

  it("applies the adjustable thresholds", () => {
    const s = summary({ candidates: [cand({ shared: 4, worksTotal: 6, newWorks: 2 })] });
    expect(bulkEligible(s, { minShared: 5, maxOnlyOrcid: 2, minSources: 2 })).toBe(false);
    expect(bulkEligible(s, { minShared: 4, maxOnlyOrcid: 1, minSources: 2 })).toBe(false);
    expect(bulkEligible(s, { minShared: 4, maxOnlyOrcid: 2, minSources: 3 })).toBe(false);
    expect(bulkEligible(s, { minShared: 4, maxOnlyOrcid: 2, minSources: 2 })).toBe(true);
  });

  it("counts works only on ORCID from new_works, else from the totals", () => {
    expect(onlyOnOrcid({ newWorks: 1, worksTotal: 10, shared: 5 })).toBe(1);
    expect(onlyOnOrcid({ worksTotal: 10, shared: 7 })).toBe(3);
  });
});
