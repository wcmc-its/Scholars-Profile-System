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
  fetchSuggestedArticles,
  fetchSuggestedArticlesViaApi,
  formatSuggestionAuthors,
  isReciterRejectEnabled,
  isReciterApiConfigured,
  postGoldStandardReject,
  preferReciterApiSource,
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

describe("preferReciterApiSource", () => {
  it("is true only for the exact 'api' string", () => {
    expect(preferReciterApiSource({ RECITER_PENDING_SOURCE: "api" })).toBe(true);
    expect(preferReciterApiSource({ RECITER_PENDING_SOURCE: "off" })).toBe(false);
    expect(preferReciterApiSource({})).toBe(false);
  });
});

describe("fetchSuggestedArticlesViaApi", () => {
  /** One reCiterArticleFeature as the FG response carries it. */
  function feat(pmid: number, score: number, userAssertion = "NULL") {
    return {
      pmid,
      authorshipLikelihoodScore: score,
      userAssertion,
      articleTitle: `Article ${pmid}`,
      journalTitleVerbose: `Journal ${pmid}`,
      publicationDateDisplay: "2025 May 28",
      publicationType: { publicationTypeCanonical: "Academic Article" },
      reCiterArticleAuthorFeatures: [{ rank: 1, firstName: "Ada", lastName: "Lovelace" }],
    };
  }
  const jsonResponse = (body: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("GETs the cached FG analysis (analysisRefreshFlag=false) with the api-key header", async () => {
    jsonResponse({ reCiterArticleFeatures: [feat(111, 55), feat(222, 92), feat(333, 73)] });

    const out = await fetchSuggestedArticlesViaApi("abc123", { config: CONFIG });

    const url = calledUrl();
    expect(url.pathname).toBe("/reciter/feature-generator/by/uid");
    expect(url.searchParams.get("uid")).toBe("abc123");
    // CRITICAL: must NOT trigger the heavy synchronous re-run.
    expect(url.searchParams.get("analysisRefreshFlag")).toBe("false");
    expect(calledInit().method).toBe("GET");
    expect((calledInit().headers as Record<string, string>)["api-key"]).toBe("admin-secret");
    // score>=40, sorted desc; no GoldStandard cross-check needed.
    expect(out.map((s) => s.pmid)).toEqual(["222", "333", "111"]);
    expect(out[0]).toMatchObject({ score: 92, articleTitle: "Article 222" });
  });

  it("drops ACCEPTED/REJECTED (userAssertion-only filter) and sub-40 scores", async () => {
    jsonResponse({
      reCiterArticleFeatures: [
        feat(111, 90, "ACCEPTED"), // already curated
        feat(222, 88, "REJECTED"), // already curated
        feat(333, 39), // below threshold
        feat(444, 70), // genuinely new
      ],
    });
    const out = await fetchSuggestedArticlesViaApi("abc123", { config: CONFIG });
    expect(out.map((s) => s.pmid)).toEqual(["444"]);
  });

  it("tolerates the wrapped { reCiterFeature: {...} } and list response shapes", async () => {
    jsonResponse({ reCiterFeature: { reCiterArticleFeatures: [feat(111, 80)] } });
    expect((await fetchSuggestedArticlesViaApi("a", { config: CONFIG })).map((s) => s.pmid)).toEqual([
      "111",
    ]);

    jsonResponse([{ reCiterArticleFeatures: [feat(222, 81)] }]);
    expect((await fetchSuggestedArticlesViaApi("a", { config: CONFIG })).map((s) => s.pmid)).toEqual([
      "222",
    ]);
  });

  it("degrades to [] on a non-2xx, and never calls the engine when unconfigured", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    expect(await fetchSuggestedArticlesViaApi("a", { config: CONFIG })).toEqual([]);

    fetchMock.mockClear();
    expect(
      await fetchSuggestedArticlesViaApi("a", { config: reciterApiConfig({}) ?? undefined }),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchSuggestedArticles", () => {
  /** Build one reCiterArticleFeature object (the Analysis list entry shape). */
  function feature(
    pmid: number,
    score: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      pmid,
      authorshipLikelihoodScore: score,
      userAssertion: "NULL",
      articleTitle: `Article ${pmid}`,
      journalTitleVerbose: `Journal ${pmid}`,
      publicationDateDisplay: "2025 May 28",
      publicationType: { publicationTypeCanonical: "Academic Article" },
      reCiterArticleAuthorFeatures: [
        { rank: 1, firstName: "Ada", lastName: "Lovelace" },
        { rank: 2, firstName: "Alan", lastName: "Turing" },
      ],
      ...extra,
    };
  }

  type GsItem =
    | { knownpmids?: number[]; rejectedpmids?: number[] }
    | undefined
    | "throw";
  type AnItem =
    | { reCiterFeature: { reCiterArticleFeatures: unknown[] } } // inline
    | { uid: string; usingS3: true } // offloaded (no inline reCiterFeature)
    | undefined;

  /**
   * A fake DynamoDBDocumentClient: `.send(GetCommand)` resolves `{ Item }`
   * keyed by the command's `TableName` (GoldStandard vs Analysis). A "throw"
   * GoldStandard item simulates an unreadable table (the degrade-to-[] path).
   */
  function fakeDdb(gs: GsItem, an: AnItem) {
    const send = vi.fn((command: { input: { TableName: string; Key: unknown } }) => {
      const table = command.input.TableName;
      if (table === "GoldStandard") {
        if (gs === "throw") return Promise.reject(new Error("GoldStandard unreadable"));
        return Promise.resolve({ Item: gs });
      }
      if (table === "Analysis") return Promise.resolve({ Item: an });
      return Promise.resolve({ Item: undefined });
    });
    return { client: { send } as never, send };
  }

  /** A fake S3Client: `.send(GetObjectCommand)` returns a body of the given JSON. */
  function fakeS3(json: unknown) {
    const send = vi.fn((_command: { input: { Bucket: string; Key: string } }) =>
      Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(json)) },
      }),
    );
    return { client: { send } as never, send };
  }

  const noS3 = fakeS3(null).client; // never reached in inline-path tests

  it("returns score>=40, uncurated suggestions sorted by score desc", async () => {
    const ddb = fakeDdb(
      { knownpmids: [], rejectedpmids: [] },
      {
        reCiterFeature: {
          reCiterArticleFeatures: [feature(111, 55), feature(222, 92), feature(333, 73)],
        },
      },
    );

    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out.map((s) => s.pmid)).toEqual(["222", "333", "111"]);
    expect(out.map((s) => s.score)).toEqual([92, 73, 55]);
    expect(out[0]).toMatchObject({
      articleTitle: "Article 222",
      journal: "Journal 222",
      datePublished: "2025 May 28",
      isPreprint: false,
      authors: "Ada Lovelace, Alan Turing",
    });

    // Read both tables by uid (key); the S3 fallback is never hit inline.
    expect(ddb.send).toHaveBeenCalledTimes(2);
    const tables = ddb.send.mock.calls.map((c) => c[0].input.TableName).sort();
    expect(tables).toEqual(["Analysis", "GoldStandard"]);
    const keys = ddb.send.mock.calls.map((c) => c[0].input.Key);
    for (const k of keys) expect(k).toEqual({ uid: "abc123" });
  });

  it("drops a pmid in knownpmids/rejectedpmids even when userAssertion is NULL (freshness)", async () => {
    const ddb = fakeDdb(
      { knownpmids: [111], rejectedpmids: [222] },
      {
        reCiterFeature: {
          reCiterArticleFeatures: [
            feature(111, 90), // freshly accepted -> in knownpmids
            feature(222, 80), // freshly rejected -> in rejectedpmids
            feature(333, 70), // genuinely new
          ],
        },
      },
    );

    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out.map((s) => s.pmid)).toEqual(["333"]);
  });

  it("returns [] when the GoldStandard read THROWS (cannot apply freshness filter)", async () => {
    const ddb = fakeDdb("throw", {
      reCiterFeature: { reCiterArticleFeatures: [feature(111, 90)] },
    });
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out).toEqual([]);
  });

  it("returns candidates when the GoldStandard item is MISSING (uncurated scholar is normal)", async () => {
    // Item undefined ⇒ empty curated set ⇒ everything qualifying is kept.
    const ddb = fakeDdb(undefined, {
      reCiterFeature: { reCiterArticleFeatures: [feature(111, 90), feature(222, 75)] },
    });
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out.map((s) => s.pmid)).toEqual(["111", "222"]);
  });

  it("reads OFFLOADED analysis from S3 when the item has no inline reCiterFeature", async () => {
    // Analysis item present but carries only uid/usingS3 ⇒ the full object is in
    // S3, whose top level IS the reCiterFeature object.
    const ddb = fakeDdb({ knownpmids: [222], rejectedpmids: [] }, {
      uid: "abc123",
      usingS3: true,
    });
    const s3 = fakeS3({
      reCiterArticleFeatures: [feature(111, 91), feature(222, 80), feature(333, 60)],
    });

    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: s3.client });
    expect(s3.send).toHaveBeenCalledTimes(1);
    const s3Input = s3.send.mock.calls[0][0].input as { Bucket: string; Key: string };
    expect(s3Input.Bucket).toBe("reciter-dynamodb");
    expect(s3Input.Key).toBe("AnalysisOutput/abc123");
    // 222 is curated (rejected) ⇒ dropped; 111 + 333 kept, sorted desc.
    expect(out.map((s) => s.pmid)).toEqual(["111", "333"]);
  });

  it("drops candidates scoring below 40", async () => {
    const ddb = fakeDdb(
      { knownpmids: [], rejectedpmids: [] },
      {
        reCiterFeature: {
          reCiterArticleFeatures: [feature(111, 39), feature(222, 40)],
        },
      },
    );
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out.map((s) => s.pmid)).toEqual(["222"]);
  });

  it("flags a Preprint and falls back journal/date to null", async () => {
    const ddb = fakeDdb(
      { knownpmids: [], rejectedpmids: [] },
      {
        reCiterFeature: {
          reCiterArticleFeatures: [
            feature(111, 88, {
              publicationType: { publicationTypeCanonical: "Preprint" },
              journalTitleVerbose: "",
              publicationDateDisplay: "",
            }),
          ],
        },
      },
    );
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out[0]).toMatchObject({ isPreprint: true, journal: null, datePublished: null });
  });

  it("truncates the author byline to first 6, ellipsis, last (>8 authors)", async () => {
    const manyAuthors = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      firstName: `F${i + 1}`,
      lastName: `L${i + 1}`,
    }));
    const ddb = fakeDdb(
      { knownpmids: [], rejectedpmids: [] },
      {
        reCiterFeature: {
          reCiterArticleFeatures: [
            feature(111, 70, { reCiterArticleAuthorFeatures: manyAuthors }),
          ],
        },
      },
    );
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: noS3 });
    expect(out[0].authors).toBe("F1 L1, F2 L2, F3 L3, F4 L4, F5 L5, F6 L6, …, F10 L10");
  });

  it("returns [] when the Analysis item is absent (no candidates, no S3 read)", async () => {
    const ddb = fakeDdb({ knownpmids: [], rejectedpmids: [] }, undefined);
    const s3 = fakeS3(null);
    const out = await fetchSuggestedArticles("abc123", { ddb: ddb.client, s3: s3.client });
    expect(out).toEqual([]);
    expect(s3.send).not.toHaveBeenCalled();
  });
});

describe("formatSuggestionAuthors", () => {
  it("orders by rank and renders 'First Last' joined by ', '", () => {
    const out = formatSuggestionAuthors([
      { rank: 2, firstName: "Alan", lastName: "Turing" },
      { rank: 1, firstName: "Ada", lastName: "Lovelace" },
    ]);
    expect(out).toBe("Ada Lovelace, Alan Turing");
  });

  it("collapses >8 authors to first 6, ellipsis, then the last author", () => {
    const features = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      firstName: `F${i + 1}`,
      lastName: `L${i + 1}`,
    }));
    const out = formatSuggestionAuthors(features);
    expect(out).toBe("F1 L1, F2 L2, F3 L3, F4 L4, F5 L5, F6 L6, …, F10 L10");
  });

  it("keeps exactly 8 authors fully expanded", () => {
    const features = Array.from({ length: 8 }, (_, i) => ({
      rank: i + 1,
      firstName: `F${i + 1}`,
      lastName: `L${i + 1}`,
    }));
    expect(formatSuggestionAuthors(features)).not.toContain("…");
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
