import { afterEach, describe, expect, it, vi } from "vitest";

import { getJson } from "@/lib/seo/openalex";

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? JSON.stringify({ ok: true }) : "", { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAlex getJson retry", () => {
  it("retries a 429, honouring Retry-After, then returns the body", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(429, { "retry-after": "5" }))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetch);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(getJson("https://api.openalex.org/works", undefined, sleep)).resolves.toEqual({
      ok: true,
    });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("backs off 2s/4s/8s on 5xx and network errors, then gives up", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(503));
    vi.stubGlobal("fetch", fetch);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(getJson("https://api.openalex.org/works", undefined, sleep)).rejects.toThrow(
      "OpenAlex HTTP 503",
    );
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a 4xx other than 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(401)));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(getJson("https://api.openalex.org/works", undefined, sleep)).rejects.toThrow(
      "OpenAlex HTTP 401",
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends OPENALEX_API_KEY but keeps it out of the error message", async () => {
    vi.stubEnv("OPENALEX_API_KEY", "k3y");
    const fetch = vi.fn().mockResolvedValue(res(403));
    vi.stubGlobal("fetch", fetch);
    const err = await getJson("https://api.openalex.org/works?x=1", "a@b.c").catch((e) => e);
    expect(fetch.mock.calls[0][0]).toBe("https://api.openalex.org/works?x=1&mailto=a%40b.c&api_key=k3y");
    expect(String(err)).not.toContain("k3y");
  });
});
