/**
 * lib/edit/overview-provenance.ts (#742 Phase B). `computeOverviewOrigin` is a
 * pure helper; `listOverviewGenerations` / `loadOverviewProvenance` are thin
 * `db.read` shapers — the DB is mocked so the test exercises the ordering /
 * cap / normalization / null handling, not Prisma. No network, no DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGenerationFindMany,
  mockProvenanceFindUnique,
  mockVersionFindMany,
  mockScholarFindUnique,
  mockScholarFindMany,
} = vi.hoisted(() => ({
  mockGenerationFindMany: vi.fn(),
  mockProvenanceFindUnique: vi.fn(),
  mockVersionFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      overviewGeneration: { findMany: mockGenerationFindMany },
      overviewProvenance: { findUnique: mockProvenanceFindUnique },
      overviewVersion: { findMany: mockVersionFindMany },
      scholar: { findUnique: mockScholarFindUnique, findMany: mockScholarFindMany },
    },
  },
}));

import {
  computeOverviewOrigin,
  listOverviewGenerations,
  listOverviewVersions,
  loadHistoryNames,
  loadImportedOverview,
  loadOverviewProvenance,
} from "@/lib/edit/overview-provenance";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeOverviewOrigin", () => {
  it("byte-equal text -> 'generated'", () => {
    expect(computeOverviewOrigin("<p>Same.</p>", "<p>Same.</p>")).toBe("generated");
  });

  it("any difference -> 'generated_edited'", () => {
    expect(computeOverviewOrigin("<p>Edited.</p>", "<p>Original.</p>")).toBe(
      "generated_edited",
    );
  });

  it("a trailing-whitespace difference still counts as edited (exact match only)", () => {
    expect(computeOverviewOrigin("<p>x</p> ", "<p>x</p>")).toBe("generated_edited");
  });
});

describe("listOverviewGenerations", () => {
  it("queries the scholar's rows newest-first, capped at 20", async () => {
    mockGenerationFindMany.mockResolvedValue([]);
    await listOverviewGenerations("self01");
    expect(mockGenerationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Only SUCCEEDED runs reach the history panel — failed attempts are persisted
        // for the audit trail but never offered for reload/restore.
        // Hidden (History-panel-deleted) drafts are excluded too.
        where: { cwid: "self01", status: "succeeded", hiddenAt: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    );
  });

  it("maps rows + re-normalizes the stored params blob", async () => {
    const createdAt = new Date("2026-06-01T00:00:00.000Z");
    mockGenerationFindMany.mockResolvedValue([
      {
        id: "gen1",
        model: "anthropic/claude-sonnet-4.5",
        // the dedicated column (#742) — an older v2 row whose blob predates versioning.
        promptVersion: "v2",
        // a stored blob with an unknown enum + dirty instructions + NO promptVersion —
        // normalization must coerce it to a usable OverviewParams (version → default).
        params: {
          voice: "bogus",
          tone: "conversational",
          length: "extended",
          elements: ["methods", "not_a_theme"],
          instructions: "  trim me  ",
        },
        createdAt,
        text: "<p>Draft one.</p>",
      },
    ]);
    const rows = await listOverviewGenerations("self01");
    expect(rows).toEqual([
      {
        id: "gen1",
        model: "anthropic/claude-sonnet-4.5",
        promptVersion: "v2", // the column passes through verbatim
        params: {
          voice: "third", // unknown enum -> default
          tone: "conversational",
          length: "extended",
          audience: "informed", // blob had none -> normalized to the default tier
          elements: ["methods"], // unknown key filtered
          instructions: "trim me", // trimmed
          promptVersion: "v4", // blob had none -> normalized to the default
        },
        createdAt,
        text: "<p>Draft one.</p>",
      },
    ]);
  });
});

describe("loadOverviewProvenance", () => {
  it("returns null when no row exists", async () => {
    mockProvenanceFindUnique.mockResolvedValue(null);
    expect(await loadOverviewProvenance("self01")).toBeNull();
    expect(mockProvenanceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: "self01" } }),
    );
  });

  it("returns the typed provenance shape when a row exists", async () => {
    const updatedAt = new Date("2026-06-02T12:00:00.000Z");
    mockProvenanceFindUnique.mockResolvedValue({
      origin: "generated_edited",
      model: "anthropic/claude-sonnet-4.5",
      sourceGenerationId: "gen9",
      updatedAt,
    });
    expect(await loadOverviewProvenance("self01")).toEqual({
      origin: "generated_edited",
      model: "anthropic/claude-sonnet-4.5",
      sourceGenerationId: "gen9",
      updatedAt,
    });
  });
});

describe("History-panel reads", () => {
  it("listOverviewVersions reads the scholar's un-hidden saves newest-first", async () => {
    mockVersionFindMany.mockResolvedValue([]);
    await listOverviewVersions("self01");
    expect(mockVersionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cwid: "self01", hiddenAt: null },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("loadImportedOverview sanitizes the ETL text and nulls an empty one", async () => {
    mockScholarFindUnique.mockResolvedValue({ overview: "<p>Hi</p><script>x()</script>" });
    expect(await loadImportedOverview("self01")).toBe("<p>Hi</p>");
    mockScholarFindUnique.mockResolvedValue({ overview: "" });
    expect(await loadImportedOverview("self01")).toBeNull();
    mockScholarFindUnique.mockResolvedValue(null);
    expect(await loadImportedOverview("self01")).toBeNull();
  });

  it("loadHistoryNames de-dupes cwids and skips the query when there are none", async () => {
    expect(await loadHistoryNames([])).toEqual({});
    expect(mockScholarFindMany).not.toHaveBeenCalled();
    mockScholarFindMany.mockResolvedValue([{ cwid: "a1", preferredName: "Ann" }]);
    expect(await loadHistoryNames(["a1", "a1", "zz"])).toEqual({ a1: "Ann" });
    expect(mockScholarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: { in: ["a1", "zz"] } } }),
    );
  });
});
