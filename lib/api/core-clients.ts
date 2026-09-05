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
  cwid: string;
  /** Scholar's preferred name, or `null` when the CWID has no Scholar row
   *  (a legitimate, non-faculty core user — never rejected for this). */
  name: string | null;
  /** Profile slug, or `null` when unresolved / ED-only. */
  slug: string | null;
  addedAt: Date;
  addedBy: string;
}

/** Minimal Prisma surface this loader needs — mock-friendly for unit tests. */
export type CoreClientLookup = {
  coreClient: {
    findMany: (args: {
      where: { coreId: string; removedAt: null };
      orderBy: { addedAt: "asc" };
      select: { cwid: true; addedAt: true; addedBy: true };
    }) => Promise<Array<{ cwid: string; addedAt: Date; addedBy: string }>>;
  };
  scholar: {
    findMany: (args: {
      where: { cwid: { in: string[] } };
      select: { cwid: true; preferredName: true; slug: true };
    }) => Promise<Array<{ cwid: string; preferredName: string; slug: string }>>;
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
    select: { cwid: true, addedAt: true, addedBy: true },
  });
  if (rows.length === 0) return [];

  const lowered = rows.map((r) => r.cwid.toLowerCase());
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: [...lowered, ...rows.map((r) => r.cwid)] } },
    select: { cwid: true, preferredName: true, slug: true },
  });
  const byLowerCwid = new Map(scholars.map((s) => [s.cwid.toLowerCase(), s]));

  return rows.map((row) => {
    const scholar = byLowerCwid.get(row.cwid.toLowerCase());
    return {
      cwid: row.cwid,
      name: scholar?.preferredName ?? null,
      slug: scholar?.slug ?? null,
      addedAt: row.addedAt,
      addedBy: row.addedBy,
    };
  });
}
