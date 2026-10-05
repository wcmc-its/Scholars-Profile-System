/**
 * The Administrators page's "All roles" tab: every role, how it's granted,
 * and what it can and can't do (`lib/edit/role-catalog.ts`). Read-only.
 * Holders: an expandable list of names for every role we can read (our own
 * tables, and ED groups via `memberURL`); an unreadable ED group says where
 * membership is managed instead.
 */
import {
  ROLE_CATALOG,
  ROLE_SOURCE_LABEL,
  type RoleCatalogEntry,
  type RoleHolderCounts,
  type RoleMembers,
} from "@/lib/edit/role-catalog";
import { cn } from "@/lib/utils";

function Chips({ items, tone }: { items: readonly string[]; tone: "can" | "cannot" }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <li
          key={t}
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs whitespace-nowrap",
            tone === "can"
              ? "bg-apollo-surface-2 border-apollo-border-strong"
              : "text-muted-foreground border-dashed",
          )}
        >
          {t}
        </li>
      ))}
    </ul>
  );
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

function Holders({
  role,
  counts,
  members,
}: {
  role: RoleCatalogEntry;
  counts: RoleHolderCounts;
  members: RoleMembers;
}) {
  if (role.source === "scholar") return <>Set by each scholar</>;
  const list = members[role.key];
  if (!list) {
    if (role.source === "ed_group") return <>Managed in MARIA</>;
    const n = counts[role.key];
    return <>{n === undefined ? "—" : people(n)}</>;
  }
  if (list.length === 0) return <>No one</>;
  return (
    <details>
      <summary className="cursor-pointer">{people(list.length)}</summary>
      <ul className="mt-1.5 flex flex-col gap-0.5" data-testid={`role-members-${role.key}`}>
        {list.map((m) => (
          <li key={m.cwid} className="whitespace-nowrap">
            <span className="text-foreground">{m.name ?? m.cwid}</span>
            {m.name && <span className="font-mono"> {m.cwid}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RolesCatalog({
  counts,
  members = {},
}: {
  counts: RoleHolderCounts;
  members?: RoleMembers;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="roles-catalog">
      <p className="text-muted-foreground -mt-2 text-[13px]">
        Every role in Scholars Console. Read-only: ED-group roles are granted in MARIA, the rest
        on the other tabs or by the scholar.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs font-medium tracking-[0.08em] uppercase">
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Granted by</th>
              <th className="py-2 pr-4 font-medium">Can</th>
              <th className="py-2 pr-4 font-medium">Cannot</th>
              <th className="py-2 font-medium">Holders</th>
            </tr>
          </thead>
          <tbody>
            {ROLE_CATALOG.map((r) => (
              <tr key={r.key} className="border-b align-top" data-testid={`role-row-${r.key}`}>
                <td className="py-3 pr-4">
                  <div className="font-medium">{r.label}</div>
                  <div className="text-muted-foreground text-xs">{r.description}</div>
                </td>
                <td className="py-3 pr-4 text-xs">
                  <div>{ROLE_SOURCE_LABEL[r.source]}</div>
                  {r.groupCn && <div className="text-muted-foreground font-mono break-all">{r.groupCn}</div>}
                  {r.alsoGrantedBy && <div className="text-muted-foreground">or {r.alsoGrantedBy}</div>}
                </td>
                <td className="py-3 pr-4">
                  <Chips items={r.can} tone="can" />
                </td>
                <td className="py-3 pr-4">
                  <Chips items={r.cannot} tone="cannot" />
                </td>
                <td className="text-muted-foreground py-3 text-xs whitespace-nowrap" data-testid={`role-holders-${r.key}`}>
                  <Holders role={r} counts={counts} members={members} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
