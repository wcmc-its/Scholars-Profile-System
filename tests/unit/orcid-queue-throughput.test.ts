/**
 * ORCID queue throughput helpers (pure): the Weak split, the tier label, and
 * the bulk-confirm rule's fixed and adjustable parts.
 */
import { describe, expect, it } from "vitest";

import {
  bulkBlocker,
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

  it("never takes two candidates, a competitor, a differing name, an iD on file, or an earlier decision", () => {
    const r = ORCID_BULK_RULE_DEFAULT;
    expect(bulkEligible(summary({ candidates: [cand(), cand({ orcid: "x" })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ competitor: true })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ nameAgrees: false })] }), r)).toBe(false);
    expect(bulkEligible(summary({ candidates: [cand({ band: "moderate" })] }), r)).toBe(false);
    expect(bulkEligible(summary({ conflict: true }), r)).toBe(false);
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

describe("bulkEligible: Cornell Ithaca", () => {
  it("takes a Strong Ithaca pair without the work/source thresholds; still refuses Moderate and a competitor", () => {
    const r = ORCID_BULK_RULE_DEFAULT;
    const ith = (c: Parameters<typeof cand>[0] = {}) =>
      summary({
        campus: "ithaca",
        candidates: [cand({ shared: 0, worksTotal: 12, sources: ["cornell_affiliation_manager"], ...c })],
      });
    expect(bulkEligible(ith(), r)).toBe(true);
    expect(bulkEligible(ith({ band: "moderate" }), r)).toBe(false);
    expect(bulkEligible(ith({ competitor: true }), r)).toBe(false);
    expect(bulkEligible(ith({ nameAgrees: false }), r)).toBe(false);
  });
  it("takes an email-verified Ithaca pair without Affiliation Manager; never a WCM one", () => {
    const r = ORCID_BULK_RULE_DEFAULT;
    const one = (campus: "ithaca" | "wcm") =>
      summary({
        campus,
        candidates: [cand({ band: "email_verified", shared: 0, worksTotal: 3, sources: [] })],
      });
    expect(bulkEligible(one("ithaca"), r)).toBe(true);
    expect(bulkEligible(one("wcm"), r)).toBe(false);
  });

  it("takes a Strong pair from Affiliation Manager or a faculty web page; refuses any other source", () => {
    const r = ORCID_BULK_RULE_DEFAULT;
    const ith = (sources: OrcidQueueSummary["candidates"][number]["sources"]) =>
      summary({ campus: "ithaca", candidates: [cand({ shared: 0, worksTotal: 12, sources })] });
    expect(bulkEligible(ith(["web_page_seed"]), r)).toBe(true);
    expect(bulkBlocker(ith(["identity"]), r)).toBe("ithaca_source");
    expect(bulkBlocker(ith([]), r)).toBe("ithaca_source");
    expect(bulkEligible(ith(["web_page_seed", "cornell_affiliation_manager"]), r)).toBe(true);
  });
});

describe("bulkBlocker", () => {
  it.each([
    ["band", { candidates: [cand({ band: "moderate" })] }],
    ["band", { candidates: [cand({ band: "email_verified" })] }],
    ["multiple", { candidates: [cand(), cand({ orcid: "x" })] }],
    ["on_file", { conflict: true }],
    ["decided", { decisions: { byScholar: true, byStaff: false, librarian: false, at: null } }],
    ["decided", { candidates: [] }],
    ["competitor", { candidates: [cand({ competitor: true })] }],
    ["name", { candidates: [cand({ nameAgrees: false })] }],
    ["threshold", { candidates: [cand({ shared: 4 })] }],
    [null, {}],
  ] as Array<[string | null, Partial<OrcidQueueSummary>]>)("%s", (want, over) => {
    expect(bulkBlocker(summary(over), ORCID_BULK_RULE_DEFAULT)).toBe(want);
  });
});
