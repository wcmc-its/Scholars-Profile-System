/**
 * Unit tests for app/api/health/refresh-status/route.ts — Phase 6 ANALYTICS-03.
 *
 * Tests the extended GET handler that includes completenessPercent and
 * belowThreshold fields from the latest completeness_snapshot row.
 *
 * Mock setup: prisma.etlRun.findFirst and prisma.completenessSnapshot.findFirst
 * are mocked. The route iterates 7 sources × 2 findFirst calls = 14 calls.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    etlRun: { findFirst: vi.fn() },
    completenessSnapshot: { findFirst: vi.fn() },
  },
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { GET } from "@/app/api/health/refresh-status/route";

/** Build a minimal NextRequest for use in tests (no auth token set in env). */
function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/health/refresh-status");
}

const RECENT_RUN = {
  completedAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago — fresh
  startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  status: "success",
  rowsProcessed: 100,
};

const STALE_RUN = {
  completedAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30 hours ago — stale
  startedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
  status: "success",
  rowsProcessed: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all ETL runs are fresh
  (prisma.etlRun.findFirst as Mock).mockResolvedValue(RECENT_RUN);
  // Default: no snapshot
  (prisma.completenessSnapshot.findFirst as Mock).mockResolvedValue(null);
});

describe("GET /api/health/refresh-status", () => {
  it("Test A: snapshot present, all sources fresh, above threshold — returns 200 with completeness fields", async () => {
    (prisma.completenessSnapshot.findFirst as Mock).mockResolvedValue({
      completenessPercent: 85.5,
      belowThreshold: false,
    });

    const resp = await GET(makeRequest());
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.allFresh).toBe(true);
    expect(body.completenessPercent).toBe(85.5);
    expect(body.belowThreshold).toBe(false);
  });

  it("Test B: snapshot present, all sources fresh, below threshold — still 200 (completeness does not gate)", async () => {
    (prisma.completenessSnapshot.findFirst as Mock).mockResolvedValue({
      completenessPercent: 60,
      belowThreshold: true,
    });

    const resp = await GET(makeRequest());
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.completenessPercent).toBe(60);
    expect(body.belowThreshold).toBe(true);
  });

  it("Test C: no snapshot yet — completeness fields are null (not 0/false)", async () => {
    (prisma.completenessSnapshot.findFirst as Mock).mockResolvedValue(null);

    const resp = await GET(makeRequest());
    const body = await resp.json();

    expect(body.completenessPercent).toBeNull();
    expect(body.belowThreshold).toBeNull();
  });

  it("Test D: stale source returns 503 — completeness does not gate the status code", async () => {
    // Make one source stale by returning STALE_RUN for the first etlRun.findFirst call
    // and null for its lastAny (no recent run)
    // The route calls findFirst 14 times (7 sources × 2 each).
    // Simplest approach: mock all as STALE_RUN to ensure 503 triggers.
    (prisma.etlRun.findFirst as Mock).mockResolvedValue(STALE_RUN);
    (prisma.completenessSnapshot.findFirst as Mock).mockResolvedValue({
      completenessPercent: 75,
      belowThreshold: false,
    });

    const resp = await GET(makeRequest());
    expect(resp.status).toBe(503);

    const body = await resp.json();
    expect(body.allFresh).toBe(false);
    // completeness fields still populated normally
    expect(body.completenessPercent).toBe(75);
    expect(body.belowThreshold).toBe(false);
  });

  it("Test E: preserves existing sources array shape with 7 entries and expected fields", async () => {
    const resp = await GET(makeRequest());
    const body = await resp.json();

    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources).toHaveLength(7);

    // Each source entry has the expected shape
    for (const src of body.sources) {
      expect(src).toHaveProperty("source");
      expect(src).toHaveProperty("fresh");
      expect(src).toHaveProperty("lastSuccessAt");
      expect(src).toHaveProperty("hoursSinceSuccess");
      expect(src).toHaveProperty("lastStatus");
      expect(src).toHaveProperty("rowsProcessed");
    }

    // completenessPercent and belowThreshold are additive fields (null when no snapshot)
    expect(Object.keys(body)).toContain("completenessPercent");
    expect(Object.keys(body)).toContain("belowThreshold");
  });
});
