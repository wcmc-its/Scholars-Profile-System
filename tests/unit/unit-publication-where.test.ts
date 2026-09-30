/**
 * The shared "visible publications of a unit" predicate — used by the three
 * unit Publications-tab loaders and the hero research-area preview.
 */
import { describe, expect, it } from "vitest";
import { unitPublicationWhere } from "@/lib/api/unit-publication-where";

const DEPT = { scholar: { deptCode: "DEPT1", deletedAt: null, status: "active" } };
const CENTER = { cwid: { in: ["aaa0001", "aaa0002"] } };

describe("unitPublicationWhere", () => {
  it("requires a confirmed unit-member author", () => {
    expect(unitPublicationWhere({ membership: DEPT, darkPmids: [] })).toEqual({
      authors: { some: { isConfirmed: true, ...DEPT } },
    });
  });

  it("adds a publicationTopics clause only when an area is given, with the same membership", () => {
    expect(unitPublicationWhere({ membership: CENTER, darkPmids: [] })).not.toHaveProperty(
      "publicationTopics",
    );
    expect(unitPublicationWhere({ membership: CENTER, darkPmids: [], area: null })).not.toHaveProperty(
      "publicationTopics",
    );
    const w = unitPublicationWhere({ membership: CENTER, darkPmids: [], area: "topic_a" });
    expect(w.publicationTopics).toEqual({ some: { parentTopicId: "topic_a", ...CENTER } });
    expect(w.authors).toEqual({ some: { isConfirmed: true, ...CENTER } });
  });

  it("omits pmid.notIn when there are no dark pmids, and adds it otherwise", () => {
    expect(unitPublicationWhere({ membership: DEPT, darkPmids: [] })).not.toHaveProperty("pmid");
    expect(unitPublicationWhere({ membership: DEPT, darkPmids: ["900001"] }).pmid).toEqual({
      notIn: ["900001"],
    });
  });
});
