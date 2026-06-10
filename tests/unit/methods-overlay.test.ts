/**
 * #800 suppression / #801 sensitivity overlay gate — the shared server-side guard
 * that keeps suppressed/sensitive method families off every PUBLIC cross-scholar
 * surface (family pages, supercategory rosters, search candidates). Every loader
 * in `lib/api/methods.ts` resolves a family's public visibility through this gate,
 * so it is the security-critical chokepoint for the standalone Method pages.
 *
 * Invariants under test:
 *  - #800 suppression is UNCONDITIONAL (always hidden).
 *  - #801 sensitivity is hidden publicly ONLY when METHODS_LENS_SENSITIVE_GATE is on;
 *    when off, the sensitivity overlay is never even queried and the set stays empty
 *    (matching the per-profile `partitionScholarFamilies` economy + semantics).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  familyOverlayKey,
  isFamilyPubliclyVisible,
  loadFamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import { prisma } from "@/lib/db";
import { isMethodsLensSensitiveGateOn } from "@/lib/profile/methods-lens-flags";

vi.mock("@/lib/db", () => ({
  prisma: {
    familySuppressionOverlay: { findMany: vi.fn() },
    familySensitivityOverlay: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensSensitiveGateOn: vi.fn(),
}));

const SUPPRESSED = { supercategory: "computational_statistical", familyLabel: "Descriptive statistics" };
const SENSITIVE = { supercategory: "animal_cell_models", familyLabel: "Genetically engineered mouse models" };

afterEach(() => {
  vi.mocked(prisma.familySuppressionOverlay.findMany).mockReset();
  vi.mocked(prisma.familySensitivityOverlay.findMany).mockReset();
  vi.mocked(isMethodsLensSensitiveGateOn).mockReset();
});

describe("familyOverlayKey", () => {
  it("joins (supercategory, label) with the collision-proof '::' separator", () => {
    expect(familyOverlayKey("animal_cell_models", "GEMM")).toBe("animal_cell_models::GEMM");
  });
});

describe("loadFamilyOverlayGate", () => {
  it("loads suppression only and leaves `sensitive` EMPTY when the sensitivity gate is OFF — never queries the sensitivity overlay", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(false);
    vi.mocked(prisma.familySuppressionOverlay.findMany).mockResolvedValue([SUPPRESSED] as never);

    const gate = await loadFamilyOverlayGate();

    expect(gate.suppressed.has(familyOverlayKey(SUPPRESSED.supercategory, SUPPRESSED.familyLabel))).toBe(true);
    expect(gate.sensitive.size).toBe(0);
    expect(prisma.familySensitivityOverlay.findMany).not.toHaveBeenCalled();
  });

  it("loads BOTH overlays when the sensitivity gate is ON", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(true);
    vi.mocked(prisma.familySuppressionOverlay.findMany).mockResolvedValue([SUPPRESSED] as never);
    vi.mocked(prisma.familySensitivityOverlay.findMany).mockResolvedValue([SENSITIVE] as never);

    const gate = await loadFamilyOverlayGate();

    expect(gate.suppressed.has(familyOverlayKey(SUPPRESSED.supercategory, SUPPRESSED.familyLabel))).toBe(true);
    expect(gate.sensitive.has(familyOverlayKey(SENSITIVE.supercategory, SENSITIVE.familyLabel))).toBe(true);
    expect(prisma.familySensitivityOverlay.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("isFamilyPubliclyVisible", () => {
  const gate = {
    suppressed: new Set([familyOverlayKey(SUPPRESSED.supercategory, SUPPRESSED.familyLabel)]),
    sensitive: new Set([familyOverlayKey(SENSITIVE.supercategory, SENSITIVE.familyLabel)]),
  };

  it("shows a clean, non-overlaid family", () => {
    expect(isFamilyPubliclyVisible("genomics_sequencing", "CRISPR gene editing", gate)).toBe(true);
  });

  it("hides a #800-suppressed family (unconditional)", () => {
    expect(isFamilyPubliclyVisible(SUPPRESSED.supercategory, SUPPRESSED.familyLabel, gate)).toBe(false);
  });

  it("hides a #801-sensitive family when the gate is on (sensitive set populated)", () => {
    expect(isFamilyPubliclyVisible(SENSITIVE.supercategory, SENSITIVE.familyLabel, gate)).toBe(false);
  });

  it("shows a would-be-sensitive family when the gate is OFF (sensitive set empty) — sensitivity is gated, not absolute", () => {
    const gateOff = { suppressed: new Set<string>(), sensitive: new Set<string>() };
    expect(isFamilyPubliclyVisible(SENSITIVE.supercategory, SENSITIVE.familyLabel, gateOff)).toBe(true);
  });
});
