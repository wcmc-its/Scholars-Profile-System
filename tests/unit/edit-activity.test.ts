import { describe, expect, it } from "vitest";

import {
  EDIT_ACTIVITY_WINDOW_DAYS,
  buildChanges,
  coerceValue,
  shapeSummary,
  toDay,
} from "@/lib/api/edit-activity";

describe("toDay", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(toDay(new Date("2026-07-03T14:30:00Z"))).toBe("2026-07-03");
  });
  it("passes a string date through, trimmed to the date part", () => {
    expect(toDay("2026-07-03")).toBe("2026-07-03");
    expect(toDay("2026-07-03T00:00:00")).toBe("2026-07-03");
  });
});

describe("coerceValue", () => {
  it("returns strings as-is; null/empty -> null; non-strings as compact JSON", () => {
    expect(coerceValue("hello")).toBe("hello");
    expect(coerceValue("")).toBeNull();
    expect(coerceValue(null)).toBeNull();
    expect(coerceValue(undefined)).toBeNull();
    expect(coerceValue(["a", "b"])).toBe('["a","b"]');
    expect(coerceValue(42)).toBe("42");
  });
});

describe("buildChanges", () => {
  it("pairs before/after per changed field from JSON-string columns", () => {
    expect(
      buildChanges(
        '["overview","slug"]',
        '{"overview":"old","slug":"a"}',
        '{"overview":"new","slug":"b"}',
      ),
    ).toEqual([
      { field: "Overview", before: "old", after: "new" },
      { field: "Slug", before: "a", after: "b" },
    ]);
  });

  it("accepts already-parsed values and null-fills a missing side", () => {
    expect(buildChanges(["overview"], null, { overview: "created" })).toEqual([
      { field: "Overview", before: null, after: "created" },
    ]);
  });

  it("returns [] when fields_changed is absent or not an array", () => {
    expect(buildChanges(null, null, null)).toEqual([]);
    expect(buildChanges('{"not":"array"}', null, null)).toEqual([]);
  });
});

describe("shapeSummary", () => {
  it("coerces counts, totals per-day, maps dimensions, and builds field changes", () => {
    const summary = shapeSummary(
      [
        { day: new Date("2026-07-03T00:00:00Z"), edits: 5n },
        { day: "2026-07-02", edits: 3 },
      ],
      [{ actor_cwid: "aog2001", edits: 8n }],
      [{ target_entity_type: "scholar", target_entity_id: "abc123", edits: 4n }],
      [
        {
          id: "row1",
          ts: new Date("2026-07-03T14:30:00Z"),
          actor_cwid: "aog2001",
          impersonated_cwid: null,
          action: "field_update",
          target_entity_type: "scholar",
          target_entity_id: "abc123",
          fields_changed: '["overview"]',
          before_values: '{"overview":"old bio"}',
          after_values: '{"overview":"new bio"}',
        },
      ],
    );

    expect(summary.windowDays).toBe(EDIT_ACTIVITY_WINDOW_DAYS);
    expect(summary.totalEdits).toBe(8); // 5 + 3, bigint coerced to number
    expect(summary.perDay).toEqual([
      { day: "2026-07-03", edits: 5 },
      { day: "2026-07-02", edits: 3 },
    ]);
    expect(summary.topEditors).toEqual([{ actorCwid: "aog2001", edits: 8 }]);
    expect(summary.topEntities).toEqual([{ entityType: "scholar", entityId: "abc123", edits: 4 }]);
    expect(summary.recent[0]).toMatchObject({
      id: "row1",
      ts: "2026-07-03T14:30:00.000Z",
      actorCwid: "aog2001",
      entityType: "scholar",
      entityId: "abc123",
      changes: [{ field: "Overview", before: "old bio", after: "new bio" }],
      detail: null,
    });
  });

  it("falls back to a compact detail for non-field actions (empty changes)", () => {
    const summary = shapeSummary(
      [],
      [],
      [],
      [
        {
          id: "row2",
          ts: "2026-07-01 12:00:00",
          actor_cwid: "aog2001",
          impersonated_cwid: "tgt0001",
          action: "proxy_grant",
          target_entity_type: "scholar",
          target_entity_id: "tgt0001",
          fields_changed: null,
          before_values: null,
          after_values: '{"proxy_cwid":"px0009"}',
        },
      ],
    );
    expect(summary.recent[0].changes).toEqual([]);
    expect(summary.recent[0].detail).toBe("px0009");
  });

  it("handles empty result sets", () => {
    const s = shapeSummary([], [], [], []);
    expect(s.totalEdits).toBe(0);
    expect(s.perDay).toEqual([]);
    expect(s.recent).toEqual([]);
  });
});
