import { describe, expect, it } from "vitest";

import { planDemotion } from "@/etl/identity/demote-legacy";

// ORCID's documentation example iD and a synthetic checksum-valid one; neither is a person.
const ID = "0000-0002-1825-0097";
const OTHER = "0000-0001-2345-6789";

describe("planDemotion", () => {
  it("demotes only where Identity holds the same iD; a different or missing one is kept and listed", () => {
    const { demote, keep } = planDemotion(
      [
        { cwid: "abc1234", orcid: ID },
        { cwid: "ABC5678", orcid: ID },
        { cwid: "def1234", orcid: ID },
        { cwid: "ghi1234", orcid: ID },
      ],
      [
        { uid: "abc1234", identity: { orcid: ID } },
        { uid: "abc5678", identity: { orcid: ID } },
        { uid: "def1234", identity: { orcid: OTHER } },
      ],
    );
    expect(demote).toEqual([
      { cwid: "abc1234", orcid: ID },
      { cwid: "ABC5678", orcid: ID },
    ]);
    expect(keep).toEqual([
      { cwid: "def1234", orcid: ID, identityOrcid: OTHER },
      { cwid: "ghi1234", orcid: ID, identityOrcid: null },
    ]);
  });
});
