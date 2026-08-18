/**
 * "View as" impersonation — display-role + unit resolution for a CWID (#637,
 * impersonation-spec.md §7/§8).
 *
 * The banner and the switcher render each impersonation subject by the real
 * RBAC shape (ADR-005 Amendment 1 / #540, widened for cores-as-org-units): a
 * **role** — `owner` | `curator` (`UnitRole`) — held over a **unit kind** —
 * `department` | `division` | `center` | `core` (`EntityType`) — or plain
 * `scholar` (a `Scholar` row, no `unit_admin` grant). Core owners/curators are
 * frequently NOT faculty (e.g. facility staff), which is exactly the
 * population "View as" needs to reach — they were previously invisible to the
 * switcher/probe even though `POST /api/impersonation` already accepted them
 * (its target check is grant-existence only, no `entityType` filter). The
 * switcher filters by unit kind (`All · Department · Division · Center · Core
 * · Scholar`) and each row reads `Name · {Owner|Curator} · {unit name}
 * ({Dept|Div|Center|Core})`.
 *
 * Both the `/api/auth/session` probe (the active overlay's target) and
 * `/api/impersonation/candidates` (the assumable-target list) MUST classify a
 * CWID the same way, so the grant-picking rule lives here once
 * (`pickDisplayGrant`); the probe uses the full `resolveImpersonationDisplay`
 * for its single target, the candidates route reuses `pickDisplayGrant` over a
 * batched page.
 *
 * The role here is a **display** label, not an authorization verdict — authz is
 * always re-derived live from the effective identity (`lib/edit/authz.ts`). A
 * CWID may hold several grants (e.g. owner of a center and curator of a
 * department); the displayed one is the **most privileged** (owner before
 * curator; ties broken by unit-kind rank center > division > department — a
 * deterministic, not semantic, tie-break).
 *
 * A superuser target is never surfaced (R2 pre-filters them out of candidates,
 * and the escalation guard rejects a `POST`), so there is no superuser display
 * role here.
 *
 * Server-only by construction (reads Prisma); no `server-only` import so the
 * unit tests can load it without a stub, matching `unit-edit-context.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The role half of the display label — the two `UnitRole`s plus the `scholar` floor. */
export type ImpersonationDisplayRole = "owner" | "curator" | "scholar";

/** The unit-kind half — the four org-unit `EntityType`s a grant can target. */
export type ImpersonationUnitKind = "department" | "division" | "center" | "core";

/** What the banner / switcher render per subject (§7 probe + candidates shape). */
export type ImpersonationDisplay = {
  /** Most-privileged role label (owner > curator > scholar). */
  role: ImpersonationDisplayRole;
  /** The administered unit's kind, or `null` when `role === "scholar"`. */
  unitKind: ImpersonationUnitKind | null;
  /** Administered unit display name (owner/curator) or the home unit (scholar); `null` when unknown. */
  unit: string | null;
};

/** A unit-scoped `unit_admin` grant, narrowed to the four org-unit kinds. */
export type DisplayGrant = {
  role: "owner" | "curator";
  entityType: ImpersonationUnitKind;
  entityId: string;
};

/** The narrow Prisma surface this helper reads — a `db.read` client satisfies it. */
export type ImpersonationDisplayClient = Pick<
  PrismaClient,
  "unitAdmin" | "department" | "division" | "center" | "core"
>;

/** Tie-break only: which unit kind wins when a CWID holds equal-role grants. */
const KIND_RANK: Record<ImpersonationUnitKind, number> = {
  core: 4,
  center: 3,
  division: 2,
  department: 1,
};

function isUnitKind(value: string): value is ImpersonationUnitKind {
  return value === "department" || value === "division" || value === "center" || value === "core";
}

/**
 * Pick the single grant to display from a CWID's `unit_admin` rows: drop any
 * non-org-unit rows, then most-privileged first — owner before curator, ties
 * broken by `KIND_RANK`. Returns `null` when the CWID holds no unit grant (a
 * plain scholar). Pure, so the probe and the candidates route share one rule.
 */
export function pickDisplayGrant(
  grants: ReadonlyArray<{ role: "owner" | "curator"; entityType: string; entityId: string }>,
): DisplayGrant | null {
  const unitGrants = grants.filter((g): g is DisplayGrant => isUnitKind(g.entityType));
  if (unitGrants.length === 0) return null;
  return [...unitGrants].sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1; // owner first
    return KIND_RANK[b.entityType] - KIND_RANK[a.entityType]; // then kind rank desc
  })[0];
}

/** One profile-less unit administrator, reduced from their `unit_admin` rows. */
export type UnitAdminSubject = {
  /** As stored (original case) — the display/POST value, not the dedupe key. */
  cwid: string;
  /** `UnitAdmin.granteeName` from any of their rows, or `null` if none carries
   *  one (the ed-admins pull had no LDAP reachability yet — #443). */
  granteeName: string | null;
  /** Their most-privileged org-unit grant; `null` if they hold none. */
  top: DisplayGrant | null;
};

/**
 * Reduce raw `unit_admin` rows to ONE subject per CWID — the shared core of the
 * candidates route's unit-admin pass (a superuser searching "View as" for an
 * administrator who has no `Scholar` row of their own).
 *
 * Case-insensitive on CWID, since `unit_admin.cwid`, `scholar.cwid` and the
 * session CWID are not guaranteed to agree on case; `exclude` is matched on the
 * same lowercased key so an admin already listed by the scholar pass is not
 * emitted twice. Order is stable (first appearance) so the popover does not
 * reshuffle between identical queries. Pure — no I/O — so the grouping rule is
 * testable without stubbing Prisma or LDAP.
 */
export function summarizeUnitAdminGrants(
  rows: ReadonlyArray<{
    cwid: string;
    granteeName: string | null;
    entityType: string;
    entityId: string;
    role: "owner" | "curator";
  }>,
  exclude: ReadonlySet<string> = new Set(),
): UnitAdminSubject[] {
  const excluded = new Set([...exclude].map((c) => c.toLowerCase()));
  const order: string[] = [];
  const grouped = new Map<string, { cwid: string; granteeName: string | null; rows: typeof rows }>();
  for (const row of rows) {
    const key = row.cwid.toLowerCase();
    if (excluded.has(key)) continue;
    const existing = grouped.get(key);
    if (existing) {
      (existing.rows as Array<(typeof rows)[number]>).push(row);
      existing.granteeName ??= row.granteeName;
    } else {
      order.push(key);
      grouped.set(key, { cwid: row.cwid, granteeName: row.granteeName, rows: [row] });
    }
  }
  return order.map((key) => {
    const g = grouped.get(key)!;
    // `pickDisplayGrant` returns the winning ROW as-is, which here still carries
    // `cwid`/`granteeName`; narrow it to exactly the three `DisplayGrant` fields
    // so the extras can never ride along into a response body.
    const won = pickDisplayGrant(g.rows);
    const top: DisplayGrant | null = won
      ? { role: won.role, entityType: won.entityType, entityId: won.entityId }
      : null;
    return { cwid: g.cwid, granteeName: g.granteeName, top };
  });
}

async function resolveUnitName(
  client: ImpersonationDisplayClient,
  kind: ImpersonationUnitKind,
  code: string,
): Promise<string | null> {
  // Call each delegate explicitly — a `client.department | client.division |
  // client.center | client.core` union is not callable (the Prisma
  // `findUnique` overloads don't unify), so narrow on `kind` first.
  const select = { name: true } as const;
  if (kind === "department") {
    return (await client.department.findUnique({ where: { code }, select }))?.name ?? null;
  }
  if (kind === "division") {
    return (await client.division.findUnique({ where: { code }, select }))?.name ?? null;
  }
  if (kind === "center") {
    return (await client.center.findUnique({ where: { code }, select }))?.name ?? null;
  }
  // `Core`'s PK is `id`, not `code` — it predates the org-unit `code` convention.
  return (await client.core.findUnique({ where: { id: code }, select }))?.name ?? null;
}

/**
 * Resolve the display `{ role, unitKind, unit }` for a single CWID. `homeUnit`
 * is the `Scholar` row's display unit (the LDAP-authoritative column the profile
 * header shows); it is the `unit` for a plain scholar and the fallback when an
 * administered unit's name can't be resolved.
 */
export async function resolveImpersonationDisplay(
  cwid: string,
  client: ImpersonationDisplayClient,
  homeUnit: string | null,
): Promise<ImpersonationDisplay> {
  const grants = await client.unitAdmin.findMany({
    where: { cwid },
    select: { role: true, entityType: true, entityId: true },
  });
  const top = pickDisplayGrant(grants);
  if (!top) return { role: "scholar", unitKind: null, unit: homeUnit };
  const unit = await resolveUnitName(client, top.entityType, top.entityId);
  return { role: top.role, unitKind: top.entityType, unit: unit ?? homeUnit };
}
