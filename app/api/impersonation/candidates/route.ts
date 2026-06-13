/**
 * "View as" impersonation — assumable-target search (#637,
 * impersonation-spec.md §6/§7/§8, R1/R2).
 *
 * `GET /api/impersonation/candidates?kind=&q=` powers the switcher popover
 * (`components/site/impersonation-switcher.tsx`): the superuser searches by name
 * or CWID, optionally filtered by **unit-kind** chip
 * (All · Department · Division · Center · Scholar), and gets back rows
 * `{ cwid, preferredName, slug, role, unitKind, unit }` to "View as".
 *
 * Two security properties live in this query so the UI is never the boundary:
 *   R1 — gate the whole route on `IMPERSONATION_ENABLED` (404 when off) and on
 *        `canImpersonate(REAL session.cwid)` (403). The real cwid, never an
 *        effective one (threat T1).
 *   R2 — PRE-FILTER OUT any candidate who is themselves a superuser. We never
 *        return a target the actor would be rejected for at `POST` time
 *        (down-only escalation guard); the switcher should not even offer them.
 *
 * Role/unit labels follow the real RBAC model (ADR-005 Amendment 1 / #540): a
 * candidate's `role` (`owner`/`curator`) and `unitKind`
 * (`department`/`division`/`center`) come from their most-privileged
 * `unit_admin` grant (`pickDisplayGrant`, shared with the probe so both
 * classify identically); `unit` is that administered unit's display name. A
 * CWID with no grant is a `scholar` (`unitKind: null`, `unit`: home department
 * for context). The query is bounded (≤50 rows, `q`-filtered) so the
 * per-candidate superuser pre-filter and the unit-name lookups stay small.
 *
 * Node runtime by construction: `isSuperuser` (`lib/auth/superuser.ts`) runs a
 * live LDAPS query and Prisma is server-only.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getSession } from "@/lib/auth/session-server";
import { canImpersonate } from "@/lib/auth/effective-identity";
import { isSuperuser } from "@/lib/auth/superuser";
import { listCommsStewardCwids } from "@/lib/auth/comms-steward";
import { pickDisplayGrant, type ImpersonationUnitKind } from "@/lib/edit/impersonation-display";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Max rows returned — keeps the per-candidate superuser pre-filter bounded. */
const CANDIDATE_LIMIT = 50;

/** The unit-kind chip filter (spec §8: All · Department · Division · Center · Scholar). */
type KindFilter = ImpersonationUnitKind | "scholar" | "all";

/** One assumable target (spec §7). */
interface Candidate {
  cwid: string;
  preferredName: string;
  /** `null` for a comms_steward with no Scholar profile of their own (dwd2001). */
  slug: string | null;
  /** Most-privileged `UnitAdmin` role (owner > curator), else `scholar`; or
   *  `comms_steward` for a Method-Family steward with no scholar/unit role. */
  role: "owner" | "curator" | "scholar" | "comms_steward";
  /** The administered unit's kind, or `null` for a plain scholar / steward. */
  unitKind: ImpersonationUnitKind | null;
  /** Administered unit display name (owner/curator) or home unit (scholar). */
  unit: string | null;
}

function parseKind(value: string | null): KindFilter {
  return value === "department" ||
    value === "division" ||
    value === "center" ||
    value === "scholar"
    ? value
    : "all";
}

function impersonationEnabled(): boolean {
  return process.env.IMPERSONATION_ENABLED === "true";
}

/**
 * Batch-resolve unit `code -> name` for one kind. The `find` thunk keeps the
 * concrete Prisma delegate at each call site (no generic-delegate typing); an
 * empty code set short-circuits with no query. Fail-soft to an empty map.
 */
async function unitNameMap(
  find: (codes: string[]) => Promise<Array<{ code: string; name: string }>>,
  codes: Set<string>,
): Promise<Map<string, string>> {
  if (codes.size === 0) return new Map();
  const rows = await find([...codes]).catch(() => [] as Array<{ code: string; name: string }>);
  return new Map(rows.map((r) => [r.code, r.name]));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!impersonationEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });

  // R1 — initiator gate on the REAL cwid (the effective cwid is irrelevant to
  // who may search for targets; threat T1).
  if (!(await canImpersonate(session.cwid))) {
    return NextResponse.json({ ok: false, error: "not_superuser" }, { status: 403 });
  }

  const { searchParams } = request.nextUrl;
  const q = (searchParams.get("q") ?? "").trim();
  const kindFilter = parseKind(searchParams.get("kind"));

  // Candidate scholars: non-departed, name/cwid `contains` (case-insensitive by
  // the column's MariaDB collation, as in `lib/api/edit-roster.ts`). Over-fetch
  // is unnecessary — the role/unit labels and the superuser pre-filter both run
  // in memory over this bounded page.
  const rows = await db.read.scholar
    .findMany({
      where: {
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { preferredName: { contains: q } },
                { fullName: { contains: q } },
                { cwid: { contains: q } },
              ],
            }
          : {}),
      },
      select: {
        cwid: true,
        preferredName: true,
        slug: true,
        department: { select: { name: true } },
        division: { select: { name: true } },
      },
      orderBy: [{ preferredName: "asc" }, { cwid: "asc" }],
      take: CANDIDATE_LIMIT,
    })
    .catch(() => [] as Array<{
      cwid: string;
      preferredName: string;
      slug: string;
      department: { name: string } | null;
      division: { name: string } | null;
    }>);

  // Most-privileged unit grant per candidate, classified by the SAME rule the
  // probe uses (`pickDisplayGrant`: owner > curator, ties by unit-kind rank).
  // One `findMany` over the page's CWIDs, reduced in memory. A CWID with no
  // grant stays a `scholar` — exactly what they can do.
  const cwids = rows.map((r) => r.cwid);
  const grants =
    cwids.length === 0
      ? []
      : await db.read.unitAdmin
          .findMany({
            where: { cwid: { in: cwids } },
            select: { cwid: true, role: true, entityType: true, entityId: true },
          })
          .catch(
            () =>
              [] as Array<{
                cwid: string;
                role: "owner" | "curator";
                entityType: string;
                entityId: string;
              }>,
          );

  const grantsByCwid = new Map<
    string,
    Array<{ role: "owner" | "curator"; entityType: string; entityId: string }>
  >();
  for (const g of grants) {
    const list = grantsByCwid.get(g.cwid);
    if (list) list.push(g);
    else grantsByCwid.set(g.cwid, [g]);
  }
  const topByCwid = new Map<string, ReturnType<typeof pickDisplayGrant>>();
  for (const [cwid, list] of grantsByCwid) topByCwid.set(cwid, pickDisplayGrant(list));

  // Resolve the administered unit's display name, one batched query per kind.
  const codesByKind: Record<ImpersonationUnitKind, Set<string>> = {
    department: new Set(),
    division: new Set(),
    center: new Set(),
  };
  for (const top of topByCwid.values()) {
    if (top) codesByKind[top.entityType].add(top.entityId);
  }
  const [deptNames, divNames, centerNames] = await Promise.all([
    unitNameMap(
      (codes) =>
        db.read.department.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        }),
      codesByKind.department,
    ),
    unitNameMap(
      (codes) =>
        db.read.division.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        }),
      codesByKind.division,
    ),
    unitNameMap(
      (codes) =>
        db.read.center.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        }),
      codesByKind.center,
    ),
  ]);
  const nameMaps: Record<ImpersonationUnitKind, Map<string, string>> = {
    department: deptNames,
    division: divNames,
    center: centerNames,
  };

  // R2 pre-filter — drop any candidate who is themselves a superuser. The check
  // is the same live LDAPS `isSuperuser` the `POST` guard uses, so the switcher
  // never offers a target that `assertImpersonable` would reject. Bounded to the
  // ≤50-row page; run in parallel. Fail-closed: an unexpected error excludes the
  // candidate (treat as not-assumable) rather than risk listing a superuser.
  const superuserFlags = await Promise.all(rows.map((r) => isSuperuser(r.cwid).catch(() => true)));

  const candidates: Candidate[] = [];
  rows.forEach((r, i) => {
    if (superuserFlags[i]) return; // R2 — not assumable
    const top = topByCwid.get(r.cwid) ?? null;
    const role: Candidate["role"] = top?.role ?? "scholar";
    const unitKind = top?.entityType ?? null;
    const homeUnit = r.department?.name ?? r.division?.name ?? null;
    const unit = top ? (nameMaps[top.entityType].get(top.entityId) ?? homeUnit) : homeUnit;
    // Unit-kind chip: a kind matches the administered kind; `scholar` matches an
    // ungranted scholar; `all` passes everything.
    if (kindFilter !== "all") {
      if (kindFilter === "scholar" ? role !== "scholar" : unitKind !== kindFilter) return;
    }
    candidates.push({ cwid: r.cwid, preferredName: r.preferredName, slug: r.slug, role, unitKind, unit });
  });

  // comms_steward candidates (role-aware-navigation-entry-points-spec.md): a
  // steward (e.g. dwd2001) is a global Method-Family role, NOT a scholar — they
  // may have no `Scholar` row at all — so the query above never surfaces them.
  // Append the enumerable stewards (the allowlist; see `listCommsStewardCwids`)
  // here. Only under the `all` view — a steward is not a department/division/
  // center/scholar, so the unit-kind chips correctly exclude them. Each still
  // passes the R2 down-only guard (superusers dropped) and the `q` filter.
  if (kindFilter === "all") {
    const emitted = new Set(candidates.map((c) => c.cwid.toLowerCase()));
    const stewardCwids = listCommsStewardCwids().filter((c) => !emitted.has(c));
    if (stewardCwids.length > 0) {
      // Resolve a display name/slug from a Scholar row when one exists; a steward
      // without a profile (the common case) shows their CWID as the label.
      const profiles = await db.read.scholar
        .findMany({
          where: { cwid: { in: stewardCwids }, deletedAt: null },
          select: { cwid: true, preferredName: true, slug: true },
        })
        .catch(() => [] as Array<{ cwid: string; preferredName: string; slug: string }>);
      const profileByCwid = new Map(profiles.map((p) => [p.cwid.toLowerCase(), p]));
      // R2 — exclude any steward who is themselves a superuser, same fail-closed
      // (error ⇒ exclude) rule as the scholar pass.
      const stewardSuperuserFlags = await Promise.all(
        stewardCwids.map((c) => isSuperuser(c).catch(() => true)),
      );
      const qLower = q.toLowerCase();
      stewardCwids.forEach((cwid, i) => {
        if (stewardSuperuserFlags[i]) return; // R2 — not assumable
        const profile = profileByCwid.get(cwid);
        const preferredName = profile?.preferredName ?? cwid;
        // `q` matches the CWID or the resolved name (the scholar pass already
        // applied `q` server-side; mirror it for the steward set in memory).
        if (qLower && !cwid.includes(qLower) && !preferredName.toLowerCase().includes(qLower)) {
          return;
        }
        candidates.push({
          cwid: profile?.cwid ?? cwid,
          preferredName,
          slug: profile?.slug ?? null,
          role: "comms_steward",
          unitKind: null,
          unit: null,
        });
      });
    }
  }

  return NextResponse.json(candidates.slice(0, CANDIDATE_LIMIT), {
    headers: { "cache-control": "no-store" },
  });
}
