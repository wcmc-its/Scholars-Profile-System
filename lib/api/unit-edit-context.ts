/**
 * Unit-curation `/edit/*` read — the suppression-OFF context for every unit
 * editor page (#540 Phase 7, `unit-curation-edit-ui-spec.md` § Data contract).
 *
 * One server call loads everything a `/edit/{department,division,center}/[code]`
 * page renders: the override-merged unit fields, the leader chip, the access
 * list (Owner, Superuser, or comms_steward), the roster (centers + manual divisions only),
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
 *
 * The disease-assignment plan (`2026-08-12-cancer-center-disease-assignment-
 * edit-ui-plan.md` §5/§6) widens each center roster row further with a
 * `diseases` list — `CancerCenterDiseaseAssignment` merged with any curator
 * `CancerCenterDiseaseDecision` for the same (cwid, diseaseCode) pair, plus a
 * v1 drift flag comparing the decision's snapshot against the CURRENT
 * assignment row. Always `[]` for a department/division, for a center with
 * no assignment/decision rows, AND (bug fix, staging report 2026-08-26) for a
 * center with no `CenterProgram` taxonomy at all — `CancerCenterDiseaseAssignment`
 * is keyed (cwid, diseaseCode) with no center column, so a program-less center
 * that happens to SHARE roster members with the Cancer Center (e.g. Health
 * Equity) would otherwise inherit their disease rows. Gated the same
 * data-driven way `resolveReportsCenterCode` (`lib/edit/cancer-center-
 * reports.ts`) picks the Cancer Center: "a center with a `CenterProgram`
 * taxonomy," not a hardcoded center code. A decision with NO matching assignment row
 * (the manual-add case — a curator attaching a disease code the generator
 * never suggested for this member) still produces a `diseases` entry:
 * `assignment: null`, `decision` populated. The merge below keys off BOTH
 * tables independently rather than iterating assignments and attaching
 * decisions, precisely so a decision-only pair is never dropped.
 *
 * The manual-add extension also widens the context with `diseaseOptions` — the
 * canonical disease-code → label list (`docs/cancer-center-person-rollup.csv`,
 * the same rollup `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`
 * reads) — so the roster card's "Add a disease" picker has something to list
 * without a second round-trip. One shared list for the whole center, computed
 * once per load — NOT per member. `null` outside a center, same convention as
 * `programs`.
 */
import { readFileSync } from "node:fs";
import { DIRECTOR_ROLE_KEY } from "@/lib/center-roles";
import path from "node:path";

import {
  loadUnitFieldOverrides,
  mergeUnitFields,
  type UnitEntityType,
  type UnitFieldOverrideName,
} from "@/lib/api/manual-layer";
import { parseCsv } from "@/lib/csv";
import {
  canManageAccess as canManageAccessPredicate,
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
  /** Present iff the actor can manage access (Owner, Superuser, or
   *  comms_steward — 2026-08-26 policy widening, decision #3); else null. */
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
    /** Whether the PERSON is still at WCM — orthogonal to the membership dates.
     *  `departed` = soft-deleted by the ED ETL (left WCM, or `affiliate_alumni`);
     *  `unknown` = no Scholar row ever matched this cwid, which is why the `name`
     *  above falls back to the raw cwid. */
    scholarState: RosterScholarState;
    /** Disease-assignment plan §5/§6 — this member's ranked disease-expertise
     *  picture. `[]` outside a center (dept/division) and for a center member
     *  with no `CancerCenterDiseaseAssignment`/`CancerCenterDiseaseDecision`
     *  rows. Optional so existing fixtures/callers that predate this feature
     *  still type-check; absent → `[]` (same convention as `RosterMember.
     *  scholarState` in `center-roster-card.tsx`). */
    diseases?: ReadonlyArray<RosterDiseaseRow>;
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
  /** Disease-assignment plan §5/§6 manual-add extension — the canonical
   *  disease-code → label list, for the roster card's "Add a disease" picker.
   *  One shared list for the whole center (not per member); `null` for a
   *  department or division, same convention as {@link programs}. */
  diseaseOptions: ReadonlyArray<DiseaseCodeOption> | null;
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
  | "cancerCenterDiseaseAssignment"
  | "cancerCenterDiseaseDecision"
>;

/**
 * Look up the leader / access / roster cwids' display name + title in one query.
 *
 * Reads WITHOUT a `deletedAt` filter on purpose: a scholar who has left WCM is
 * SOFT-deleted by the ED ETL (`etl/ed/index.ts`, `data: { deletedAt: new Date() }`),
 * and a curated center roster must still be able to show who they were. Filtering
 * them out here would turn every departure into a bare-CWID row and destroy the
 * historical record the roster exists to keep.
 *
 * `departed` rides along so callers can DISTINGUISH the two cases instead of
 * conflating them, which is what the roster did before #2324:
 *   - resolved + departed=false → currently at WCM
 *   - resolved + departed=true  → left WCM (or `affiliate_alumni`, soft-hidden
 *     the same way); name is still known and still shown
 *   - NOT in the map at all     → no Scholar row has ever existed for this cwid
 *     (a manually-added membership that never matched anyone)
 */
async function resolveScholarNames(
  cwids: ReadonlyArray<string>,
  client: UnitEditContextClient,
): Promise<Map<string, { name: string; title: string | null; departed: boolean }>> {
  const out = new Map<string, { name: string; title: string | null; departed: boolean }>();
  const unique = [...new Set(cwids.filter((c) => c.length > 0))];
  if (unique.length === 0) return out;
  const rows = await client.scholar.findMany({
    where: { cwid: { in: unique } },
    select: { cwid: true, preferredName: true, primaryTitle: true, deletedAt: true },
  });
  for (const row of rows) {
    out.set(row.cwid, {
      name: row.preferredName,
      title: row.primaryTitle,
      departed: row.deletedAt !== null,
    });
  }
  return out;
}

/**
 * Whether a roster member is still at WCM, has left, or was never resolvable.
 * Derived from the `resolveScholarNames` lookup — NOT from membership dates,
 * which are a separate axis (`rosterStatusOf`: a member can have a current
 * membership AND have left the institution, which is exactly the state a center
 * needs to notice).
 */
export type RosterScholarState = "active" | "departed" | "unknown";

export function scholarStateOf(
  resolved: { departed: boolean } | undefined,
): RosterScholarState {
  if (resolved === undefined) return "unknown";
  return resolved.departed ? "departed" : "active";
}

/**
 * One (cwid, diseaseCode) pair — the CURRENT `CancerCenterDiseaseAssignment`
 * row for it, if the assignment ETL's most recent full-replace still carries
 * one, UNION'd with the curator's `CancerCenterDiseaseDecision`, if any exists.
 * Either can be present alone: an assignment with no decision is simply
 * unreviewed; a decision with no current assignment is the "evidence
 * disappeared" drift case below (plan §6).
 */
export type RosterDiseaseRow = {
  diseaseCode: string;
  assignment: {
    rank: number;
    focus: string;
    confidence: string;
    leadPubs: number;
    secondPubs: number;
    middlePubs: number;
    grantsLed: number;
    grantsSupport: number;
    trialsLed: number;
    trialsSupport: number;
    pubScore: number;
    score: number;
    firstYear: number | null;
    lastYear: number | null;
    recentPubs: number;
    specialtyStatus: string;
  } | null;
  decision: {
    decision: string; // "confirmed" | "rejected"
    decidedBy: string;
    decidedAt: Date;
    /** null for a manual add (plan's manual-add extension) — a curator-attached
     *  disease with no `CancerCenterDiseaseAssignment` row to snapshot. Always
     *  populated for a decision made against a live assignment (the ordinary
     *  confirm/reject flow). */
    scoreAtDecision: number | null;
    confidenceAtDecision: string | null;
  } | null;
  /** Plan §6 v1 drift flag — see `isDiseaseDecisionDrifted`. */
  drifted: boolean;
};

/** One canonical disease code — for the "Add a disease" picker (manual-add
 *  extension) and for validating a curator-supplied code server-side. */
export type DiseaseCodeOption = { code: string; label: string };

/** `docs/cancer-center-person-rollup.csv`, read via a cwd-relative path — the
 *  same file `scripts/cancer-center-disease-assignments.ts`'s CLI entrypoint
 *  reads. Traced into the app runtime image via `next.config.ts`'s
 *  `outputFileTracingIncludes` for the routes that call
 *  {@link loadDiseaseCodeOptions}; any NEW app-runtime caller must be added
 *  there too (mirrors `loadMeshAncestorContext`'s own CSV-tracing guardrail,
 *  `lib/clinical-mesh-anchors.ts`). */
const DISEASE_ROLLUP_CSV_PATH = path.join(process.cwd(), "docs/cancer-center-person-rollup.csv");

/**
 * The canonical disease-code → label list, deduped by code (a code can repeat
 * across several `article_bucket` rows in the rollup — first label wins, same
 * as `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`), sorted
 * by label for the picker. Deliberately NOT an import of `labelsOf()` itself:
 * that file's `runAssignments` pulls in the raw `mariadb` driver + `lib/
 * cancer-taxonomy.ts` at module scope (behind an `import.meta.url` CLI guard,
 * not a lazy import), which this context loader — reached by every unit-editor
 * route, not only centers — has no reason to carry. `parseCsv` (the one CSV
 * dialect this repo has) IS reused; only the ~3-line code→label dedup is
 * re-derived locally.
 *
 * Throws (fail-loud) if the CSV is absent — same stance
 * `loadSpecialtyAnchorMap` documents for its own CSV: the file is committed,
 * so absence is a packaging bug, not a runtime-degrade case. The one caller in
 * this module ({@link loadUnitEditContext}) catches around its call site and
 * degrades `diseaseOptions` to `[]` rather than failing the whole unit page.
 */
export function loadDiseaseCodeOptions(
  csvPath: string = DISEASE_ROLLUP_CSV_PATH,
): ReadonlyArray<DiseaseCodeOption> {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const seen = new Set<string>();
  const options: DiseaseCodeOption[] = [];
  for (const r of rows) {
    const code = r.person_code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    options.push({ code, label: r.display_label });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Plan §6 — deliberately simple v1 drift flag, recomputed on every load by
 * comparing a decision's AT-DECISION-TIME snapshot against the CURRENT
 * assignment row for the same pair. A visible badge only; no auto-revert, no
 * notification.
 *
 * ponytail: v2 could add thresholds / a staleness window / a digest instead
 * of a per-row badge the curator happens to notice next time they're on the
 * row — flagged here so this doesn't quietly become the permanent ceiling.
 */
export function isDiseaseDecisionDrifted(
  decision: { decision: string; confidenceAtDecision: string | null },
  current: { confidence: string } | undefined,
): boolean {
  if (decision.decision === "rejected") {
    // Evidence "tripled" — now high confidence, and wasn't at decision time.
    return current !== undefined && current.confidence === "high" && decision.confidenceAtDecision !== "high";
  }
  if (decision.decision === "confirmed") {
    // A manual add (`confidenceAtDecision === null` — no assignment row to
    // snapshot at decision time, the route's manual-add branch) never had
    // evidence to begin with, so "the row disappeared" doesn't apply to it.
    // Only flag drift when a decision that WAS backed by evidence loses its
    // assignment row.
    return decision.confidenceAtDecision !== null && current === undefined;
  }
  return false;
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
        centerType: true,
        // #2542 Phase 1 — leadership is a membership row, not a center column.
        members: {
          where: { leadershipRoleKey: DIRECTOR_ROLE_KEY },
          select: { cwid: true, leadershipInterim: true },
          orderBy: { leadershipSortOrder: "asc" },
          take: 1,
        },
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
    rowLeaderCwid = row.members[0]?.cwid ?? null;
    rowLeaderInterim = row.members[0]?.leadershipInterim ?? false;
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
  // gate above) acts as a CURATOR for content-editing purposes — `actorRole`
  // (client-side rail filtering) stays whatever the actor's real grant says,
  // "curator" as the floor. Access-management no longer rides on `actorRole`
  // at all: per the 2026-08-26 policy widening (decision #3,
  // `comms-steward-profile-editing-spec.md` §11) a comms_steward gets FULL
  // access-management parity on every unit — grant/revoke owner AND curator
  // rows — regardless of any grant they personally hold, so `canManageAccess`
  // below ORs in `session.isCommsSteward` directly rather than deriving it
  // from `actorRole`. A steward who ALSO holds a real owner/curator grant
  // keeps that `actorRole`.
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

  // 4. Access list (Owner/Superuser/comms_steward, delegated to `lib/edit/
  // authz.ts`'s own `canManageAccess` predicate — same inputs already in
  // scope: `session` and `effective`, the `EffectiveUnitRole`. Passing
  // `effective` rather than `actorRole` is deliberate: `actorRole` collapses
  // to `"superuser"` for a superuser, which would never equal `"owner"`, but
  // the predicate's `session.isSuperuser` branch already ALLOWs first, so the
  // `effectiveRole === "owner"` arm is only ever reached for a non-superuser
  // actor anyway) and roster (center/manual-division).
  const canManageAccess = canManageAccessPredicate(session, effective).ok;
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

  // 4b. Disease-expertise rows (plan §5/§6) — center only, keyed off the
  // roster cwids just loaded above. `CancerCenterDiseaseAssignment` /
  // `CancerCenterDiseaseDecision` carry no center column of their own (a
  // scholar's disease profile isn't center-scoped data — same posture as the
  // `/disease-assignments` route's own docblock), so this is "assignments +
  // decisions for THIS center's current roster members," not a query scoped
  // by a center FK.
  //
  // Gated on `hasProgramTaxonomy` (bug fix, staging report 2026-08-26): a
  // center with NO `CenterProgram` rows is not the Cancer Center, but this
  // person-scoped query would otherwise still surface its roster members'
  // disease rows whenever they overlap with the Cancer Center's own roster
  // (e.g. Health Equity shares members with Meyer). This is the same
  // data-driven "has a program taxonomy" gate `resolveReportsCenterCode`
  // (`lib/edit/cancer-center-reports.ts`) uses to resolve the Cancer Center —
  // not a hardcoded center code.
  const hasProgramTaxonomy = unitType === "center" && (programRowsRaw?.length ?? 0) > 0;
  const diseasesByCwid = new Map<string, RosterDiseaseRow[]>();
  if (hasProgramTaxonomy && rosterRows.length > 0) {
    const rosterCwids = rosterRows.map((r) => r.cwid);
    const [assignmentRows, decisionRows] = await Promise.all([
      client.cancerCenterDiseaseAssignment.findMany({
        where: { cwid: { in: rosterCwids } },
        select: {
          cwid: true,
          diseaseCode: true,
          rank: true,
          focus: true,
          confidence: true,
          leadPubs: true,
          secondPubs: true,
          middlePubs: true,
          grantsLed: true,
          grantsSupport: true,
          trialsLed: true,
          trialsSupport: true,
          pubScore: true,
          score: true,
          firstYear: true,
          lastYear: true,
          recentPubs: true,
          specialtyStatus: true,
        },
      }),
      client.cancerCenterDiseaseDecision.findMany({
        where: { cwid: { in: rosterCwids } },
        select: {
          cwid: true,
          diseaseCode: true,
          decision: true,
          decidedBy: true,
          decidedAt: true,
          scoreAtDecision: true,
          confidenceAtDecision: true,
        },
      }),
    ]);

    // Both tables share the same (cwid, diseaseCode) composite id — key on it
    // to look up "does this decision's pair still have a live assignment row"
    // for the drift check below.
    const assignmentByKey = new Map<string, (typeof assignmentRows)[number]>();
    for (const a of assignmentRows) assignmentByKey.set(`${a.cwid}::${a.diseaseCode}`, a);

    const rowsByCwid = new Map<string, Map<string, RosterDiseaseRow>>();
    const rowFor = (cwid: string, diseaseCode: string): RosterDiseaseRow => {
      let byCode = rowsByCwid.get(cwid);
      if (!byCode) rowsByCwid.set(cwid, (byCode = new Map()));
      let row = byCode.get(diseaseCode);
      if (!row) {
        row = { diseaseCode, assignment: null, decision: null, drifted: false };
        byCode.set(diseaseCode, row);
      }
      return row;
    };

    for (const a of assignmentRows) {
      rowFor(a.cwid, a.diseaseCode).assignment = {
        rank: a.rank,
        focus: a.focus,
        confidence: a.confidence,
        leadPubs: a.leadPubs,
        secondPubs: a.secondPubs,
        middlePubs: a.middlePubs,
        grantsLed: a.grantsLed,
        grantsSupport: a.grantsSupport,
        trialsLed: a.trialsLed,
        trialsSupport: a.trialsSupport,
        pubScore: a.pubScore,
        score: a.score,
        firstYear: a.firstYear,
        lastYear: a.lastYear,
        recentPubs: a.recentPubs,
        specialtyStatus: a.specialtyStatus,
      };
    }
    for (const d of decisionRows) {
      const row = rowFor(d.cwid, d.diseaseCode);
      row.decision = {
        decision: d.decision,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        scoreAtDecision: d.scoreAtDecision,
        confidenceAtDecision: d.confidenceAtDecision,
      };
      const current = assignmentByKey.get(`${d.cwid}::${d.diseaseCode}`);
      row.drifted = isDiseaseDecisionDrifted(
        row.decision,
        current ? { confidence: current.confidence } : undefined,
      );
    }

    // Ranked — live assignments by their rank, any decision-only ("evidence
    // disappeared") rows trail at the end ordered by code.
    for (const [cwid, byCode] of rowsByCwid) {
      const rows = [...byCode.values()].sort((a, b) => {
        const rankA = a.assignment?.rank ?? Number.MAX_SAFE_INTEGER;
        const rankB = b.assignment?.rank ?? Number.MAX_SAFE_INTEGER;
        return rankA - rankB || a.diseaseCode.localeCompare(b.diseaseCode);
      });
      diseasesByCwid.set(cwid, rows);
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
    ? rosterRows.map((r) => {
        const resolved = nameMap.get(r.cwid);
        return {
          cwid: r.cwid,
          name: resolved?.name ?? r.cwid,
          title: resolved?.title ?? null,
          source: r.source,
          membershipType: r.membershipType,
          programCode: r.programCode,
          startDate: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
          endDate: r.endDate ? r.endDate.toISOString().slice(0, 10) : null,
          scholarState: scholarStateOf(resolved),
          diseases: diseasesByCwid.get(r.cwid) ?? [],
        };
      })
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

  // 7. Disease-code options (manual-add extension) — center only, one shared
  // list for the whole roster (not per member). A read failure (the CSV
  // missing from this route's `outputFileTracingIncludes` trace, or absent
  // entirely) degrades the picker to empty rather than failing the whole unit
  // page — `loadDiseaseCodeOptions` itself stays fail-loud so a genuinely
  // missing/malformed CSV is easy to spot from this one call site.
  //
  // Gated on the same `hasProgramTaxonomy` check as §4b (bug fix, staging
  // report 2026-08-26): a program-less center gets no manual-add picker
  // payload either — there's no disease surface for it to attach to.
  let diseaseOptions: ReadonlyArray<DiseaseCodeOption> | null = null;
  if (hasProgramTaxonomy) {
    try {
      diseaseOptions = loadDiseaseCodeOptions();
    } catch (err) {
      console.error("[unit-edit-context] loadDiseaseCodeOptions failed", err);
      diseaseOptions = [];
    }
  }

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
    diseaseOptions,
    actorRole,
    actorCwid: session.cwid,
  };
}
