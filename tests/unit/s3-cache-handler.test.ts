/**
 * #1503 — shared S3 ISR cacheHandler.
 *
 * Covers the two pieces of non-trivial logic: the freshness math
 * (`computeStale` — an entry is stale iff one of its tags was revalidated after
 * it was written) and fail-open (a slow/broken S3 must never throw into a
 * render or 500 an edit — get degrades to a miss, set/revalidateTag no-op).
 * Also the cross-task propagation path and Buffer round-trip through S3 JSON.
 */
import { describe, expect, it } from "vitest";
// CJS module (module.exports = class, with test hooks attached as props).
import mod from "../../lib/cache/s3-cache-handler.js";

const { createHandler, computeStale, _sha } = mod as unknown as {
  createHandler: (o: {
    client: unknown;
    bucket: string;
    now?: () => number;
  }) => {
    get: (k: string, ctx?: unknown) => Promise<{ value: unknown; lastModified: number } | null>;
    set: (k: string, data: unknown, ctx?: { tags?: string[] }) => Promise<void>;
    revalidateTag: (t: string | string[]) => Promise<void>;
  };
  computeStale: (
    entry: { lastModified: number; tags?: string[] },
    ctxTags: string[],
    ts: Record<string, number>,
  ) => boolean;
  _sha: (s: string) => string;
};

/** In-memory S3 double. Distinguishes Put (has input.Body) from Get by shape. */
function fakeS3(opts: { failAll?: boolean; failGet?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    async send(cmd: { input: { Key: string; Body?: string } }) {
      const { Key, Body } = cmd.input;
      if (opts.failAll) throw new Error("s3-down");
      if (Body !== undefined) {
        store.set(Key, Body);
        return {};
      }
      if (opts.failGet) throw new Error("s3-down");
      if (!store.has(Key)) {
        const e = new Error("nope") as Error & { name: string };
        e.name = "NoSuchKey";
        throw e;
      }
      const body = store.get(Key)!;
      return { Body: { transformToString: async () => body } };
    },
  };
}

describe("computeStale (freshness math)", () => {
  it("fresh when no tag was revalidated after the entry", () => {
    expect(computeStale({ lastModified: 100, tags: ["t"] }, [], { t: 50 })).toBe(false);
  });
  it("stale when an entry tag was revalidated after lastModified", () => {
    expect(computeStale({ lastModified: 100, tags: ["t"] }, [], { t: 150 })).toBe(true);
  });
  it("stale via an implicit ctx/path tag (revalidatePath route)", () => {
    expect(computeStale({ lastModified: 100, tags: [] }, ["/topics/x"], { "/topics/x": 200 })).toBe(
      true,
    );
  });
  it("fresh with no tags at all", () => {
    expect(computeStale({ lastModified: 100, tags: [] }, [], {})).toBe(false);
  });
  it("missing timestamp counts as never-revalidated (0)", () => {
    expect(computeStale({ lastModified: 100, tags: ["t"] }, [], {})).toBe(false);
  });
});

describe("handler get/set/revalidateTag", () => {
  it("set then get returns the value while fresh", async () => {
    const h = createHandler({ client: fakeS3(), bucket: "b", now: () => 1000 });
    await h.set("k", { kind: "PAGE", html: "<p>hi</p>" }, { tags: ["/p"] });
    const got = await h.get("k", { tags: ["/p"] });
    expect(got?.value).toEqual({ kind: "PAGE", html: "<p>hi</p>" });
    expect(got?.lastModified).toBe(1000);
  });

  it("revalidateTag makes a previously-set entry a miss (same task)", async () => {
    let t = 1000;
    const h = createHandler({ client: fakeS3(), bucket: "b", now: () => t });
    await h.set("k", { html: "old" }, { tags: ["/p"] });
    t = 2000;
    await h.revalidateTag("/p");
    expect(await h.get("k", { tags: ["/p"] })).toBeNull();
  });

  it("propagates a revalidation across tasks after the in-process TTL", async () => {
    const s3 = fakeS3();
    const writer = createHandler({ client: s3, bucket: "b", now: () => 1000 });
    await writer.set("k", { html: "v1" }, { tags: ["/p"] });

    // reader on the SAME shared store, later clock
    let rt = 1000;
    const reader = createHandler({ client: s3, bucket: "b", now: () => rt });
    expect((await reader.get("k", { tags: ["/p"] }))?.value).toEqual({ html: "v1" }); // fresh, caches tag=0

    // another task revalidates in the shared store
    await createHandler({ client: s3, bucket: "b", now: () => 5000 }).revalidateTag("/p");

    // within the 3s in-process TTL the reader still serves the cached ts=0
    rt = 1500;
    expect((await reader.get("k", { tags: ["/p"] }))?.value).toEqual({ html: "v1" });
    // past the TTL it re-reads S3, sees the newer stamp, and misses
    rt = 9000;
    expect(await reader.get("k", { tags: ["/p"] })).toBeNull();
  });

  it("round-trips a Buffer value through S3 JSON (RSC/route bodies)", async () => {
    const s3 = fakeS3();
    const writer = createHandler({ client: s3, bucket: "b", now: () => 1 });
    await writer.set("k", { kind: "ROUTE", body: Buffer.from([1, 2, 3, 255]) }, { tags: [] });
    // fresh reader forces the S3 path (JSON serialize/parse), not the LRU
    const reader = createHandler({ client: s3, bucket: "b", now: () => 1 });
    const got = (await reader.get("k")) as { value: { body: unknown } } | null;
    expect(Buffer.isBuffer(got?.value.body)).toBe(true);
    expect([...(got!.value.body as Buffer)]).toEqual([1, 2, 3, 255]);
  });
});

describe("fail-open (S3 unavailable never throws)", () => {
  it("get returns null (miss) instead of throwing on S3 error", async () => {
    const h = createHandler({ client: fakeS3({ failAll: true }), bucket: "b", now: () => 1 });
    await expect(h.get("k")).resolves.toBeNull();
  });
  it("set swallows S3 errors but keeps the entry in-process", async () => {
    const h = createHandler({ client: fakeS3({ failAll: true }), bucket: "b", now: () => 1 });
    await expect(h.set("k", { html: "x" }, { tags: [] })).resolves.toBeUndefined();
    // still served from the in-process front despite the failed S3 write
    expect((await h.get("k"))?.value).toEqual({ html: "x" });
  });
  it("revalidateTag swallows S3 errors", async () => {
    const h = createHandler({ client: fakeS3({ failAll: true }), bucket: "b", now: () => 1 });
    await expect(h.revalidateTag(["/p", "/q"])).resolves.toBeUndefined();
  });
  it("serves an LRU entry when the tag-freshness read fails (fail-open)", async () => {
    const s3 = fakeS3();
    const h = createHandler({ client: s3, bucket: "b", now: () => 1 });
    await h.set("k", { html: "x" }, { tags: ["/p"] }); // in LRU + S3
    s3.send = async () => {
      throw new Error("s3-down");
    }; // break subsequent reads
    expect((await h.get("k", { tags: ["/p"] }))?.value).toEqual({ html: "x" });
  });
});

describe("key hashing", () => {
  it("is stable and hex", () => {
    expect(_sha("route:/topics/x")).toMatch(/^[0-9a-f]{64}$/);
    expect(_sha("a")).toBe(_sha("a"));
    expect(_sha("a")).not.toBe(_sha("b"));
  });
});
