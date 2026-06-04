/**
 * The `/edit/units` index body (#753) — "Units you manage". Lists the actor's
 * directly-granted org units grouped by kind, each linking to its existing
 * editor page, and surfaces the create affordances appropriate to the actor.
 *
 * Server component (no interactivity of its own); it embeds the client
 * `UnitFinder` for the superuser "jump to any unit" case. Create affordances
 * mirror `/edit/unit/new`'s own authorization:
 *   - Superuser → a "Create a unit" button (the form's mode toggle covers both
 *     a coded division and an informal center).
 *   - Department Owner → a per-row "Add a center" link carrying that department
 *     as the parent (`?type=center&dept=`); never a dead end — when the
 *     superuser-only lockdown is on, that route renders the request affordance.
 * Curators and center/division owners get no create link (they cannot create).
 */
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { UnitFinder } from "@/components/edit/unit-finder";
import {
  unitKindLabel,
  type ManageableUnit,
  type ManageableUnits,
  type UnitFinderEntry,
} from "@/lib/edit/manageable-units";

export type ManageableUnitsIndexProps = {
  units: ManageableUnits;
  isSuperuser: boolean;
  /** Every unit, for the superuser finder; empty for non-superusers. */
  finderUnits: ReadonlyArray<UnitFinderEntry>;
};

export function ManageableUnitsIndex({
  units,
  isSuperuser,
  finderUnits,
}: ManageableUnitsIndexProps) {
  const hasGrants = units.total > 0;

  return (
    <div className="flex flex-col gap-8" data-slot="manageable-units-index">
      {isSuperuser && (
        <section
          className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-xl border p-5"
          data-testid="units-superuser-tools"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold">Jump to any unit</h2>
              <p className="text-muted-foreground text-sm">
                As a superuser you can edit every department, division, and center.
              </p>
            </div>
            <Button asChild variant="apollo" size="sm">
              <Link href="/edit/unit/new" data-testid="units-create">
                <Plus className="size-4" aria-hidden />
                Create a unit
              </Link>
            </Button>
          </div>
          <UnitFinder units={finderUnits} />
        </section>
      )}

      {hasGrants ? (
        <>
          <UnitGroup title="Departments" units={units.departments} showAddCenter={!isSuperuser} />
          <UnitGroup title="Divisions" units={units.divisions} showAddCenter={false} />
          <UnitGroup title="Centers" units={units.centers} showAddCenter={false} />
        </>
      ) : (
        !isSuperuser && <EmptyState />
      )}
    </div>
  );
}

function UnitGroup({
  title,
  units,
  showAddCenter,
}: {
  title: string;
  units: ManageableUnit[];
  /** Render the Owner-only "Add a center" link on department rows. */
  showAddCenter: boolean;
}) {
  if (units.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid={`units-group-${title.toLowerCase()}`}>
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{title}</p>
      <ul className="flex flex-col gap-2">
        {units.map((unit) => (
          <UnitRow key={`${unit.kind}:${unit.code}`} unit={unit} showAddCenter={showAddCenter} />
        ))}
      </ul>
    </section>
  );
}

function UnitRow({ unit, showAddCenter }: { unit: ManageableUnit; showAddCenter: boolean }) {
  const canAddCenter = showAddCenter && unit.kind === "department" && unit.role === "owner";
  return (
    <li
      data-testid={`units-row-${unit.kind}-${unit.code}`}
      className="border-apollo-border bg-apollo-surface flex items-center gap-3 rounded-xl border px-4 py-3.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{unit.name}</span>
          <RoleTag role={unit.role} />
        </div>
        <div className="text-muted-foreground text-sm">
          {unitKindLabel(unit.kind)} · {unit.code}
        </div>
      </div>
      <div className="flex flex-none items-center gap-4">
        {canAddCenter && (
          <Link
            href={`/edit/unit/new?type=center&dept=${encodeURIComponent(unit.code)}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm whitespace-nowrap"
            data-testid={`units-add-center-${unit.code}`}
          >
            <Plus className="size-3.5" aria-hidden />
            Add a center
          </Link>
        )}
        <Link
          href={unit.href}
          className="text-apollo-slate inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap"
          data-testid={`units-edit-${unit.kind}-${unit.code}`}
        >
          Edit
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}

function RoleTag({ role }: { role: "owner" | "curator" }) {
  return (
    <span className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border flex-none rounded-full border px-2 py-0.5 text-xs font-medium capitalize">
      {role}
    </span>
  );
}

function EmptyState() {
  return (
    <section
      className="border-apollo-border bg-apollo-surface rounded-xl border px-5 py-8 text-center"
      data-testid="units-empty"
    >
      <p className="text-[15px] font-semibold">You don&apos;t manage any units</p>
      <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
        Unit curation is granted per department, division, or center. If you believe you should be
        able to edit one, contact ITS Support.
      </p>
    </section>
  );
}
