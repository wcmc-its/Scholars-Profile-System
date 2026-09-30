/**
 * `/edit/units?kind=` — the unit editor breadcrumb's "{Kind plural}" crumb
 * (`EditShell`) links here to list only that kind. Pure (type-only imports),
 * so it is safe from both the page and client-bundled code.
 */
import type { ManageableUnits, UnitPageKind } from "@/lib/edit/manageable-units";

const KINDS: ReadonlyArray<UnitPageKind> = ["department", "division", "center", "core"];

/** Lowercase plural for the "Showing centers" line. */
export const UNIT_KIND_PLURAL_LOWER: Record<UnitPageKind, string> = {
  department: "departments",
  division: "divisions",
  center: "centers",
  core: "cores",
};

/** A `?kind=` value → a unit page kind; anything else (absent, repeated,
 *  unknown) → null, i.e. no filter. */
export function parseUnitKindParam(value: string | string[] | undefined): UnitPageKind | null {
  return typeof value === "string" && (KINDS as ReadonlyArray<string>).includes(value)
    ? (value as UnitPageKind)
    : null;
}

/** The actor's grants narrowed to one kind (every other group emptied). */
export function filterManageableUnitsByKind(
  units: ManageableUnits,
  kind: UnitPageKind,
): ManageableUnits {
  const keep = {
    departments: kind === "department" ? units.departments : [],
    divisions: kind === "division" ? units.divisions : [],
    centers: kind === "center" ? units.centers : [],
    cores: kind === "core" ? units.cores : [],
    institutions: [],
  };
  return {
    ...keep,
    total:
      keep.departments.length + keep.divisions.length + keep.centers.length + keep.cores.length,
  };
}
