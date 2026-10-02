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

export async function loadRoleHolderCounts(client: CountClient): Promise<RoleHolderCounts> {
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
  const counts: RoleHolderCounts = {};
  if (admins) {
    type Admin = { cwid: string; role: string; entityType: string };
    const people = (pred: (a: Admin) => boolean) =>
      new Set(admins.filter(pred).map((a) => a.cwid.toLowerCase())).size;
    counts.unit_owner = people((a) => a.entityType !== "institution" && a.role === "owner");
    counts.unit_curator = people((a) => a.entityType !== "institution" && a.role === "curator");
    counts.institution_admin = people((a) => a.entityType === "institution");
  }
  if (reporting) counts.reporting = new Set(reporting.map((r) => r.cwid.toLowerCase())).size;
  return counts;
}

type MemberDeps = {
  listMembers?: typeof listGroupMemberCwids;
  resolveNames?: (cwids: Iterable<string>) => Promise<Map<string, string>>;
};

/**
 * Members of every ED-group role in the catalog, with ED display names, keyed
 * by catalog key. The superuser row also lists the interim allowlist, which
 * confers the role without the group. Names fall back to null (the CWID shows).
 */
export async function loadRoleMembers(deps: MemberDeps = {}): Promise<RoleMembers> {
  const listMembers = deps.listMembers ?? listGroupMemberCwids;
  const resolveNames = deps.resolveNames ?? ((c: Iterable<string>) => resolveDirectoryNames(c));
  const edRoles = ROLE_CATALOG.filter((r) => r.source === "ed_group" && r.groupCn);
  const byCn = await listMembers(
    edRoles.map((r) => r.groupCn!),
    (reason) => console.warn(JSON.stringify({ event: "role_members_read_failed", reason })),
  );
  const cwidsByKey = new Map<string, string[]>();
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
