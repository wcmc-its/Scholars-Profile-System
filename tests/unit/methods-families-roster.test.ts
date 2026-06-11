/**
 * Comms-steward Method-Family roster builder — pure / DB-free logic
 * (`docs/comms-steward-methods-visibility-spec.md` §7, test matrix §13).
 *
 * `buildFamilyRoster` takes an injectable Prisma read client, so a hand-rolled
 * stub stands in for the live DB — these tests never touch a real database.
 * Covered §13 rows:
 *   - "Family in neither overlay" → tier=public
 *   - "Family in suppression overlay" → tier=suppressed
 *   - "Family in sensitivity overlay" → tier=sensitive (the gate-on/off PUBLIC
 *     RENDER distinction is the public-surface concern of `methods-overlay`, not
 *     the steward roster — the roster always reports the *assigned* tier)
 *   - "New family after A2 ingest" / "A2 relabels an existing family ⇒ new key,
 *     isNew=true" → driven by the `family_review_flag` firstSeenAt vs run mark
 * Plus the §6 review-queue ordering and the §7 filter helpers.
 */
import { describe, expect, it } from "vitest";

import {
  applyRosterFilter,
  buildFamilyRoster,
  parseRosterFilter,
  type FamilyRosterRow,
} from "@/lib/api/methods-families";

// ---------------------------------------------------------------------------
// A minimal in-memory Prisma stub matching the surface `buildFamilyRoster` reads.
// ---------------------------------------------------------------------------

type FamilyGroup = {
  supercategory: string;
  familyLabel: string;
  _count: { cwid: number };
  _sum: { pmidCount: number | null };
};
type OverlayRow = { supercategory: string; familyLabel: string };
type FlagRow = {
  supercategory: string;
  familyLabel: string;
  reason: string;
  firstSeenAt: Date;
  reviewedAt: Date | null;
};

function makeDb(input: {
  families: FamilyGroup[];
  suppression?: OverlayRow[];
  sensitivity?: OverlayRow[];
  flags?: FlagRow[];
}) {
  const flags = input.flags ?? [];
  const maxLastSeen =
    flags.length > 0
      ? new Date(Math.max(...flags.map((f) => f.firstSeenAt.getTime())))
      : null;
  return {
    scholarFamily: {
      groupBy: async () => input.families,
    },
    familySuppressionOverlay: {
      findMany: async () => input.suppression ?? [],
    },
    familySensitivityOverlay: {
      findMany: async () => input.sensitivity ?? [],
    },
    familyReviewFlag: {
      // The surfacing pass writes one run-wide timestamp, so lastSeenAt == the
      // flag's own firstSeenAt in these fixtures; aggregate returns the max.
      findMany: async () =>
        flags.map((f) => ({
          supercategory: f.supercategory,
          familyLabel: f.familyLabel,
          reason: f.reason,
          firstSeenAt: f.firstSeenAt,
          reviewedAt: f.reviewedAt,
        })),
      aggregate: async () => ({ _max: { lastSeenAt: maxLastSeen } }),
    },
    // Cast at the call site keeps the stub terse without re-declaring all of
    // PrismaClient — `buildFamilyRoster` only ever touches the four reads above.
  } as unknown as Parameters<typeof buildFamilyRoster>[0];
}

const fam = (
  supercategory: string,
  familyLabel: string,
  count = 1,
  pmid = 1,
): FamilyGroup => ({
  supercategory,
  familyLabel,
  _count: { cwid: count },
  _sum: { pmidCount: pmid },
});

const byKey = (rows: FamilyRosterRow[], label: string) =>
  rows.find((r) => r.familyLabel === label)!;

// ---------------------------------------------------------------------------
// tier derivation (§13 tier rows)
// ---------------------------------------------------------------------------

describe("buildFamilyRoster — tier derived from overlay membership (§13)", () => {
  it("a family in NEITHER overlay is tier=public", async () => {
    const rows = await buildFamilyRoster(
      makeDb({ families: [fam("genomics_sequencing", "CRISPR gene editing")] }),
    );
    expect(byKey(rows, "CRISPR gene editing").tier).toBe("public");
  });

  it("a family in the SUPPRESSION overlay is tier=suppressed", async () => {
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam("computational_statistical", "Descriptive statistics")],
        suppression: [
          { supercategory: "computational_statistical", familyLabel: "Descriptive statistics" },
        ],
      }),
    );
    expect(byKey(rows, "Descriptive statistics").tier).toBe("suppressed");
  });

  it("a family in the SENSITIVITY overlay is tier=sensitive", async () => {
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam("animal_cell_models", "GEMM")],
        sensitivity: [{ supercategory: "animal_cell_models", familyLabel: "GEMM" }],
      }),
    );
    expect(byKey(rows, "GEMM").tier).toBe("sensitive");
  });

  it("suppression WINS over sensitivity when a family is (incorrectly) in both — mirrors loadFamilyOverlayGate", async () => {
    const f = { supercategory: "animal_cell_models", familyLabel: "Mouse xenograft" };
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam(f.supercategory, f.familyLabel)],
        suppression: [f],
        sensitivity: [f],
      }),
    );
    expect(byKey(rows, "Mouse xenograft").tier).toBe("suppressed");
  });

  it("keys on the STABLE (supercategory, family_label) identity — same label under different supercategories are distinct families", async () => {
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam("a_models", "Models"), fam("b_models", "Models")],
        suppression: [{ supercategory: "a_models", familyLabel: "Models" }],
      }),
    );
    expect(rows.find((r) => r.supercategory === "a_models")!.tier).toBe("suppressed");
    expect(rows.find((r) => r.supercategory === "b_models")!.tier).toBe("public");
  });

  it("carries the per-family scholar count and pmid sum (null pmidCount → 0)", async () => {
    const rows = await buildFamilyRoster(
      makeDb({
        families: [
          { supercategory: "x", familyLabel: "Y", _count: { cwid: 4 }, _sum: { pmidCount: null } },
        ],
      }),
    );
    expect(byKey(rows, "Y").scholarCount).toBe(4);
    expect(byKey(rows, "Y").pmidCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isNew / relabel surfacing (§13 "new family after A2 ingest", "A2 relabels")
// ---------------------------------------------------------------------------

describe("buildFamilyRoster — isNew tracks the latest surfacing pass (§13)", () => {
  const OLD = new Date("2026-06-01T00:00:00Z");
  const NOW = new Date("2026-06-11T00:00:00Z");

  it("a family first seen in the LATEST pass (firstSeenAt == run mark) is isNew=true", async () => {
    // The newly-ingested family's flag is the max firstSeenAt, so the run mark
    // == NOW; its firstSeenAt >= run mark ⇒ new. A relabel produces a brand-new
    // (supercategory, label) key, which is exactly this case.
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam("animal_cell_models", "Animal cell models"), fam("genetics", "Old family")],
        flags: [
          {
            supercategory: "animal_cell_models",
            familyLabel: "Animal cell models",
            reason: "supercategory:animal_cell_models",
            firstSeenAt: NOW,
            reviewedAt: null,
          },
          {
            supercategory: "genetics",
            familyLabel: "Old family",
            reason: "term:mouse",
            firstSeenAt: OLD,
            reviewedAt: null,
          },
        ],
      }),
    );
    expect(byKey(rows, "Animal cell models").isNew).toBe(true);
    expect(byKey(rows, "Animal cell models").reason).toBe("supercategory:animal_cell_models");
    // The neither-overlay flagged family still renders PUBLIC (allow-by-default).
    expect(byKey(rows, "Animal cell models").tier).toBe("public");
    // An older flag (firstSeenAt < run mark) is NOT new.
    expect(byKey(rows, "Old family").isNew).toBe(false);
  });

  it("a reviewed flag is never isNew (the nag is cleared) even if firstSeenAt == run mark", async () => {
    const rows = await buildFamilyRoster(
      makeDb({
        families: [fam("animal_cell_models", "Reviewed family")],
        flags: [
          {
            supercategory: "animal_cell_models",
            familyLabel: "Reviewed family",
            reason: "supercategory:animal_cell_models",
            firstSeenAt: NOW,
            reviewedAt: new Date("2026-06-11T01:00:00Z"),
          },
        ],
      }),
    );
    const r = byKey(rows, "Reviewed family");
    expect(r.isNew).toBe(false);
    expect(r.reviewedAt).toBe("2026-06-11T01:00:00.000Z");
  });

  it("an unflagged family has reason=null, isNew=false", async () => {
    const rows = await buildFamilyRoster(makeDb({ families: [fam("genetics", "Plain")] }));
    expect(byKey(rows, "Plain").reason).toBeNull();
    expect(byKey(rows, "Plain").isNew).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// review-queue ordering (§6): new∧flagged > flagged∧unreviewed > flagged∧reviewed > unflagged
// ---------------------------------------------------------------------------

describe("buildFamilyRoster — §6 review-queue ordering", () => {
  it("orders by priority band, then alphabetically within a band", async () => {
    const NOW = new Date("2026-06-11T00:00:00Z");
    const OLD = new Date("2026-06-01T00:00:00Z");
    const rows = await buildFamilyRoster(
      makeDb({
        families: [
          fam("sc", "Z unflagged"),
          fam("sc", "A unflagged"),
          fam("sc", "Flagged reviewed"),
          fam("sc", "Flagged unreviewed"),
          fam("sc", "New flagged"),
        ],
        flags: [
          // band 4: new ∧ flagged (firstSeenAt == run mark, unreviewed)
          { supercategory: "sc", familyLabel: "New flagged", reason: "term:mouse", firstSeenAt: NOW, reviewedAt: null },
          // band 3: flagged ∧ unreviewed but old (not new)
          { supercategory: "sc", familyLabel: "Flagged unreviewed", reason: "term:rat", firstSeenAt: OLD, reviewedAt: null },
          // band 2: flagged ∧ reviewed
          { supercategory: "sc", familyLabel: "Flagged reviewed", reason: "term:nhp", firstSeenAt: OLD, reviewedAt: OLD },
        ],
      }),
    );
    expect(rows.map((r) => r.familyLabel)).toEqual([
      "New flagged", // band 4
      "Flagged unreviewed", // band 3
      "Flagged reviewed", // band 2
      "A unflagged", // band 1, alphabetical
      "Z unflagged", // band 1, alphabetical
    ]);
  });
});

// ---------------------------------------------------------------------------
// filter helpers (§7)
// ---------------------------------------------------------------------------

describe("parseRosterFilter", () => {
  it.each(["all", "flagged", "new", "public", "suppressed", "sensitive"] as const)(
    "accepts the known filter %s",
    (f) => {
      expect(parseRosterFilter(f)).toBe(f);
    },
  );

  it("defaults unknown / absent values to 'all'", () => {
    expect(parseRosterFilter(null)).toBe("all");
    expect(parseRosterFilter("")).toBe("all");
    expect(parseRosterFilter("DROP TABLE")).toBe("all");
  });
});

describe("applyRosterFilter", () => {
  const rows: FamilyRosterRow[] = [
    { supercategory: "sc", familyLabel: "Pub", tier: "public", reason: null, isNew: false, reviewedAt: null, scholarCount: 1, pmidCount: 1 },
    { supercategory: "sc", familyLabel: "Sup", tier: "suppressed", reason: "term:rat", isNew: false, reviewedAt: null, scholarCount: 1, pmidCount: 1 },
    { supercategory: "sc", familyLabel: "Sen", tier: "sensitive", reason: "supercategory:animal_cell_models", isNew: true, reviewedAt: null, scholarCount: 1, pmidCount: 1 },
  ];

  it("'all' is the identity", () => {
    expect(applyRosterFilter(rows, "all")).toHaveLength(3);
  });

  it("'flagged' keeps only rows with a reason", () => {
    expect(applyRosterFilter(rows, "flagged").map((r) => r.familyLabel)).toEqual(["Sup", "Sen"]);
  });

  it("'new' keeps only isNew rows", () => {
    expect(applyRosterFilter(rows, "new").map((r) => r.familyLabel)).toEqual(["Sen"]);
  });

  it.each(["public", "suppressed", "sensitive"] as const)("'%s' narrows by derived tier", (tier) => {
    const out = applyRosterFilter(rows, tier);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe(tier);
  });
});
