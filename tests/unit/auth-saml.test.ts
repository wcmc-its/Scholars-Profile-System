import { describe, expect, it } from "vitest";
import { extractCwid } from "@/lib/auth/saml";
import type { Profile } from "@node-saml/node-saml";

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
