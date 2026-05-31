import { describe, expect, it } from "vitest";
import { extractCwid, extractCwidFromEppn } from "@/lib/auth/saml";
import { parseScopes } from "@/lib/auth/config";
import type { Profile } from "@node-saml/node-saml";

const EPPN = "urn:oid:1.3.6.1.4.1.5923.1.1.1.6";

function profile(extra: Record<string, unknown>): Profile {
  return {
    issuer: "https://idp.example",
    nameID: "nameid-value",
    nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    ...extra,
  } as Profile;
}

describe("extractCwid", () => {
  it("uses the NameID when no attribute is configured", () => {
    expect(extractCwid(profile({ nameID: "abc1234" }), undefined)).toBe("abc1234");
  });

  it("uses the configured attribute when set", () => {
    const p = profile({ nameID: "abc1234", "urn:oid:cwid": "xyz9999" });
    expect(extractCwid(p, "urn:oid:cwid")).toBe("xyz9999");
  });

  it("takes the first element of a multi-valued attribute", () => {
    expect(extractCwid(profile({ cwid: ["first1", "second2"] }), "cwid")).toBe("first1");
  });

  it("trims surrounding whitespace", () => {
    expect(extractCwid(profile({ cwid: "  abc1234  " }), "cwid")).toBe("abc1234");
  });

  it("returns null when the configured attribute is absent", () => {
    expect(extractCwid(profile({}), "missing-attr")).toBeNull();
  });

  it("returns null for an empty or non-string value", () => {
    expect(extractCwid(profile({ cwid: "" }), "cwid")).toBeNull();
    expect(extractCwid(profile({ cwid: 123 }), "cwid")).toBeNull();
    expect(extractCwid(profile({ nameID: "" }), undefined)).toBeNull();
  });
});

describe("extractCwidFromEppn", () => {
  const scopes = ["nyp.org", "qatar-med.cornell.edu"];

  it("returns the eppn local-part when the scope is trusted (NYP)", () => {
    // The exact attribute set captured from a live NYP login (2026-05-31).
    const p = profile({ [EPPN]: "paa2013@nyp.org" });
    expect(extractCwidFromEppn(p, EPPN, scopes)).toBe("paa2013");
  });

  it("returns the eppn local-part for the anticipated WCM-Q scope", () => {
    const p = profile({ [EPPN]: "abc1234@qatar-med.cornell.edu" });
    expect(extractCwidFromEppn(p, EPPN, scopes)).toBe("abc1234");
  });

  it("is case-insensitive on the scope", () => {
    expect(extractCwidFromEppn(profile({ [EPPN]: "paa2013@NYP.ORG" }), EPPN, scopes)).toBe(
      "paa2013",
    );
  });

  it("takes the first element of a multi-valued eppn", () => {
    const p = profile({ [EPPN]: ["paa2013@nyp.org", "other@nyp.org"] });
    expect(extractCwidFromEppn(p, EPPN, scopes)).toBe("paa2013");
  });

  it("refuses an untrusted scope (no arbitrary domain stripping)", () => {
    expect(extractCwidFromEppn(profile({ [EPPN]: "paa2013@evil.example" }), EPPN, scopes)).toBeNull();
  });

  it("returns null when the allowlist is empty (fallback disabled)", () => {
    expect(extractCwidFromEppn(profile({ [EPPN]: "paa2013@nyp.org" }), EPPN, [])).toBeNull();
  });

  it("returns null for a malformed eppn (missing scope, empty local, multiple @)", () => {
    expect(extractCwidFromEppn(profile({ [EPPN]: "paa2013" }), EPPN, scopes)).toBeNull();
    expect(extractCwidFromEppn(profile({ [EPPN]: "paa2013@" }), EPPN, scopes)).toBeNull();
    expect(extractCwidFromEppn(profile({ [EPPN]: "@nyp.org" }), EPPN, scopes)).toBeNull();
    expect(extractCwidFromEppn(profile({ [EPPN]: "a@b@nyp.org" }), EPPN, scopes)).toBeNull();
  });

  it("returns null when the eppn attribute is absent", () => {
    expect(extractCwidFromEppn(profile({}), EPPN, scopes)).toBeNull();
  });
});

describe("parseScopes", () => {
  it("splits, trims, lower-cases, and de-duplicates", () => {
    expect(parseScopes(" NYP.org , med.cornell.edu ,nyp.org ")).toEqual([
      "nyp.org",
      "med.cornell.edu",
    ]);
  });

  it("returns [] for unset or empty input", () => {
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("  , ,")).toEqual([]);
  });
});
