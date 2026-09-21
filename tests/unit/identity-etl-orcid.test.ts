/**
 * #2675 — `etl/identity`: the ORCID lives at the NESTED `identity.orcid` path, and the scan
 * must match string-typed values only. The top-level `orcid` the ETL used to scan never exists
 * on any Identity item, which is why the nightly matched 0 rows for months while grading green.
 */
import { describe, expect, it } from "vitest";

import {
  IDENTITY_ORCID_SCAN,
  type ScholarOrcidState,
  cwidFromIdentityItem,
  decideIdentityRow,
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

  // #2682 UPPERCASED the uid on the theory that scholar.cwid was uppercase. It is
  // lowercase (10,814 / 10,815 on the prod-shaped dump), so that nightly read 3,794
  // ORCIDs and matched 0 scholars. Lowercase is the form the scholar Map is keyed by.
  it("lowercases the Identity uid to the (lowercase) scholar.cwid form", () => {
    expect(cwidFromIdentityItem({ uid: " abc1234 " })).toBe("abc1234");
    expect(cwidFromIdentityItem({ uid: "ABC1234" })).toBe("abc1234");
    expect(cwidFromIdentityItem({})).toBe("");
    expect(cwidFromIdentityItem({ uid: 42 } as never)).toBe("");
  });
});

describe("identity ETL — per-row decision against SPS", () => {
  const ID = "0000-0002-1825-0097";
  const OTHER = "0000-0001-5109-3700";
  const state = (
    orcid: string | null,
    orcidConfirmedAt: Date | null = null,
  ): ScholarOrcidState => ({ orcid, orcidConfirmedAt });
  // The main() Map is keyed by cwid.toLowerCase(); mirror that here.
  const scholars = (m: Record<string, ScholarOrcidState>) =>
    new Map(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));

  it("a lowercase Identity uid matches a lowercase scholar cwid (the case #2682 broke)", () => {
    const d = decideIdentityRow(
      { uid: "abc1234", identity: { orcid: ID } },
      scholars({ abc1234: state(null) }),
    );
    expect(d).toEqual({ kind: "update", cwid: "abc1234", orcid: ID });
  });

  it("an UPPERCASE Identity uid still matches (both sides are lowercased)", () => {
    const d = decideIdentityRow(
      { uid: "ABC1234", identity: { orcid: ID } },
      scholars({ abc1234: state(null) }),
    );
    expect(d).toEqual({ kind: "update", cwid: "abc1234", orcid: ID });
    // ...and the one uppercase scholar row on the dump matches a lowercase uid.
    const d2 = decideIdentityRow(
      { uid: "abc1234", identity: { orcid: ID } },
      scholars({ ABC1234: state(null) }),
    );
    expect(d2).toEqual({ kind: "update", cwid: "abc1234", orcid: ID });
  });

  it("no scholar row / malformed iD / missing fields are counted, never written", () => {
    expect(
      decideIdentityRow({ uid: "zzz9999", identity: { orcid: ID } }, scholars({ abc1234: state(null) })),
    ).toEqual({ kind: "no_scholar" });
    expect(
      decideIdentityRow(
        { uid: "abc1234", identity: { orcid: "0000-0002-1825-009" } },
        scholars({ abc1234: state(null) }),
      ),
    ).toEqual({ kind: "invalid" });
    expect(decideIdentityRow({ identity: { orcid: ID } }, scholars({}))).toEqual({ kind: "skip" });
    expect(decideIdentityRow({ uid: "abc1234", identity: { orcid: null } }, scholars({}))).toEqual({
      kind: "skip",
    });
  });

  it("Identity equal to SPS is unchanged — confirmed or not (a confirmation Identity agrees with is kept)", () => {
    expect(
      decideIdentityRow({ uid: "abc1234", identity: { orcid: ID } }, scholars({ abc1234: state(ID) })),
    ).toEqual({ kind: "unchanged" });
    expect(
      decideIdentityRow(
        { uid: "abc1234", identity: { orcid: ID } },
        scholars({ abc1234: state(ID, new Date("2026-09-21T12:00:00Z")) }),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("an unconfirmed different value is a plain update (Identity backfills as before)", () => {
    expect(
      decideIdentityRow(
        { uid: "abc1234", identity: { orcid: ID } },
        scholars({ abc1234: state(OTHER) }),
      ),
    ).toEqual({ kind: "update", cwid: "abc1234", orcid: ID });
  });

  it("conflict: Identity holds a DIFFERENT iD than one confirmed in SPS → Identity wins and the confirmation is cleared", () => {
    const d = decideIdentityRow(
      { uid: "abc1234", identity: { orcid: ID } },
      scholars({ abc1234: state(OTHER, new Date("2026-09-21T12:00:00Z")) }),
    );
    // `conflict` (not `update`) is what main() keys the `orcidConfirmedAt: null` write and
    // the summary counter on — a plain `update` here would keep a confirmation of the
    // wrong iD on the row.
    expect(d).toEqual({ kind: "conflict", cwid: "abc1234", orcid: ID });
  });
});
