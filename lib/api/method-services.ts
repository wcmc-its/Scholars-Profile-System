/**
 * Method services (`method_service`): the server-side reads behind the Method
 * services section of `/edit/department/[code]` and `/edit/core/[coreId]`, and
 * the family check `/api/edit/method-service` runs before a write.
 *
 * Imports `@/lib/db` at module scope, so a client component may import only
 * TYPES from here, never a value. The types and pure validation live in
 * `lib/method-services/validation.ts`.
 */
import { isFamilyPubliclyVisible, loadFamilyOverlayGate } from "@/lib/api/methods-overlay";
import { db } from "@/lib/db";
import {
  isMethodServiceEntityType,
  methodFamilyKey,
  type MethodServiceEntityType,
  type MethodServiceFamily,
  type MethodServiceView,
} from "@/lib/method-services/validation";

/** The columns a view is built from. */
export const METHOD_SERVICE_SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  name: true,
  url: true,
  families: true,
  supportedPmids: true,
  excludedPmids: true,
  countStaffPapers: true,
  affiliationPhrases: true,
  coauthoredPmids: true,
  affiliationCheckedPmids: true,
} as const;

export type MethodServiceRow = {
  id: number;
  entityType: string;
  entityId: string;
  name: string;
  url: string;
  families: unknown;
  supportedPmids: unknown;
  excludedPmids: unknown;
  countStaffPapers: boolean;
  affiliationPhrases: unknown;
  coauthoredPmids: unknown;
  /** Server-only bookkeeping, not part of the view: see
   *  {@link affiliationCheckedPmidsOf}. Absent on a row read without it. */
  affiliationCheckedPmids?: unknown;
};

function familiesOf(value: unknown): MethodServiceFamily[] {
  if (!Array.isArray(value)) return [];
  const out: MethodServiceFamily[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { supercategory, familyLabel } = item as Record<string, unknown>;
    if (typeof supercategory === "string" && typeof familyLabel === "string") {
      out.push({ supercategory, familyLabel });
    }
  }
  return out;
}

/** A stored JSON list of strings (PMIDs, affiliation phrases). */
function pmidsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The supported PMIDs whose author affiliations PubMed has already been
 *  asked about, against the row's current phrases. The save route's own: it is
 *  what lets a long list be read from PubMed over several saves. */
export function affiliationCheckedPmidsOf(row: MethodServiceRow): string[] {
  return pmidsOf(row.affiliationCheckedPmids);
}

/** A stored row as the editor shows it. The JSON columns are read defensively:
 *  the route validates every write, but a view never throws on a bad one.
 *  `null` for a row whose owner is not a unit kind that may hold a service. */
export function toMethodServiceView(row: MethodServiceRow): MethodServiceView | null {
  if (!isMethodServiceEntityType(row.entityType)) return null;
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    name: row.name,
    url: row.url,
    families: familiesOf(row.families),
    supportedPmids: pmidsOf(row.supportedPmids),
    excludedPmids: pmidsOf(row.excludedPmids),
    countStaffPapers: row.countStaffPapers,
    affiliationPhrases: pmidsOf(row.affiliationPhrases),
    coauthoredPmids: pmidsOf(row.coauthoredPmids),
  };
}

/** A unit's services, by name. */
export async function loadMethodServicesForUnit(
  entityType: MethodServiceEntityType,
  entityId: string,
): Promise<MethodServiceView[]> {
  const rows = await db.read.methodService.findMany({
    where: { entityType, entityId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: METHOD_SERVICE_SELECT,
  });
  return rows.flatMap((r) => toMethodServiceView(r) ?? []);
}

/**
 * The families in `families` that a service may NOT be attached to: not a
 * family at all, or one with no public page. The same two facts a method page
 * resolves on (`getFamily`, `lib/api/methods.ts`): a `scholar_family` row for
 * the exact `(supercategory, familyLabel)`, and the shared suppression and
 * sensitivity overlay gate. The comparison is exact in JS, since the column's
 * collation would otherwise accept a label in the wrong case and store it.
 */
export async function findNonPublicFamilies(
  families: ReadonlyArray<MethodServiceFamily>,
): Promise<MethodServiceFamily[]> {
  if (families.length === 0) return [];
  const [groups, gate] = await Promise.all([
    db.read.scholarFamily.groupBy({
      by: ["supercategory", "familyLabel"],
      where: {
        OR: families.map((f) => ({ supercategory: f.supercategory, familyLabel: f.familyLabel })),
      },
    }),
    loadFamilyOverlayGate(),
  ]);
  const real = new Set(groups.map(methodFamilyKey));
  return families.filter(
    (f) =>
      !real.has(methodFamilyKey(f)) || !isFamilyPubliclyVisible(f.supercategory, f.familyLabel, gate),
  );
}
