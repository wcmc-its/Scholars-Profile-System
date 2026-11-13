/**
 * Display names for a set of CWIDs, for any UI that would otherwise show a bare
 * CWID as a person's name (audit actors, "granted by", leaders, requesters).
 *
 * Scholar `preferredName` first (cheap, one batched read), then the WCM
 * directory for the rest (staff, superusers, proxies, trainees — people with no
 * Scholar row). Keyed by lowercased CWID. A CWID neither source can name is
 * simply absent, so callers fall back to the CWID only when resolution truly
 * fails. Never throws. Server-only (Prisma + LDAP).
 */
import { db } from "@/lib/db";
import { resolveDirectoryNames, type DirectoryNameDeps } from "@/lib/edit/directory-names";

export type ScholarNameReader = {
  scholar: {
    findMany: (args: {
      where: { cwid: { in: string[] } };
      select: { cwid: true; preferredName: true };
    }) => Promise<Array<{ cwid: string; preferredName: string | null }>>;
  };
};

export async function resolvePersonNames(
  cwids: Iterable<string | null | undefined>,
  deps: { read?: ScholarNameReader; directory?: DirectoryNameDeps } = {},
): Promise<Map<string, string>> {
  const unique = [
    ...new Set([...cwids].map((c) => c?.trim().toLowerCase()).filter((c): c is string => !!c)),
  ];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  const rows = await (deps.read ?? db.read).scholar
    .findMany({ where: { cwid: { in: unique } }, select: { cwid: true, preferredName: true } })
    .catch(() => []);
  for (const r of rows) {
    const name = r.preferredName?.trim();
    if (name) out.set(r.cwid.toLowerCase(), name);
  }

  const rest = unique.filter((c) => !out.has(c));
  if (rest.length > 0) {
    for (const [cwid, name] of await resolveDirectoryNames(rest, deps.directory)) {
      out.set(cwid, name);
    }
  }
  return out;
}

/** Look up one CWID in a {@link resolvePersonNames} map; the CWID itself only
 *  when no name was found. */
export function nameOr(names: ReadonlyMap<string, string>, cwid: string): string {
  return names.get(cwid.trim().toLowerCase()) ?? cwid;
}
