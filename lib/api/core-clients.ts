/**
 * "Known clients" of a core facility (ReciterAI #383 / SPS #2607, CWID-only
 * pass) — a core owner's manual attestation that a CWID is a known user of
 * the core, independent of any publication evidence. Persisted in
 * `CoreClient` (soft-remove; "active" = `removedAt IS NULL`) and
 * read-resolved here to a Scholar name/slug when one exists, matching
 * `lib/api/core-queue.ts`'s case-insensitive CWID join (the engine's/owner's
 * casing is not guaranteed to match `scholar.cwid`'s stored casing).
 *
 * `parseCwidBlock` is re-exported from `lib/cores/cwid-block.ts` (the pure
 * parsing half, shared with `components/edit/core-clients-panel.tsx` — see
 * that module's comment for why the parser lives apart from this one, which
 * imports `@/lib/db` at module scope).
 */
import { db } from "@/lib/db";

export { parseCwidBlock } from "@/lib/cores/cwid-block";

/** One resolved "known clients" row for the panel. */
export interface CoreClientRow {
  /** Row id. The remove control keys on this, not on `cwid`, because a
   *  name-only row has no cwid to key on. */
  id: string;
  /** `null` on a NAME-ONLY row (someone with no CWID). Such a row is
   *  roster-only: it never flags a byline and is never mirrored to the engine. */
  cwid: string | null;
  /** Display name: the Scholar's preferred name for a CWID row, the owner-typed
   *  `displayName` for a name-only row, or `null` when a CWID resolves to
   *  nothing (a legitimate, non-faculty core user — never rejected for this). */
  name: string | null;
  /** Profile slug, or `null` when unresolved / ED-only / name-only. */
  slug: string | null;
  /** Department for a CWID row (Scholar/ED), or the owner-typed affiliation for
   *  a name-only row. `null` when neither is known. */
  affiliation: string | null;
  addedAt: Date;
  /** EFFECTIVE actor cwid who added the row. */
  addedBy: string;
  /** That actor's Scholar name, when they have one — the roster's provenance
   *  line reads "added by Doug Ballon (djb2001)". `null` for a cwid with no
   *  Scholar row (a steward, a service account), where the cwid stands alone. */
  addedByName: string | null;
}

/** Minimal Prisma surface this loader needs — mock-friendly for unit tests. */
export type CoreClientLookup = {
  coreClient: {
    findMany: (args: {
      where: { coreId: string; removedAt: null };
      orderBy: { addedAt: "asc" };
      select: {
        id: true;
        cwid: true;
        displayName: true;
        affiliation: true;
        addedAt: true;
        addedBy: true;
      };
    }) => Promise<
      Array<{
        id: string;
        cwid: string | null;
        displayName: string | null;
        affiliation: string | null;
        addedAt: Date;
        addedBy: string;
      }>
    >;
  };
  scholar: {
    findMany: (args: {
      where: { cwid: { in: string[] } };
      select: { cwid: true; preferredName: true; slug: true; primaryDepartment: true };
    }) => Promise<
      Array<{
        cwid: string;
        preferredName: string;
        slug: string;
        primaryDepartment: string | null;
      }>
    >;
  };
};

/**
 * Load the active ("removedAt IS NULL" — see the schema comment on
 * `CoreClient` for why this must never be expressed as a `NOT { removedAt }`
 * clause, which never matches a NULL row in MySQL) known-clients list for one
 * core, oldest-added first, each resolved to a Scholar name/slug when one
 * exists. The join is case-insensitive: it queries both the stored
 * (lowercased) cwids and their as-is form, the same convention
 * `loadCoreReviewQueue` uses, since a Scholar row's own `cwid` casing is not
 * guaranteed to match.
 */
export async function loadCoreClients(
  coreId: string,
  client: CoreClientLookup = db.read as unknown as CoreClientLookup,
): Promise<CoreClientRow[]> {
  const rows = await client.coreClient.findMany({
    where: { coreId, removedAt: null },
    orderBy: { addedAt: "asc" },
    select: {
      id: true,
      cwid: true,
      displayName: true,
      affiliation: true,
      addedAt: true,
      addedBy: true,
    },
  });
  if (rows.length === 0) return [];

  // Name-only rows carry their own name and resolve nothing, so they are left
  // out of the Scholar lookup entirely — passing a `null` into `{ cwid: { in } }`
  // would widen the query, not narrow it.
  const withCwid = rows.filter((r): r is typeof r & { cwid: string } => r.cwid !== null);
  const lowered = withCwid.map((r) => r.cwid.toLowerCase());
  // The actors who added these rows resolve in the SAME query — a name-only row
  // still has an `addedBy`, so this list is not a subset of the one above.
  const actors = rows.map((r) => r.addedBy).filter((c) => c.length > 0);
  const wanted = [
    ...new Set([
      ...lowered,
      ...withCwid.map((r) => r.cwid),
      ...actors,
      ...actors.map((c) => c.toLowerCase()),
    ]),
  ];
  const scholars =
    wanted.length === 0
      ? []
      : await client.scholar.findMany({
          where: { cwid: { in: wanted } },
          select: { cwid: true, preferredName: true, slug: true, primaryDepartment: true },
        });
  const byLowerCwid = new Map(scholars.map((s) => [s.cwid.toLowerCase(), s]));

  return rows.map((row) => {
    const scholar = row.cwid ? byLowerCwid.get(row.cwid.toLowerCase()) : undefined;
    return {
      id: row.id,
      cwid: row.cwid,
      // A name-only row's own `displayName` is the name; a CWID row's name comes
      // from Scholar, and stays null when the CWID resolves to nobody.
      name: scholar?.preferredName ?? row.displayName ?? null,
      slug: scholar?.slug ?? null,
      affiliation: scholar?.primaryDepartment ?? row.affiliation ?? null,
      addedAt: row.addedAt,
      addedBy: row.addedBy,
      addedByName: byLowerCwid.get(row.addedBy.toLowerCase())?.preferredName ?? null,
    };
  });
}

/** How many years back "N recent" counts. Five calendar years INCLUSIVE of the
 *  current one, so 2026 spans 2022-2026. */
export const RECENT_PAPER_YEARS = 5;

/** What this core already holds from one person. */
export interface CoreClientPaperCount {
  papers: number;
  recent: number;
}

/** Minimal Prisma surface for the counts query — mock-friendly for unit tests. */
export type CoreClientPaperCountLookup = {
  publicationAuthor: {
    findMany: (args: {
      where: {
        pmid: { in: string[] };
        cwid: { in: string[] };
        isConfirmed: true;
      };
      select: { pmid: true; cwid: true };
    }) => Promise<Array<{ pmid: string; cwid: string | null }>>;
  };
};

/**
 * Per-person counts of the papers this core ALREADY holds from each of its known
 * clients — the "18 papers, 11 recent" half of the queue's client evidence token.
 *
 * Counted over the CONFIRMED list only, and deliberately so: counting candidates
 * would make a row's own evidence line quote the very pile it is asking the
 * reviewer to judge.
 *
 * WHY THIS IS A QUERY and not a fold over `CoreQueueRow.wcmAuthors`, which is
 * already in hand: that field is capped at `WCM_AUTHORS_CAP` (12) per paper, so
 * folding it silently drops a client who is the 13th WCM author on a large
 * consortium paper — and the count renders as a bare fact ("18 papers"), the kind
 * of number a curator has no way to notice is short. This reads the byline table
 * directly, uncapped, and only for the handful of CWIDs actually on the roster.
 *
 * Keyed by LOWERCASED cwid. `now` is injected so the recency window is testable.
 */
export async function loadCoreClientPaperCounts(
  confirmed: ReadonlyArray<{ pmid: string; year: number | null }>,
  cwids: readonly string[],
  client: CoreClientPaperCountLookup = db.read as unknown as CoreClientPaperCountLookup,
  now: Date = new Date(),
): Promise<Record<string, CoreClientPaperCount>> {
  const wanted = [...new Set(cwids.map((c) => c.toLowerCase()).filter((c) => c.length > 0))];
  if (wanted.length === 0 || confirmed.length === 0) return {};

  // Year per pmid, so recency needs no second read. A pmid with no year on file
  // counts as a paper but never as a recent one.
  const yearByPmid = new Map(confirmed.map((r) => [r.pmid, r.year]));
  const rows = await client.publicationAuthor.findMany({
    // Case-insensitive the same way `loadCoreClients` is: a stored cwid's casing
    // is not guaranteed to match `publication_author.cwid`.
    where: {
      pmid: { in: [...yearByPmid.keys()] },
      cwid: { in: [...wanted, ...cwids] },
      isConfirmed: true,
    },
    select: { pmid: true, cwid: true },
  });

  const floor = now.getFullYear() - (RECENT_PAPER_YEARS - 1);
  const out: Record<string, CoreClientPaperCount> = {};
  // Dedupe (person, paper): a byline listing someone twice must not count the
  // paper twice.
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.cwid) continue;
    const key = row.cwid.toLowerCase();
    if (!yearByPmid.has(row.pmid)) continue;
    const pair = `${key} ${row.pmid}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const year = yearByPmid.get(row.pmid) ?? null;
    const held = out[key] ?? { papers: 0, recent: 0 };
    out[key] = {
      papers: held.papers + 1,
      recent: held.recent + (year !== null && year >= floor ? 1 : 0),
    };
  }
  return out;
}
