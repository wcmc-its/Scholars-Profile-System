/**
 * §2.1 — a sha256 short-circuit run (fresh completedAt, unchanged artifact) must
 * NOT reset the freshness clock. The anchor keys on the producer's
 * manifestGeneratedAt when present; parseManifestGeneratedAt refuses any value
 * that would make that anchor lie (fail-open).
 */
import { describe, it, expect } from "vitest";
import { freshnessAnchor, parseManifestGeneratedAt } from "@/etl/freshness/anchor";

describe("freshnessAnchor", () => {
  const fresh = new Date("2026-07-17T06:00:00Z"); // completedAt of a short-circuit run
  const old = new Date("2026-07-01T06:00:00Z"); // manifest.generated_at — the real artifact age

  it("prefers the artifact time so a short-circuit does not read as fresh", () => {
    // The bug: without this, anchor = completedAt = today = "fresh" for a 16d-old artifact.
    expect(freshnessAnchor({ completedAt: fresh, manifestGeneratedAt: old })).toEqual(old);
  });

  it("falls back to completedAt when the source has no S3 manifest", () => {
    expect(freshnessAnchor({ completedAt: fresh, manifestGeneratedAt: null })).toEqual(fresh);
  });

  it("returns null when there is no successful run on record", () => {
    expect(freshnessAnchor(null)).toBeNull();
  });
});

describe("parseManifestGeneratedAt", () => {
  const now = Date.parse("2026-07-17T12:00:00Z");

  it("parses a valid past ISO timestamp", () => {
    expect(parseManifestGeneratedAt("2026-07-01T06:00:00Z", now)).toEqual(
      new Date("2026-07-01T06:00:00Z"),
    );
  });

  it("returns null (→ fall back to completedAt + WARN) on absent / empty / malformed", () => {
    // Each of these would otherwise store an Invalid Date whose NaN age never
    // exceeds the SLA — the exact §2.1 fail-open, re-opened silently.
    expect(parseManifestGeneratedAt(undefined, now)).toBeNull();
    expect(parseManifestGeneratedAt("", now)).toBeNull();
    expect(parseManifestGeneratedAt("not-a-date", now)).toBeNull();
  });

  it("rejects a FUTURE timestamp (negative age would never exceed the SLA)", () => {
    expect(parseManifestGeneratedAt("2026-07-18T12:00:00Z", now)).toBeNull();
  });
});
