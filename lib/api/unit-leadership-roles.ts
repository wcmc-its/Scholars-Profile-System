/**
 * Server side of the `/edit` Vice Chair card: load a department's rows and
 * validate a write. The vocabulary and the view type live in the import-free
 * `lib/unit-leadership.ts`.
 */
import { isPublicLeader } from "@/lib/eligibility";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  LEADERSHIP_FUNCTIONS,
  LEADERSHIP_SITES,
  LEADERSHIP_TIERS,
  isFullTimeFaculty,
  parseFunctions,
  parseLeadershipTitle,
  serializeFunctions,
  sortLeadershipRoles,
  type LeadershipFunction,
  type LeadershipSite,
  type LeadershipTier,
  type UnitLeadershipRoleView,
} from "@/lib/unit-leadership";

export const LEADERSHIP_ENTITY_TYPE = "department";

const HOLDER_SELECT = {
  preferredName: true,
  primaryTitle: true,
  edPrimaryTitle: true,
  roleCategory: true,
  deletedAt: true,
  status: true,
} as const;

type RowWithHolder = {
  id: string;
  cwid: string;
  displayTitle: string;
  tier: string;
  functions: string;
  areaText: string | null;
  site: string | null;
  startDate: Date | null;
  source: string;
  sourceUrl: string | null;
  note: string | null;
  scholar: {
    preferredName: string;
    primaryTitle: string | null;
    edPrimaryTitle: string | null;
    roleCategory: string | null;
  };
};

export function toLeadershipRoleView(row: RowWithHolder): UnitLeadershipRoleView {
  return {
    id: row.id,
    cwid: row.cwid,
    name: row.scholar.preferredName,
    title: row.scholar.primaryTitle,
    fullTimeFaculty: isFullTimeFaculty(row.scholar.roleCategory, row.scholar.primaryTitle, row.scholar.edPrimaryTitle),
    displayTitle: row.displayTitle,
    tier: row.tier as LeadershipTier,
    functions: parseFunctions(row.functions),
    areaText: row.areaText,
    site: row.site as LeadershipSite | null,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    source: row.source,
    sourceUrl: row.sourceUrl,
    note: row.note,
  };
}

/**
 * A department's Vice Chairs, tier order. A holder who has left WCM (deleted
 * or no longer active) is left out, so a departure needs no cleanup job.
 */
export async function loadUnitLeadershipRoles(
  departmentCode: string,
  client: Pick<PrismaClient, "unitLeadershipRole">,
): Promise<UnitLeadershipRoleView[]> {
  const rows = await client.unitLeadershipRole.findMany({
    where: { entityType: LEADERSHIP_ENTITY_TYPE, entityId: departmentCode },
    include: { scholar: { select: HOLDER_SELECT } },
  });
  return sortLeadershipRoles(
    rows.filter((r) => r.scholar.deletedAt === null && r.scholar.status === "active").map(toLeadershipRoleView),
  );
}

export { HOLDER_SELECT as LEADERSHIP_HOLDER_SELECT };

export type LeadershipRoleFields = {
  displayTitle: string;
  tier: LeadershipTier;
  /** Column form: comma-joined, vocabulary order. */
  functions: string;
  areaText: string | null;
  site: LeadershipSite | null;
  startDate: Date | null;
  note: string | null;
};

const text = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > max ? undefined : t || null;
};

/**
 * Validate the editable fields of an add / update body. Returns the fields, or
 * `{ error, field }` for the first problem. Pure.
 */
export function validateLeadershipFields(
  body: Record<string, unknown>,
): { ok: true; fields: LeadershipRoleFields } | { ok: false; error: string; field: string } {
  const bad = (error: string, field: string) => ({ ok: false as const, error, field });

  const displayTitle = text(body.displayTitle, 255);
  if (!displayTitle) return bad("invalid_value", "displayTitle");

  if (typeof body.tier !== "string" || !(LEADERSHIP_TIERS as readonly string[]).includes(body.tier)) {
    return bad("invalid_value", "tier");
  }
  const tier = body.tier as LeadershipTier;

  const rawFunctions = body.functions ?? [];
  if (
    !Array.isArray(rawFunctions) ||
    rawFunctions.some((f) => !(LEADERSHIP_FUNCTIONS as readonly unknown[]).includes(f))
  ) {
    return bad("invalid_value", "functions");
  }
  const functions = rawFunctions as LeadershipFunction[];

  const areaText = text(body.areaText, 255);
  if (areaText === undefined) return bad("invalid_value", "areaText");
  if (functions.includes("clinical_area") && !areaText) return bad("area_text_required", "areaText");

  // A title that names an area must carry at least one function code.
  if (functions.length === 0 && parseLeadershipTitle(displayTitle).some((p) => p.functions.length > 0)) {
    return bad("area_unmapped", "functions");
  }

  let site: LeadershipSite | null = null;
  if (body.site !== undefined && body.site !== null && body.site !== "") {
    if (!(LEADERSHIP_SITES as readonly unknown[]).includes(body.site)) return bad("invalid_value", "site");
    site = body.site as LeadershipSite;
  }

  let startDate: Date | null = null;
  if (body.startDate !== undefined && body.startDate !== null && body.startDate !== "") {
    if (typeof body.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      return bad("invalid_value", "startDate");
    }
    startDate = new Date(`${body.startDate}T00:00:00.000Z`);
    if (Number.isNaN(startDate.getTime())) return bad("invalid_value", "startDate");
  }

  const note = text(body.note, 512);
  if (note === undefined) return bad("invalid_value", "note");

  return {
    ok: true,
    fields: { displayTitle, tier, functions: serializeFunctions(functions), areaText, site, startDate, note },
  };
}

/** One Vice Chair as the PUBLIC department page lists it. */
export type PublicViceChair = {
  cwid: string;
  preferredName: string;
  slug: string;
  /** The published title, verbatim. */
  displayTitle: string;
  tier: LeadershipTier;
  site: LeadershipSite | null;
};

/**
 * A department's Vice Chairs for its public page: tier order, then name. A
 * holder who is not publicly displayed (hidden identity class, soft-deleted or
 * inactive — the `isPublicLeader` rule the chair card uses) is left out.
 */
export async function loadPublicViceChairs(
  departmentCode: string,
  client: Pick<PrismaClient, "unitLeadershipRole">,
): Promise<PublicViceChair[]> {
  const rows = await client.unitLeadershipRole.findMany({
    where: { entityType: LEADERSHIP_ENTITY_TYPE, entityId: departmentCode },
    select: {
      cwid: true,
      displayTitle: true,
      tier: true,
      site: true,
      scholar: {
        select: { preferredName: true, slug: true, roleCategory: true, deletedAt: true, status: true },
      },
    },
  });
  return rows
    .filter((r) => isPublicLeader(r.scholar))
    .map((r) => ({
      cwid: r.cwid,
      preferredName: r.scholar.preferredName,
      slug: r.scholar.slug,
      displayTitle: r.displayTitle,
      tier: r.tier as LeadershipTier,
      site: r.site as LeadershipSite | null,
    }))
    .sort(
      (a, b) =>
        LEADERSHIP_TIERS.indexOf(a.tier) - LEADERSHIP_TIERS.indexOf(b.tier) ||
        a.preferredName.localeCompare(b.preferredName),
    );
}

/**
 * The profile title line for a Vice Chair role: the published title followed
 * by the department, unless the title already names it ("Vice Chair, Weill
 * Department of Medicine" / "Vice Chair of Ophthalmology").
 */
export function viceChairTitleLine(displayTitle: string, unitName: string, unitShortName?: string): string {
  const t = displayTitle.toLowerCase();
  const namesUnit =
    t.includes("department") ||
    t.includes(unitName.toLowerCase()) ||
    (unitShortName !== undefined && t.includes(unitShortName.toLowerCase()));
  return namesUnit ? displayTitle : `${displayTitle}, ${unitName}`;
}

/**
 * A scholar's Vice Chair title lines for their profile, tier order. Rows with
 * `showOnProfile = false` are left out (they still show on the department
 * page). A row whose department vanished contributes nothing.
 */
export async function loadProfileViceChairTitles(
  cwid: string,
  client: Pick<PrismaClient, "unitLeadershipRole" | "department">,
): Promise<string[]> {
  const rows = await client.unitLeadershipRole.findMany({
    where: { cwid, entityType: LEADERSHIP_ENTITY_TYPE, showOnProfile: true },
    select: { entityId: true, displayTitle: true, tier: true },
  });
  if (rows.length === 0) return [];
  const depts = await client.department.findMany({
    where: { code: { in: rows.map((r) => r.entityId) } },
    select: { code: true, name: true, officialName: true },
  });
  const byCode = new Map(depts.map((d) => [d.code, d]));
  return [...rows]
    .sort(
      (a, b) =>
        LEADERSHIP_TIERS.indexOf(a.tier as LeadershipTier) - LEADERSHIP_TIERS.indexOf(b.tier as LeadershipTier) ||
        a.displayTitle.localeCompare(b.displayTitle),
    )
    .flatMap((r) => {
      const d = byCode.get(r.entityId);
      return d ? [viceChairTitleLine(r.displayTitle, d.officialName ?? d.name, d.name)] : [];
    });
}
