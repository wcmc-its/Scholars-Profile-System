/**
 * cachedRead / bust with the cross-task S3 bust signal ACTIVE.
 *
 * swr-cache.ts bypasses its cache under VITEST and no-ops the signal when
 * NEXT_ISR_CACHE_BUCKET is unset, so this file stubs both env reads and
 * re-imports the module fresh per test, with @aws-sdk/client-s3 mocked.
 *
 * Covers:
 *   - a stale-window hit (15-60 min old) that another task busted is reloaded
 *     (blocking), not served stale;
 *   - an un-busted stale-window hit still serves stale + refreshes behind;
 *   - non-404 marker GET/PUT failures are logged, a 404 GET is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = send;
  }
  class GetObjectCommand {
    kind = "get";
    constructor(public input: unknown) {}
  }
  class PutObjectCommand {
    kind = "put";
    constructor(public input: unknown) {}
  }
  return { S3Client, GetObjectCommand, PutObjectCommand };
});

type Mod = typeof import("@/lib/api/swr-cache");
const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

async function load(): Promise<Mod> {
  vi.resetModules();
  return import("@/lib/api/swr-cache");
}

function marker(bustedAt: number) {
  return { Body: { transformToString: async () => JSON.stringify({ bustedAt }) } };
}

function notFound() {
  return Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
}

function denied() {
  return Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_ISR_CACHE_BUCKET", "test-bucket");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  send.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  warn.mockRestore();
});

const flush = () => new Promise((r) => setImmediate(r));

describe("cachedRead stale window honours the cross-task bust marker", () => {
  it("reloads (blocking) a stale-window entry busted by another task", async () => {
    const { cachedRead } = await load();
    send.mockRejectedValue(notFound()); // no marker on first load
    const loader = vi.fn().mockResolvedValueOnce("pre-edit").mockResolvedValueOnce("post-edit");

    expect(await cachedRead("department:detail:x", loader)).toBe("pre-edit");

    // 20 min later (stale window); another task busted "department:" at T0+10m.
    vi.setSystemTime(T0 + 20 * MIN);
    send.mockResolvedValue(marker(T0 + 10 * MIN));

    expect(await cachedRead("department:detail:x", loader)).toBe("post-edit");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("still serves stale and refreshes in the background when not busted", async () => {
    const { cachedRead } = await load();
    send.mockRejectedValue(notFound());
    const loader = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");

    expect(await cachedRead("center:detail:y", loader)).toBe("v1");
    vi.setSystemTime(T0 + 20 * MIN);

    expect(await cachedRead("center:detail:y", loader)).toBe("v1");
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await cachedRead("center:detail:y", loader)).toBe("v2");
  });
});

describe("bust marker failure logging", () => {
  const logged = () =>
    (warn.mock.calls as unknown[][])
      .map((c): { event?: string } | null => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .filter((x) => x?.event === "swr_bust_marker_failed");

  it("does not log a 404/NoSuchKey on marker GET", async () => {
    const { cachedRead } = await load();
    send.mockRejectedValue(notFound());
    await cachedRead("division:a", async () => 1);
    vi.setSystemTime(T0 + 1 * MIN);
    await cachedRead("division:a", async () => 1);
    expect(send).toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it("logs a non-404 GET failure (e.g. AccessDenied)", async () => {
    const { cachedRead } = await load();
    send.mockRejectedValue(denied());
    await cachedRead("division:a", async () => 1);
    vi.setSystemTime(T0 + 1 * MIN);
    expect(await cachedRead("division:a", async () => 2)).toBe(1); // fails open
    expect(logged()).toEqual([
      { event: "swr_bust_marker_failed", op: "get", prefix: "division:", error: "AccessDenied" },
    ]);
  });

  it("logs a failed marker PUT from bust()", async () => {
    const { bust } = await load();
    send.mockRejectedValue(denied());
    expect(() => bust("department:")).not.toThrow();
    await flush();
    expect(logged()).toEqual([
      { event: "swr_bust_marker_failed", op: "put", prefix: "department:", error: "AccessDenied" },
    ]);
  });
});
