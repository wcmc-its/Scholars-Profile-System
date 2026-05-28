/**
 * Consent module (#538 PR-1) — exposes the version constant and a stub
 * text loader so PR-2 (form) can import this without PR-3 (consent
 * markdown + B03 audit wiring) landing first.
 */
import { describe, expect, it } from "vitest";

import { CURRENT_CONSENT_VERSION, loadConsentMarkdown } from "@/lib/feedback/consent";

describe("CURRENT_CONSENT_VERSION", () => {
  it("is v1 at PR-1", () => {
    expect(CURRENT_CONSENT_VERSION).toBe("v1");
  });

  it("matches the documented consent_version column max length", () => {
    expect(CURRENT_CONSENT_VERSION.length).toBeLessThanOrEqual(16);
  });
});

describe("loadConsentMarkdown", () => {
  it("returns a non-empty disclosure body", () => {
    const text = loadConsentMarkdown();
    expect(text.length).toBeGreaterThan(0);
  });

  it("returns trimmed text (no leading / trailing whitespace)", () => {
    const text = loadConsentMarkdown();
    expect(text).toBe(text.trim());
  });

  it("mentions aggregate analysis and published reports (covers the IRB-required disclosures)", () => {
    const text = loadConsentMarkdown().toLowerCase();
    expect(text).toContain("aggregate");
    expect(text).toContain("published");
  });
});
