/**
 * Issue #233 — PI facet derivation tests.
 *
 * Locks two surfaces:
 *   1. `isTrainingOnlyGrant` matches the spec's mechanism-first rule with a
 *      program_type fallback for non-NIH grants.
 *   2. The index-time derivation of `piRoleEver` / `activePiGrantCount` —
 *      reproduced here as inline helpers so the spec's test-case table is
 *      a single source of truth and survives ETL refactors.
 */
import { describe, expect, it } from "vitest";
import { isTrainingOnlyGrant } from "@/lib/grants/training-exclusions";
import { isFundingActive } from "@/lib/api/search-funding";
import { PI_ROLES as SHARED_PI_ROLES } from "@/lib/funding-roles";

// The SHARED vocabulary, not a local re-declaration — this test exists to lock the
// index-time derivation in `lib/search-index-docs.ts`, and a private copy here let
// the two drift apart silently (which is exactly what happened: the indexer's set
// was narrow, this file agreed with it, and the PI facet was wrong in both).
const PI_ROLES = new Set<string>(SHARED_PI_ROLES);

type GrantLike = {
  role: string;
  endDate: Date;
  mechanism: string | null;
  programType: string;
};

function activePiGrantCount(grants: GrantLike[], now: Date): number {
  return grants.reduce((n, g) => {
    if (!PI_ROLES.has(g.role)) return n;
    if (!isFundingActive(g.endDate, now)) return n;
    if (isTrainingOnlyGrant(g)) return n;
    return n + 1;
  }, 0);
}

function piRoleEver(grants: GrantLike[]): boolean {
  return grants.some((g) => PI_ROLES.has(g.role));
}

const NOW = new Date("2026-05-13T00:00:00Z");
const FAR_FUTURE = new Date("2029-05-13T00:00:00Z");
const EIGHT_MONTHS_AGO = new Date("2025-09-13T00:00:00Z");
const FOURTEEN_MONTHS_AGO = new Date("2025-03-13T00:00:00Z");

describe("isTrainingOnlyGrant", () => {
  it("flags fellowships by mechanism regardless of program_type", () => {
    expect(isTrainingOnlyGrant({ mechanism: "F31", programType: "Grant" })).toBe(true);
    expect(isTrainingOnlyGrant({ mechanism: "F32", programType: "Fellowship" })).toBe(true);
  });

  it("flags mentored K-awards by mechanism (K01, K08, K23, K99, KL2)", () => {
    for (const m of ["K01", "K08", "K23", "K99", "KL2"]) {
      expect(isTrainingOnlyGrant({ mechanism: m, programType: "Grant" })).toBe(true);
    }
  });

  it("flags TL1 but not T32/T35/T37 (T-mech directors are real PIs)", () => {
    expect(isTrainingOnlyGrant({ mechanism: "TL1", programType: "Training" })).toBe(true);
    expect(isTrainingOnlyGrant({ mechanism: "T32", programType: "Training" })).toBe(false);
    expect(isTrainingOnlyGrant({ mechanism: "T35", programType: "Training" })).toBe(false);
  });

  it("does NOT flag R00 (independent phase) or K22 (independent K-award)", () => {
    expect(isTrainingOnlyGrant({ mechanism: "R00", programType: "Grant" })).toBe(false);
    expect(isTrainingOnlyGrant({ mechanism: "R00", programType: "Career" })).toBe(false);
    expect(isTrainingOnlyGrant({ mechanism: "K22", programType: "Grant" })).toBe(false);
  });

  it("does NOT flag midcareer K24/K76 (real PIs per audit)", () => {
    expect(isTrainingOnlyGrant({ mechanism: "K24", programType: "Career" })).toBe(false);
    expect(isTrainingOnlyGrant({ mechanism: "K76", programType: "Career" })).toBe(false);
  });

  it("does NOT flag standard research mechanisms (R01, R21, U01, P30)", () => {
    for (const m of ["R01", "R21", "R03", "U01", "P30", "S10", "D43"]) {
      expect(isTrainingOnlyGrant({ mechanism: m, programType: "Grant" })).toBe(false);
    }
  });

  it("falls back to program_type when mechanism is null (non-NIH)", () => {
    expect(isTrainingOnlyGrant({ mechanism: null, programType: "Career" })).toBe(true);
    expect(isTrainingOnlyGrant({ mechanism: null, programType: "Fellowship" })).toBe(true);
    expect(isTrainingOnlyGrant({ mechanism: null, programType: "Training" })).toBe(true);
    expect(isTrainingOnlyGrant({ mechanism: null, programType: "Grant" })).toBe(false);
  });
});

describe("PI facet — locked test cases from SPEC (lines 318–330)", () => {
  it("row 1: single active R01 as PI — in `any`, in `active`, out of `multi≥2`", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(1);
  });

  it("row 2: only grant is active K99 PI — in `any`, out of `active` (training exclusion)", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: FAR_FUTURE, mechanism: "K99", programType: "Career" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(0);
  });

  it("row 3: active R00 PI — in `any`, in `active` (R00 NOT excluded)", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: FAR_FUTURE, mechanism: "R00", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(1);
  });

  it("row 4: only grant is Co-I R01 — out of all options", () => {
    const grants: GrantLike[] = [
      { role: "Co-I", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(false);
    expect(activePiGrantCount(grants, NOW)).toBe(0);
  });

  it("row 5: R01 ended 8 months ago (within NCE grace) — in `active`", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: EIGHT_MONTHS_AGO, mechanism: "R01", programType: "Grant" },
    ];
    expect(activePiGrantCount(grants, NOW)).toBe(1);
  });

  it("row 6: R01 ended 14 months ago (past NCE grace) — in `any` (history), out of `active`", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: FOURTEEN_MONTHS_AGO, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(0);
  });

  it("row 7: two active R01s as contact PI — qualifies for `multi≥2`", () => {
    const grants: GrantLike[] = [
      { role: "PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
      { role: "PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(activePiGrantCount(grants, NOW)).toBe(2);
  });

  it("row 8: one PI + one Co-PI active — BOTH count; a Co-PI is an MPI, not a lesser PI", () => {
    // Was "Co-PI not counted, only one active PI grant". Inverted with #1998: the
    // May-2026 audit that dropped Co-PI predates the finding that InfoEd writes
    // Co-PI for the NON-CONTACT PD/PI of an NIH multiple-PI award — a principal
    // investigator, not a junior "co-" role. Counting one is counting the other.
    const grants: GrantLike[] = [
      { role: "PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
      { role: "Co-PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(2);
  });

  it("row 9: only ever Co-PI — `piRoleEver=true`; an MPI-only scholar IS a PI", () => {
    // Was "`piRoleEver=false` (Co-PI dropped per audit)". Same inversion, and this
    // is the row that made the defect visible: a scholar whose principal-investigator
    // standing is entirely on multiple-PI awards was absent from the PI facet.
    const grants: GrantLike[] = [
      { role: "Co-PI", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(1);
  });

  it("PI-Subaward counts the same as PI for all three options", () => {
    const grants: GrantLike[] = [
      { role: "PI-Subaward", endDate: FAR_FUTURE, mechanism: "U01", programType: "Grant" },
      { role: "PI-Subaward", endDate: FAR_FUTURE, mechanism: "R01", programType: "Grant" },
    ];
    expect(piRoleEver(grants)).toBe(true);
    expect(activePiGrantCount(grants, NOW)).toBe(2);
  });
});
