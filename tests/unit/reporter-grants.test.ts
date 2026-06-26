import { describe, expect, it } from "vitest";
import {
  dedupeAgainstInfoEd,
  netNewLabel,
  rankByPmidOverlap,
  type Candidate,
  type ReporterProject,
} from "@/lib/edit/reporter-grants";

const proj = (over: Partial<ReporterProject>): ReporterProject => ({
  coreProjectNum: "R01XX000001",
  awardNumber: "5R01XX000001-01",
  orgName: "WEILL MEDICAL COLL OF CORNELL UNIV",
  fiscalYear: 2020,
  awardAmount: 100000,
  title: "t",
  ...over,
});

describe("dedupeAgainstInfoEd", () => {
  it("drops a RePORTER project whose exact core is already in InfoEd", () => {
    const { netNew, dropped } = dedupeAgainstInfoEd(
      [proj({ coreProjectNum: "R01AI176943", awardNumber: "5R01AI176943-03" })],
      [{ awardNumber: "5 R01 AI176943-01" }],
    );
    expect(netNew).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("drops a phased sibling at the SAME org (UG3 in InfoEd → UH3 from RePORTER, both WCM)", () => {
    // Real case: Glesby DEPTH trial. Different activity code, same IC+serial, same org.
    const { netNew, dropped } = dedupeAgainstInfoEd(
      [proj({ coreProjectNum: "UH3HL154944", awardNumber: "5UH3HL154944-04" })],
      [{ awardNumber: "1 UG3 HL154944-01A1" }],
    );
    expect(netNew).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("KEEPS a phased sibling at a DIFFERENT org (K99@Stanford, R00@WCM in InfoEd)", () => {
    // Real case: Conor Liston. Same family MH097822, but the K99 was held elsewhere —
    // a genuinely distinct prior-institution CV line.
    const { netNew } = dedupeAgainstInfoEd(
      [proj({ coreProjectNum: "K99MH097822", awardNumber: "5K99MH097822-01", orgName: "STANFORD UNIVERSITY" })],
      [{ awardNumber: "5 R00 MH097822-05" }],
    );
    expect(netNew).toHaveLength(1);
    expect(netNewLabel(netNew[0])).toBe("prior-institution");
  });

  it("keeps a genuinely new grant and labels WCM-org net-new as historical", () => {
    const { netNew } = dedupeAgainstInfoEd(
      [proj({ coreProjectNum: "R01DK065515", awardNumber: "5R01DK065515-04" })],
      [{ awardNumber: "5 R01 AI176943-03" }],
    );
    expect(netNew).toHaveLength(1);
    expect(netNewLabel(netNew[0])).toBe("wcm-historical"); // InfoEd dropped old WCM history
  });

  it("ignores InfoEd rows with unparseable (non-NIH) award numbers", () => {
    const { netNew } = dedupeAgainstInfoEd(
      [proj({ coreProjectNum: "R01AI176943" })],
      [{ awardNumber: "OCRA-2024-091" }, { awardNumber: null }],
    );
    expect(netNew).toHaveLength(1); // nothing to dedup against
  });
});

const cand = (profileId: number, pmids: number[]): Candidate => ({
  profileId,
  fullName: `pid${profileId}`,
  orgs: [],
  grantPmids: new Set(pmids),
});

describe("rankByPmidOverlap", () => {
  const me = new Set([1, 2, 3, 4, 5]);

  it("auto-locks a clear winner and orders by overlap", () => {
    const r = rankByPmidOverlap(me, [
      cand(100, [1, 2, 3, 4]), // overlap 4
      cand(200, [9, 8, 7]), // overlap 0 (different person)
    ]);
    expect(r.autoLock).toBe(100);
    expect(r.ranked[0].profileId).toBe(100);
    expect(r.ranked[0].overlap).toBe(4);
  });

  it("does NOT auto-lock a sparse winner (overlap 2 < K_AUTOLOCK) but DOES suggest it", () => {
    const r = rankByPmidOverlap(me, [
      cand(100, [1, 2]), // overlap 2
      cand(200, [9, 8, 7, 6]), // overlap 0
    ]);
    expect(r.autoLock).toBeNull();
    expect(r.suggestions.map((s) => s.profileId)).toEqual([100]);
  });

  it("abstains entirely on a tie (separation gate fails)", () => {
    const r = rankByPmidOverlap(me, [
      cand(100, [1, 2]), // overlap 2
      cand(200, [3, 4]), // overlap 2
    ]);
    expect(r.autoLock).toBeNull();
    expect(r.suggestions).toHaveLength(0);
  });

  it("returns no lock for an empty candidate set", () => {
    const r = rankByPmidOverlap(me, []);
    expect(r.autoLock).toBeNull();
    expect(r.ranked).toHaveLength(0);
  });
});
