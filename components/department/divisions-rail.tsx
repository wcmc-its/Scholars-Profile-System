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
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Divisions ({divisions.length})
      </div>
      <ScrollArea className="h-full">
        <ul className="flex flex-col">
          <li>
            <a
              href={`/departments/${deptSlug}`}
              className={`flex items-center justify-between rounded px-3 py-2 ${
                activeDivisionSlug === null
                  ? "bg-[#eaf0f5] text-[var(--color-accent-slate)]"
                  : "hover:bg-accent"
              }`}
            >
              <span className="text-sm font-medium">All scholars</span>
              <span className="text-sm text-muted-foreground">
                {totalScholars.toLocaleString()}
              </span>
            </a>
          </li>
          <li className="my-1 border-t border-border" />
          {divisions.map((d) => {
            const isActive = activeDivisionSlug === d.slug;
            return (
              <li key={d.code}>
                <a
                  href={`/departments/${deptSlug}/divisions/${d.slug}`}
                  className={`flex items-center justify-between rounded px-3 py-2 ${
                    isActive
                      ? "bg-[#eaf0f5] text-[var(--color-accent-slate)]"
                      : "hover:bg-accent"
                  }`}
                >
                  <span className="text-sm">{d.name}</span>
                  <span className="text-sm text-muted-foreground">
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
