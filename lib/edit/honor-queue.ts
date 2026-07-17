/**
 * Issue #1762 — the honors approval queue's loader.
 *
 * The queue exists because Phase 2 (#1761) seeds EVERY honor as `pending`,
 * including the ~156 rows derived from the Dean's spreadsheet. That sheet carries
 * names, not CWIDs, so those CWIDs come from an F1 name match (surname + FULL
 * first name) rather than a human. An F1 match is strong here — its 100%-precision
 * measurement was taken on exactly this regime, contemporary people with
 * affiliation already narrowed — but it is not a sign-off, and `published` renders
 * on a real person's public page. So a human confirms here first.
 *
 * MUTUALLY EXCLUSIVE CANDIDATES ARE THE REASON THIS IS NOT A LIST OF BUTTONS.
 * One roster line can F1-match more than one scholar (same surname, same full
 * first name — two real people). The matcher emits a row PER CANDIDATE, so those
 * rows are competing claims on ONE award: at most one is true. Approving both
 * credits two people with one fellowship, which is the expensive direction —
 * misses are cheap, mismatches are not. `sourceRef` is what links them: Phase 2
 * seeds it as a roster-ROW identity (roster URL + a per-line discriminator), so
 * rows sharing one are candidates for the same assertion.
 *
 * Read-only and pure of authz: the caller gates. `loadHonorQueue` is only ever
 * reached from a superuser-checked page.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { HonorCategory } from "@/lib/generated/prisma/enums";

/** The Prisma surface this loader needs — same idiom as `SlugRequestQueueClient`.
 *  A hand-rolled structural type does NOT accept a real `PrismaClient`. */
type HonorQueueClient = Pick<PrismaClient, "honor" | "scholar">;

export type HonorQueueRow = {
  id: string;
  cwid: string;
  slug: string | null;
  scholarName: string;
  title: string | null;
  department: string | null;
  category: HonorCategory;
  name: string;
  organization: string;
  year: number | null;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  /** Competing claims on the same roster line — see the module note. Empty for
   *  an ordinary unambiguous row. */
  competingCwids: string[];
};

/** One roster line's worth of candidates. A group of 1 is the normal case. */
export type HonorQueueGroup = {
  /** `sourceRef` when present; otherwise the row id (an unlinked singleton). */
  key: string;
  rows: HonorQueueRow[];
  /** True when >1 candidate competes for this line ⇒ approving one MUST reject
   *  the others. The UI must not offer a plain "approve" here. */
  contested: boolean;
};

export function isHonorQueueEnabled(): boolean {
  return process.env.HONORS_APPROVAL_QUEUE === "on";
}

/**
 * Every `pending` honor, grouped by the roster line it came from.
 *
 * Ordering: contested groups first — they are the ones that can do damage if
 * rubber-stamped — then oldest first, so the queue drains deterministically
 * rather than by whatever order the DB felt like.
 */
export async function loadHonorQueue(client: HonorQueueClient): Promise<HonorQueueGroup[]> {
  const rows = await client.honor.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      cwid: true,
      category: true,
      name: true,
      organization: true,
      year: true,
      source: true,
      sourceRef: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return [];

  // One query for every scholar, not one per row: this queue is ~250 rows on day
  // one and an N+1 here would be 250 round trips. (slug-request's loader does
  // per-row lookups, but its queue is a handful of rows.)
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: [...new Set(rows.map((r) => r.cwid))] } },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      primaryTitle: true,
      primaryDepartment: true,
    },
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));

  // Group by roster line. A NULL sourceRef cannot be linked to anything, so it is
  // its own group keyed by id — never lumped with other NULLs, which would
  // silently mark unrelated rows as competing.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.sourceRef ?? `id:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const out: HonorQueueGroup[] = [];
  for (const [key, groupRows] of groups) {
    const cwids = groupRows.map((r) => r.cwid);
    const contested = new Set(cwids).size > 1;
    out.push({
      key,
      contested,
      rows: groupRows.map((r) => {
        const s = byCwid.get(r.cwid);
        return {
          id: r.id,
          cwid: r.cwid,
          slug: s?.slug ?? null,
          scholarName: s?.preferredName ?? s?.fullName ?? r.cwid,
          title: s?.primaryTitle ?? null,
          department: s?.primaryDepartment ?? null,
          category: r.category,
          name: r.name,
          organization: r.organization,
          year: r.year,
          source: r.source,
          sourceRef: r.sourceRef,
          createdAt: r.createdAt.toISOString(),
          competingCwids: contested ? cwids.filter((c) => c !== r.cwid) : [],
        };
      }),
    });
  }

  // Contested first, then oldest. `rows[0]` is safe: a group is never empty.
  return out.sort((a, b) => {
    if (a.contested !== b.contested) return a.contested ? -1 : 1;
    return a.rows[0].createdAt.localeCompare(b.rows[0].createdAt);
  });
}

/**
 * Award-year plausibility — a SIGNAL a reviewer weighs, NEVER a silent drop rule.
 *
 * A pre-1996 award sitting on someone whose CURRENT title is junior is very likely
 * a generational name collision (the D3 re-run's smoking gun was a 1970s award
 * matched to a current postdoc). But a genuine emeritus hit is entirely plausible
 * in the 1980s band, so this only ever annotates a row for a human. The moment it
 * filters anything, it becomes the silent-drop rule the SPEC forbids.
 */
const JUNIOR_TITLE = /postdoc|fellow|resident|student|instructor|assistant/i;

export function yearPlausibilityNote(row: {
  year: number | null;
  title: string | null;
}): string | null {
  if (row.year === null) return null;
  if (row.year >= 1996) return null;
  if (!row.title || !JUNIOR_TITLE.test(row.title)) return null;
  const age = 2026 - row.year;
  return `Awarded ${age} years ago, but the current title reads junior — check this is the same person, not a namesake.`;
}
