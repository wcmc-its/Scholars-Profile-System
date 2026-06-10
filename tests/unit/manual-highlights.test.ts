/**
 * #836 — opt-in manual Highlights override.
 *
 * Covers the three pieces of new logic:
 *   - `validateSelectedHighlightPmids` — the write-path shape validator.
 *   - `getSelectedHighlightPmids` — the read of the `field_override` row.
 *   - `pickManualHighlights` — the read-time precedence (manual order, suppressed
 *      pmid dropped, invalid/absent → AI fallback).
 */
import { describe, expect, it, vi } from "vitest";

import {
  MAX_SELECTED_HIGHLIGHTS,
  validateSelectedHighlightPmids,
} from "@/lib/edit/validators";
import { getSelectedHighlightPmids, pickManualHighlights } from "@/lib/api/manual-layer";

// ---------------------------------------------------------------------------
// validateSelectedHighlightPmids
// ---------------------------------------------------------------------------

describe("validateSelectedHighlightPmids", () => {
  it("accepts an in-bounds array of numeric PMID strings, preserving order", () => {
    const r = validateSelectedHighlightPmids(["300", "100", "200"]);
    expect(r).toEqual({ ok: true, value: ["300", "100", "200"] });
  });

  it("accepts a JSON-string payload (the stored shape) and parses it", () => {
    const r = validateSelectedHighlightPmids('["123","456"]');
    expect(r).toEqual({ ok: true, value: ["123", "456"] });
  });

  it("accepts an empty array (a benign no-op — read path falls back to AI)", () => {
    expect(validateSelectedHighlightPmids([])).toEqual({ ok: true, value: [] });
  });

  it("rejects more than the highlight count", () => {
    const tooMany = Array.from({ length: MAX_SELECTED_HIGHLIGHTS + 1 }, (_, i) => String(i + 1));
    expect(validateSelectedHighlightPmids(tooMany)).toEqual({ ok: false, error: "too_many" });
  });

  it("rejects a non-array value", () => {
    expect(validateSelectedHighlightPmids({ pmids: ["1"] })).toEqual({
      ok: false,
      error: "invalid_value",
    });
    expect(validateSelectedHighlightPmids(42)).toEqual({ ok: false, error: "invalid_value" });
  });

  it("rejects a malformed JSON string", () => {
    expect(validateSelectedHighlightPmids("not json")).toEqual({
      ok: false,
      error: "invalid_value",
    });
  });

  it("rejects a non-numeric, empty, or leading-zero PMID", () => {
    expect(validateSelectedHighlightPmids(["abc"])).toEqual({ ok: false, error: "invalid_pmid" });
    expect(validateSelectedHighlightPmids([""])).toEqual({ ok: false, error: "invalid_pmid" });
    expect(validateSelectedHighlightPmids(["0123"])).toEqual({ ok: false, error: "invalid_pmid" });
    expect(validateSelectedHighlightPmids([123 as unknown as string])).toEqual({
      ok: false,
      error: "invalid_pmid",
    });
  });

  it("rejects duplicate PMIDs", () => {
    expect(validateSelectedHighlightPmids(["100", "100"])).toEqual({
      ok: false,
      error: "duplicate",
    });
  });
});

// ---------------------------------------------------------------------------
// getSelectedHighlightPmids
// ---------------------------------------------------------------------------

type OverrideClient = Parameters<typeof getSelectedHighlightPmids>[1];

function client(row: unknown): OverrideClient {
  return {
    fieldOverride: { findUnique: vi.fn().mockResolvedValue(row) },
  } as unknown as OverrideClient;
}

describe("getSelectedHighlightPmids", () => {
  it("returns the parsed PMID array, in order, when an override exists", async () => {
    const r = await getSelectedHighlightPmids("cwid1", client({ value: '["9","8","7"]' }));
    expect(r).toEqual(["9", "8", "7"]);
  });

  it("returns null when there is no override", async () => {
    expect(await getSelectedHighlightPmids("cwid1", client(null))).toBeNull();
  });

  it("treats a corrupt stored value as no override (never throws)", async () => {
    expect(await getSelectedHighlightPmids("cwid1", client({ value: "{bad json" }))).toBeNull();
    expect(await getSelectedHighlightPmids("cwid1", client({ value: '["x"]' }))).toBeNull();
  });

  it("looks the override up by the (scholar, cwid, selectedHighlightPmids) key", async () => {
    const c = client(null);
    await getSelectedHighlightPmids("cwid9", c);
    expect(c.fieldOverride.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType_entityId_fieldName: {
            entityType: "scholar",
            entityId: "cwid9",
            fieldName: "selectedHighlightPmids",
          },
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// pickManualHighlights — the read-time precedence
// ---------------------------------------------------------------------------

type Pub = { pmid: string; label: string };

const VISIBLE: Pub[] = [
  { pmid: "1", label: "one" },
  { pmid: "2", label: "two" },
  { pmid: "3", label: "three" },
  { pmid: "4", label: "four" },
];
// The AI default (a top-N slice of VISIBLE in some ranked order).
const AI: Pub[] = [
  { pmid: "3", label: "three" },
  { pmid: "1", label: "one" },
];

describe("pickManualHighlights", () => {
  it("falls back to the AI selection when there is no override", () => {
    expect(pickManualHighlights(VISIBLE, AI, null)).toEqual(AI);
  });

  it("falls back to the AI selection for an empty override array", () => {
    expect(pickManualHighlights(VISIBLE, AI, [])).toEqual(AI);
  });

  it("returns the manual pubs IN STORED ORDER when an override is present", () => {
    const r = pickManualHighlights(VISIBLE, AI, ["4", "2"]);
    expect(r.map((p) => p.pmid)).toEqual(["4", "2"]);
  });

  it("drops a manual pmid that is not in the visible set (suppressed since the pick)", () => {
    // "2" was suppressed → not in `visible`; it is silently dropped, never
    // resurfaced. The remaining pick stands.
    const visibleMinus2 = VISIBLE.filter((p) => p.pmid !== "2");
    const r = pickManualHighlights(visibleMinus2, AI, ["4", "2", "1"]);
    expect(r.map((p) => p.pmid)).toEqual(["4", "1"]);
  });

  it("falls back to AI when EVERY manual pick dropped out (never an empty surface)", () => {
    // All manual picks suppressed/out-of-set → the section would be empty, so we
    // fall back to the AI selection rather than render nothing.
    const r = pickManualHighlights(VISIBLE, AI, ["999", "888"]);
    expect(r).toEqual(AI);
  });

  it("returns a fresh array (does not alias the AI input)", () => {
    const r = pickManualHighlights(VISIBLE, AI, null);
    expect(r).not.toBe(AI);
    expect(r).toEqual(AI);
  });
});
