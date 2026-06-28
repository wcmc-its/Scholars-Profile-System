/**
 * Unit tests for normalizeClinical (etl/pops/index.ts).
 *
 * The ETL's main() is guarded by `!process.env.VITEST`, so importing this
 * module here does NOT trigger a POPS fetch or DB write.
 *
 * Covered cases:
 *   - board-cert specialty + primary specialty with identical casing collapse
 *     to one entry; board-cert wins on casing.
 *   - board-cert specialty + primary specialty that differ only in case collapse
 *     to one entry (the core dedup requirement).
 *   - boardSet contains only board-cert specialty strings, not primary-only ones.
 *   - empty input → all arrays empty.
 */
import { describe, expect, it } from "vitest";

import { normalizeClinical } from "@/etl/pops/index";

/** Minimal PopsEnrichment stub — only the fields normalizeClinical reads. */
function makePops({
  boardCerts = [] as { board: string; specialty: string | null }[],
  specialties = [] as string[],
  expertise = [] as string[],
} = {}) {
  return {
    npi: null,
    boardCertifications: boardCerts,
    training: [],
    degrees: [],
    appointments: [],
    honors: [],
    specialties,
    practices: [],
    expertise,
    castleConnolly: false,
  };
}

describe("normalizeClinical — case-insensitive specialty dedup", () => {
  it("collapses board-cert 'Cardiology' + primary 'cardiology' to a single entry", () => {
    const result = normalizeClinical(
      makePops({
        boardCerts: [{ board: "American Board of Internal Medicine", specialty: "Cardiology" }],
        specialties: ["cardiology"],
      }),
    );
    expect(result.specialties).toHaveLength(1);
    // Board-cert casing wins.
    expect(result.specialties[0]).toBe("Cardiology");
  });

  it("boardSet contains only the board-cert specialty, not the primary-only entry", () => {
    const result = normalizeClinical(
      makePops({
        boardCerts: [{ board: "American Board of Internal Medicine", specialty: "Cardiology" }],
        specialties: ["cardiology", "Interventional Cardiology"],
      }),
    );
    // boardSet = board-cert specialties only.
    expect(result.boardSet).toEqual(["Cardiology"]);
    // "Interventional Cardiology" is primary-only → NOT in boardSet.
    expect(result.boardSet).not.toContain("Interventional Cardiology");
    // But it IS in specialties.
    expect(result.specialties).toContain("Interventional Cardiology");
  });

  it("retains distinct specialties from both sources when they don't overlap", () => {
    const result = normalizeClinical(
      makePops({
        boardCerts: [{ board: "ABP", specialty: "Pediatrics" }],
        specialties: ["Neonatology"],
      }),
    );
    expect(result.specialties).toHaveLength(2);
    expect(result.specialties).toContain("Pediatrics");
    expect(result.specialties).toContain("Neonatology");
  });

  it("drops null board-cert specialties from boardSet and specialties", () => {
    const result = normalizeClinical(
      makePops({
        boardCerts: [{ board: "Uncategorized Board", specialty: null }],
        specialties: [],
      }),
    );
    expect(result.boardSet).toHaveLength(0);
    expect(result.specialties).toHaveLength(0);
  });

  it("empty input → all arrays empty", () => {
    const result = normalizeClinical(makePops());
    expect(result.boardCertifications).toEqual([]);
    expect(result.specialties).toEqual([]);
    expect(result.expertise).toEqual([]);
    expect(result.boardSet).toEqual([]);
  });

  it("passes expertise through unchanged", () => {
    const result = normalizeClinical(
      makePops({ expertise: ["Retinal Laser Photocoagulation", "Retina Degeneration"] }),
    );
    expect(result.expertise).toEqual(["Retinal Laser Photocoagulation", "Retina Degeneration"]);
  });
});
