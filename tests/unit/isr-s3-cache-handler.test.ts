import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// CJS handler (loaded by Next via require at runtime); default export is the
// class, with a `__test` surface attached.
import Handler from "@/lib/cache/isr-s3-cache-handler.js";

interface Entry {
  value: {
    html: string;
    rscData: Buffer;
    segmentData: Map<string, Buffer>;
    headers: Record<string, string>;
  };
  lastModified: number;
  tags: string[];
}
interface TestSurface {
  serialize: (v: unknown) => string;
  deserialize: (s: string) => Entry;
  keyFor: (k: string) => string;
  tagKeyFor: (t: string) => string;
  setS3Client: (c: unknown) => void;
  reset: () => void;
  clearTaskCaches: () => void;
}
const T = (Handler as unknown as { __test: TestSurface }).__test;

function assertPresent<V>(v: V | null): asserts v is V {
  if (v === null) throw new Error("expected a non-null cache entry");
}

// Minimal fake S3 client: routes on command class name, keyed object store.
interface FakeCommand {
  constructor: { name: string };
  input: { Key: string; Body?: string };
}
class FakeS3 {
  store = new Map<string, string>();
  puts: Array<{ Key: string; Body: string }> = [];
  failWith: Error | null = null;
  hang = false;

  send(command: FakeCommand, opts?: { abortSignal?: AbortSignal }) {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.hang) {
      // Never resolves on its own; settles only when the caller aborts (mirrors
      // the real SDK aborting an in-flight request on timeout).
      return new Promise((_resolve, reject) => {
        opts?.abortSignal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    const name = command.constructor.name;
    const { Key, Body } = command.input;
    if (name.startsWith("Put")) {
      this.store.set(Key, String(Body));
      this.puts.push({ Key, Body: String(Body) });
      return Promise.resolve({});
    }
    if (name.startsWith("Get")) {
      if (!this.store.has(Key)) {
        const e = new Error("missing");
        e.name = "NoSuchKey";
        return Promise.reject(e);
      }
      const body = this.store.get(Key) as string;
      return Promise.resolve({ Body: { transformToString: async () => body } });
    }
    return Promise.resolve({});
  }
}

// An APP_PAGE-ish cache value with the binary + Map fields Next actually stores,
// plus the implicit path tag in the header (how pages carry tags).
function appPageValue(tag: string) {
  return {
    kind: "APP_PAGE",
    html: "<html>hi</html>",
    rscData: Buffer.from([1, 2, 3, 250, 251]),
    postponed: undefined,
    status: 200,
    headers: { "x-next-cache-tags": tag },
    segmentData: new Map<string, Buffer>([["/seg", Buffer.from("abc")]]),
  };
}

let fake: FakeS3;
beforeEach(() => {
  T.reset();
  fake = new FakeS3();
  T.setS3Client(fake);
  process.env.NEXT_ISR_CACHE_BUCKET = "test-bucket";
});
afterEach(() => {
  T.reset();
  delete process.env.NEXT_ISR_CACHE_BUCKET;
  vi.useRealTimers();
});

describe("serialize/deserialize", () => {
  it("round-trips Buffers and Maps inside a nested value", () => {
    const v = appPageValue("t1");
    const entry = { value: v, lastModified: 123, tags: [] };
    const out = T.deserialize(T.serialize(entry));
    expect(out.lastModified).toBe(123);
    expect(out.value.html).toBe("<html>hi</html>");
    expect(Buffer.isBuffer(out.value.rscData)).toBe(true);
    expect(out.value.rscData.equals(v.rscData)).toBe(true);
    expect(out.value.segmentData instanceof Map).toBe(true);
    expect(out.value.segmentData.get("/seg")?.equals(Buffer.from("abc"))).toBe(
      true,
    );
  });
});

describe("key scheme", () => {
  it("is deterministic, prefixed, and hashed (not the raw key)", () => {
    expect(T.keyFor("/topics/x")).toBe(T.keyFor("/topics/x"));
    expect(T.keyFor("/topics/x")).not.toBe(T.keyFor("/topics/y"));
    expect(T.keyFor("/a").startsWith("next-isr-cache/v1/")).toBe(true);
    expect(T.keyFor("/a")).not.toContain("/topics"); // hashed, no raw path
  });
});

describe("get/set round-trip", () => {
  it("serves from S3 after the per-task front cache is cleared, Buffers intact", async () => {
    const h = new Handler({ revalidatedTags: [] });
    await h.set("/topics/foo", appPageValue("t"), {});
    // Force the S3 read path (a cold task has an empty front cache).
    T.clearTaskCaches();
    const got = await h.get("/topics/foo", {});
    assertPresent(got);
    expect(got.value.html).toBe("<html>hi</html>");
    expect(Buffer.isBuffer(got.value.rscData)).toBe(true);
    expect(got.value.segmentData.get("/seg").toString()).toBe("abc");
    // exactly one page object written under the versioned prefix
    expect(fake.puts.some((p) => p.Key.startsWith("next-isr-cache/v1/"))).toBe(
      true,
    );
  });
});

describe("tag revalidation (freshness)", () => {
  it("a fresh entry is served; revalidating its tag makes it stale", async () => {
    const h = new Handler({ revalidatedTags: [] });
    await h.set("/topics/foo", appPageValue("_N_T_/topics/foo"), {});
    expect(await h.get("/topics/foo", {})).not.toBeNull();

    await h.revalidateTag("_N_T_/topics/foo");
    expect(await h.get("/topics/foo", {})).toBeNull();
  });

  it("revalidation on one task is visible to another task via S3", async () => {
    const a = new Handler({ revalidatedTags: [] });
    await a.set("/topics/foo", appPageValue("_N_T_/topics/foo"), {});
    await a.revalidateTag("_N_T_/topics/foo"); // writes the tag object to S3

    // Simulate a different task: same shared S3, empty local caches.
    T.clearTaskCaches();
    const b = new Handler({ revalidatedTags: [] });
    expect(await b.get("/topics/foo", {})).toBeNull();
  });

  it("honors the per-request revalidatedTags for instant same-request consistency", async () => {
    const writer = new Handler({ revalidatedTags: [] });
    await writer.set("/topics/foo", appPageValue("_N_T_/topics/foo"), {});
    const reader = new Handler({ revalidatedTags: ["_N_T_/topics/foo"] });
    expect(await reader.get("/topics/foo", {})).toBeNull();
  });
});

describe("S3 failure is always safe", () => {
  it("get returns null (never throws) when S3 errors", async () => {
    const h = new Handler({ revalidatedTags: [] });
    await h.set("/topics/foo", appPageValue("t"), {});
    T.clearTaskCaches(); // force the S3 read
    fake.failWith = new Error("s3 down");
    await expect(h.get("/topics/foo", {})).resolves.toBeNull();
  });

  it("set and revalidateTag never throw when S3 errors", async () => {
    const h = new Handler({ revalidatedTags: [] });
    fake.failWith = new Error("s3 down");
    await expect(
      h.set("/topics/foo", appPageValue("t"), {}),
    ).resolves.toBeUndefined();
    await expect(h.revalidateTag("t")).resolves.toBeUndefined();
  });

  it("get returns null within the timeout when S3 hangs", async () => {
    vi.useFakeTimers();
    const h = new Handler({ revalidatedTags: [] });
    // seed the store then leave the front empty so get must hit the (hanging) S3
    fake.store.set(
      T.keyFor("/topics/foo"),
      T.serialize({ value: appPageValue("t"), lastModified: 1, tags: [] }),
    );
    fake.hang = true;
    const p = h.get("/topics/foo", {});
    await vi.advanceTimersByTimeAsync(300); // past the 250ms timeout
    await expect(p).resolves.toBeNull();
  });
});

describe("disabled (no bucket configured)", () => {
  it("get returns null and set is a no-op front cache write", async () => {
    delete process.env.NEXT_ISR_CACHE_BUCKET;
    const h = new Handler({ revalidatedTags: [] });
    await h.set("/topics/foo", appPageValue("t"), {});
    expect(fake.puts.length).toBe(0); // nothing written to S3
    // still served from the in-process front cache within the same task
    expect(await h.get("/topics/foo", {})).not.toBeNull();
  });
});
