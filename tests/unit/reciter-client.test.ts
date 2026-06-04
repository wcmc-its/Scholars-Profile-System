/**
 * lib/reciter/client — the single network-touching module for ReCiter
 * gold-standard feedback (#746). Verifies the exact request contract read from
 * the ReCiter Java controller: POST /reciter/goldstandard with the pmid in
 * `rejectedPmids` and NO `goldStandardUpdateFlag` (so ReCiter defaults to the
 * additive UPDATE merge), `source=Scholars`, the `api-key` header; and the
 * GET feature-generator with `analysisRefreshFlag=true`. Plus the dormant-safe
 * config readers and the retry helper. The api key is never logged.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  isReciterRejectEnabled,
  isReciterApiConfigured,
  postGoldStandardReject,
  reciterApiConfig,
  runFeatureGenerator,
  withRetry,
} from "@/lib/reciter/client";

const CONFIG = { baseUrl: "http://reciter.test:5000", apiKey: "admin-secret" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL the mocked fetch was called with, as a parsed URL. */
function calledUrl(call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call][0]));
}
function calledInit(call = 0): RequestInit {
  return fetchMock.mock.calls[call][1] as RequestInit;
}

describe("config + flag readers", () => {
  it("isReciterRejectEnabled is true only for the exact 'on' string", () => {
    expect(isReciterRejectEnabled({ RECITER_REJECT_SEND: "on" })).toBe(true);
    expect(isReciterRejectEnabled({ RECITER_REJECT_SEND: "off" })).toBe(false);
    expect(isReciterRejectEnabled({})).toBe(false);
  });

  it("reciterApiConfig returns null unless BOTH base URL and key are set", () => {
    expect(reciterApiConfig({})).toBeNull();
    expect(reciterApiConfig({ RECITER_API_BASE_URL: "http://x" })).toBeNull();
    expect(reciterApiConfig({ RECITER_API_KEY: "k" })).toBeNull();
    expect(
      reciterApiConfig({ RECITER_API_BASE_URL: "http://x:5000", RECITER_API_KEY: "k" }),
    ).toEqual({ baseUrl: "http://x:5000", apiKey: "k" });
    expect(isReciterApiConfigured({ RECITER_API_BASE_URL: "http://x", RECITER_API_KEY: "k" })).toBe(
      true,
    );
  });
});

describe("postGoldStandardReject", () => {
  it("POSTs the reject with the right URL, header, and additive (no-flag) body", async () => {
    await postGoldStandardReject({ uid: "abc123", pmid: "12345678" }, { config: CONFIG });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = calledUrl();
    expect(url.pathname).toBe("/reciter/goldstandard");
    expect(url.searchParams.get("source")).toBe("Scholars");
    expect(url.searchParams.get("entryPath")).toBe("CANDIDATE_LIST");
    // CRITICAL: never send goldStandardUpdateFlag — ReCiter must default to the
    // additive UPDATE merge; REFRESH would overwrite the whole record.
    expect(url.searchParams.has("goldStandardUpdateFlag")).toBe(false);

    const init = calledInit();
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("admin-secret");
    expect(JSON.parse(init.body as string)).toEqual({
      uid: "abc123",
      rejectedPmids: [12345678],
    });
  });

  it("throws on a non-2xx response (caller treats it as best-effort)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401, statusText: "Unauthorized" }));
    await expect(
      postGoldStandardReject({ uid: "abc123", pmid: "12345678" }, { config: CONFIG }),
    ).rejects.toThrow(/goldstandard POST failed/);
  });

  it("rejects a non-numeric pmid before any network call", async () => {
    await expect(
      postGoldStandardReject({ uid: "abc123", pmid: "not-a-pmid" }, { config: CONFIG }),
    ).rejects.toThrow(/Invalid pmid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws (no call) when unconfigured", async () => {
    await expect(
      postGoldStandardReject({ uid: "a", pmid: "1" }, { config: reciterApiConfig({}) ?? undefined }),
    ).rejects.toThrow(/not configured/);
  });
});

describe("runFeatureGenerator", () => {
  it("GETs the per-uid re-score with analysisRefreshFlag=true and gold-standard evidence", async () => {
    await runFeatureGenerator({ uid: "abc123" }, { config: CONFIG });
    const url = calledUrl();
    expect(url.pathname).toBe("/reciter/feature-generator/by/uid");
    expect(url.searchParams.get("uid")).toBe("abc123");
    expect(url.searchParams.get("analysisRefreshFlag")).toBe("true");
    expect(url.searchParams.get("useGoldStandard")).toBe("AS_EVIDENCE");
    expect(calledInit().method).toBe("GET");
    expect((calledInit().headers as Record<string, string>)["api-key"]).toBe("admin-secret");
  });
});

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, 3, 0)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to `attempts` then rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("recovers on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, 3, 0)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
