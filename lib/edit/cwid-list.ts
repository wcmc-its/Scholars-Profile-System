/**
 * Stored CWID lists for report 8's "CWID list" filter (`report_cwid_list`).
 * A pasted list can run to thousands of CWIDs, too long for a URL, so it is
 * stored once and the report URL carries its id (`list=<id>`). Rows are
 * insert-only: nothing here updates or deletes one, so a shared link keeps
 * meaning the same people. Creating a list is not audited (it grants and
 * changes nothing; it only names a set of people to count).
 *
 * The parsing rule (any separator, CWID-shaped tokens only, at most
 * `CWID_LIST_MAX`) lives in `lib/cwid-list-text.ts`, shared with the rail.
 * Server-only (`@/lib/db`).
 */
import { randomBytes } from "node:crypto";

import { CWID_PATTERN } from "@/lib/cwid";
import { CWID_LIST_MAX } from "@/lib/cwid-list-text";
import { db } from "@/lib/db";
import { CWID_LIST_ID_PATTERN } from "@/lib/edit/person-filter";

export { CWID_LIST_MAX };

/** A resolved list: `found` false for an unknown or malformed id (the filter
 *  then matches nobody, never everyone); `unmatched` = the CWIDs with no
 *  active scholar row, which the report cannot count. */
export type CwidListData = { id: string; found: boolean; cwids: string[]; unmatched: string[] };

/** 12 URL-safe characters (72 random bits). */
function newListId(): string {
  return randomBytes(9).toString("base64url");
}

/** Validated CWIDs → the new list's id. The caller has already checked the
 *  shape and the size; this re-checks both so a bad array never lands. */
export async function createCwidList(cwids: readonly string[], createdBy: string): Promise<string> {
  const clean = [...new Set(cwids)];
  if (clean.length === 0 || clean.length > CWID_LIST_MAX || !clean.every((c) => CWID_PATTERN.test(c))) {
    throw new Error("createCwidList: invalid CWID list");
  }
  for (let attempt = 0; ; attempt++) {
    const id = newListId();
    try {
      await db.write.reportCwidList.create({ data: { id, cwids: clean, createdBy } });
      return id;
    } catch (err) {
      // A 72-bit id collision is vanishingly rare; retry once, then give up.
      if ((err as { code?: string } | null)?.code !== "P2002" || attempt > 0) throw err;
    }
  }
}

function asCwids(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((c): c is string => typeof c === "string" && CWID_PATTERN.test(c)) : [];
}

/** The list's CWIDs, split into those the report can count (active,
 *  non-deleted scholars) and the rest. Read on the replica first, then the
 *  primary: the page opens right after the list was written, and a replica
 *  that has not caught up must not turn a new list into "not found". */
export async function loadCwidList(id: string): Promise<CwidListData> {
  if (!CWID_LIST_ID_PATTERN.test(id)) return { id, found: false, cwids: [], unmatched: [] };
  const select = { cwids: true } as const;
  const row =
    (await db.read.reportCwidList.findUnique({ where: { id }, select })) ??
    (await db.write.reportCwidList.findUnique({ where: { id }, select }));
  if (!row) return { id, found: false, cwids: [], unmatched: [] };
  const cwids = asCwids(row.cwids);
  const active =
    cwids.length > 0
      ? await db.read.scholar.findMany({
          where: { cwid: { in: cwids }, deletedAt: null, status: "active" },
          select: { cwid: true },
        })
      : [];
  const known = new Set(active.map((r) => r.cwid));
  return { id, found: true, cwids, unmatched: cwids.filter((c) => !known.has(c)) };
}
