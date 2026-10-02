/**
 * Holder counts for the "All roles" tab (`lib/edit/role-catalog.ts`). Only the
 * roles whose grants live in our own tables are countable; ED-group membership
 * can't be read by the app's directory account, so those stay uncounted.
 * A failed read degrades to "no count", never to a wrong one.
 */
import type { RoleHolderCounts } from "@/lib/edit/role-catalog";

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
