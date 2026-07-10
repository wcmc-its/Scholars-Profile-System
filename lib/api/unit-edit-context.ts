/**
 * Unit-curation `/edit/*` read — the suppression-OFF context for every unit
 * editor page (#540 Phase 7, `unit-curation-edit-ui-spec.md` § Data contract).
 *
 * One server call loads everything a `/edit/{department,division,center}/[code]`
 * page renders: the override-merged unit fields, the leader chip, the access
 * list (Owner/Superuser only), the roster (centers + manual divisions only),
 * and — on a department — its child divisions for the sub-rail. The actor's
 * effective role rides along so the client can filter the attribute rail
 * without a second round-trip.
 *
 * Returns `null` when:
 *   - the unit row does not exist (the page renders 404), OR
 *   - the actor has no role on it and is not a Superuser (the page renders the
 *     visible 403), OR
 *   - the unit is retired AND the actor is not a Superuser (Superusers see
 *     retired units in order to restore them — the SPEC's one read-path
 *     exception).
 *
 * Suppression read-through: like `loadEditContext`, this reads with the
 * suppression filter OFF. The `actorRole` gate above already filtered out
 * non-actors, so a retired unit only reaches the render path for a Superuser.
 *
 * Server-only by construction (uses Prisma) — no `server-only` import so the
 * module loads under vitest without a stub, matching `manual-layer.ts` and
 * `edit-context.ts`.
 *
 * PR-7a ships the `/edit/department/[code]` route only; the division and center
 * branches here are exercised by the context unit tests and consumed by the
 * unit-curation routes. #552 widened the center `roster` rows with
 * membershipType / programCode / startDate / endDate and added a per-center
 * `programs` taxonomy map (both null/empty for non-center units), consumed by
 * the center roster table (`center-roster-card.tsx`).
 */
import {
  loadUnitFieldOverrides,
  mergeUnitFields,
  type UnitEntityType,
  type UnitFieldOverrideName,
} from "@/lib/api/manual-layer";
import {
  getEffectiveUnitRole,
  type UnitAdminLookup,
  type UnitRef,
} from "@/lib/edit/authz";
import type { EditSession } from "@/lib/auth/superuser";
import type { PrismaClient } from "@/lib/generated/prisma/client";

export type UnitActorRole = "superuser" | "owner" | "curator";

export type UnitEditContext = {
  unit: {
    unitType: UnitEntityType;
    /** dept code, division N-code, or center synthetic code. */
    code: string;
    name: string;
    /** override-merged (dept/div); the in-row value for a center. */
    description: string | null;
    /** #1021 — outbound website URL; override-merged (dept/div) or in-row
     *  (center), same as description. null/empty = no link. */
    url: string | null;
    /** The live public slug — the column value (dept/div is NOT runtime-merged;
     *  the ETL consults the override before re-deriving). */
    slug: string;
    /** dept/div: the `field_override(slug)` value if one exists, else null —
     *  drives the slug card's "Clear override" + "pending ETL" copy. Always null
     *  for a center (no `field_override`; the slug column is edited in-row). */
    slugOverride: string | null;
    /** null for departments; the parent dept code for a division. */
    deptCode: string | null;
    /** parent dept display name — for the breadcrumb / sibling rail. */
    deptName: string | null;
    /** parent dept slug — for a division's public-preview URL
     *  (`/departments/{deptSlug}/divisions/{slug}`). null for dept/center. */
    deptSlug: string | null;
    /** dept/div carry "ED" | "manual"; a center is always "manual". */
    source: "ED" | "manual";
    /** center only. */
    centerType: "center" | "institute" | null;
    /** Which curator-editable fields currently have a `field_override` row —
     *  drives each card's "Clear override" affordance. Always empty for a
     *  center (centers edit in-row; no `field_override`). */
    overriddenFields: ReadonlyArray<UnitFieldOverrideName>;
    leader: {
      /** null = no override / no detected leader (incl. explicit vacancy). */
      cwid: string | null;
      /** true ⇔ an override row set `leaderCwid = ""` (dept/div only). */
      explicitVacancy: boolean;
      interim: boolean;
      name: string | null;
      title: string | null;
    };
    suppression: { id: string; suppressedAt: Date; actorCwid: string } | null;
  };
  /** Present iff the actor can manage access (Owner or Superuser); else null. */
  access: ReadonlyArray<{
    cwid: string;
    name: string;
    title: string | null;
    role: "owner" | "curator";
    /** `"manual"` for an in-app grant; `"ED:*"` for an Enterprise-Directory
     *  sync. ED-sourced rows are not removable here (#955) — the route's
     *  `ed_locked` gate is the backstop; the card disables Remove for them. */
    source: string;
    grantedBy: string | null;
    grantedAt: Date;
  }> | null;
  /** Present iff the unit carries a roster (center, or manual division). The
   *  extended fields (#552) are populated for a center; always null for a
   *  manual division (DivisionMembership has no such columns). Dates are
   *  `YYYY-MM-DD` strings — serializable to the client date pickers. */
  roster: ReadonlyArray<{
    cwid: string;
    name: string;
    title: string | null;
    source: string;
    membershipType: "research" | "clinical" | null;
    programCode: string | null;
    startDate: string | null;
    endDate: string | null;
  }> | null;
  /** The center's program taxonomy (#552), present for a center (empty when the
   *  center has none — the roster editor hides Type + Program then). null for a
   *  department or division. #1117 widens each program with its prose
   *  `description` and ordered `leaders` (0..N — a program may be co-led) for the
   *  program editor; `name`/`title` resolve a leader cwid to a WCM scholar (null
   *  when the cwid is an external leader with no scholar row). */
  programs: ReadonlyArray<{
    code: string;
    label: string;
    sortOrder: number;
    description: string | null;
    leaders: ReadonlyArray<{
      cwid: string;
      name: string | null;
      title: string | null;
      interim: boolean;
      role: "leader" | "coe_liaison";
      sortOrder: number;
    }>;
  }> | null;
  /** Present on a department only — its child divisions for the sub-rail. */
  siblingDivisions: ReadonlyArray<{
    code: string;
    name: string;
    slug: string;
  }> | null;
  /** The actor's effective role on THIS unit (drives client-side rail filtering). */
  actorRole: UnitActorRole;
  /** The acting session's CWID — the access card disables Remove on this row
   *  (the self-revoke footgun guard, mirrored from `/api/edit/grant`). */
  actorCwid: string;
};

/**
 * The Prisma surface this helper reads — a `PrismaClient` (or a `db.read`
 * client) satisfies it structurally. Kept narrow so the context unit tests can
 * mock exactly these models.
 */
export type UnitEditContextClient = Pick<
  PrismaClient,
  | "department"
  | "division"
  | "center"
  | "unitAdmin"
  | "fieldOverride"
  | "suppression"
  | "scholar"
  | "centerMembership"
  | "divisionMembership"
  | "centerProgram"
>;

/** Look up the leader / access / roster cwids' display name + title in one query. */
async function resolveScholarNames(
  cwids: ReadonlyArray<string>,
  client: UnitEditContextClient,
): Promise<Map<string, { name: string; title: string | null }>> {
  const out = new Map<string, { name: string; title: string | null }>();
  const unique = [...new Set(cwids.filter((c) => c.length > 0))];
  if (unique.length === 0) return out;
  const rows = await client.scholar.findMany({
    where: { cwid: { in: unique } },
    select: { cwid: true, preferredName: true, primaryTitle: true },
  });
  for (const row of rows) {
    out.set(row.cwid, { name: row.preferredName, title: row.primaryTitle });
  }
  return out;
}

export async function loadUnitEditContext(
  unitType: UnitEntityType,
  code: string,
  session: EditSession,
  client: UnitEditContextClient,
): Promise<UnitEditContext | null> {
  // 1. Load the unit row (+ parent dept for a division).
  let name: string;
  let description: string | null;
  let url: string | null;
  let slug: string;
  let deptCode: string | null = null;
  let deptName: string | null = null;
  let deptSlug: string | null = null;
  let source: "ED" | "manual";
  let centerType: "center" | "institute" | null = null;
  let rowLeaderCwid: string | null;
  let rowLeaderInterim: boolean | undefined;

  if (unitType === "department") {
    const row = await client.department.findUnique({
      where: { code },
      select: { code: true, name: true, description: true, url: true, slug: true, chairCwid: true, source: true },
    });
    if (!row) return null;
    name = row.name;
    description = row.description;
    url = row.url;
    slug = row.slug;
    source = row.source === "manual" ? "manual" : "ED";
    rowLeaderCwid = row.chairCwid;
  } else if (unitType === "division") {
    const row = await client.division.findUnique({
      where: { code },
      select: {
        code: true,
        name: true,
        description: true,
        url: true,
        slug: true,
        chiefCwid: true,
        source: true,
        deptCode: true,
        department: { select: { name: true, slug: true } },
      },
    });
    if (!row) return null;
    name = row.name;
    description = row.description;
    url = row.url;
    slug = row.slug;
    source = row.source === "manual" ? "manual" : "ED";
    deptCode = row.deptCode;
    deptName = row.department?.name ?? null;
    deptSlug = row.department?.slug ?? null;
    rowLeaderCwid = row.chiefCwid;
  } else {
    const row = await client.center.findUnique({
      where: { code },
      select: {
        code: true,
        name: true,
        description: true,
        url: true,
        slug: true,
        directorCwid: true,
        centerType: true,
        leaderInterim: true,
      },
    });
    if (!row) return null;
    name = row.name;
    description = row.description;
    url = row.url;
    slug = row.slug;
    // A center is always manually owned — the SPEC treats its source as
    // "manual" regardless of the seed/import provenance on the row.
    source = "manual";
    centerType = row.centerType === "institute" ? "institute" : "center";
    rowLeaderCwid = row.directorCwid;
    rowLeaderInterim = row.leaderInterim;
  }

  // 2. Effective role + the superuser/retired gates.
  const unitRef: UnitRef =
    unitType === "department"
      ? { kind: "department", code }
      : unitType === "division"
        ? { kind: "division", code, parentDeptCode: deptCode }
        : { kind: "center", code };
  const effective = await getEffectiveUnitRole(
    session,
    unitRef,
    client as unknown as UnitAdminLookup,
  );
  // A comms_steward edits any existing unit at curator parity (content only, no
  // grants — comms-steward-profile-editing-spec.md §3b), so they pass the
  // "no unit-admin role" gate like a superuser does. The retired-unit gate below
  // still excludes them (only a superuser sees/restores a retired unit).
  if (!session.isSuperuser && !session.isCommsSteward && effective === "none") return null;

  // Retire gate — a non-Superuser never sees a retired unit; a Superuser does
  // (restore path). The suppression row, when present, populates `unit.suppression`.
  const suppressionRow = await client.suppression.findFirst({
    where: { entityType: unitType, entityId: code, revokedAt: null },
    select: { id: true, createdAt: true, createdBy: true },
    orderBy: { createdAt: "desc" },
  });
  if (suppressionRow !== null && !session.isSuperuser) return null;

  // A steward without a real grant (`effective === "none"`, having passed the
  // gate above) acts as a CURATOR: edits content but never manages access
  // (`canManageAccess` below stays Superuser/Owner-only, so a steward gets no
  // grant UI). A steward who ALSO holds a real owner/curator grant keeps it.
  const actorRole: UnitActorRole = session.isSuperuser
    ? "superuser"
    : effective === "none"
      ? "curator"
      : (effective as "owner" | "curator");

  // 3. Override-merge the curator-editable fields (centers return {}).
  const overrides = await loadUnitFieldOverrides(unitType, code, client);
  const merged = mergeUnitFields(
    { description, url, leaderCwid: rowLeaderCwid, leaderInterim: rowLeaderInterim },
    overrides,
  );

  const explicitVacancy = unitType !== "center" && merged.leaderCwid === "";
  const leaderCwid =
    merged.leaderCwid === null || merged.leaderCwid === "" ? null : merged.leaderCwid;

  // 4. Access list (Owner/Superuser only) and roster (center/manual-division).
  const canManageAccess = session.isSuperuser || actorRole === "owner";
  const hasRoster = unitType === "center" || (unitType === "division" && source === "manual");

  const accessRows = canManageAccess
    ? await client.unitAdmin.findMany({
        where: { entityType: unitType, entityId: code },
        select: { cwid: true, role: true, source: true, grantedBy: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  type RosterRow = {
    cwid: string;
    source: string;
    membershipType: "research" | "clinical" | null;
    programCode: string | null;
    startDate: Date | null;
    endDate: Date | null;
  };
  let rosterRows: RosterRow[] = [];
  // A center's program taxonomy (#552) + #1117 per-program leaders/description.
  // Raw rows are resolved into the public `programs` shape after the name batch.
  type ProgramRowRaw = {
    code: string;
    label: string;
    sortOrder: number;
    description: string | null;
    leaders: Array<{ cwid: string; interim: boolean; role: string; sortOrder: number }>;
  };
  let programRowsRaw: ProgramRowRaw[] | null = null;
  if (hasRoster) {
    if (unitType === "center") {
      rosterRows = await client.centerMembership.findMany({
        where: { centerCode: code },
        select: {
          cwid: true,
          source: true,
          membershipType: true,
          programCode: true,
          startDate: true,
          endDate: true,
        },
        orderBy: { cwid: "asc" },
      });
      programRowsRaw = await client.centerProgram.findMany({
        where: { centerCode: code },
        select: {
          code: true,
          label: true,
          sortOrder: true,
          description: true,
          leaders: {
            select: { cwid: true, interim: true, role: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { cwid: "asc" }],
          },
        },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      });
    } else {
      const rows = await client.divisionMembership.findMany({
        where: { divisionCode: code },
        select: { cwid: true, source: true },
        orderBy: { cwid: "asc" },
      });
      // A division has no extended membership columns — pad with nulls.
      rosterRows = rows.map((r) => ({
        cwid: r.cwid,
        source: r.source,
        membershipType: null,
        programCode: null,
        startDate: null,
        endDate: null,
      }));
    }
  }

  // 5. Batch-resolve names for the leader + access + roster cwids. A unit admin
  // is often a non-Scholar staff member, so a Scholar miss is expected — the
  // access card re-resolves those names client-side via /api/directory/people.
  const nameMap = await resolveScholarNames(
    [
      ...(leaderCwid ? [leaderCwid] : []),
      ...accessRows.map((r) => r.cwid),
      ...rosterRows.map((r) => r.cwid),
      // #1117 — program-leader cwids, so the program editor shows names.
      ...(programRowsRaw ?? []).flatMap((p) => p.leaders.map((l) => l.cwid)),
    ],
    client,
  );

  const leaderResolved = leaderCwid ? nameMap.get(leaderCwid) : undefined;

  const access = canManageAccess
    ? accessRows.map((r) => ({
        cwid: r.cwid,
        name: nameMap.get(r.cwid)?.name ?? r.cwid,
        title: nameMap.get(r.cwid)?.title ?? null,
        role: r.role,
        source: r.source,
        grantedBy: r.grantedBy,
        grantedAt: r.createdAt,
      }))
    : null;

  const roster = hasRoster
    ? rosterRows.map((r) => ({
        cwid: r.cwid,
        name: nameMap.get(r.cwid)?.name ?? r.cwid,
        title: nameMap.get(r.cwid)?.title ?? null,
        source: r.source,
        membershipType: r.membershipType,
        programCode: r.programCode,
        startDate: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
        endDate: r.endDate ? r.endDate.toISOString().slice(0, 10) : null,
      }))
    : null;

  // #1117 — resolve each program's leader cwids to display names for the editor.
  // A leader cwid that isn't a WCM scholar (external leader) stays name/title
  // null; the card re-resolves it client-side like the access/roster cards do.
  const programs = programRowsRaw
    ? programRowsRaw.map((p) => ({
        code: p.code,
        label: p.label,
        sortOrder: p.sortOrder,
        description: p.description,
        leaders: p.leaders.map((l) => ({
          cwid: l.cwid,
          name: nameMap.get(l.cwid)?.name ?? null,
          title: nameMap.get(l.cwid)?.title ?? null,
          interim: l.interim,
          // `role` is a VarChar, not an enum — narrow it the same way the public
          // program page does (`lib/api/centers.ts`): anything unrecognized is a leader.
          role: l.role === "coe_liaison" ? ("coe_liaison" as const) : ("leader" as const),
          sortOrder: l.sortOrder,
        })),
      }))
    : null;

  // 6. Sibling divisions (departments only).
  const siblingDivisions =
    unitType === "department"
      ? (
          await client.division.findMany({
            where: { deptCode: code },
            select: { code: true, name: true, slug: true },
            orderBy: { name: "asc" },
          })
        ).map((d) => ({ code: d.code, name: d.name, slug: d.slug }))
      : null;

  return {
    unit: {
      unitType,
      code,
      name,
      description: merged.description,
      url: merged.url,
      slug,
      slugOverride: unitType === "center" ? null : (overrides.slug ?? null),
      deptCode,
      deptName,
      deptSlug,
      source,
      centerType,
      overriddenFields: (Object.keys(overrides) as UnitFieldOverrideName[]).filter(
        (f) => f !== "slug",
      ),
      leader: {
        cwid: leaderCwid,
        explicitVacancy,
        interim: merged.leaderInterim,
        name: leaderResolved?.name ?? null,
        title: leaderResolved?.title ?? null,
      },
      suppression: suppressionRow
        ? {
            id: suppressionRow.id,
            suppressedAt: suppressionRow.createdAt,
            actorCwid: suppressionRow.createdBy,
          }
        : null,
    },
    access,
    roster,
    programs,
    siblingDivisions,
    actorRole,
    actorCwid: session.cwid,
  };
}
