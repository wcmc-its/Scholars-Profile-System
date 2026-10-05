/**
 * Holders for the "All roles" tab (`lib/edit/role-catalog.ts`): counts for the
 * roles whose grants live in our own tables, and the members of each ED-group
 * role, read from the groups' `memberURL` values and named from ED. A failed
 * read degrades to "no count" / "no list", never to a wrong one.
 *
 * Server-only (reaches LDAP).
 */
import { getSuperuserAllowlist } from "@/lib/auth/config";
import { listGroupMemberCwids } from "@/lib/auth/ldap-group";
import { resolveDirectoryNames } from "@/lib/edit/directory-names";
import { ROLE_CATALOG, type RoleHolderCounts, type RoleMembers } from "@/lib/edit/role-catalog";

type CountClient = {
  unitAdmin: {
    findMany(args: {
      select: { cwid: true; role: true; entityType: true };
    }): Promise<Array<{ cwid: string; role: string; entityType: string }>>;
  };
  functionalRoleGrant: {
    findMany(args: {
      where: { role: string };
      select: { cwid: true };
    }): Promise<Array<{ cwid: string }>>;
  };
};

/** The CWIDs holding each role granted in our own tables (unit roles,
 *  Reporting), lowercased and de-duplicated. A failed read leaves that
 *  table's roles out, never empty. */
async function tableRoleCwids(client: CountClient): Promise<Map<string, string[]>> {
  const [admins, reporting] = await Promise.all([
    Promise.resolve()
      .then(() => client.unitAdmin.findMany({ select: { cwid: true, role: true, entityType: true } }))
      .catch(() => null),
    Promise.resolve()
      .then(() =>
        client.functionalRoleGrant.findMany({ where: { role: "reporting" }, select: { cwid: true } }),
      )
      .catch(() => null),
  ]);
  const out = new Map<string, string[]>();
  const distinct = (rows: Array<{ cwid: string }>) => [
    ...new Set(rows.map((r) => r.cwid.toLowerCase())),
  ];
  if (admins) {
    const units = admins.filter((a) => a.entityType !== "institution");
    out.set("unit_owner", distinct(units.filter((a) => a.role === "owner")));
    out.set("unit_curator", distinct(units.filter((a) => a.role === "curator")));
    out.set("institution_admin", distinct(admins.filter((a) => a.entityType === "institution")));
  }
  if (reporting) out.set("reporting", distinct(reporting));
  return out;
}

export async function loadRoleHolderCounts(client: CountClient): Promise<RoleHolderCounts> {
  const counts: RoleHolderCounts = {};
  for (const [key, cwids] of await tableRoleCwids(client)) counts[key] = cwids.length;
  return counts;
}

type MemberDeps = {
  /** Also list the roles granted in our own tables (unit roles, Reporting). */
  client?: CountClient;
  listMembers?: typeof listGroupMemberCwids;
  resolveNames?: (cwids: Iterable<string>) => Promise<Map<string, string>>;
};

/**
 * Members of every ED-group role in the catalog, plus (given `client`) the
 * roles granted in our own tables, with ED display names, keyed by catalog
 * key. The superuser row also lists the interim allowlist, which
 * confers the role without the group. Names fall back to null (the CWID shows).
 */
export async function loadRoleMembers(deps: MemberDeps = {}): Promise<RoleMembers> {
  const listMembers = deps.listMembers ?? listGroupMemberCwids;
  const resolveNames = deps.resolveNames ?? ((c: Iterable<string>) => resolveDirectoryNames(c));
  const edRoles = ROLE_CATALOG.filter((r) => r.source === "ed_group" && r.groupCn);
  const [byCn, tables] = await Promise.all([
    listMembers(
      edRoles.map((r) => r.groupCn!),
      (reason) => console.warn(JSON.stringify({ event: "role_members_read_failed", reason })),
    ),
    deps.client ? tableRoleCwids(deps.client) : new Map<string, string[]>(),
  ]);
  const cwidsByKey = new Map<string, string[]>(tables);
  for (const r of edRoles) {
    const cwids = byCn.get(r.groupCn!);
    if (!cwids) continue;
    const all = r.key === "superuser" ? [...new Set([...cwids, ...getSuperuserAllowlist()])] : cwids;
    cwidsByKey.set(r.key, all.sort());
  }
  const names = await resolveNames(new Set([...cwidsByKey.values()].flat())).catch(
    () => new Map<string, string>(),
  );
  const members: RoleMembers = {};
  for (const [key, cwids] of cwidsByKey) {
    members[key] = cwids
      .map((cwid) => ({ cwid, name: names.get(cwid) ?? null }))
      .sort((a, b) => (a.name ?? a.cwid).localeCompare(b.name ?? b.cwid));
  }
  return members;
}
