/**
 * lib/reciter/refresh — the delayed ReCiter re-score scanner (#746), the durable
 * backstop mirroring the #393 reconciler. Verifies the dormant no-op, pass 1
 * (deliver not-yet-sent gold-standard rejects + record failures), and pass 2
 * (one coalesced feature-generator re-score per uid, only once the uid's oldest
 * reject is past the delay window AND all its evidence is delivered).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockFindMany,
  mockUpdate,
  mockUpdateMany,
  mockIsRejectEnabled,
  mockIsApiConfigured,
  mockPostGoldStandard,
  mockRunFeatureGenerator,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockIsRejectEnabled: vi.fn(),
  mockIsApiConfigured: vi.fn(),
  mockPostGoldStandard: vi.fn(),
  mockRunFeatureGenerator: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { reciterPendingRefresh: { findMany: mockFindMany } },
    write: { reciterPendingRefresh: { update: mockUpdate, updateMany: mockUpdateMany } },
  },
}));
vi.mock("@/lib/reciter/client", () => ({
  isReciterRejectEnabled: mockIsRejectEnabled,
  isReciterApiConfigured: mockIsApiConfigured,
  postGoldStandardReject: mockPostGoldStandard,
  runFeatureGenerator: mockRunFeatureGenerator,
  // call straight through so retries don't sleep in the test
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { runReciterRefresh } from "@/lib/reciter/refresh";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const PAST_CUTOFF = new Date("2026-06-04T10:00:00.000Z"); // > 60 min before NOW
const WITHIN_CUTOFF = new Date("2026-06-04T11:45:00.000Z"); // < 60 min before NOW

// Per-test fixtures for the three findMany queries the scanner issues.
let pendingPosts: Array<{ id: string; uid: string; pmid: string }> = [];
let awaiting: Array<{ uid: string; createdAt: Date }> = [];
let blocked: Array<{ uid: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockIsRejectEnabled.mockReturnValue(true);
  mockIsApiConfigured.mockReturnValue(true);
  mockPostGoldStandard.mockResolvedValue(undefined);
  mockRunFeatureGenerator.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue(undefined);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  pendingPosts = [];
  awaiting = [];
  blocked = [];
  mockFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const w = args.where;
    const hasFg = "featureGeneratorSentAt" in w;
    // NB: `typeof null === "object"`, so the goldstandardSentAt===null branches
    // must be checked BEFORE the `{ not: null }` (object) branch.
    if (!hasFg && w.goldstandardSentAt === null) return pendingPosts; // pass 1
    if (hasFg && w.goldstandardSentAt === null) return blocked; // undelivered for a uid
    if (hasFg && w.goldstandardSentAt && typeof w.goldstandardSentAt === "object") return awaiting;
    return [];
  });
});

describe("runReciterRefresh", () => {
  it("is a dormant no-op when the feature is off", async () => {
    mockIsRejectEnabled.mockReturnValue(false);
    const summary = await runReciterRefresh({ now: NOW });
    expect(summary).toMatchObject({ enabled: false, goldstandardSent: 0, uidsRefreshed: 0 });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("is a dormant no-op when the API is unconfigured", async () => {
    mockIsApiConfigured.mockReturnValue(false);
    const summary = await runReciterRefresh({ now: NOW });
    expect(summary.configured).toBe(false);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("pass 1 — delivers a not-yet-sent reject and stamps the sentinel", async () => {
    pendingPosts = [{ id: "p1", uid: "u1", pmid: "111" }];
    const summary = await runReciterRefresh({ now: NOW });
    expect(mockPostGoldStandard).toHaveBeenCalledWith({ uid: "u1", pmid: "111" });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { goldstandardSentAt: NOW, lastError: null },
    });
    expect(summary.goldstandardSent).toBe(1);
    expect(summary.goldstandardFailed).toBe(0);
  });

  it("pass 1 — a failed delivery records attempts/last_error and is counted", async () => {
    pendingPosts = [{ id: "p1", uid: "u1", pmid: "111" }];
    mockPostGoldStandard.mockRejectedValue(new Error("ReCiter 503"));
    const summary = await runReciterRefresh({ now: NOW });
    expect(summary.goldstandardFailed).toBe(1);
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.attempts).toEqual({ increment: 1 });
    expect(data.lastError).toContain("ReCiter 503");
  });

  it("pass 2 — fires ONE coalesced re-score per uid past the delay window", async () => {
    awaiting = [
      { uid: "u1", createdAt: PAST_CUTOFF },
      { uid: "u1", createdAt: PAST_CUTOFF }, // two rejects, one re-score
      { uid: "u2", createdAt: WITHIN_CUTOFF }, // too recent — not yet
    ];
    const summary = await runReciterRefresh({ now: NOW });
    expect(mockRunFeatureGenerator).toHaveBeenCalledTimes(1);
    expect(mockRunFeatureGenerator).toHaveBeenCalledWith({ uid: "u1" });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { uid: "u1", featureGeneratorSentAt: null, goldstandardSentAt: { not: null } },
      data: { featureGeneratorSentAt: NOW, lastError: null },
    });
    expect(summary.uidsRefreshed).toBe(1);
  });

  it("pass 2 — skips a uid that still holds an undelivered reject", async () => {
    awaiting = [{ uid: "u1", createdAt: PAST_CUTOFF }]; // past cutoff…
    blocked = [{ uid: "u1" }]; // …but an undelivered reject blocks the re-score
    const summary = await runReciterRefresh({ now: NOW });
    expect(mockRunFeatureGenerator).not.toHaveBeenCalled();
    expect(summary.uidsRefreshed).toBe(0);
  });

  it("pass 2 — a failed re-score records the failure on the uid's rows", async () => {
    awaiting = [{ uid: "u1", createdAt: PAST_CUTOFF }];
    mockRunFeatureGenerator.mockRejectedValue(new Error("engine timeout"));
    const summary = await runReciterRefresh({ now: NOW });
    expect(summary.uidsFailed).toBe(1);
    const lastCall = mockUpdateMany.mock.calls.at(-1)![0];
    expect(lastCall.where).toMatchObject({ uid: "u1", featureGeneratorSentAt: null });
    expect(lastCall.data.attempts).toEqual({ increment: 1 });
  });
});
