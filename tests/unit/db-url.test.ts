import { describe, expect, it } from "vitest";
import { MARIADB_POOL_PARAMS, withMariadbPoolParams } from "@/lib/db-url";

describe("withMariadbPoolParams", () => {
  it("adds connectTimeout and connectionLimit to a bare URL", () => {
    const out = new URL(
      withMariadbPoolParams("mysql://app:pw@host:3306/scholars"),
    );
    expect(out.searchParams.get("connectTimeout")).toBe("5000");
    expect(out.searchParams.get("connectionLimit")).toBe("15");
  });

  it("adds a low minimumIdle so idle pool connections reap instead of pinning connectionLimit", () => {
    const out = new URL(
      withMariadbPoolParams("mysql://app:pw@host:3306/scholars"),
    );
    expect(out.searchParams.get("minimumIdle")).toBe("2");
    // Must stay below connectionLimit -- at minimumIdle == connectionLimit the
    // mariadb driver never reaps idle connections, which pins the pool at its
    // full budget (the sps-aurora-connections-prod flat-90 regression).
    expect(Number(out.searchParams.get("minimumIdle"))).toBeLessThan(
      Number(out.searchParams.get("connectionLimit")),
    );
  });

  it("preserves an explicit value already on the URL (secret wins)", () => {
    const out = new URL(
      withMariadbPoolParams(
        "mysql://app:pw@host:3306/scholars?connectTimeout=12000",
      ),
    );
    // The caller-supplied value must not be overwritten.
    expect(out.searchParams.get("connectTimeout")).toBe("12000");
    // The missing one is still filled in.
    expect(out.searchParams.get("connectionLimit")).toBe("15");
  });

  it("preserves credentials, host, port, and database", () => {
    const out = new URL(
      withMariadbPoolParams("mysql://app:p%40ss@db.internal:3307/scholars"),
    );
    expect(out.protocol).toBe("mysql:");
    expect(out.username).toBe("app");
    // A password with an encoded special char round-trips intact.
    expect(decodeURIComponent(out.password)).toBe("p@ss");
    expect(out.hostname).toBe("db.internal");
    expect(out.port).toBe("3307");
    expect(out.pathname).toBe("/scholars");
  });

  it("is idempotent", () => {
    const once = withMariadbPoolParams("mysql://app:pw@host:3306/scholars");
    const twice = withMariadbPoolParams(once);
    expect(twice).toBe(once);
  });

  it("leaves an unparseable connection string untouched", () => {
    expect(withMariadbPoolParams("not a url")).toBe("not a url");
  });

  it("keeps an existing unrelated query param", () => {
    const out = new URL(
      withMariadbPoolParams(
        "mysql://app:pw@host:3306/scholars?sslmode=require",
      ),
    );
    expect(out.searchParams.get("sslmode")).toBe("require");
    expect(out.searchParams.get("connectTimeout")).toBe(
      MARIADB_POOL_PARAMS.connectTimeout,
    );
  });
});
