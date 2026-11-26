/**
 * ORCID queue throughput helpers (pure): the Weak split, the tier label, and
 * the bulk-confirm rule's fixed and adjustable parts.
 */
import { describe, expect, it } from "vitest";

import { matchesQueueView } from "@/components/edit/orcid-queue-filter-bar";
import { MIN_BYLINE_STRONG } from "@/etl/orcid-evidence/byline";
import {
  bulkBlocker,
  bulkEligible,
  bulkRoutes,
  ORCID_BULK_BLOCKER_LABEL,
  ORCID_BULK_MIN_BYLINE,
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
    expect(bulkEligible(s, { minShared: 5, maxOnlyOrcid: 2 })).toBe(false);
    expect(bulkEligible(s, { minShared: 4, maxOnlyOrcid: 1 })).toBe(false);
    expect(bulkEligible(s, { minShared: 4, maxOnlyOrcid: 2 })).toBe(true);
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
  it("is unchanged by the WCM controls: two iDs, a differing name and byline papers", () => {
    const loose = { ...ORCID_BULK_RULE_DEFAULT, allowMultiple: true, allowNameDiffers: true };
    const c = cand({ shared: 0, worksTotal: 12, sources: ["cornell_affiliation_manager"] });
    const ith = (over: Partial<OrcidQueueSummary>) => summary({ campus: "ithaca", ...over });
    expect(bulkBlocker(ith({ candidates: [c, cand({ orcid: "x" })] }), loose)).toBe("multiple");
    expect(bulkBlocker(ith({ candidates: [{ ...c, nameAgrees: false }] }), loose)).toBe("name");
    // No route applies: a byline-only setting still takes an Ithaca source pair,
    // and byline papers don't stand in for the source.
    expect(bulkBlocker(ith({ candidates: [c] }), { ...loose, passesBy: "byline" })).toBeNull();
    expect(
      bulkBlocker(ith({ candidates: [{ ...c, sources: ["identity"], bylinePapers: 5 }] }), loose),
    ).toBe("ithaca_source");
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

describe("bulkBlocker: the two routes through the WCM floor", () => {
  const ANY = { minShared: 0, maxOnlyOrcid: 10_000 };
  const one = (c: Parameters<typeof cand>[0]) => summary({ candidates: [cand(c)] });

  it("the byline threshold is the ETL's", () => {
    expect(ORCID_BULK_MIN_BYLINE).toBe(MIN_BYLINE_STRONG);
  });

  it("passes by the ORCID record (3+ shared works and an institution match) or by 2+ byline papers", () => {
    expect(bulkRoutes({ shared: 3, instMatch: true })).toEqual({ record: true, byline: false });
    expect(bulkRoutes({ shared: 2, instMatch: true, bylinePapers: 2 })).toEqual({
      record: false,
      byline: true,
    });
    // A summary built before instMatch was carried: the server floor decides.
    expect(bulkRoutes({ shared: 3 }).record).toBe(true);
    expect(bulkBlocker(one({ shared: 2, bylinePapers: 2 }), ANY)).toBeNull();
    expect(bulkBlocker(one({ shared: 9, instMatch: false, bylinePapers: 2 }), ANY)).toBeNull();
  });

  it("a scholar who fails both routes is reported with a reason that says so", () => {
    expect(bulkBlocker(one({ shared: 2, bylinePapers: 1 }), ANY)).toBe("shared");
    expect(bulkBlocker(one({ shared: 9, instMatch: false }), ANY)).toBe("institution");
    expect(ORCID_BULK_BLOCKER_LABEL.shared).toBe(
      "Fewer than 3 shared works and fewer than 2 uncontested byline papers",
    );
    expect(ORCID_BULK_BLOCKER_LABEL.institution).toContain("fewer than 2 uncontested byline");
  });

  it("Passes by narrows to one route; shared works at least narrows the record route only", () => {
    const both = one({ shared: 8, instMatch: true, bylinePapers: 3 });
    const record = one({ shared: 8, instMatch: true });
    const byline = one({ shared: 1, bylinePapers: 2 });
    for (const [s, by, want] of [
      [both, "record", null],
      [both, "byline", null],
      [record, "byline", "threshold"],
      [record, "either", null],
      [byline, "record", "threshold"],
      [byline, "either", null],
    ] as const)
      expect(bulkBlocker(s, { ...ANY, passesBy: by })).toBe(want);
    // 4 shared works under "at least 5": out by the record, in by the bylines.
    const four = { shared: 4, worksTotal: 4, newWorks: 0 };
    expect(bulkBlocker(one(four), ORCID_BULK_RULE_DEFAULT)).toBe("threshold");
    expect(bulkBlocker(one({ ...four, bylinePapers: 2 }), ORCID_BULK_RULE_DEFAULT)).toBeNull();
    // Only on ORCID applies to both routes.
    expect(
      bulkBlocker(one({ shared: 1, worksTotal: 4, newWorks: 3, bylinePapers: 2 }), {
        ...ANY,
        maxOnlyOrcid: 1,
      }),
    ).toBe("threshold");
  });

  it("One candidate iD and Name agrees can be unchecked; the rest stays locked", () => {
    const two = summary({ candidates: [cand(), cand({ orcid: "x", band: "weak" })] });
    const differs = one({ nameAgrees: false });
    expect(bulkBlocker(two, ANY)).toBe("multiple");
    expect(bulkBlocker(two, { ...ANY, allowMultiple: true })).toBeNull();
    expect(bulkBlocker(differs, ANY)).toBe("name");
    expect(bulkBlocker(differs, { ...ANY, allowNameDiffers: true })).toBeNull();
    const loose = { ...ANY, allowMultiple: true, allowNameDiffers: true };
    expect(bulkBlocker(one({ competitor: true, bylinePapers: 4 }), loose)).toBe("competitor");
    expect(bulkBlocker(summary({ conflict: true }), loose)).toBe("on_file");
    expect(
      bulkBlocker(
        summary({ decisions: { byScholar: false, byStaff: true, librarian: false, at: null } }),
        loose,
      ),
    ).toBe("decided");
  });
});

describe("matchesQueueView: facet counts", () => {
  const view = { q: "", bands: [], decision: "open" as const, errorsOnly: false };
  const strong = summary({ cwid: "aa0001" });
  const weak = summary({ cwid: "bb0002", candidates: [cand({ band: "weak" })] });
  const auto = summary({
    cwid: "cc0003",
    autoConfirmed: true,
    candidates: [cand({ band: "email_verified" })],
  });
  const all = [strong, weak, auto];
  const count = (v: typeof view | Record<string, unknown>, skip?: "bands" | "decision") =>
    all.filter((s) => matchesQueueView(s, v as never, undefined, skip)).map((s) => s.cwid);

  it("the Confidence counts read the scholars the Decision filter leaves", () => {
    // Unassigned: the email-confirmed scholar is not counted under any band.
    expect(count(view, "bands")).toEqual(["aa0001", "bb0002"]);
    expect(count({ ...view, decision: "email" }, "bands")).toEqual(["cc0003"]);
    expect(count({ ...view, decision: null }, "bands")).toEqual(["aa0001", "bb0002", "cc0003"]);
  });

  it("a facet's counts apply every other filter, not its own", () => {
    const strongOnly = { ...view, bands: ["strong"] };
    expect(count(strongOnly, "bands")).toEqual(["aa0001", "bb0002"]);
    expect(count(strongOnly)).toEqual(["aa0001"]);
    // Decision's own counts ignore Decision and keep Confidence and search.
    expect(count({ ...view, bands: ["email_verified"] }, "decision")).toEqual(["cc0003"]);
    expect(count({ ...view, q: "bb0002" }, "bands")).toEqual(["bb0002"]);
  });

  it("Unassigned can count the decisions made on the page", () => {
    expect(all.filter((s) => matchesQueueView(s, view, (x) => x.cwid === "bb0002"))).toEqual([
      weak,
    ]);
  });
});
