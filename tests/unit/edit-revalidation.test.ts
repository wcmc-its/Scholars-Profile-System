import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindUnique,
  mockPublicationAuthorFindMany,
  mockRevalidatePath,
  mockCdnCreate,
  mockCdnUpdate,
  mockCfSend,
  deferredTasks,
} = vi.hoisted(() => ({
  mockScholarFindUnique: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCdnCreate: vi.fn(),
  mockCdnUpdate: vi.fn(),
  mockCfSend: vi.fn(),
  // #955 #6 — `runAfterResponse` defers the CloudFront send off the request
  // path. Capture each scheduled task so a test can assert it was NOT run
  // in-request, then `flushDeferred()` to drive the deferred send + bookkeeping.
  deferredTasks: [] as Array<() => Promise<void>>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockScholarFindUnique },
      publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    },
    write: {
      cdnInvalidation: { create: mockCdnCreate, update: mockCdnUpdate },
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
// Capture deferred tasks instead of scheduling them on Next's `after()`, which
// is unavailable outside a request scope in a unit test.
vi.mock("@/lib/edit/after-response", () => ({
  runAfterResponse: (task: () => Promise<void>) => {
    deferredTasks.push(task);
  },
}));
// Mock the CloudFront SDK so the enqueue/mark path runs without real AWS.
vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: vi.fn().mockImplementation(() => ({ send: mockCfSend })),
  CreateInvalidationCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import {
  reflectOverviewEdit,
  reflectUnitChange,
  reflectVisibilityChange,
  resolveAffectedProfiles,
} from "@/lib/edit/revalidation";

/** Run everything `runAfterResponse` deferred, mimicking the post-response tick. */
async function flushDeferred(): Promise<void> {
  const tasks = deferredTasks.splice(0);
  for (const task of tasks) await task();
}

beforeEach(() => {
  vi.clearAllMocks();
  deferredTasks.length = 0;
  delete process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
  mockCdnCreate.mockResolvedValue({ id: "row-1" });
  mockCdnUpdate.mockResolvedValue({});
  mockCfSend.mockResolvedValue({});
});

describe("resolveAffectedProfiles", () => {
  it("resolves a scholar target to that scholar's slug + cwid", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "jane-smith", cwid: "cwid1" });
    expect(await resolveAffectedProfiles("scholar", "cwid1", null)).toEqual([
      { slug: "jane-smith", cwid: "cwid1" },
    ]);
  });

  it("returns nothing for a scholar with no row", async () => {
    mockScholarFindUnique.mockResolvedValue(null);
    expect(await resolveAffectedProfiles("scholar", "cwid1", null)).toEqual([]);
  });

  it("resolves a per-author publication suppression to the contributor's slug + cwid", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "bob-jones", cwid: "cwid2" });
    expect(await resolveAffectedProfiles("publication", "999", "cwid2")).toEqual([
      { slug: "bob-jones", cwid: "cwid2" },
    ]);
  });

  it("resolves a whole-publication takedown to every confirmed WCM author's slug + cwid", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([
      { cwid: "a", scholar: { slug: "a-one" } },
      { cwid: "b", scholar: { slug: "b-two" } },
      { cwid: "c", scholar: null },
    ]);
    expect(await resolveAffectedProfiles("publication", "999", null)).toEqual([
      { slug: "a-one", cwid: "a" },
      { slug: "b-two", cwid: "b" },
    ]);
  });
});

describe("reflectOverviewEdit", () => {
  it("revalidates only the profile page", async () => {
    await reflectOverviewEdit("jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });

  it("enqueues the outbox row in-path and defers the CloudFront send", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    await reflectOverviewEdit("jane-smith");
    // Durable row enqueued synchronously (#353 backstop stays in the request).
    expect(mockCdnCreate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockCdnCreate.mock.calls[0][0].data.paths)).toEqual([
      "/scholars/jane-smith",
    ]);
    // The slow AWS send is deferred — not issued when the response returns.
    expect(mockCfSend).not.toHaveBeenCalled();
    await flushDeferred();
    expect(mockCfSend).toHaveBeenCalledTimes(1);
  });
});

describe("reflectUnitChange", () => {
  it("revalidates the unit page and /browse for a department edit", async () => {
    await reflectUnitChange({ unitKind: "department", unitSlug: "medicine" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/departments/medicine");
  });

  it("enqueues a CloudFront invalidation for the unit page and /browse", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    await reflectUnitChange({ unitKind: "department", unitSlug: "medicine" });
    expect(mockCdnCreate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockCdnCreate.mock.calls[0][0].data.paths)).toEqual([
      "/browse",
      "/departments/medicine",
    ]);
    expect(mockCfSend).not.toHaveBeenCalled();
    await flushDeferred();
    expect(mockCfSend).toHaveBeenCalledTimes(1);
  });

  it("enqueues both the old and new center slug paths on a slug change", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    await reflectUnitChange({
      unitKind: "center",
      unitSlug: "new-center",
      previousSlug: "old-center",
    });
    expect(JSON.parse(mockCdnCreate.mock.calls[0][0].data.paths)).toEqual([
      "/browse",
      "/centers/new-center",
      "/centers/old-center",
    ]);
    await flushDeferred();
    expect(mockCfSend).toHaveBeenCalledTimes(1);
  });

  it("is dormant when no distribution id is set: no enqueue, no send", async () => {
    // beforeEach already deletes SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID.
    await reflectUnitChange({ unitKind: "department", unitSlug: "medicine" });
    expect(mockCdnCreate).not.toHaveBeenCalled();
    expect(mockCfSend).not.toHaveBeenCalled();
  });
});

describe("reflectVisibilityChange", () => {
  it("revalidates /browse and each affected profile page", async () => {
    await reflectVisibilityChange(["jane-smith", "bob-jones"]);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/bob-jones");
  });

  it("skips a path that is not on the shared allow-list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reflectVisibilityChange(["bad slug"]);
    expect(mockRevalidatePath).not.toHaveBeenCalledWith("/scholars/bad slug");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
    warn.mockRestore();
  });
});

describe("invalidateCloudFront enqueue/mark (#353 outbox)", () => {
  // Exercised through reflectVisibilityChange, which calls invalidateCloudFront.
  it("is dormant when no distribution id is set: no enqueue, no send", async () => {
    // beforeEach already deletes SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID.
    await reflectVisibilityChange(["jane-smith"]);
    expect(mockCdnCreate).not.toHaveBeenCalled();
    expect(mockCfSend).not.toHaveBeenCalled();
    expect(mockCdnUpdate).not.toHaveBeenCalled();
  });

  it("enqueues the exact paths (JSON) in-path and, on the deferred send, stamps invalidatedAt", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";

    await reflectVisibilityChange(["jane-smith"]);

    // Enqueued pending row remembering the literal paths (not recomputable) —
    // synchronously, before the response returns.
    expect(mockCdnCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCdnCreate.mock.calls[0][0];
    expect(JSON.parse(createArg.data.paths)).toEqual(["/browse", "/scholars/jane-smith"]);
    expect(createArg.data.attempts).toBe(0);

    // Neither the send nor the stamp has happened yet — both are deferred.
    expect(mockCfSend).not.toHaveBeenCalled();
    expect(mockCdnUpdate).not.toHaveBeenCalled();

    await flushDeferred();

    // CreateInvalidation issued for those paths, sentinel stamped on success.
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockCdnUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "row-1" });
    expect(updateArg.data.invalidatedAt).toBeInstanceOf(Date);
  });

  it("on a failed deferred send, records attempts=1 + lastError and leaves the row pending (no invalidatedAt)", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    mockCfSend.mockRejectedValue(new Error("cloudfront 503"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // The in-request call returns once the row is enqueued (send still deferred).
    await expect(reflectVisibilityChange(["jane-smith"])).resolves.toBeUndefined();
    expect(mockCdnCreate).toHaveBeenCalledTimes(1);

    // The deferred send fails best-effort — never thrown into the (already sent)
    // response — and records the retry budget for the #353 reconciler.
    await expect(flushDeferred()).resolves.toBeUndefined();
    expect(mockCdnUpdate).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate.mock.calls[0][0]).toEqual({
      where: { id: "row-1" },
      data: { attempts: 1, lastError: "cloudfront 503" },
    });
    const failLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_cdn_invalidation_failed");
    expect(failLog).toMatchObject({ error: "cloudfront 503" });
    consoleError.mockRestore();
  });

  it("a DB enqueue failure is logged in-path, not thrown, and still defers a one-shot send", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    mockCdnCreate.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(reflectVisibilityChange(["jane-smith"])).resolves.toBeUndefined();
    // The enqueue failure is logged synchronously in the request path.
    const enqLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_cdn_invalidation_enqueue_failed");
    expect(enqLog).toMatchObject({ error: "db down" });

    await flushDeferred();
    // Enqueue failed → no row to mark, but the purge is still attempted.
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
