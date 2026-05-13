import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { formatPublishedName, normalizePostnominal } from "@/lib/postnominal";

describe("normalizePostnominal", () => {
  it("collapses 'Doctor of Philosophy' to 'PhD'", () => {
    expect(normalizePostnominal("Doctor of Philosophy")).toBe("PhD");
  });

  it("collapses 'Doctor of Medicine' to 'MD'", () => {
    expect(normalizePostnominal("Doctor of Medicine")).toBe("MD");
  });

  it("leaves already-abbreviated values unchanged", () => {
    expect(normalizePostnominal("PhD")).toBe("PhD");
    expect(normalizePostnominal("MD, PhD")).toBe("MD, PhD");
    expect(normalizePostnominal("DPhil")).toBe("DPhil");
  });

  it("handles compound forms that mix abbreviations and full titles", () => {
    // ETL hasn't been observed producing these in production, but be
    // defensive — split on commas and normalize each segment.
    expect(normalizePostnominal("Doctor of Medicine, PhD")).toBe("MD, PhD");
    expect(normalizePostnominal("MD, Doctor of Philosophy")).toBe("MD, PhD");
  });

  it("is case-insensitive on the full-title match", () => {
    expect(normalizePostnominal("doctor of philosophy")).toBe("PhD");
    expect(normalizePostnominal("DOCTOR OF MEDICINE")).toBe("MD");
  });

  it("trims whitespace around segments", () => {
    expect(normalizePostnominal("  Doctor of Philosophy  ")).toBe("PhD");
    expect(normalizePostnominal("MD ,  PhD")).toBe("MD, PhD");
  });

  it("returns null for null/empty/whitespace-only input", () => {
    expect(normalizePostnominal(null)).toBeNull();
    expect(normalizePostnominal(undefined)).toBeNull();
    expect(normalizePostnominal("")).toBeNull();
    expect(normalizePostnominal("   ")).toBeNull();
    expect(normalizePostnominal(", ,")).toBeNull();
  });

  it("leaves unrecognized 'Doctor of …' forms unchanged but warns in dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(normalizePostnominal("Doctor of Veterinary Medicine")).toBe(
        "Doctor of Veterinary Medicine",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Doctor of Veterinary Medicine"),
      );
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });
});

describe("formatPublishedName", () => {
  it("appends normalized postnominal with comma separator", () => {
    expect(formatPublishedName("Ashna Singh", "Doctor of Philosophy")).toBe(
      "Ashna Singh, PhD",
    );
    expect(formatPublishedName("Conor Liston", "PhD, MD")).toBe(
      "Conor Liston, PhD, MD",
    );
  });

  it("returns the preferred name alone when postnominal is missing", () => {
    expect(formatPublishedName("Lisa Park", null)).toBe("Lisa Park");
    expect(formatPublishedName("Lisa Park", undefined)).toBe("Lisa Park");
    expect(formatPublishedName("Lisa Park", "")).toBe("Lisa Park");
    expect(formatPublishedName("Lisa Park", "   ")).toBe("Lisa Park");
  });
});
