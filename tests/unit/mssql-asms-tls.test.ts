import { describe, expect, it } from "vitest";

import { rdsCaBundlePath } from "@/lib/db-tls";
import { asmsTlsOptions } from "@/lib/sources/mssql-asms";

describe("asmsTlsOptions", () => {
  it("keeps the unverified behaviour unless ASMS_TLS_VERIFY is exactly 'on'", () => {
    for (const v of [undefined, "", "off", "true", "1", "ON", " on"]) {
      expect(asmsTlsOptions({ ASMS_TLS_VERIFY: v })).toEqual({
        encrypt: true,
        trustServerCertificate: true,
      });
    }
  });

  it("verifies against the shipped RDS CA bundle when on", () => {
    const opts = asmsTlsOptions({ ASMS_TLS_VERIFY: "on" }, rdsCaBundlePath());
    expect(opts.encrypt).toBe(true);
    expect(opts.trustServerCertificate).toBe(false);
    expect(String(opts.cryptoCredentialsDetails?.ca)).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("fails loudly when on and the bundle is missing", () => {
    expect(() => asmsTlsOptions({ ASMS_TLS_VERIFY: "on" }, "/nonexistent/bundle.pem")).toThrow(/missing/);
  });
});
