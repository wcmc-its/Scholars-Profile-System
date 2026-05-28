/**
 * `sanitizeFreeText` (#538 PR-1) — server-side cleanup for the form's
 * free-text fields.
 */
import { describe, expect, it } from "vitest";

import { sanitizeFreeText } from "@/lib/feedback/sanitize";

describe("sanitizeFreeText", () => {
  it("returns trimmed text unchanged when under the bound", () => {
    expect(sanitizeFreeText("  hello world  ", 500)).toEqual({ ok: true, value: "hello world" });
  });

  it("returns NULL for empty / whitespace / null / undefined input", () => {
    expect(sanitizeFreeText("", 500)).toEqual({ ok: true, value: null });
    expect(sanitizeFreeText("   ", 500)).toEqual({ ok: true, value: null });
    expect(sanitizeFreeText("\t\n  \t", 500)).toEqual({ ok: true, value: null });
    expect(sanitizeFreeText(null, 500)).toEqual({ ok: true, value: null });
    expect(sanitizeFreeText(undefined, 500)).toEqual({ ok: true, value: null });
  });

  it("truncates to maxLen", () => {
    const input = "a".repeat(600);
    expect(sanitizeFreeText(input, 500)).toEqual({ ok: true, value: "a".repeat(500) });
  });

  it("preserves \\n and \\t but strips other control chars", () => {
    const input = "line1\nline2\tindented\x01\x07\x1b\x7f";
    expect(sanitizeFreeText(input, 500)).toEqual({ ok: true, value: "line1\nline2\tindented" });
  });

  it("drops \\r (CRLF normalization)", () => {
    expect(sanitizeFreeText("line1\r\nline2", 500)).toEqual({ ok: true, value: "line1\nline2" });
  });

  it("fails closed on a null byte (hostile probe)", () => {
    expect(sanitizeFreeText("hello\x00world", 500)).toEqual({ ok: false, error: "null_byte" });
  });

  it("preserves common Unicode (non-ASCII letters, emoji, RTL)", () => {
    const input = "café naïve résumé — π — ✓ — שלום";
    expect(sanitizeFreeText(input, 500)).toEqual({ ok: true, value: input });
  });

  it("truncates at character (UTF-16 code-unit) boundary, not byte", () => {
    const input = "x".repeat(498) + "café"; // 502 code units (é is 1 unit in BMP)
    const result = sanitizeFreeText(input, 500);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.length).toBe(500);
    }
  });

  it("respects different per-field bounds (Q1 other=200, Q8 other=100)", () => {
    expect(sanitizeFreeText("z".repeat(300), 200)).toEqual({ ok: true, value: "z".repeat(200) });
    expect(sanitizeFreeText("z".repeat(300), 100)).toEqual({ ok: true, value: "z".repeat(100) });
  });
});
