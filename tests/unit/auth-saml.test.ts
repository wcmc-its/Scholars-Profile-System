import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkResponseBinding,
  extractCwid,
  extractCwidFromEppn,
  extractAssertionIdentity,
  MAX_ASSERTION_AGE_MS,
} from "@/lib/auth/saml";
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

describe("extractAssertionIdentity", () => {
  const NOW = new Date("2026-07-03T12:00:00.000Z");
  const OPTS = { now: NOW, clockSkewMs: 5000 };

  /**
   * Build a Profile whose `getAssertion()` mirrors node-saml's xml2js shape
   * (explicitRoot + explicitArray + explicitCharkey): the root `Assertion` is a
   * single object with `$` attributes and arrayed children.
   */
  function assertionProfile(opts: {
    assertionId?: string;
    responseId?: string;
    conditionsNotOnOrAfter?: string;
    subjectNotOnOrAfter?: string;
    omitAssertion?: boolean;
  }): Profile {
    const p = profile({}) as Profile & { getAssertion?: () => Record<string, unknown> };
    if (opts.responseId) p.ID = opts.responseId;
    if (!opts.omitAssertion) {
      p.getAssertion = () => ({
        Assertion: {
          $: { ID: opts.assertionId, IssueInstant: "2026-07-03T11:59:00Z", Version: "2.0" },
          Conditions: opts.conditionsNotOnOrAfter
            ? [{ $: { NotOnOrAfter: opts.conditionsNotOnOrAfter } }]
            : undefined,
          Subject: [
            {
              SubjectConfirmation: [
                {
                  SubjectConfirmationData: opts.subjectNotOnOrAfter
                    ? [{ $: { NotOnOrAfter: opts.subjectNotOnOrAfter } }]
                    : undefined,
                },
              ],
            },
          ],
        },
      });
    }
    return p;
  }

  it("keys on the signature-covered assertion ID and is deterministic on re-presentation", () => {
    const p = assertionProfile({
      assertionId: "_9f8e7d6c",
      conditionsNotOnOrAfter: "2026-07-03T12:04:00.000Z",
    });
    const first = extractAssertionIdentity(p, "raw-b64", OPTS);
    const second = extractAssertionIdentity(p, "raw-b64", OPTS);
    // Same message => same key: the single-use guard can recognise the second POST.
    expect(first.id).toBe("assn:_9f8e7d6c");
    expect(second.id).toBe(first.id);
  });

  it("derives the prune horizon from NotOnOrAfter plus the accepted clock skew", () => {
    const p = assertionProfile({
      assertionId: "_a",
      conditionsNotOnOrAfter: "2026-07-03T12:04:00.000Z",
    });
    const { expiresAt } = extractAssertionIdentity(p, "raw", OPTS);
    // 12:04:00 + 5000ms skew.
    expect(expiresAt.toISOString()).toBe("2026-07-03T12:04:05.000Z");
  });

  it("uses the latest NotOnOrAfter across Conditions and SubjectConfirmationData", () => {
    const p = assertionProfile({
      assertionId: "_a",
      conditionsNotOnOrAfter: "2026-07-03T12:04:00.000Z",
      subjectNotOnOrAfter: "2026-07-03T12:06:00.000Z",
    });
    const { expiresAt } = extractAssertionIdentity(p, "raw", OPTS);
    expect(expiresAt.toISOString()).toBe("2026-07-03T12:06:05.000Z");
  });

  it("falls back to the response ID when the assertion carries no ID", () => {
    const p = assertionProfile({ responseId: "_resp-42" });
    expect(extractAssertionIdentity(p, "raw", OPTS).id).toBe("resp:_resp-42");
  });

  it("falls back to a hash of the raw SAMLResponse when no id is available", () => {
    const p = assertionProfile({ omitAssertion: true });
    const expected = "hash:" + createHash("sha256").update("the-raw-response").digest("hex");
    expect(extractAssertionIdentity(p, "the-raw-response", OPTS).id).toBe(expected);
    // Distinct responses hash to distinct keys; identical responses collide (by design).
    const other = extractAssertionIdentity(p, "different-response", OPTS).id;
    expect(other).not.toBe(expected);
  });

  it("uses the fixed fallback window when no NotOnOrAfter is present", () => {
    const p = assertionProfile({ assertionId: "_a" });
    const { expiresAt } = extractAssertionIdentity(p, "raw", {
      ...OPTS,
      fallbackWindowMs: 60_000,
    });
    expect(expiresAt.toISOString()).toBe("2026-07-03T12:01:00.000Z");
  });
});

describe("checkResponseBinding", () => {
  const ACS = "https://scholars.example.org/api/auth/saml/callback";
  const OTHER_ACS = "https://scholars-staging.example.org/api/auth/saml/callback";
  const NOW = new Date("2026-10-23T12:00:00.000Z");
  const OPTS = {
    acsUrl: ACS,
    now: NOW,
    clockSkewMs: 5000,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
  };
  const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

  /** Profile shaped like node-saml's output: xml2js assertion + raw response XML. */
  function boundProfile(opts: {
    recipient?: string | null;
    method?: string;
    destination?: string | null;
    issueInstant?: string | null;
  }): Profile {
    const recipient = opts.recipient === undefined ? ACS : opts.recipient;
    const destination = opts.destination === undefined ? ACS : opts.destination;
    const issueInstant =
      opts.issueInstant === undefined ? "2026-10-23T11:59:30Z" : opts.issueInstant;
    const p = profile({}) as Profile & {
      getAssertion?: () => Record<string, unknown>;
      getSamlResponseXml?: () => string;
    };
    p.getAssertion = () => ({
      Assertion: {
        $: { ID: "_a", Version: "2.0", ...(issueInstant ? { IssueInstant: issueInstant } : {}) },
        Subject: [
          {
            SubjectConfirmation: [
              {
                $: { Method: opts.method ?? BEARER },
                SubjectConfirmationData: [
                  {
                    $: {
                      NotOnOrAfter: "2026-10-23T12:04:30Z",
                      ...(recipient ? { Recipient: recipient } : {}),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const destAttr = destination ? ` Destination="${destination}"` : "";
    p.getSamlResponseXml = () =>
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0"${destAttr}></samlp:Response>`;
    return p;
  }

  it("accepts a Recipient and Destination equal to this environment's ACS", () => {
    expect(checkResponseBinding(boundProfile({}), OPTS)).toBeNull();
  });

  it("rejects an assertion whose Recipient is the other environment's ACS", () => {
    const p = boundProfile({ recipient: OTHER_ACS, destination: null });
    expect(checkResponseBinding(p, OPTS)).toBe("recipient_mismatch");
  });

  it("rejects a Response whose Destination is the other environment's ACS", () => {
    const p = boundProfile({ destination: OTHER_ACS });
    expect(checkResponseBinding(p, OPTS)).toBe("destination_mismatch");
  });

  it("requires an exact match (no trailing-slash or case tolerance)", () => {
    expect(checkResponseBinding(boundProfile({ recipient: `${ACS}/` }), OPTS)).toBe(
      "recipient_mismatch",
    );
    expect(
      checkResponseBinding(boundProfile({ recipient: ACS.toUpperCase() }), OPTS),
    ).toBe("recipient_mismatch");
  });

  it("allows an absent Destination when the Recipient matches", () => {
    expect(checkResponseBinding(boundProfile({ destination: null }), OPTS)).toBeNull();
  });

  it("rejects an assertion with no Recipient", () => {
    expect(checkResponseBinding(boundProfile({ recipient: null }), OPTS)).toBe(
      "recipient_missing",
    );
  });

  it("ignores a Recipient on a non-bearer confirmation", () => {
    const p = boundProfile({ method: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" });
    expect(checkResponseBinding(p, OPTS)).toBe("recipient_missing");
  });

  it("rejects a stale assertion past the max age plus skew", () => {
    // Issued 5m06s before NOW: past 5m + 5s skew.
    const p = boundProfile({ issueInstant: "2026-10-23T11:54:54Z" });
    expect(checkResponseBinding(p, OPTS)).toBe("assertion_too_old");
  });

  it("accepts an assertion just inside the max age plus skew", () => {
    const p = boundProfile({ issueInstant: "2026-10-23T11:54:56Z" });
    expect(checkResponseBinding(p, OPTS)).toBeNull();
  });

  it("rejects an assertion issued in the future beyond the skew", () => {
    const p = boundProfile({ issueInstant: "2026-10-23T12:00:10Z" });
    expect(checkResponseBinding(p, OPTS)).toBe("assertion_not_yet_valid");
  });

  it("rejects an assertion with no IssueInstant", () => {
    expect(checkResponseBinding(boundProfile({ issueInstant: null }), OPTS)).toBe(
      "issue_instant_missing",
    );
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
