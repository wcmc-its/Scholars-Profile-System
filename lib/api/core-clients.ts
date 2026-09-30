/**
 * "Known clients" of a core facility (ReciterAI #383 / SPS #2607, CWID-only
 * pass) — a core owner's manual attestation that a CWID is a known user of
 * the core, independent of any publication evidence. Persisted in
 * `CoreClient` (soft-remove; "active" = `removedAt IS NULL`) and
 * read-resolved here to a Scholar name/slug when one exists, matching
 * `lib/api/core-queue.ts`'s case-insensitive CWID join (the engine's/owner's
 * casing is not guaranteed to match `scholar.cwid`'s stored casing).
 *
 * `parseCwidBlock` and the paper-count shape/arithmetic are re-exported from
 * their pure modules under `lib/cores/` (shared with the panel and the review
 * queue, both client components — see those modules' comments for why they live
 * apart from this one, which imports `@/lib/db` at module scope).
 */
import { db } from "@/lib/db";
import { recentFloorYear, type CoreClientPaperCount } from "@/lib/cores/paper-counts";

export { parseCwidBlock } from "@/lib/cores/cwid-block";
export type { CoreClientPaperCount } from "@/lib/cores/paper-counts";

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

/** Minimal Prisma surface for the counts queries — mock-friendly for unit tests. */
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
    groupBy: (args: {
      by: ["cwid"];
      where: { cwid: { in: string[] }; isConfirmed: true };
      _count: { pmid: true };
    }) => Promise<Array<{ cwid: string | null; _count: { pmid: number } }>>;
  };
};

/**
 * Per-person counts behind the queue's evidence lines: how many papers this core
 * ALREADY holds from a person ("18 papers, 11 recent") and how much of their
 * whole output that is ("18 of their 29 publications").
 *
 * `cwids` is EVERY person the queue may have to name — the "Known clients"
 * roster PLUS every WCM byline author on a queue row. The repeat-user line names
 * a person, and the only name that cannot disagree with the number printed
 * beside it is the one whose own count was computed here: the engine publishes
 * `author_affinity` as a bare scalar and never records whose it is, so naming
 * from the engine's number would be a guess dressed as a fact.
 *
 * `papers`/`recent` are counted over the CONFIRMED list only, and deliberately
 * so: counting candidates would make a row's own evidence line quote the very
 * pile it is asking the reviewer to judge. `total` is deliberately NOT scoped to
 * this core — it is the denominator, so it counts everything.
 *
 * A CONFIRMED row is inside its own counts, so the Confirmed tab must take that
 * one paper back out before it says "previous occasions" — `excludingOwnPaper`
 * in `lib/cores/paper-counts.ts`. Doing it here instead would key the map by
 * (person, row) rather than by person, which is the whole queue squared.
 *
 * WHY THIS IS A QUERY and not a fold over `CoreQueueRow.wcmAuthors`, which is
 * already in hand: that field is capped at `WCM_AUTHORS_CAP` (12) per paper, so
 * folding it silently drops a client who is the 13th WCM author on a large
 * consortium paper — and the count renders as a bare fact ("18 papers"), the kind
 * of number a curator has no way to notice is short. This reads the byline table
 * directly, uncapped.
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

  // Case-insensitive the same way `loadCoreClients` is — a stored cwid's casing
  // is not guaranteed to match `publication_author.cwid` — and de-duped across
  // BOTH casings: `cwids` now arrives with one entry per byline seat in the whole
  // queue, so the as-is half would otherwise repeat a name hundreds of times in
  // one `IN` list for no extra matching.
  const eitherCasing = [...new Set([...wanted, ...cwids.filter((c) => c.length > 0)])];

  // Year per pmid, so recency needs no second read. A pmid with no year on file
  // counts as a paper but never as a recent one.
  const yearByPmid = new Map(confirmed.map((r) => [r.pmid, r.year]));
  const rows = await client.publicationAuthor.findMany({
    where: {
      pmid: { in: [...yearByPmid.keys()] },
      cwid: { in: eitherCasing },
      isConfirmed: true,
    },
    select: { pmid: true, cwid: true },
  });

  const floor = recentFloorYear(now);
  const held = new Map<string, { papers: number; recent: number }>();
  // The cwid casings this core's own bylines actually carry — the denominator's
  // IN list below, and nothing wider.
  const casings = new Set<string>();
  // Dedupe (person, paper): a byline listing someone twice must not count the
  // paper twice.
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.cwid) continue;
    if (!yearByPmid.has(row.pmid)) continue;
    const key = row.cwid.toLowerCase();
    casings.add(row.cwid);
    casings.add(key);
    const pair = `${key} ${row.pmid}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const year = yearByPmid.get(row.pmid) ?? null;
    const prior = held.get(key) ?? { papers: 0, recent: 0 };
    held.set(key, {
      papers: prior.papers + 1,
      recent: prior.recent + (year !== null && year >= floor ? 1 : 0),
    });
  }
  // A key only exists once a confirmed paper landed on it, so `papers` is >= 1 on
  // every entry. That is the point — a zero would both print as "0 papers" (a
  // person the core looked at and rejected, which is not what it means) and grow
  // this map by a row for every WCM author in the institution who ever shared a
  // byline with a queued paper. Empty here means there is also no denominator
  // worth reading: nothing survives for one to attach to.
  if (held.size === 0) return {};

  // The denominator is unscoped by pmid, so it is a groupBy and not a second row
  // read — over every publication these people have, the rows ARE the count.
  //
  // Scoped to the people the read above actually found a confirmed paper for,
  // NOT to `cwids`: `total` is only ever read off a key that survives into the
  // returned map, and only these keys do, so a wider list buys nothing and costs
  // a great deal. `cwids` now arrives with one entry per byline SEAT in the whole
  // queue — 7,443 seats, 1,456 distinct CWIDs on staging core 14, against the 246
  // people that core has actually confirmed a paper from. Measured there
  // 2026-09-08: the wide groupBy 1,742ms, the narrow one 132ms on top of the
  // 44ms pmid-scoped read, so the page loses ~1.5s. It is index-covered either
  // way (`@@index([cwid, isConfirmed])`); the cost is rows, not a missing index,
  // so the only lever is asking about fewer people. Serial rather than the
  // `Promise.all` this used to be — the narrow list is not knowable until the
  // read above returns, and 44+132 still beats 1,742.
  //
  // (`_count` has no DISTINCT and there is no unique constraint on (pmid, cwid),
  // so a byline listing someone twice inflates `total` by one where `papers`
  // de-dupes it. `total` is printed as a denominator, never as a claim about a
  // specific paper.)
  const totals = await client.publicationAuthor.groupBy({
    by: ["cwid"],
    where: { cwid: { in: [...casings] }, isConfirmed: true },
    _count: { pmid: true },
  });
  // Fold both casings onto one lowercased key: the `IN` above asks for both, and
  // a case-sensitive collation would hand back two groups for the same person.
  const totalByCwid = new Map<string, number>();
  for (const t of totals) {
    if (!t.cwid) continue;
    const key = t.cwid.toLowerCase();
    totalByCwid.set(key, (totalByCwid.get(key) ?? 0) + t._count.pmid);
  }

  const out: Record<string, CoreClientPaperCount> = {};
  for (const [key, counts] of held) {
    out[key] = { ...counts, total: totalByCwid.get(key) ?? 0 };
  }
  return out;
}
