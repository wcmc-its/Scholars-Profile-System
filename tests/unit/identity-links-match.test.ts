import { describe, expect, it } from "vitest";
import {
  matchIdentities,
  nameKey,
  wcmNameKey,
  type CornellPerson,
  type WcmPerson,
} from "@/etl/identity-links/match";

const w = (cwid: string, fullName: string, x: Partial<WcmPerson> = {}): WcmPerson => ({
  cwid,
  fullName,
  netid: null,
  email: null,
  orcids: [],
  ...x,
});
const c = (
  netid: string,
  firstName: string,
  lastName: string,
  x: Partial<CornellPerson> = {},
): CornellPerson => ({
  netid,
  firstName,
  lastName,
  emails: [],
  orcids: [],
  name: null,
  department: null,
  title: null,
  ...x,
});

describe("identity-links matcher", () => {
  it("normalizes names: diacritics, hyphens, suffixes, multi-word surnames", () => {
    expect(nameKey("José", "Núñez-Ruiz")).toBe("jose|nunezruiz");
    expect(wcmNameKey("Jane Q. Doe Jr.")).toBe("jane|doe");
    expect(wcmNameKey("Maria de la Cruz")).toBe(nameKey("Maria", "De La Cruz"));
    expect(wcmNameKey("Cher")).toBeNull();
  });

  it("bands each signal and skips a shared identifier", () => {
    const links = matchIdentities(
      [
        w("abc2001", "Ann Smith", { netid: "as1" }),
        w("def2002", "Bo Lee", { orcids: ["0000-0001-0000-0001"] }),
        w("ghi2003", "Cy Park", { email: "cyp9001@med.cornell.edu" }),
        w("jkl2004", "Dee Unique"),
        w("same1", "Ed Same", { netid: "same1" }),
      ],
      [
        c("as1", "Ann", "Smith"),
        c("bl2", "Robert", "Lee", { orcids: ["0000-0001-0000-0001"] }),
        c("cp3", "Cy", "Park", { emails: ["cyp9001@med.cornell.edu"] }),
        c("du4", "Dee", "Unique"),
        c("same1", "Ed", "Same"),
      ],
    );
    expect(links.map((l) => [l.cwid, l.netid, l.band])).toEqual([
      ["abc2001", "as1", "known"],
      ["def2002", "bl2", "strong"],
      ["ghi2003", "cp3", "strong"],
      ["jkl2004", "du4", "possible"],
    ]);
    expect(links[2].signals).toEqual({ email: "cyp9001@med.cornell.edu", name: true });
  });

  it("matches a Cornell email whose local part is the CWID", () => {
    const [l] = matchIdentities(
      [w("xyz3003", "Zed One")],
      [c("zo1", "Zack", "Other", { emails: ["XYZ3003@med.cornell.edu"] })],
    );
    expect(l).toMatchObject({ cwid: "xyz3003", netid: "zo1", band: "strong" });
  });

  it("drops a name-only match when the name is not unique on either side", () => {
    expect(
      matchIdentities([w("a1", "Wei Wang"), w("a2", "Wei Wang")], [c("ww1", "Wei", "Wang")]),
    ).toEqual([]);
    expect(
      matchIdentities([w("a1", "Wei Wang")], [c("ww1", "Wei", "Wang"), c("ww2", "Wei", "Wang")]),
    ).toEqual([]);
  });

  it("a known pair suppresses weaker guesses on either identifier", () => {
    const links = matchIdentities(
      [
        w("abc2001", "Ann Smith", { netid: "as1" }),
        w("zzz9999", "Ann Smyth", { orcids: ["0000-0002-0000-0002"] }),
      ],
      [c("as1", "Ann", "Smith", { orcids: ["0000-0002-0000-0002"] })],
    );
    expect(links.map((l) => l.cwid)).toEqual(["abc2001"]);
    expect(links[0].signals).toEqual({ ed: true, name: true });
  });

  it("ignores an ED NetID that is not on the Cornell roster", () => {
    expect(matchIdentities([w("abc2001", "Ann Smith", { netid: "gone1" })], [])).toEqual([]);
  });
});
