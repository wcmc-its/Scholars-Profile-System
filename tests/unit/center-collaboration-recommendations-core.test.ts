import { describe, it, expect } from "vitest";
import {
  computeCollabCandidateMetrics,
  pct,
  splitName,
  type CollabAuthorRow,
  type CollabUniverseMember,
} from "@/lib/center-collaboration/recommendations-core";

describe("splitName", () => {
  it("splits on the last token", () => {
    expect(splitName("Jane Q. Public")).toEqual({ given: "Jane Q.", surname: "Public" });
  });
  it("handles a single-token name", () => {
    expect(splitName("Cher")).toEqual({ given: "", surname: "Cher" });
  });
});

describe("pct", () => {
  it("rounds to one decimal, 0/0 -> 0", () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(0, 0)).toBe(0);
  });
});

describe("computeCollabCandidateMetrics", () => {
  // 3 research members: m1/m2 in P1 (co-author paper A), m3 in P2 (no collab).
  // 2 candidates: c1 co-authors with m1 (paper D, not cancer-related); c2 has
  // no collaboration but 1 cancer-related paper of their own (paper E).
  const universe: CollabUniverseMember[] = [
    { cwid: "m1", isResearchMember: true, programCode: "P1" },
    { cwid: "m2", isResearchMember: true, programCode: "P1" },
    { cwid: "m3", isResearchMember: true, programCode: "P2" },
    { cwid: "c1", isResearchMember: false, programCode: null },
    { cwid: "c2", isResearchMember: false, programCode: null },
  ];
  const rows: CollabAuthorRow[] = [
    { pmid: "A", cwid: "m1", meshUis: [] },
    { pmid: "A", cwid: "m2", meshUis: [] },
    { pmid: "B", cwid: "m3", meshUis: [] },
    { pmid: "D", cwid: "m1", meshUis: [] },
    { pmid: "D", cwid: "c1", meshUis: [] },
    { pmid: "E", cwid: "c2", meshUis: ["CANCER_UI"] },
  ];
  const isCancerRelated = (uis: string[]) => uis.includes("CANCER_UI");
  const byCwid = new Map(computeCollabCandidateMetrics(universe, rows, isCancerRelated).map((m) => [m.cwid, m]));

  it("counts a research member's collaboration via co-occurrence, not their own solo papers", () => {
    expect(byCwid.get("m1")!.collaborationsWithCenter).toBe(1); // A, with m2
    expect(byCwid.get("m1")!.totalPapersPostCutoff).toBe(2); // A, D
    expect(byCwid.get("m3")!.collaborationsWithCenter).toBe(0); // solo on B
  });

  it("counts a non-member's collaboration via pmid overlap with a research member", () => {
    expect(byCwid.get("c1")!.collaborationsWithCenter).toBe(1); // D, with m1
    expect(byCwid.get("c2")!.collaborationsWithCenter).toBe(0); // E is solo
  });

  it("computes cancer-relevance independently of collaboration", () => {
    expect(byCwid.get("c2")!.cancerRelatedPapers).toBe(1);
    expect(byCwid.get("c1")!.cancerRelatedPapers).toBe(0);
  });

  it("stamps isCurrentMember/currentProgramCode from the universe input, not derived", () => {
    expect(byCwid.get("m1")!.isCurrentMember).toBe(true);
    expect(byCwid.get("m1")!.currentProgramCode).toBe("P1");
    expect(byCwid.get("c1")!.isCurrentMember).toBe(false);
    expect(byCwid.get("c1")!.currentProgramCode).toBeNull();
  });

  it("totalPapersPostCutoff is pmid-deduped, not a raw row count (PublicationAuthor has no DB-unique on pmid+cwid)", () => {
    const metrics = computeCollabCandidateMetrics(
      [{ cwid: "dup", isResearchMember: false, programCode: null }],
      [
        { pmid: "X", cwid: "dup", meshUis: [] },
        { pmid: "X", cwid: "dup", meshUis: [] }, // duplicate row, same pmid
        { pmid: "Y", cwid: "dup", meshUis: [] },
      ],
      () => false,
    );
    expect(metrics[0].totalPapersPostCutoff).toBe(2); // 2 distinct pmids, not 3 rows
  });

  it("a universe member with zero authorship rows gets an all-zero row, not a crash", () => {
    const metrics = computeCollabCandidateMetrics(
      [{ cwid: "ghost", isResearchMember: false, programCode: null }],
      [],
      () => false,
    );
    expect(metrics).toEqual([
      {
        cwid: "ghost",
        totalPapersPostCutoff: 0,
        collaborationsWithCenter: 0,
        cancerRelatedPapers: 0,
        isCurrentMember: false,
        currentProgramCode: null,
      },
    ]);
  });
});
