/**
 * #2675 — `etl/identity`: the ORCID lives at the NESTED `identity.orcid` path, and the scan
 * must match string-typed values only. The top-level `orcid` the ETL used to scan never exists
 * on any Identity item, which is why the nightly matched 0 rows for months while grading green.
 */
import { describe, expect, it } from "vitest";

import {
  IDENTITY_ORCID_SCAN,
  cwidFromIdentityItem,
  orcidFromIdentityItem,
} from "@/etl/identity/index";

describe("identity ETL — nested identity.orcid", () => {
  it("scans the nested path for string-typed values only, projecting just uid + identity.orcid", () => {
    expect(IDENTITY_ORCID_SCAN.FilterExpression).toBe("attribute_type(#identity.orcid, :s)");
    expect(IDENTITY_ORCID_SCAN.ProjectionExpression).toBe("uid, #identity.orcid");
    expect(IDENTITY_ORCID_SCAN.ExpressionAttributeNames).toEqual({ "#identity": "identity" });
    expect(IDENTITY_ORCID_SCAN.ExpressionAttributeValues).toEqual({ ":s": "S" });
  });

  it("reads the ORCID off the nested map, trimmed; typed NULL / missing / top-level read as absent", () => {
    expect(
      orcidFromIdentityItem({ uid: "abc1234", identity: { orcid: " 0000-0002-1825-0097 " } }),
    ).toBe("0000-0002-1825-0097");
    expect(orcidFromIdentityItem({ uid: "abc1234", identity: { orcid: null } })).toBe("");
    expect(orcidFromIdentityItem({ uid: "abc1234", identity: {} })).toBe("");
    expect(orcidFromIdentityItem({ uid: "abc1234" })).toBe("");
    // The shape the ETL used to assume — a top-level orcid — is NOT read.
    expect(orcidFromIdentityItem({ uid: "abc1234", orcid: "0000-0002-1825-0097" } as never)).toBe(
      "",
    );
  });

  it("uppercases the lowercase Identity uid to the scholar.cwid form (3,794 read / 0 matched otherwise)", () => {
    expect(cwidFromIdentityItem({ uid: " abc1234 " })).toBe("ABC1234");
    expect(cwidFromIdentityItem({ uid: "ABC1234" })).toBe("ABC1234");
    expect(cwidFromIdentityItem({})).toBe("");
    expect(cwidFromIdentityItem({ uid: 42 } as never)).toBe("");
  });
});
