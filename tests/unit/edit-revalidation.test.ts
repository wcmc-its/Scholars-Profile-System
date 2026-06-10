import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindUnique,
  mockPublicationAuthorFindMany,
  mockRevalidatePath,
  mockCdnCreate,
  mockCdnUpdate,
  mockCfSend,
} = vi.hoisted(() => ({
  mockScholarFindUnique: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCdnCreate: vi.fn(),
  mockCdnUpdate: vi.fn(),
  mockCfSend: vi.fn(),
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
// Mock the CloudFront SDK so the enqueue/mark path runs without real AWS.
vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: vi.fn().mockImplementation(() => ({ send: mockCfSend })),
  CreateInvalidationCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import {
  reflectOverviewEdit,
  reflectVisibilityChange,
  resolveAffectedProfiles,
} from "@/lib/edit/revalidation";

beforeEach(() => {
  vi.clearAllMocks();
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
  it("revalidates only the profile page", () => {
    reflectOverviewEdit("jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
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

  it("enqueues the exact paths (JSON) and, on a successful send, stamps invalidatedAt", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";

    await reflectVisibilityChange(["jane-smith"]);

    // Enqueued pending row remembering the literal paths (not recomputable).
    expect(mockCdnCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCdnCreate.mock.calls[0][0];
    expect(JSON.parse(createArg.data.paths)).toEqual(["/browse", "/scholars/jane-smith"]);
    expect(createArg.data.attempts).toBe(0);

    // CreateInvalidation issued for those paths.
    expect(mockCfSend).toHaveBeenCalledTimes(1);

    // Sentinel stamped on success.
    expect(mockCdnUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockCdnUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "row-1" });
    expect(updateArg.data.invalidatedAt).toBeInstanceOf(Date);
  });

  it("on a failed send, records attempts=1 + lastError and leaves the row pending (no invalidatedAt)", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    mockCfSend.mockRejectedValue(new Error("cloudfront 503"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw into the caller.
    await expect(reflectVisibilityChange(["jane-smith"])).resolves.toBeUndefined();

    expect(mockCdnCreate).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate.mock.calls[0][0]).toEqual({
      where: { id: "row-1" },
      data: { attempts: 1, lastError: "cloudfront 503" },
    });
    // The original best-effort failure log is preserved.
    const failLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_cdn_invalidation_failed");
    expect(failLog).toMatchObject({ error: "cloudfront 503" });
    consoleError.mockRestore();
  });

  it("a DB enqueue failure is logged, not thrown, and still attempts a one-shot send", async () => {
    process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID = "E1234567890ABC";
    mockCdnCreate.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(reflectVisibilityChange(["jane-smith"])).resolves.toBeUndefined();

    // Enqueue failed → no row to mark, but the purge is still attempted.
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    expect(mockCdnUpdate).not.toHaveBeenCalled();
    const enqLog = consoleError.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "edit_cdn_invalidation_enqueue_failed");
    expect(enqLog).toMatchObject({ error: "db down" });
    consoleError.mockRestore();
  });
});
