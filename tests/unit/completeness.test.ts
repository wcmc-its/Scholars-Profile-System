/**
 * Unit tests for lib/analytics/completeness.ts — Phase 6 ANALYTICS-03.
 *
 * Tests computeCompletenessSnapshot() using Prisma mocks covering:
 *   A. 100% — all scholars complete, above threshold
 *   B. 65% — below threshold
 *   C. 70% — boundary (NOT below threshold, strict <70 check)
 *   D. 0/0 — empty DB, returns 0% but does NOT trip alarm
 *   E. Correct where clauses for both count queries
 *   F. COMPLETENESS_THRESHOLD export equals 70
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { count: vi.fn() },
    completenessSnapshot: { create: vi.fn(async () => ({})) },
  },
}));

import { prisma } from "@/lib/db";
import {
  computeCompletenessSnapshot,
  COMPLETENESS_THRESHOLD,
} from "@/lib/analytics/completeness";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeCompletenessSnapshot", () => {
  it("Test A: 100/100 = 100% above threshold", async () => {
    (prisma.scholar.count as Mock)
      .mockResolvedValueOnce(100) // totalScholars
      .mockResolvedValueOnce(100); // completeCount

    const result = await computeCompletenessSnapshot();

    expect(result).toEqual({
      totalScholars: 100,
      completeCount: 100,
      completenessPercent: 100,
      belowThreshold: false,
    });
    expect(prisma.completenessSnapshot.create).toHaveBeenCalledWith({
      data: {
        totalScholars: 100,
        completeCount: 100,
        completenessPercent: 100,
        belowThreshold: false,
      },
    });
  });

  it("Test B: 65/100 = 65% below threshold", async () => {
    (prisma.scholar.count as Mock)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(65);

    const result = await computeCompletenessSnapshot();

    expect(result.completenessPercent).toBe(65);
    expect(result.belowThreshold).toBe(true);
  });

  it("Test C: 70/100 = 70% NOT below threshold (boundary — strict < 70)", async () => {
    (prisma.scholar.count as Mock)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(70);

    const result = await computeCompletenessSnapshot();

    expect(result.completenessPercent).toBe(70);
    expect(result.belowThreshold).toBe(false);
  });

  it("Test D: 0/0 = 0% NOT below threshold (no spurious alarm on empty DB)", async () => {
    (prisma.scholar.count as Mock)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const result = await computeCompletenessSnapshot();

    expect(result.completenessPercent).toBe(0);
    expect(result.belowThreshold).toBe(false);
  });

  it("Test E: first count uses active-scholars where clause; second uses completeness where clause", async () => {
    (prisma.scholar.count as Mock)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8);

    await computeCompletenessSnapshot();

    const calls = (prisma.scholar.count as Mock).mock.calls;
    expect(calls).toHaveLength(2);

    // First call: total active scholars
    expect(calls[0][0]).toEqual({
      where: { deletedAt: null, status: "active" },
    });

    // Second call: scholars with overview + at least 1 confirmed publication
    expect(calls[1][0]).toEqual({
      where: {
        deletedAt: null,
        status: "active",
        overview: { not: null },
        authorships: { some: { isConfirmed: true } },
      },
    });
  });

  it("Test F: COMPLETENESS_THRESHOLD export equals 70", () => {
    expect(COMPLETENESS_THRESHOLD).toStrictEqual(70);
  });
});
