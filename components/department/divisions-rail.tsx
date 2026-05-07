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

  // Active state per neurology_dept_body_per_spec.html: cornell-red text on
  // a soft red wash (#fbeded). Replaces the prior slate-on-pale-blue treatment.
  const activeBg = "#fbeded";
  const activeText = "var(--color-primary-cornell-red)";

  return (
    <aside className="w-full" aria-label="Divisions">
      <div className="px-[10px] pb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Divisions
      </div>
      <ScrollArea className="h-full">
        <ul className="flex flex-col">
          <li>
            <a
              href={`/departments/${deptSlug}`}
              className="flex items-center justify-between gap-2 rounded-md px-[10px] py-2 text-[13px] leading-[1.3]"
              style={
                activeDivisionSlug === null
                  ? { backgroundColor: activeBg, color: activeText, fontWeight: 500 }
                  : undefined
              }
            >
              <span>All scholars</span>
              <span
                className="shrink-0 text-[12px]"
                style={{
                  color:
                    activeDivisionSlug === null
                      ? activeText
                      : "var(--color-text-tertiary)",
                }}
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
                  className="flex items-center justify-between gap-2 rounded-md px-[10px] py-2 text-[13px] leading-[1.3]"
                  style={
                    isActive
                      ? {
                          backgroundColor: activeBg,
                          color: activeText,
                          fontWeight: 500,
                        }
                      : undefined
                  }
                >
                  <span>{d.name}</span>
                  <span
                    className="shrink-0 text-[12px]"
                    style={{
                      color: isActive ? activeText : "var(--color-text-tertiary)",
                    }}
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
