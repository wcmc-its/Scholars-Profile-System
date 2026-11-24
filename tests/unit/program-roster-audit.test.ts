/**
 * The internal program roster's audit rows carry trainee and mentor CWIDs
 * (some trainees are minors). They must be writable (the four ENUM sites in
 * audit-log.sql) and must never reach /edit/activity, which a Reporting grant
 * opens to people with no roster access.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadEditActivityCsv, loadEditActivitySummary, loadOlderEdits } from "@/lib/api/edit-activity";

describe("program roster audit", () => {
  it("every ENUM site accepts the roster actions and targets", () => {
    const enums = [...readFileSync("scripts/sql/audit-log.sql", "utf8").matchAll(/ENUM\('[^)]*\)/g)].map((m) => m[0]);
    const actions = enums.filter((e) => e.includes("'field_override'"));
    const targets = enums.filter((e) => e.includes("'publication'"));
    expect([actions.length, targets.length]).toEqual([2, 2]);
    for (const e of actions) expect(e).toMatch(/'roster_program_change','roster_entry_change'\)$/);
    for (const e of targets) expect(e).toMatch(/'roster_program','roster_entry'\)$/);
  });

  it("every Activity read of the audit log leaves the roster rows out", async () => {
    const reads: string[] = [];
    const client = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("manual_edit_audit")) reads.push(sql);
        return [];
      },
    } as unknown as Parameters<typeof loadEditActivitySummary>[0];
    const now = new Date("2026-11-24T12:00:00Z");
    await loadEditActivitySummary(client, now);
    await loadOlderEdits(client, { ts: now, id: "1" } as unknown as Parameters<typeof loadOlderEdits>[1], now);
    await loadEditActivityCsv(client, "30d", now);
    expect(reads).toHaveLength(8);
    for (const sql of reads) {
      expect(sql).toContain("AND target_entity_type NOT IN ('roster_program', 'roster_entry')");
    }
  });
});
