/**
 * The `/edit` title picker — server side.
 *
 * `lib/scholar-title.ts` holds the pure precedence logic and is safe in the
 * client bundle. THIS module talks to the database and must stay server-only:
 * `components/edit/edit-page.tsx` receives its output as a prop and imports
 * only the pure module. Importing this one from a `"use client"` file drags
 * the mariadb driver into the browser and breaks the Next build on `fs`/`net`
 * (the `lib/edit/manageable-units.ts` trap, CLAUDE.md).
 *
 * Two `field_override` field names carry the state, both on the existing
 * table — no new table, no new audit action:
 *
 *   `primaryTitle`         an operator's pick. Wins over every derived tier.
 *   `primaryTitleRequest`  a scholar's (or their proxy's) PENDING request.
 *                          Has no public effect until approved.
 *
 * `FieldOverride` is `@@unique([entityType, entityId, fieldName])`, so an
 * upsert on the request name gives supersede-by-newest for free — one pending
 * request per scholar, no status column and no `superseded` state to keep
 * consistent. Withdrawing is deleting the row, which is the same code path an
 * operator's Dismiss takes.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { CENTER_ENTITY_TYPE, DIRECTOR_ROLE_KEY } from "@/lib/org-unit-roles";
import {
  ambiguousUnitNames,
  buildTitleOptions,
  formatUnitLeadershipTitle,
  resolveFromOptions,
  type TitleOption,
} from "@/lib/scholar-title";

/** `field_override.fieldName` for an operator's pick. */
export const TITLE_OVERRIDE_FIELD = "primaryTitle";
/** `field_override.fieldName` for a scholar's pending request. */
export const TITLE_REQUEST_FIELD = "primaryTitleRequest";

/** `SCHOLAR_TITLE_RESOLUTION` — wired per-env in BOTH `cdk/lib/app-stack.ts`
 *  (app container) and `cdk/lib/etl-stack.ts` (`baseEnvironment`), because the
 *  app renders the picker and the ETL runs the resolution post-pass and they
 *  are different task definitions. Both must agree for flag parity — the same
 *  dual-wiring `SELF_EDIT_ED_ADMINS_IMPORT` uses.
 *
 *  OFF ⇒ the picker does not render, the route rejects both field names, and
 *  the ETL resolves from the override + ED primary title only (today's
 *  behaviour), so flipping it back self-heals on the next nightly. */
export function isTitleResolutionEnabled(): boolean {
  return process.env.SCHOLAR_TITLE_RESOLUTION === "on";
}

/**
 * Center directors title their holder on the EA ladder (2026-09-24): an
 * INSTITUTIONAL center's director ranks 5, above division chief; any other
 * center's director ranks 10, above a plain academic title. This supersedes
 * #2735's Cancer-Center-only rule. Associate directors still never count —
 * that was the #2735 demotion ("Associate Director, … Center" over
 * "Professor of …"). Matched on the role KEY (labels are editable); interim
 * directors count.
 *
 * "Institutional" is data-driven, no center code hardcoded: a center with a
 * `CenterProgram` taxonomy (the Cancer Center, the same test as
 * `resolveReportsCenterCode`) or `centerType = "institute"`.
 */
export async function loadInstitutionalCenterCodes(
  client: Pick<PrismaClient, "centerProgram" | "center">,
): Promise<Set<string>> {
  const [programs, institutes] = await Promise.all([
    client.centerProgram.findMany({ select: { centerCode: true }, distinct: ["centerCode"] }),
    client.center.findMany({ where: { centerType: "institute" }, select: { code: true } }),
  ]);
  return new Set([...programs.map((r) => r.centerCode), ...institutes.map((c) => c.code)]);
}

/** Director only — co- and associate directors do not title their holder
 *  (#2735, kept on the ladder: its ranks name "Director"). */
export function isCenterDirector(a: { role: { key: string } }): boolean {
  return a.role.key === DIRECTOR_ROLE_KEY;
}

/** A scholar's current ED appointment titles — the `appointment` tier's pool. */
export async function loadCurrentAppointmentTitles(
  client: Pick<PrismaClient, "appointment">,
  cwids?: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await client.appointment.findMany({
    where: { source: "ED", endDate: null, ...(cwids ? { cwid: { in: [...cwids] } } : {}) },
    select: { cwid: true, title: true },
    orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
  });
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.cwid, [...(out.get(r.cwid) ?? []), r.title]);
  return out;
}

type TitlePickerClient = Pick<
  PrismaClient,
  | "scholar"
  | "orgUnitRoleAssignment"
  | "division"
  | "center"
  | "centerProgram"
  | "fieldOverride"
  | "appointment"
>;

export type PendingTitleRequest = {
  /** The option string the requester asked for. */
  value: string;
  /** Who filed it — the scholar, or a proxy acting for them. */
  requestedBy: string;
  requestedAt: Date;
};

export type TitlePickerState = {
  /** Every tier, highest rank first; `value: null` marks one that does not
   *  apply. Rendered disabled rather than omitted so an operator can see WHY
   *  a tier did not win. */
  options: TitleOption[];
  /** What is displayed today (`Scholar.primaryTitle`). */
  current: string | null;
  /** The operator override, when one is pinned. `""` means explicitly
   *  un-pinned, which resolves to the derived default. */
  override: string | null;
  /** A pending request awaiting an operator decision. */
  pending: PendingTitleRequest | null;
};

/**
 * Build the picker state for one scholar.
 *
 * Deliberately per-scholar: `/edit` renders one profile at a time, so the
 * bulk-map shape the ETL post-pass uses would be wasted work here. The two
 * share `lib/scholar-title.ts`, which is what keeps the picker's options and
 * the ETL's resolution from disagreeing about precedence or formatting.
 */
export async function loadTitlePickerState(
  client: TitlePickerClient,
  cwid: string,
): Promise<TitlePickerState | null> {
  const scholar = await client.scholar.findUnique({
    where: { cwid },
    select: { primaryTitle: true, edPrimaryTitle: true, workingTitle: true },
  });
  if (!scholar) return null;

  const [assignments, overrideRows, institutionalCenters, appointmentTitles] = await Promise.all([
    client.orgUnitRoleAssignment.findMany({
      where: {
        cwid,
        entityType: { in: ["division", CENTER_ENTITY_TYPE] },
        role: { roleGroup: "leadership", profileTitle: true },
      },
      select: {
        entityType: true,
        entityId: true,
        interim: true,
        role: { select: { key: true, label: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { entityId: "asc" }],
    }),
    client.fieldOverride.findMany({
      where: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: { in: [TITLE_OVERRIDE_FIELD, TITLE_REQUEST_FIELD] },
      },
      select: { fieldName: true, value: true, actorCwid: true, updatedAt: true },
    }),
    loadInstitutionalCenterCodes(client),
    loadCurrentAppointmentTitles(client, [cwid]),
  ]);

  const divAssignment = assignments.find((a) => a.entityType === "division");
  // An institutional directorship outranks a unit-based one, so prefer it.
  const centerDirectorships = assignments.filter(
    (a) => a.entityType === CENTER_ENTITY_TYPE && isCenterDirector(a),
  );
  const centerAssignment =
    centerDirectorships.find((a) => institutionalCenters.has(a.entityId)) ?? centerDirectorships[0];

  let chiefTitle: string | null = null;
  if (divAssignment) {
    const division = await client.division.findUnique({
      where: { code: divAssignment.entityId },
      select: { name: true, department: { select: { name: true } } },
    });
    if (division) {
      // Ambiguity is a property of the whole division table, not of this
      // scholar — "Cardiology" is ambiguous even on a profile where only one
      // of the two divisions has a chief. Names only; cheap.
      const allDivisions = await client.division.findMany({ select: { name: true } });
      chiefTitle = formatUnitLeadershipTitle({
        roleLabel: divAssignment.role.label,
        interim: divAssignment.interim,
        unitName: division.name,
        parentName: division.department?.name ?? null,
        ambiguous: ambiguousUnitNames(allDivisions).has(division.name.trim().toLowerCase()),
      });
    }
  }

  let centerHeadTitle: string | null = null;
  if (centerAssignment) {
    const center = await client.center.findUnique({
      where: { code: centerAssignment.entityId },
      select: { name: true, officialName: true },
    });
    if (center) {
      centerHeadTitle = formatUnitLeadershipTitle({
        roleLabel: centerAssignment.role.label,
        interim: centerAssignment.interim,
        unitName: center.officialName ?? center.name,
      });
    }
  }

  const overrideRow = overrideRows.find((r) => r.fieldName === TITLE_OVERRIDE_FIELD);
  const requestRow = overrideRows.find((r) => r.fieldName === TITLE_REQUEST_FIELD);

  return {
    options: buildTitleOptions({
      workingTitle: scholar.workingTitle,
      appointmentTitles: appointmentTitles.get(cwid) ?? [],
      chiefTitle,
      centerHeadTitle,
      centerHeadInstitutional:
        centerAssignment !== undefined && institutionalCenters.has(centerAssignment.entityId),
      edPrimaryTitle: scholar.edPrimaryTitle,
    }),
    current: scholar.primaryTitle,
    override: overrideRow?.value ?? null,
    pending: requestRow
      ? {
          value: requestRow.value,
          requestedBy: requestRow.actorCwid,
          requestedAt: requestRow.updatedAt,
        }
      : null,
  };
}

/**
 * Is `value` one this scholar may actually be given?
 *
 * The empty string is accepted as "un-pin, fall back to the derived default".
 * Everything else must EQUAL one of the computed options — this is not free
 * text, and that is load-bearing: it is what keeps the picker from being the
 * upstream-scalar masking problem that made `slug` superuser-only, and it is
 * why the request path can be opened to scholars at all. Do not relax it to
 * "operators may type anything" without revisiting who may use it.
 */
export function isSelectableTitle(value: string, options: readonly TitleOption[]): boolean {
  if (value === "") return true;
  return options.some((o) => o.value !== null && o.value === value);
}

/**
 * What `Scholar.primaryTitle` should become given a (possibly new) override.
 * Used by the write path so a pick takes effect immediately rather than at the
 * next nightly; the ETL recomputes the same answer from the same module.
 */
export function resolveWithOverride(
  state: TitlePickerState,
  override: string | null,
): string | null {
  return resolveFromOptions(state.options, override).value;
}

// ponytail: pending requests are discoverable on the profile an operator is
// already looking at, which is enough for the ~49 scholars who have a working
// title at all. If a cross-scholar queue is ever wanted it is one findMany —
// `fieldOverride.findMany({ where: { entityType: "scholar", fieldName:
// TITLE_REQUEST_FIELD } })` — precisely because the pending state lives in a
// table rather than in somebody's inbox.
