/**
 * #552 Phase 7 — center roster audit-history read (`lib/api/center-audit.ts`).
 *
 * Drives the change-derivation + row-shaping pure functions directly, and the
 * `loadCenterAuditHistory` query path with a fake `$queryRaw` (no live DB).
 * Covers: add / remove / modify kinds, the field-diff summary, JSON columns
 * arriving as strings vs parsed objects, the impersonation column, the
 * empty-code short-circuit, and that the bound window cutoff is passed through.
 */
import { describe, expect, it, vi } from "vitest";
import {
  deriveChange,
  shapeAuditRows,
  loadCenterAuditHistory,
  CENTER_AUDIT_WINDOW_DAYS,
  type CenterAuditClient,
} from "@/lib/api/center-audit";

describe("deriveChange", () => {
  it("before=null → add; targetCwid from after", () => {
    const r = deriveChange(null, { cwid: "abc1001", programCode: "CT" });
    expect(r.changeKind).toBe("add");
    expect(r.targetCwid).toBe("abc1001");
    expect(r.fieldChanges).toEqual([]);
  });

  it("after=null → remove; targetCwid from before", () => {
    const r = deriveChange({ cwid: "abc1001", programCode: "CT" }, null);
    expect(r.changeKind).toBe("remove");
    expect(r.targetCwid).toBe("abc1001");
    expect(r.fieldChanges).toEqual([]);
  });

  it("both present → modify; only changed fields surface, with labels", () => {
    const r = deriveChange(
      {
        cwid: "abc1001",
        membershipType: "research",
        programCode: "CT",
        startDate: null,
        endDate: null,
      },
      {
        cwid: "abc1001",
        membershipType: "clinical",
        programCode: "CT",
        startDate: "2024-07-01",
        endDate: null,
      },
    );
    expect(r.changeKind).toBe("modify");
    expect(r.targetCwid).toBe("abc1001");
    expect(r.fieldChanges).toEqual([
      { field: "type", from: "research", to: "clinical" },
      { field: "start", from: null, to: "2024-07-01" },
    ]);
  });

  it("modify with no field delta → empty diff (e.g. a no-op set)", () => {
    const snap = {
      cwid: "abc1001",
      membershipType: "research",
      programCode: "CT",
      startDate: null,
      endDate: null,
    };
    expect(deriveChange(snap, { ...snap }).fieldChanges).toEqual([]);
  });
});

describe("shapeAuditRows", () => {
  it("parses JSON columns whether string-encoded or already objects", () => {
    const [a, b] = shapeAuditRows([
      {
        id: 10n,
        ts: new Date("2026-06-01T12:00:00.000Z"),
        actor_cwid: "cur0001",
        impersonated_cwid: null,
        before_values: null,
        after_values: '{"cwid":"abc1001","programCode":"CT"}', // string-encoded
      },
      {
        id: 9,
        ts: "2026-05-31 09:30:00.000",
        actor_cwid: "sup0001",
        impersonated_cwid: "own0002",
        before_values: { cwid: "def2002", programCode: "ZY" }, // parsed object
        after_values: null,
      },
    ]);
    expect(a).toMatchObject({
      id: "10",
      changeKind: "add",
      targetCwid: "abc1001",
      actorCwid: "cur0001",
    });
    expect(a.ts).toBe("2026-06-01T12:00:00.000Z");
    expect(b).toMatchObject({
      id: "9",
      changeKind: "remove",
      targetCwid: "def2002",
      impersonatedCwid: "own0002",
    });
    // a DATETIME(3) string round-trips to an ISO instant
    expect(b.ts).toBe("2026-05-31T09:30:00.000Z");
  });

  it("tolerates an unparseable JSON string (treated as null snapshot)", () => {
    const [row] = shapeAuditRows([
      {
        id: 1,
        ts: new Date("2026-06-01T00:00:00.000Z"),
        actor_cwid: "cur0001",
        impersonated_cwid: null,
        before_values: "not json",
        after_values: { cwid: "abc1001" },
      },
    ]);
    // before parsed as null → add
    expect(row.changeKind).toBe("add");
    expect(row.targetCwid).toBe("abc1001");
  });
});

describe("loadCenterAuditHistory", () => {
  it("returns [] for an empty center code without querying", async () => {
    const queryRaw = vi.fn();
    const client = { $queryRaw: queryRaw } as unknown as CenterAuditClient;
    expect(await loadCenterAuditHistory("", client)).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("queries and shapes rows; binds the center code and the windowed cutoff", async () => {
    const captured: unknown[] = [];
    // The tagged-template $queryRaw receives (strings, ...values).
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push(...values);
      return [
        {
          id: 5n,
          ts: new Date("2026-06-05T08:00:00.000Z"),
          actor_cwid: "cur0001",
          impersonated_cwid: null,
          before_values: null,
          after_values: { cwid: "abc1001", programCode: "CT" },
        },
      ];
    });
    const client = { $queryRaw: queryRaw } as unknown as CenterAuditClient;
    const now = new Date("2026-06-09T00:00:00.000Z");

    const entries = await loadCenterAuditHistory("meyer_cancer_center", client, now);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ changeKind: "add", targetCwid: "abc1001" });
    // bound values: the center code + the 90-day cutoff Date
    expect(captured[0]).toBe("meyer_cancer_center");
    const cutoff = captured[1] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(now.getTime() - cutoff.getTime()).toBe(CENTER_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });
});
