"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { DepartmentDivisionSummary } from "@/lib/api/departments";

export function DivisionsRail({
  deptSlug,
  divisions,
  activeDivisionSlug,
  totalScholars,
}: {
  deptSlug: string;
  divisions: DepartmentDivisionSummary[];
  activeDivisionSlug: string | null;
  totalScholars: number;
}) {
  // Don't render at all if dept has no divisions per UI-SPEC §6.8 absence-as-default.
  if (divisions.length === 0) return null;

  return (
    <aside className="w-full" aria-label="Divisions">
      <div className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        DIVISIONS
      </div>
      <ScrollArea className="h-full">
        <ul className="flex flex-col">
          <li>
            <a
              href={`/departments/${deptSlug}`}
              className={`flex items-center justify-between rounded px-3 py-2 ${
                activeDivisionSlug === null
                  ? "bg-[var(--color-accent-slate)] text-white"
                  : "hover:bg-accent"
              }`}
            >
              <span className="text-base">All scholars</span>
              <span
                className={`text-sm ${activeDivisionSlug === null ? "text-white" : "text-muted-foreground"}`}
              >
                {totalScholars.toLocaleString()}
              </span>
            </a>
          </li>
          {divisions.map((d) => {
            const isActive = activeDivisionSlug === d.slug;
            return (
              <li key={d.code}>
                <a
                  href={`/departments/${deptSlug}/divisions/${d.slug}`}
                  className={`flex items-center justify-between rounded px-3 py-2 ${
                    isActive
                      ? "bg-[var(--color-accent-slate)] text-white"
                      : "hover:bg-accent"
                  }`}
                >
                  <span className="text-base">{d.name}</span>
                  <span
                    className={`text-sm ${isActive ? "text-white" : "text-muted-foreground"}`}
                  >
                    {d.scholarCount.toLocaleString()}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
