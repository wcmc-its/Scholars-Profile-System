/**
 * ED ETL slug re-mint precedence — the pin (#497 §5.2).
 *
 * `maybeUpdatedSlug` is the ED scholar-update slug step. It must:
 *   - SKIP re-mint entirely for a scholar whose slug is pinned by a
 *     FieldOverride(slug) — Scholar.slug, slug_history, and the override are
 *     left untouched on a name change; and
 *   - still re-mint (write slug_history + set Scholar.slug via
 *     reconcileScholarSlug) for an UNpinned scholar whose name changed.
 *
 * The module guards `main()` behind `!process.env.VITEST`, so importing it here
 * does not trigger a real ED sync. We mock `@/lib/db` to capture the writes the
 * shared `reconcileScholarSlug` helper issues.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockScholarFindUnique, mockScholarUpdate, mockSlugHistoryUpsert } = vi.hoisted(() => ({
  mockScholarFindUnique: vi.fn(),
  mockScholarUpdate: vi.fn(),
  mockSlugHistoryUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      scholar: { findUnique: mockScholarFindUnique, update: mockScholarUpdate },
      slugHistory: { upsert: mockSlugHistoryUpsert },
    },
  },
}));

// The ED module pulls in the LDAP source layer at import; stub it so the import
// resolves without an LDAP client. None of these are reached by maybeUpdatedSlug.
vi.mock("@/lib/sources/ldap", () => ({
  collapseEmployeeRecordsByCwid: vi.fn(),
  fetchActiveEmployeeRecords: vi.fn(),
  fetchActiveFaculty: vi.fn(),
  fetchActiveFacultyAppointments: vi.fn(),
  fetchActiveNypAffiliates: vi.fn(),
  fetchAllPostdocEmploymentRecords: vi.fn(),
  fetchDoctoralStudents: vi.fn(),
  fetchPersonNamesByCwid: vi.fn(),
  openLdap: vi.fn(),
}));

import { maybeUpdatedSlug } from "@/etl/ed/index";

beforeEach(() => {
  vi.clearAllMocks();
  // reconcileScholarSlug reads the current slug from Scholar; default returns
  // the value passed via the per-test mock below.
  mockScholarUpdate.mockResolvedValue({});
  mockSlugHistoryUpsert.mockResolvedValue({});
});

describe("maybeUpdatedSlug — pin precedence (#497 §5.2)", () => {
  it("skips re-mint entirely for a PINNED scholar (no read, no history, no update)", async () => {
    const existingSlugs = new Set(["jane-smith"]);
    await maybeUpdatedSlug(
      "jane-smith", // current slug (the pinned value)
      "Janet Smith-Jones", // a slug-affecting name change
      "pinned1",
      existingSlugs,
      new Set(["pinned1"]), // pinned
    );
    // No DB work at all — the pin is authoritative.
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockSlugHistoryUpsert).not.toHaveBeenCalled();
    expect(mockScholarUpdate).not.toHaveBeenCalled();
    // ...and the in-memory taken-set is untouched.
    expect(existingSlugs.has("jane-smith")).toBe(true);
  });

  it("re-mints for an UNPINNED scholar on a name change (regression guard)", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "jane-smith" });
    const existingSlugs = new Set(["jane-smith"]);
    await maybeUpdatedSlug(
      "jane-smith",
      "Janet Doe", // -> derives "janet-doe", slug-affecting
      "free1",
      existingSlugs,
      new Set(), // not pinned
    );
    expect(mockSlugHistoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oldSlug: "jane-smith" },
        create: { oldSlug: "jane-smith", currentCwid: "free1" },
      }),
    );
    expect(mockScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "free1" },
      data: { slug: "janet-doe" },
    });
    // taken-set updated for later scholars in the same run
    expect(existingSlugs.has("jane-smith")).toBe(false);
    expect(existingSlugs.has("janet-doe")).toBe(true);
  });

  it("is a no-op for an UNPINNED scholar whose name did not change the slug", async () => {
    const existingSlugs = new Set(["jane-smith"]);
    await maybeUpdatedSlug(
      "jane-smith",
      "Jane Smith", // same derived base
      "free2",
      existingSlugs,
      new Set(),
    );
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockSlugHistoryUpsert).not.toHaveBeenCalled();
    expect(mockScholarUpdate).not.toHaveBeenCalled();
  });

  it("re-mints onto the numeric floor when the new derived slug collides", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "old-name" });
    const existingSlugs = new Set(["old-name", "jane-smith"]); // jane-smith taken by another
    await maybeUpdatedSlug("old-name", "Jane Smith", "free3", existingSlugs, new Set());
    expect(mockScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "free3" },
      data: { slug: "jane-smith-2" },
    });
  });
});
