import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSamlEnv, parseIdpCert } from "@/lib/auth/config";

const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBcertAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
-----END CERTIFICATE-----`;

const CERT_B = `-----BEGIN CERTIFICATE-----
MIIBcertBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
-----END CERTIFICATE-----`;

describe("parseIdpCert", () => {
  it("returns the input string unchanged when exactly one PEM block is present", () => {
    expect(parseIdpCert(CERT_A)).toBe(CERT_A);
  });

  it("tolerates surrounding whitespace around a single PEM", () => {
    const padded = `\n\n  ${CERT_A}  \n`;
    expect(parseIdpCert(padded)).toBe(padded);
  });

  it("returns a 2-element array when two PEMs are concatenated (rollover format)", () => {
    const combined = `${CERT_A}\n\n${CERT_B}`;
    const parsed = parseIdpCert(combined);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect((parsed as string[])[0]).toBe(CERT_A);
    expect((parsed as string[])[1]).toBe(CERT_B);
  });

  it("returns each block independently of separator (whitespace, blank lines, mixed newlines)", () => {
    const combined = `${CERT_A}\r\n\r\n   \r\n${CERT_B}\n`;
    const parsed = parseIdpCert(combined) as string[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe(CERT_A);
    expect(parsed[1]).toBe(CERT_B);
  });

  it("throws a clear message when no PEM block is present", () => {
    expect(() => parseIdpCert("not a certificate at all")).toThrow(
      /SAML_IDP_CERT must contain at least one PEM/,
    );
  });

  it("throws when the BEGIN marker is present but the END marker is missing", () => {
    const malformed = "-----BEGIN CERTIFICATE-----\nMIIBmissingEnd\n";
    expect(() => parseIdpCert(malformed)).toThrow(/SAML_IDP_CERT/);
  });

  it("throws on an empty string", () => {
    expect(() => parseIdpCert("")).toThrow(/SAML_IDP_CERT/);
  });
});

describe("getSamlEnv — idpCert shape", () => {
  const REQUIRED_ENV: Record<string, string> = {
    SAML_IDP_SSO_URL: "https://idp.example/sso",
    SAML_SP_ENTITY_ID: "https://sp.example/metadata",
    SAML_SP_ACS_URL: "https://sp.example/acs",
  };

  const SAVED: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) {
      SAVED[k] = process.env[k];
      process.env[k] = REQUIRED_ENV[k];
    }
    SAVED.SAML_IDP_CERT = process.env.SAML_IDP_CERT;
  });

  afterEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
    if (SAVED.SAML_IDP_CERT === undefined) delete process.env.SAML_IDP_CERT;
    else process.env.SAML_IDP_CERT = SAVED.SAML_IDP_CERT;
  });

  it("returns a string for single-cert input", () => {
    process.env.SAML_IDP_CERT = CERT_A;
    expect(typeof getSamlEnv().idpCert).toBe("string");
  });

  it("returns an array for two-cert concatenated input", () => {
    process.env.SAML_IDP_CERT = `${CERT_A}\n${CERT_B}`;
    const cert = getSamlEnv().idpCert;
    expect(Array.isArray(cert)).toBe(true);
    expect(cert).toHaveLength(2);
  });

  it("throws when SAML_IDP_CERT is malformed", () => {
    process.env.SAML_IDP_CERT = "garbage";
    expect(() => getSamlEnv()).toThrow(/SAML_IDP_CERT/);
  });
});
