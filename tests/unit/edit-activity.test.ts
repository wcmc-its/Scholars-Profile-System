import { describe, expect, it } from "vitest";

import {
  EDIT_ACTIVITY_RECENT_LIMIT,
  EDIT_ACTIVITY_WINDOW_DAYS,
  type EditActivitySummary,
  buildChanges,
  coerceValue,
  collectCwids,
  decodeCursor,
  easternOffset,
  encodeCursor,
  isSystemActor,
  loadEditActivitySummary,
  loadOlderEdits,
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

describe("collectCwids", () => {
  /** Only the fields collectCwids reads. */
  const summary = (over: Partial<EditActivitySummary>): EditActivitySummary =>
    ({
      windowDays: 30,
      totalEdits: 0,
      perDay: [],
      topEditors: [],
      topEntities: [],
      recent: [],
      people: {},
      ...over,
    }) as EditActivitySummary;

  const recentRow = (over: Partial<EditActivitySummary["recent"][number]>) => ({
    id: "r",
    ts: "2026-07-03T00:00:00.000Z",
    actorCwid: "act0001",
    impersonatedCwid: null,
    action: "field_update",
    entityType: "scholar",
    entityId: "sch0001",
    changes: [],
    detail: null,
    ...over,
  });

  it("collects editors, impersonated actors, and scholar entity ids — deduped", () => {
    expect(
      collectCwids(
        summary({
          topEditors: [{ actorCwid: "act0001", edits: 9 }],
          topEntities: [{ entityType: "scholar", entityId: "sch0002", edits: 4 }],
          recent: [
            recentRow({}),
            recentRow({ id: "r2", impersonatedCwid: "imp0003" }),
            recentRow({ id: "r3" }),
          ],
        }),
      ).sort(),
    ).toEqual(["act0001", "imp0003", "sch0001", "sch0002"]);
  });

  it("🔴 never treats a non-scholar entity id as a CWID — those are unit CODES", () => {
    // `target_entity_id` is a department/division/center code for every other
    // entity type. Feeding those to the Scholar lookup is harmless but wrong, and
    // it is how a code would end up rendered as somebody's name.
    expect(
      collectCwids(
        summary({
          topEntities: [
            { entityType: "center", entityId: "CTSC", edits: 4 },
            { entityType: "department", entityId: "MED", edits: 2 },
          ],
          recent: [recentRow({ entityType: "center", entityId: "CTSC" })],
        }),
      ).sort(),
    ).toEqual(["act0001"]);
  });
});

describe("loadEditActivitySummary name resolution", () => {
  /** $queryRaw answers the four aggregate reads in call order. */
  const fakeClient = (scholarFindMany: () => Promise<unknown[]>) => {
    const answers = [
      [{ day: "2026-07-03", edits: 1 }],
      [{ actor_cwid: "act0001", edits: 1 }],
      [],
      [],
    ];
    let call = 0;
    return {
      $queryRaw: async () => answers[call++] ?? [],
      scholar: { findMany: scholarFindMany },
    } as never;
  };

  it("attaches name + title for each resolved CWID", async () => {
    const summary = await loadEditActivitySummary(
      fakeClient(async () => [
        { cwid: "act0001", preferredName: "Ada Editor", primaryTitle: "Professor of Medicine" },
      ]),
    );
    expect(summary.people).toEqual({
      act0001: { name: "Ada Editor", title: "Professor of Medicine" },
    });
  });

  it("🔴 fails SOFT when the Scholar read throws — a cosmetic lookup must not blank the page", async () => {
    // The page renders its "unavailable" notice when this loader throws. Before the
    // fail-soft, an unreadable Scholar table turned a perfectly good audit read into
    // an outage.
    const summary = await loadEditActivitySummary(
      fakeClient(async () => {
        throw new Error("SELECT command denied");
      }),
    );
    expect(summary.people).toEqual({});
    expect(summary.totalEdits).toBe(1);
    expect(summary.topEditors).toEqual([{ actorCwid: "act0001", edits: 1 }]);
  });
});

describe("activity redesign — KPIs, day buckets, entity names", () => {
  it("easternOffset follows DST", () => {
    expect(easternOffset(new Date("2026-07-01T12:00:00Z"))).toBe("-04:00");
    expect(easternOffset(new Date("2026-01-15T12:00:00Z"))).toBe("-05:00");
  });

  it("isSystemActor is the system- prefix only", () => {
    expect(isSystemActor("system-autolock")).toBe(true);
    expect(isSystemActor("abc1234")).toBe(false);
  });

  it("shapeSummary reads window-wide editor stats (bigint) and stamps generatedAt", () => {
    const now = new Date("2026-09-24T15:00:00Z");
    const s = shapeSummary(
      [{ day: "2026-09-24", edits: 10 }],
      [{ actor_cwid: "abc1234", edits: 10n }],
      [],
      [],
      [{ editors: 7n, automated_editors: 1n, automated_edits: 4n }],
      now,
    );
    expect(s.editorStats).toEqual({ editors: 7, automatedEditors: 1, automatedEdits: 4 });
    expect(s.generatedAt).toBe("2026-09-24T15:00:00.000Z");
  });

  it("without a stats row, editor stats fall back to the capped list", () => {
    const s = shapeSummary(
      [],
      [
        { actor_cwid: "system-autolock", edits: 3n },
        { actor_cwid: "abc1234", edits: 2n },
      ],
      [],
      [],
    );
    expect(s.editorStats).toEqual({ editors: 2, automatedEditors: 1, automatedEdits: 3 });
  });

  it("buckets days in Eastern time with a bound offset, and names centers + cores", async () => {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const answers = [
      [{ day: "2026-09-24", edits: 2 }],
      [{ actor_cwid: "abc1234", edits: 2 }],
      [
        { target_entity_type: "center", target_entity_id: "ctr_one", edits: 1 },
        { target_entity_type: "core", target_entity_id: "7", edits: 1 },
      ],
      [],
      [{ editors: 1, automated_editors: 0, automated_edits: 0 }],
    ];
    let call = 0;
    const client = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqls.push(strings.join("?"));
        params.push(values);
        return answers[call++] ?? [];
      },
      scholar: { findMany: async () => [] },
      center: { findMany: async () => [{ code: "ctr_one", name: "Center One" }] },
      core: { findMany: async () => [{ id: "7", name: "Core Seven" }] },
    } as never;
    const summary = await loadEditActivitySummary(client, new Date("2026-09-24T15:00:00Z"));
    expect(sqls[0]).toContain("CONVERT_TZ(ts, '+00:00', ?)");
    expect(params[0]![0]).toBe("-04:00");
    expect(sqls[4]).toContain("COUNT(DISTINCT actor_cwid)");
    expect(summary.editorStats.editors).toBe(1);
    expect(summary.entityNames).toEqual({ "center:ctr_one": "Center One", "core:7": "Core Seven" });
  });
});

describe("Load older: cursor + paged read", () => {
  /** A raw audit row; `n` is the id and walks the timestamp back by n seconds. */
  const raw = (n: number, over: Record<string, unknown> = {}) => ({
    id: BigInt(n),
    ts: new Date(Date.UTC(2026, 8, 24, 12, 0, 0) - n * 1000),
    actor_cwid: "abc1234",
    impersonated_cwid: null,
    action: "field_override",
    target_entity_type: "scholar",
    target_entity_id: "sch0001",
    fields_changed: null,
    before_values: null,
    after_values: null,
    ...over,
  });

  it("encodeCursor / decodeCursor round-trip (ts, id)", () => {
    const c = encodeCursor({ ts: "2026-09-24T12:00:00.123Z", id: "98765" });
    expect(c).toBe("2026-09-24T12:00:00.123Z_98765");
    expect(decodeCursor(c)).toEqual({ ts: new Date("2026-09-24T12:00:00.123Z"), id: 98765n });
  });

  it("decodeCursor rejects anything malformed", () => {
    for (const bad of [
      null,
      "",
      "garbage",
      "2026-09-24T12:00:00.000Z",
      "2026-09-24T12:00:00.000Z_",
      "2026-09-24T12:00:00.000Z_12a",
      "2026-09-24T12:00:00.000Z_-1",
      "2026-13-45T12:00:00.000Z_1",
      "not-a-date_1",
      "1' OR 1=1_1",
      `2026-09-24T12:00:00.000Z_${"9".repeat(40)}`,
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("shapeSummary stringifies bigint ids and sets nextCursor only when the first page filled and more exist", () => {
    const full = Array.from({ length: EDIT_ACTIVITY_RECENT_LIMIT }, (_, i) => raw(i + 1));
    const s = shapeSummary([{ day: "2026-09-24", edits: 150 }], [], [], full);
    expect(s.recent[0]!.id).toBe("1");
    expect(JSON.stringify(s.recent[0])).toContain('"id":"1"');
    expect(s.nextCursor).toBe(encodeCursor(s.recent[EDIT_ACTIVITY_RECENT_LIMIT - 1]!));

    // Every edit in the window is already loaded.
    expect(shapeSummary([{ day: "2026-09-24", edits: 100 }], [], [], full).nextCursor).toBeNull();
    // A short first page is the whole window.
    expect(
      shapeSummary([{ day: "2026-09-24", edits: 150 }], [], [], [raw(1)]).nextCursor,
    ).toBeNull();
  });

  const pagedClient = (rows: unknown[]) => {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const client = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqls.push(strings.join("?"));
        params.push(values);
        return rows;
      },
      scholar: {
        findMany: async () => [
          { cwid: "abc1234", preferredName: "Ada Editor", primaryTitle: null },
        ],
      },
      center: { findMany: async () => [{ code: "ctr_one", name: "Center One" }] },
      core: { findMany: async () => [] },
    } as never;
    return { client, sqls, params };
  };

  it("loadOlderEdits reads strictly after the (ts, id) cursor, window-bounded, one look-ahead row", async () => {
    const rows = Array.from({ length: EDIT_ACTIVITY_RECENT_LIMIT + 1 }, (_, i) => raw(i + 200));
    const { client, sqls, params } = pagedClient(rows);
    const cursor = decodeCursor("2026-09-24T11:56:40.000Z_200")!;
    const now = new Date("2026-09-24T15:00:00Z");
    const page = await loadOlderEdits(client, cursor, now);

    expect(sqls).toHaveLength(1);
    const sql = sqls[0]!.replace(/\s+/g, " ");
    expect(sql).toContain("WHERE ts >= ? AND (ts < ? OR (ts = ? AND id < ?))");
    expect(sql).toContain("ORDER BY ts DESC, id DESC");
    expect(sql).toContain(`LIMIT ${EDIT_ACTIVITY_RECENT_LIMIT + 1}`);
    expect(params[0]).toEqual([
      new Date(now.getTime() - EDIT_ACTIVITY_WINDOW_DAYS * 86_400_000),
      cursor.ts,
      cursor.ts,
      200n,
    ]);

    // The look-ahead row is dropped; the cursor points at the last row returned.
    expect(page.recent).toHaveLength(EDIT_ACTIVITY_RECENT_LIMIT);
    expect(page.nextCursor).toBe(encodeCursor(page.recent[EDIT_ACTIVITY_RECENT_LIMIT - 1]!));
    expect(page.people).toEqual({ abc1234: { name: "Ada Editor", title: null } });
  });

  it("loadOlderEdits returns nextCursor null on the last page and names centers", async () => {
    const { client } = pagedClient([
      raw(5, { target_entity_type: "center", target_entity_id: "ctr_one" }),
    ]);
    const page = await loadOlderEdits(client, decodeCursor("2026-09-24T12:00:00.000Z_9")!);
    expect(page.recent.map((r) => r.id)).toEqual(["5"]);
    expect(page.nextCursor).toBeNull();
    expect(page.entityNames).toEqual({ "center:ctr_one": "Center One" });
  });

  it("loadOlderEdits throws when the audit read fails, but name lookups fail soft", async () => {
    const failing = {
      $queryRaw: async () => {
        throw new Error("SELECT command denied");
      },
      scholar: { findMany: async () => [] },
    } as never;
    await expect(
      loadOlderEdits(failing, decodeCursor("2026-09-24T12:00:00.000Z_9")!),
    ).rejects.toThrow("SELECT command denied");

    const softNames = {
      $queryRaw: async () => [raw(1)],
      scholar: {
        findMany: async () => {
          throw new Error("denied");
        },
      },
    } as never;
    const page = await loadOlderEdits(softNames, decodeCursor("2026-09-24T12:00:00.000Z_9")!);
    expect(page.recent).toHaveLength(1);
    expect(page.people).toEqual({});
  });
});
