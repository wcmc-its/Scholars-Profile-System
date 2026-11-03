import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RDS_CA_BUNDLE_RELATIVE_PATH,
  connectionOptionsFromDsn,
  dbSslOptions,
  dbTlsEnabled,
  loadRdsCa,
  rdsCaBundlePath,
  withSchemaEngineTls,
} from "@/lib/db-tls";
import { mariadbPoolConfig, withMariadbPoolParams } from "@/lib/db-url";

const ON = { DB_TLS: "on" };
const OFF = {};
// The real bundle shipped in the repo (vitest runs from the repo root).
const REPO_CA = rdsCaBundlePath();

describe("dbTlsEnabled", () => {
  it("is on only for exactly 'on'", () => {
    expect(dbTlsEnabled(ON)).toBe(true);
    for (const v of [undefined, "", "off", "true", "1", "ON", " on"]) {
      expect(dbTlsEnabled({ DB_TLS: v })).toBe(false);
    }
  });
});

describe("the shipped RDS CA bundle", () => {
  it("is at certs/rds-global-bundle.pem and parses as a multi-cert PEM bundle", () => {
    expect(REPO_CA).toBe(path.resolve(process.cwd(), RDS_CA_BUNDLE_RELATIVE_PATH));
    const pem = loadRdsCa(REPO_CA);
    const count = pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
    expect(count).toBeGreaterThan(10);
    expect(pem).toContain("-----END CERTIFICATE-----");
  });
});

describe("dbSslOptions", () => {
  it("flag off -> no ssl", () => {
    expect(dbSslOptions(OFF)).toBeUndefined();
    expect(dbSslOptions({ DB_TLS: "off" })).toBeUndefined();
  });

  it("flag on -> ssl with the RDS CA and rejectUnauthorized true", () => {
    const ssl = dbSslOptions(ON);
    expect(ssl).toEqual({ ca: loadRdsCa(REPO_CA), rejectUnauthorized: true });
  });

  it("flag on with a missing bundle throws instead of falling back to plaintext", () => {
    expect(() => dbSslOptions(ON, "/nonexistent/rds.pem")).toThrow(/missing/);
  });

  it("flag on with a non-PEM file throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-tls-"));
    const bad = path.join(dir, "bad.pem");
    writeFileSync(bad, "not a cert");
    expect(() => dbSslOptions(ON, bad)).toThrow(/not a PEM/);
  });
});

describe("connectionOptionsFromDsn", () => {
  const dsn = "mysql://us%40er:p%3Aw@db.example.test:3307/scholars";

  it("parses the DSN and adds no ssl when the flag is off", () => {
    expect(connectionOptionsFromDsn(dsn, OFF)).toEqual({
      host: "db.example.test",
      port: 3307,
      user: "us@er",
      password: "p:w",
      database: "scholars",
    });
  });

  it("adds verified ssl when the flag is on", () => {
    const opts = connectionOptionsFromDsn(dsn, ON);
    expect(opts.ssl).toEqual({ ca: loadRdsCa(REPO_CA), rejectUnauthorized: true });
    expect(opts.host).toBe("db.example.test");
  });

  it("omits database for a server-level DSN and defaults the port", () => {
    const opts = connectionOptionsFromDsn("mysql://u:p@h/", OFF);
    expect(opts).toEqual({ host: "h", port: 3306, user: "u", password: "p" });
  });
});

describe("mariadbPoolConfig (lib/db.ts pools)", () => {
  const url = withMariadbPoolParams("mysql://app:p%40w@db.example.test:3306/scholars");

  it("flag off -> the URL string, unchanged", () => {
    expect(mariadbPoolConfig(url, OFF)).toBe(url);
  });

  it("flag on -> a PoolConfig with verified ssl and the pool params typed as the driver parses them", () => {
    const cfg = mariadbPoolConfig(url, ON);
    expect(typeof cfg).toBe("object");
    expect(cfg).toMatchObject({
      host: "db.example.test",
      port: 3306,
      user: "app",
      password: "p@w",
      database: "scholars",
      connectTimeout: 5000,
      connectionLimit: 15,
      minimumIdle: 2,
      ssl: { ca: loadRdsCa(REPO_CA), rejectUnauthorized: true },
    });
  });

  it("flag on overrides a DSN ?ssl=true with the verified settings", () => {
    const cfg = mariadbPoolConfig("mysql://a:b@h:3306/d?ssl=true&allowPublicKeyRetrieval=false", ON);
    expect(cfg).toMatchObject({
      ssl: { rejectUnauthorized: true },
      allowPublicKeyRetrieval: false,
    });
  });
});

describe("withSchemaEngineTls (prisma.config.ts, migrate task)", () => {
  const url = "mysql://sps_migrate:pw@db.example.test:3306/scholars";

  it("flag off -> unchanged, including undefined", () => {
    expect(withSchemaEngineTls(url, OFF)).toBe(url);
    expect(withSchemaEngineTls(undefined, ON)).toBeUndefined();
  });

  it("flag on -> sslcert (absolute CA path) + sslaccept=strict", () => {
    const out = new URL(withSchemaEngineTls(url, ON)!);
    expect(out.searchParams.get("sslaccept")).toBe("strict");
    expect(out.searchParams.get("sslcert")).toBe(REPO_CA);
    expect(path.isAbsolute(out.searchParams.get("sslcert")!)).toBe(true);
    expect(out.hostname).toBe("db.example.test");
    expect(out.pathname).toBe("/scholars");
  });

  it("flag on with a missing bundle throws", () => {
    expect(() => withSchemaEngineTls(url, ON, "/nonexistent/rds.pem")).toThrow(/missing/);
  });
});
