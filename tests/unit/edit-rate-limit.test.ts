import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockExecuteRaw, mockQueryRaw } = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { write: { $executeRaw: mockExecuteRaw, $queryRaw: mockQueryRaw } },
}));

import {
  cvExportRateLimit,
  recordCvExportAttempt,
  recordRequestChangeAttempt,
  requestChangeRateLimit,
} from "@/lib/edit/rate-limit";

const ENV = "SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT";
const original = process.env[ENV];

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(1);
  delete process.env[ENV];
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("requestChangeRateLimit()", () => {
  it("defaults to 20 when the env var is unset", () => {
    expect(requestChangeRateLimit()).toBe(20);
  });

  it("honors a positive integer env override", () => {
    process.env[ENV] = "5";
    expect(requestChangeRateLimit()).toBe(5);
  });

  it.each(["abc", "0", "-3", "2.5", ""])(
    "falls back to the default for a non-positive-integer value %j",
    (value) => {
      process.env[ENV] = value;
      expect(requestChangeRateLimit()).toBe(20);
    },
  );
});

describe("recordRequestChangeAttempt()", () => {
  it("issues the atomic INSERT ... ON DUPLICATE KEY UPDATE increment", async () => {
    mockQueryRaw.mockResolvedValue([{ count: 1 }]);
    await recordRequestChangeAttempt("self01");

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Tagged-template call: the SQL fragments are the first arg.
    const sql = (mockExecuteRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("request_change_rate_limit");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
  });

  it("allows an attempt at or under the limit", async () => {
    process.env[ENV] = "3";
    mockQueryRaw.mockResolvedValue([{ count: 3 }]);
    const res = await recordRequestChangeAttempt("self01");
    expect(res).toMatchObject({ allowed: true, count: 3, limit: 3 });
  });

  it("blocks an attempt over the limit with a Retry-After window", async () => {
    process.env[ENV] = "2";
    mockQueryRaw.mockResolvedValue([{ count: 3 }]);
    // Mid-window: 20 minutes past the hour boundary -> ~40 minutes remaining.
    const now = new Date("2026-05-26T10:20:00.000Z");
    const res = await recordRequestChangeAttempt("self01", now);

    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("expected blocked");
    expect(res.count).toBe(3);
    expect(res.limit).toBe(2);
    expect(res.retryAfterSeconds).toBe(40 * 60);
  });

  it("coerces a BIGINT-typed count and never returns a 0s Retry-After", async () => {
    process.env[ENV] = "1";
    mockQueryRaw.mockResolvedValue([{ count: 2n }]);
    // Exactly on the next boundary: remaining rounds to >= 1s, never 0.
    const now = new Date("2026-05-26T10:59:59.999Z");
    const res = await recordRequestChangeAttempt("self01", now);
    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("expected blocked");
    expect(res.count).toBe(2);
    expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("treats an empty result as the requester's own first increment (allowed)", async () => {
    mockQueryRaw.mockResolvedValue([]);
    const res = await recordRequestChangeAttempt("self01");
    expect(res).toMatchObject({ allowed: true, count: 1 });
  });
});

// CV export cap — the M1 research summary is a Bedrock call per export, so the
// route counts the attempt like its overview/biosketch siblings.
describe("cvExportRateLimit() / recordCvExportAttempt()", () => {
  const CV_ENV = "EDIT_CV_EXPORT_RATE_LIMIT";
  const cvOriginal = process.env[CV_ENV];

  afterEach(() => {
    if (cvOriginal === undefined) delete process.env[CV_ENV];
    else process.env[CV_ENV] = cvOriginal;
  });

  it("defaults to 10 when the env var is unset", () => {
    delete process.env[CV_ENV];
    expect(cvExportRateLimit()).toBe(10);
  });

  it("honors a positive integer env override", () => {
    process.env[CV_ENV] = "3";
    expect(cvExportRateLimit()).toBe(3);
  });

  it.each(["abc", "0", "-3", "2.5", ""])(
    "falls back to the default for a non-positive-integer value %j",
    (value) => {
      process.env[CV_ENV] = value;
      expect(cvExportRateLimit()).toBe(10);
    },
  );

  it("counts in its own cv: namespaced bucket, disjoint from the other limiters", async () => {
    mockQueryRaw.mockResolvedValue([{ count: 1 }]);
    await recordCvExportAttempt("self01");
    // Tagged-template call: interpolated values follow the SQL fragments.
    expect(mockExecuteRaw.mock.calls[0][1]).toBe("cv:self01");
  });

  it("blocks over the limit with a Retry-After window", async () => {
    process.env[CV_ENV] = "2";
    mockQueryRaw.mockResolvedValue([{ count: 3 }]);
    const res = await recordCvExportAttempt("self01", new Date("2026-05-26T10:20:00.000Z"));
    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("expected blocked");
    expect(res.retryAfterSeconds).toBe(40 * 60);
  });
});
