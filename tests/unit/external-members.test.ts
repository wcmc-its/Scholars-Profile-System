/**
 * #2519 PR 2 — `lib/api/external-members.ts` render helpers.
 * No network/DB: `loadExternalMembersByCuid` is exercised via its
 * empty-input short-circuit (no prisma call needed); the querying path is
 * covered indirectly by the centers/divisions render-union tests, which mock
 * `@/lib/db`.
 */
import { describe, expect, it } from "vitest";

import {
  buildExternalMemberHit,
  cornellDirectoryUrl,
  loadExternalMembersByCuid,
} from "@/lib/api/external-members";
import type { ExternalMember } from "@/lib/generated/prisma/client";

describe("cornellDirectoryUrl", () => {
  it("builds the exact Cornell directory SSO URL for a netid", () => {
    expect(cornellDirectoryUrl("ab123")).toBe(
      "https://www.cornell.edu/search/sso/people.cfm?netid=ab123",
    );
  });

  it("percent-encodes a netid with characters that would otherwise break the query string", () => {
    expect(cornellDirectoryUrl("a b&c")).toBe(
      "https://www.cornell.edu/search/sso/people.cfm?netid=a%20b%26c",
    );
  });
});

describe("loadExternalMembersByCuid", () => {
  it("short-circuits to an empty map with no query for an empty cuid list", async () => {
    const result = await loadExternalMembersByCuid([]);
    expect(result.size).toBe(0);
  });
});

const EXTERNAL_MEMBER: ExternalMember = {
  cuid: "ab123",
  displayName: "Ada Byron",
  givenName: "Ada",
  familyName: "Byron",
  title: "Research Associate",
  dept: "Computer Science",
  email: "ab123@cornell.edu",
  affiliation: "staff",
  source: "cornell-ithaca",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("buildExternalMemberHit", () => {
  it("shapes an ExternalMember row into an external roster hit with no slug and no profile data", () => {
    const hit = buildExternalMemberHit(EXTERNAL_MEMBER);
    expect(hit).toMatchObject({
      cwid: "ab123",
      preferredName: "Ada Byron",
      slug: "",
      primaryTitle: "Research Associate",
      departmentName: "Computer Science",
      divisionName: null,
      roleCategory: null,
      roleCategoryRaw: null,
      pubCount: 0,
      grantCount: 0,
      isExternal: true,
      externalProfileUrl: "https://www.cornell.edu/search/sso/people.cfm?netid=ab123",
    });
  });
});
