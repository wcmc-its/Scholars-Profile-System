import { describe, expect, it } from "vitest";

import { EDIT_ACTIVITY_WINDOW_DAYS, shapeSummary, toDay } from "@/lib/api/edit-activity";

describe("toDay", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(toDay(new Date("2026-07-03T14:30:00Z"))).toBe("2026-07-03");
  });
  it("passes a string date through, trimmed to the date part", () => {
    expect(toDay("2026-07-03")).toBe("2026-07-03");
    expect(toDay("2026-07-03T00:00:00")).toBe("2026-07-03");
  });
});

describe("shapeSummary", () => {
  it("coerces bigint counts, totals per-day, and maps every dimension", () => {
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
    expect(summary.topEntities).toEqual([
      { entityType: "scholar", entityId: "abc123", edits: 4 },
    ]);
    expect(summary.recent[0]).toMatchObject({
      id: "row1",
      ts: "2026-07-03T14:30:00.000Z",
      actorCwid: "aog2001",
      impersonatedCwid: null,
      entityType: "scholar",
      entityId: "abc123",
    });
  });

  it("handles empty result sets", () => {
    const s = shapeSummary([], [], [], []);
    expect(s.totalEdits).toBe(0);
    expect(s.perDay).toEqual([]);
    expect(s.recent).toEqual([]);
  });
});
