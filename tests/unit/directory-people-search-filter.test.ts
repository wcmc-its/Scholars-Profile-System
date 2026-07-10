/**
 * `buildDirectoryNameFilter` — the RFC-4515 filter the "Add admin" / "Add a
 * leader" typeahead sends to the ED directory. Pure string construction, so no
 * LDAP: the regression these guard is a curator being unable to find a person
 * whose `displayName` carries a middle initial (e.g. "Curtis L Cole"), or by
 * CWID.
 */
import { describe, expect, it } from "vitest";

import { buildDirectoryNameFilter } from "@/lib/sources/ldap";

describe("buildDirectoryNameFilter", () => {
  it("ANDs whitespace tokens so 'First Last' matches a 'First MI Last' displayName", () => {
    expect(buildDirectoryNameFilter("Curtis Cole")).toBe(
      "(&(objectClass=eduPerson)" +
        "(|(givenName=*Curtis*)(sn=*Curtis*)(displayName=*Curtis*)(weillCornellEduCWID=Curtis))" +
        "(|(givenName=*Cole*)(sn=*Cole*)(displayName=*Cole*)(weillCornellEduCWID=Cole)))",
    );
  });

  it("resolves a bare CWID via an exact weillCornellEduCWID clause", () => {
    expect(buildDirectoryNameFilter("ccole")).toBe(
      "(&(objectClass=eduPerson)" +
        "(|(givenName=*ccole*)(sn=*ccole*)(displayName=*ccole*)(weillCornellEduCWID=ccole)))",
    );
  });

  it("collapses repeated/edge whitespace", () => {
    expect(buildDirectoryNameFilter("  Curtis   Cole  ")).toBe(
      buildDirectoryNameFilter("Curtis Cole"),
    );
  });

  it("RFC-4515-escapes wildcards so a typed '*' is literal, not an injection", () => {
    expect(buildDirectoryNameFilter("a*b")).toContain("(givenName=*a\\2ab*)");
  });
});
