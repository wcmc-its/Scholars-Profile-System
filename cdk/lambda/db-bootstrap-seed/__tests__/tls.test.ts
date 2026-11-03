import { describe, expect, it, vi } from "vitest";

import { RDS_CA_BUNDLE_FILE, seederSslOptions } from "../tls.js";

const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

describe("seederSslOptions", () => {
  it("flag off -> no ssl and no file read", () => {
    const readCa = vi.fn(() => PEM);
    expect(seederSslOptions({}, readCa)).toBeUndefined();
    expect(seederSslOptions({ DB_TLS: "off" }, readCa)).toBeUndefined();
    expect(seederSslOptions({ DB_TLS: "true" }, readCa)).toBeUndefined();
    expect(readCa).not.toHaveBeenCalled();
  });

  it("flag on -> ssl with the bundled CA from the asset root, rejectUnauthorized true", () => {
    const readCa = vi.fn(() => PEM);
    const ssl = seederSslOptions({ DB_TLS: "on", LAMBDA_TASK_ROOT: "/var/task" }, readCa);
    expect(ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(readCa).toHaveBeenCalledWith(`/var/task/${RDS_CA_BUNDLE_FILE}`);
  });

  it("flag on with a non-PEM bundle throws", () => {
    expect(() =>
      seederSslOptions({ DB_TLS: "on", LAMBDA_TASK_ROOT: "/var/task" }, () => "junk"),
    ).toThrow(/not a PEM/);
  });

  it("flag on with a missing bundle propagates the read error", () => {
    expect(() =>
      seederSslOptions({ DB_TLS: "on", LAMBDA_TASK_ROOT: "/nonexistent" }),
    ).toThrow(/ENOENT/);
  });
});
