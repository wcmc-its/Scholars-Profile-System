/**
 * The regression this file exists for: `manifestGeneratedAt` was computed in
 * etl/tools/index.ts, warned about, and documented in a fifteen-line comment —
 * and never placed in the object handed to Prisma. It shipped. The column was
 * NULL on every row, the Tools freshness anchor silently stayed on
 * `completedAt`, and the FreshnessAck that depends on Tools grading STALE was
 * therefore inert.
 *
 * Nothing caught it: `tsc` cannot (the Prisma field is optional, so omitting
 * the key is legal) and ESLint cannot (the value IS referenced, in the
 * null-check that emits the warning). Only a row in the database showed it.
 *
 * So these assertions are deliberately about the VALUE ARRIVING, not about the
 * parse — tests/unit/freshness-anchor.test.ts already covers
 * parseManifestGeneratedAt itself. Deleting the field from the returned object
 * must fail here.
 */
import { describe, expect, it } from "vitest";
import { buildToolsRunRecord } from "@/etl/tools/run-record";

const NOW = Date.parse("2026-09-09T07:31:38Z");
const base = {
  source: "Tools",
  status: "success" as const,
  startedAt: new Date("2026-09-09T07:30:00Z"),
  completedAt: new Date("2026-09-09T07:31:38Z"),
  rowsProcessed: 12345,
  manifestSha256: "abc123",
  now: NOW,
};

describe("buildToolsRunRecord", () => {
  it("puts the artifact's generated_at on the row — the anchor the ack depends on", () => {
    const r = buildToolsRunRecord({
      ...base,
      // The real staging/prod manifest, frozen since June.
      manifest: { generated_at: "2026-06-23T17:56:59Z", version: "v2026-06-23" },
    });

    expect(r.manifestGeneratedAt).toEqual(new Date("2026-06-23T17:56:59Z"));
    // Not the import's own clock. Anchoring there is what made Tools read green
    // against a 77-day-old artifact in the first place.
    expect(r.manifestGeneratedAt).not.toEqual(r.completedAt);
    expect(r.manifestTaxonomyVersion).toBe("v2026-06-23");
    expect(r.manifestSha256).toBe("abc123");
  });

  it("falls back to a null anchor rather than throwing, on anything unusable", () => {
    // null => freshness uses completedAt, i.e. exactly the old behaviour.
    for (const generated_at of [undefined, "", "not-a-date", "2027-01-01T00:00:00Z"]) {
      const r = buildToolsRunRecord({ ...base, manifest: { generated_at, version: "v1" } });
      expect(r.manifestGeneratedAt, `generated_at=${String(generated_at)}`).toBeNull();
    }
  });

  it("carries no manifest fields at all when there is no manifest (a failed run)", () => {
    const r = buildToolsRunRecord({
      ...base,
      status: "failed",
      rowsProcessed: 0,
      errorMessage: "S3 read failed",
      manifestSha256: null,
    });

    expect(r.manifestGeneratedAt).toBeNull();
    expect(r.manifestTaxonomyVersion).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toBe("S3 read failed");
  });

  it("defaults errorMessage to null, never undefined", () => {
    // Prisma treats an undefined field as "do not set"; the column is nullable
    // and the page reads null. They are not the same thing.
    expect(buildToolsRunRecord({ ...base }).errorMessage).toBeNull();
  });
});
