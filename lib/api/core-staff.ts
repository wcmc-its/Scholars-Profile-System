/**
 * SPS-curated core staff (`core_staff`), resolved for the Staff section of
 * `/edit/core/[coreId]`. The twin of `loadCoreClients` in
 * `lib/api/core-clients.ts`: names come from Scholar first, then ONE batched
 * enterprise-directory lookup for whoever Scholar does not hold (core staff are
 * often non-faculty with no Scholar row). The join is case-insensitive, since a
 * Scholar row's own `cwid` casing is not guaranteed to match the stored
 * (lowercased) one.
 *
 * Imports `@/lib/db` at module scope, so a client component may import only
 * the `CoreStaffRow` TYPE from here, never a value.
 */
import { db } from "@/lib/db";
import { resolveDirectoryNames } from "@/lib/edit/directory-names";

/** One resolved staff row for the panel. */
export interface CoreStaffRow {
  cwid: string;
  /** Scholar preferred name, else the ED name, else `null` (a CWID neither
   *  store knows is still a legitimate staff entry, never rejected). */
  name: string | null;
  /** Profile slug, or `null` when unresolved / ED-only. */
  slug: string | null;
  /** Scholar primary department, when there is a Scholar row. */
  affiliation: string | null;
  addedAt: Date;
  /** EFFECTIVE actor cwid who added the row. */
  addedBy: string;
  /** That actor's Scholar name (else ED name), or `null`. */
  addedByName: string | null;
}

/** Minimal Prisma surface this loader needs; mock-friendly for unit tests. */
export type CoreStaffLookup = {
  coreStaff: {
    findMany: (args: {
      where: { coreId: string };
      orderBy: { createdAt: "asc" };
      select: { cwid: true; addedBy: true; createdAt: true };
    }) => Promise<Array<{ cwid: string; addedBy: string; createdAt: Date }>>;
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

/** Load one core's curated staff, oldest-added first, each resolved to a name. */
export async function loadCoreStaff(
  coreId: string,
  client: CoreStaffLookup = db.read as unknown as CoreStaffLookup,
  directory: (cwids: string[]) => Promise<Map<string, string>> = resolveDirectoryNames,
): Promise<CoreStaffRow[]> {
  const rows = await client.coreStaff.findMany({
    where: { coreId },
    orderBy: { createdAt: "asc" },
    select: { cwid: true, addedBy: true, createdAt: true },
  });
  if (rows.length === 0) return [];

  // Staff AND the actors who added them resolve in the same query.
  const people = [...rows.map((r) => r.cwid), ...rows.map((r) => r.addedBy)].filter(
    (c) => c.length > 0,
  );
  const wanted = [...new Set([...people, ...people.map((c) => c.toLowerCase())])];
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: wanted } },
    select: { cwid: true, preferredName: true, slug: true, primaryDepartment: true },
  });
  const byLowerCwid = new Map(scholars.map((s) => [s.cwid.toLowerCase(), s]));

  // Fail-soft ED fallback: `resolveDirectoryNames` never throws, and a throwing
  // injected lookup is caught too; the row keeps a null name.
  const misses = [
    ...new Set(people.map((c) => c.toLowerCase()).filter((c) => !byLowerCwid.has(c))),
  ];
  let edNames = new Map<string, string>();
  if (misses.length > 0) {
    try {
      edNames = await directory(misses);
    } catch (err) {
      console.warn("core staff: ED name lookup failed", err);
    }
  }

  return rows.map((row) => {
    const key = row.cwid.toLowerCase();
    const scholar = byLowerCwid.get(key);
    const actorKey = row.addedBy.toLowerCase();
    return {
      cwid: row.cwid,
      name: scholar?.preferredName ?? edNames.get(key) ?? null,
      slug: scholar?.slug ?? null,
      affiliation: scholar?.primaryDepartment ?? null,
      addedAt: row.createdAt,
      addedBy: row.addedBy,
      addedByName: byLowerCwid.get(actorKey)?.preferredName ?? edNames.get(actorKey) ?? null,
    };
  });
}
