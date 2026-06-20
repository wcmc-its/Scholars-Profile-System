/**
 * Read-time merge of CoreClaim over publication_core.status (lib/api/core-merge).
 * Pure functions only — the DB loaders are thin and integration-covered.
 */
import { describe, expect, it } from "vitest";
import {
  claimKey,
  effectiveCoreStatus,
  isEffectiveConfirmed,
  isOpenCandidate,
} from "@/lib/api/core-merge";

describe("effectiveCoreStatus", () => {
  it("an active 'claimed' wins over any engine status", () => {
    expect(effectiveCoreStatus("candidate", "claimed")).toBe("confirmed");
    expect(effectiveCoreStatus("below_threshold", "claimed")).toBe("confirmed");
  });

  it("an active 'rejected' excludes the pair even if the engine confirmed it", () => {
    expect(effectiveCoreStatus("confirmed", "rejected")).toBe("rejected");
  });

  it("with no claim the engine status passes through", () => {
    expect(effectiveCoreStatus("confirmed", null)).toBe("confirmed");
    expect(effectiveCoreStatus("candidate", null)).toBe("candidate");
    expect(effectiveCoreStatus("below_threshold", undefined)).toBe("below_threshold");
  });

  it("normalizes an unknown engine status to candidate", () => {
    expect(effectiveCoreStatus("weird", null)).toBe("candidate");
    expect(effectiveCoreStatus("", null)).toBe("candidate");
  });
});

describe("predicates", () => {
  it("isEffectiveConfirmed", () => {
    expect(isEffectiveConfirmed("candidate", "claimed")).toBe(true);
    expect(isEffectiveConfirmed("confirmed", null)).toBe(true);
    expect(isEffectiveConfirmed("confirmed", "rejected")).toBe(false);
    expect(isEffectiveConfirmed("candidate", null)).toBe(false);
  });

  it("isOpenCandidate is true only for an unclaimed engine candidate", () => {
    expect(isOpenCandidate("candidate", null)).toBe(true);
    expect(isOpenCandidate("candidate", "claimed")).toBe(false);
    expect(isOpenCandidate("candidate", "rejected")).toBe(false);
    expect(isOpenCandidate("confirmed", null)).toBe(false);
  });

  it("claimKey is stable and pair-specific", () => {
    expect(claimKey("123", "2")).toBe("123::2");
    expect(claimKey("123", "2")).not.toBe(claimKey("123", "3"));
  });
});
