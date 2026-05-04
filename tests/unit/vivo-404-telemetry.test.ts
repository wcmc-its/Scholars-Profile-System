/**
 * Unit tests for ANALYTICS-04: VIVO legacy 404 URL telemetry.
 *
 * RED phase — tests import VIVO_PATTERN and logVivoFourOhFour from
 * lib/analytics/vivo-pattern.ts which does not yet exist. Tests MUST FAIL
 * until Task 3 creates that module.
 *
 * Two concerns tested:
 * 1. VIVO_PATTERN regex — matches /display/cwid-{alnum}, rejects all other paths
 * 2. logVivoFourOhFour helper — emits structured log only on VIVO matches
 *
 * Log shape: { event: "vivo_404", url, ts: ISO8601 }
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("VIVO_PATTERN regex", () => {
  it("matches /display/cwid-abc123 (canonical VIVO profile URL)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/display/cwid-abc123")).toBe(true);
  });

  it("matches /display/cwid-ABC123XYZ (uppercase alphanumeric)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/display/cwid-ABC123XYZ")).toBe(true);
  });

  it("matches /display/cwid-a1b2c3d4 (mixed alnum CWID format)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/display/cwid-a1b2c3d4")).toBe(true);
  });

  it("does NOT match /scholars/jane-doe (profile slug path)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/scholars/jane-doe")).toBe(false);
  });

  it("does NOT match /topics/foo (topic page)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/topics/foo")).toBe(false);
  });

  it("does NOT match /random (arbitrary path)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/random")).toBe(false);
  });

  it("does NOT match /display/cwid- (no alnum after dash — empty suffix)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    // \w+ requires at least one word char after cwid-
    expect(VIVO_PATTERN.test("/display/cwid-")).toBe(false);
  });

  it("does NOT match /display/other-abc123 (wrong prefix)", async () => {
    const { VIVO_PATTERN } = await import("@/lib/analytics/vivo-pattern");
    expect(VIVO_PATTERN.test("/display/other-abc123")).toBe(false);
  });
});

describe("logVivoFourOhFour helper", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits vivo_404 log when pathname matches VIVO pattern", async () => {
    const { logVivoFourOhFour } = await import("@/lib/analytics/vivo-pattern");
    logVivoFourOhFour("/display/cwid-abc123");

    expect(consoleSpy).toHaveBeenCalled();

    const vivoCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.event === "vivo_404";
      } catch {
        return false;
      }
    });

    expect(
      vivoCall,
      "Expected a console.log call with JSON containing event: vivo_404",
    ).toBeDefined();

    const parsed = JSON.parse(vivoCall![0] as string);
    expect(parsed.event).toBe("vivo_404");
    expect(parsed.url).toBe("/display/cwid-abc123");
    expect(parsed.ts).toBeDefined();
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("does NOT emit log when pathname does not match VIVO pattern", async () => {
    const { logVivoFourOhFour } = await import("@/lib/analytics/vivo-pattern");

    logVivoFourOhFour("/scholars/jane-doe");
    expect(consoleSpy).not.toHaveBeenCalled();

    logVivoFourOhFour("/topics/foo");
    expect(consoleSpy).not.toHaveBeenCalled();

    logVivoFourOhFour("/random");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit log for empty pathname", async () => {
    const { logVivoFourOhFour } = await import("@/lib/analytics/vivo-pattern");
    logVivoFourOhFour("");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("log line is valid JSON (parseable by log drain)", async () => {
    const { logVivoFourOhFour } = await import("@/lib/analytics/vivo-pattern");
    logVivoFourOhFour("/display/cwid-xyz789");

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "vivo_404";
      } catch {
        return false;
      }
    });

    expect(call).toBeDefined();
    expect(() => JSON.parse(call![0] as string)).not.toThrow();
  });

  it("logs the exact pathname (not a mangled version)", async () => {
    const { logVivoFourOhFour } = await import("@/lib/analytics/vivo-pattern");
    logVivoFourOhFour("/display/cwid-zzz999");

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "vivo_404";
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(call![0] as string);
    expect(parsed.url).toBe("/display/cwid-zzz999");
  });
});
