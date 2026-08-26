/**
 * Cornell (Ithaca) LDAP attribute map (#2519 PR 1, §4/§14) — a fixture
 * Cornell directory entry projected to the `CornellDirectoryPerson` shape.
 * No live LDAP; exercises `projectCornellPerson` directly.
 */
import { describe, expect, it } from "vitest";

import { buildCornellNameFilter, projectCornellPerson } from "@/lib/sources/cornell-ldap";

describe("projectCornellPerson", () => {
  it("maps a full Cornell entry to the expected DirectoryPerson-shaped result", () => {
    const entry = {
      uid: ["ab123"],
      displayName: ["Ada Byron"],
      givenName: ["Ada"],
      sn: ["Byron"],
      cornelleduwrkngtitle1: ["Research Associate"],
      cornelleduunivtitle1: ["Visiting Scholar"],
      cornelledudeptname1: ["Computer Science"],
      mail: ["ab123@cornell.edu"],
      cornelleduprimaryaffiliation: ["staff"],
      cornellEduCWID: ["wcm999"],
    };

    expect(projectCornellPerson(entry)).toEqual({
      netid: "ab123",
      name: "Ada Byron",
      givenName: "Ada",
      familyName: "Byron",
      title: "Research Associate", // wrkngtitle1 preferred over univtitle1
      dept: "Computer Science",
      email: "ab123@cornell.edu",
      affiliation: "staff",
      cornellEduCWID: "wcm999",
    });
  });

  it("falls back to cornelleduunivtitle1 when wrkngtitle1 is absent", () => {
    const entry = {
      uid: "cd456",
      sn: "Doe",
      cornelleduunivtitle1: "Professor Emeritus",
    };
    const person = projectCornellPerson(entry);
    expect(person?.title).toBe("Professor Emeritus");
  });

  it("constructs a name from givenName+sn when displayName is absent", () => {
    const entry = { uid: "ef789", givenName: "Eve", sn: "Franklin" };
    expect(projectCornellPerson(entry)?.name).toBe("Eve Franklin");
  });

  it("falls back to the netid when no name parts are present", () => {
    const entry = { uid: "gh012" };
    const person = projectCornellPerson(entry);
    expect(person?.name).toBe("gh012");
    expect(person?.givenName).toBeNull();
    expect(person?.familyName).toBeNull();
  });

  it("is null for cornellEduCWID when the entry carries no bridge", () => {
    const entry = { uid: "ij345", displayName: "Ida Jones" };
    expect(projectCornellPerson(entry)?.cornellEduCWID).toBeNull();
  });

  it("returns null when uid is absent (not a resolvable person entry)", () => {
    expect(projectCornellPerson({ displayName: "No Uid" })).toBeNull();
  });

  it("takes the first value of a multi-valued attribute", () => {
    const entry = { uid: ["kl678", "duplicate-uid"], mail: ["primary@cornell.edu", "alt@cornell.edu"] };
    const person = projectCornellPerson(entry);
    expect(person?.netid).toBe("kl678");
    expect(person?.email).toBe("primary@cornell.edu");
  });
});

describe("buildCornellNameFilter", () => {
  it("excludes alumni via the centralized population filter", () => {
    const filter = buildCornellNameFilter("ada");
    expect(filter.startsWith("(&(!(cornelleduprimaryaffiliation=alumni))")).toBe(true);
  });

  it("builds prefix-safe (no leading wildcard) per-token clauses", () => {
    const filter = buildCornellNameFilter("ada");
    expect(filter).toContain("(givenName=ada*)");
    expect(filter).toContain("(sn=ada*)");
    expect(filter).toContain("(uid=ada)");
    expect(filter).not.toContain("*ada*");
  });

  it("AND-s multiple whitespace-separated tokens", () => {
    const filter = buildCornellNameFilter("ada byron");
    expect(filter).toContain("ada*");
    expect(filter).toContain("byron*");
  });

  it("escapes a literal wildcard in the query so it is not injected", () => {
    const filter = buildCornellNameFilter("a*b");
    expect(filter).toContain("a\\2ab*");
  });
});
