/**
 * #955 finding #11 — scholar profile audit-history read (`lib/api/scholar-audit.ts`).
 *
 * Drives the label / field / detail / row-shaping pure functions directly, and
 * the `loadScholarAuditHistory` query path with a fake `$queryRaw` (no live DB).
 * Covers: action labelling (mapped + humanized fallback), field-label parsing
 * (string-encoded vs parsed JSON, non-string filtering), per-action detail
 * (proxy cwid, slug), JSON columns arriving as strings vs objects, the
 * impersonation column, the empty-cwid short-circuit, and that the bound window
 * cutoff is passed through.
 */
import { describe, expect, it, vi } from "vitest";
import {
  detailForAction,
  fieldLabels,
  humanizeField,
  labelForAction,
  loadScholarAuditHistory,
  shapeScholarAuditRows,
  SCHOLAR_AUDIT_WINDOW_DAYS,
  type ScholarAuditClient,
} from "@/lib/api/scholar-audit";

describe("humanizeField / labelForAction", () => {
  it("known field keys get a curated label; others humanize from camelCase / snake", () => {
    expect(humanizeField("overview")).toBe("Overview");
    expect(humanizeField("primaryTitle")).toBe("Primary title");
    expect(humanizeField("orcid")).toBe("ORCID");
    expect(humanizeField("some_other_field")).toBe("Some other field");
  });

  it("maps known actions and falls back to a humanized label for unmapped ones", () => {
    expect(labelForAction("field_override")).toBe("Updated profile");
    expect(labelForAction("proxy_grant")).toBe("Granted proxy editor");
    expect(labelForAction("impersonation_start")).toBe("Started View-as session");
    // an action with no curated label still renders human-readably, never raw
    expect(labelForAction("some_future_action")).toBe("Some future action");
  });
});

describe("fieldLabels", () => {
  it("parses a string-encoded array and humanizes each, filtering non-strings", () => {
    expect(fieldLabels('["overview","primaryTitle"]')).toEqual(["Overview", "Primary title"]);
    expect(fieldLabels(["overview", "", 7, null])).toEqual(["Overview"]);
  });

  it("returns [] for null / non-array / unparseable input", () => {
    expect(fieldLabels(null)).toEqual([]);
    expect(fieldLabels("not json")).toEqual([]);
    expect(fieldLabels('{"overview":true}')).toEqual([]);
  });
});

describe("detailForAction", () => {
  it("surfaces the proxy cwid from the right side of the change", () => {
    expect(detailForAction("proxy_grant", null, { proxy_cwid: "prx0001" })).toBe("prx0001");
    expect(detailForAction("proxy_revoke", { proxy_cwid: "prx0002" }, null)).toBe("prx0002");
  });

  it("surfaces the requested slug, and is null for actions without a detail", () => {
    expect(detailForAction("slug_request", null, { slug: "jane-doe" })).toBe("jane-doe");
    expect(detailForAction("field_override", { overview: "x" }, { overview: "y" })).toBeNull();
  });
});

describe("shapeScholarAuditRows", () => {
  it("shapes rows; parses JSON columns whether string-encoded or already objects", () => {
    const [a, b] = shapeScholarAuditRows([
      {
        id: 10n,
        ts: new Date("2026-06-01T12:00:00.000Z"),
        actor_cwid: "self0001",
        impersonated_cwid: null,
        action: "field_override",
        fields_changed: '["overview"]', // string-encoded
        before_values: null,
        after_values: '{"overview":"…"}',
      },
      {
        id: 9,
        ts: "2026-05-31 09:30:00.000",
        actor_cwid: "sup0001",
        impersonated_cwid: "own0002",
        action: "proxy_grant",
        fields_changed: null,
        before_values: null,
        after_values: { proxy_cwid: "prx0003" }, // parsed object
      },
    ]);
    expect(a).toMatchObject({
      id: "10",
      action: "field_override",
      actionLabel: "Updated profile",
      fields: ["Overview"],
      detail: null,
      actorCwid: "self0001",
    });
    expect(a.ts).toBe("2026-06-01T12:00:00.000Z");
    expect(b).toMatchObject({
      id: "9",
      action: "proxy_grant",
      actionLabel: "Granted proxy editor",
      fields: [],
      detail: "prx0003",
      impersonatedCwid: "own0002",
    });
    // a DATETIME(3) string round-trips to an ISO instant
    expect(b.ts).toBe("2026-05-31T09:30:00.000Z");
  });
});

describe("loadScholarAuditHistory", () => {
  it("returns [] for an empty cwid without querying", async () => {
    const queryRaw = vi.fn();
    const client = { $queryRaw: queryRaw } as unknown as ScholarAuditClient;
    expect(await loadScholarAuditHistory("", client)).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("queries and shapes rows; binds the cwid and the windowed cutoff", async () => {
    const captured: unknown[] = [];
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push(...values);
      return [
        {
          id: 5n,
          ts: new Date("2026-06-05T08:00:00.000Z"),
          actor_cwid: "self0001",
          impersonated_cwid: null,
          action: "field_override",
          fields_changed: ["overview"],
          before_values: null,
          after_values: null,
        },
      ];
    });
    const client = { $queryRaw: queryRaw } as unknown as ScholarAuditClient;
    const now = new Date("2026-06-09T00:00:00.000Z");

    const entries = await loadScholarAuditHistory("abc1001", client, now);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "field_override", fields: ["Overview"] });
    // bound values: the cwid + the 90-day cutoff Date
    expect(captured[0]).toBe("abc1001");
    const cutoff = captured[1] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(now.getTime() - cutoff.getTime()).toBe(SCHOLAR_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });
});
