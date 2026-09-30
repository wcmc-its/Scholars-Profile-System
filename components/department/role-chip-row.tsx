"use client";

import { useMemo } from "react";
import {
  ROLE_GROUPS as ROLE_GROUP_DEFS,
  ROLE_CATEGORIES as ROLE_GROUP_LABELS,
  groupMatchesDisplay,
  type RoleGroupLabel,
} from "@/lib/role-groups";

// #2537 — re-exported (not re-declared) so existing importers of `RoleCategory`
// keep resolving; the label set now lives in lib/role-groups.ts, the single
// source of truth shared with the server-side `?type=` filter.
export type RoleCategory = RoleGroupLabel;

const ROLE_GROUPS: {
  label: RoleCategory;
  matches: (role: string | null) => boolean;
}[] = ROLE_GROUP_DEFS.map((g) => ({
  label: g.label,
  matches: (r: string | null) => groupMatchesDisplay(g.label, r),
}));

// Consumed by department-faculty-client.tsx to validate a `?type=` deep-link
// param against the known chip labels.
export const ROLE_CATEGORIES: RoleCategory[] = ROLE_GROUP_LABELS;

export function RoleChipRow({
  faculty,
  roleCategoryCounts,
  totalCount,
  active,
  onChange,
}: {
  faculty: Array<{ roleCategory: string | null }>;
  /**
   * Whole-scope counts keyed by normalized role-category label. When
   * provided, chip counts reflect the full dataset (not just the visible
   * page). Falls back to per-page count when undefined for backward
   * compatibility. (#17)
   */
  roleCategoryCounts?: Record<string, number>;
  /** Whole-scope total used for the "All" chip. */
  totalCount?: number;
  active: RoleCategory;
  onChange: (cat: RoleCategory) => void;
}) {
  const counts = useMemo(() => {
    const byGroup = new Map<RoleCategory, number>();
    const useWholeScope = roleCategoryCounts !== undefined;
    for (const group of ROLE_GROUPS) {
      let c: number;
      if (group.label === "All") {
        c = useWholeScope ? totalCount ?? 0 : faculty.length;
      } else if (useWholeScope) {
        c = Object.entries(roleCategoryCounts).reduce(
          (acc, [label, n]) => (group.matches(label) ? acc + n : acc),
          0,
        );
      } else {
        c = faculty.filter((f) => group.matches(f.roleCategory)).length;
      }
      byGroup.set(group.label, c);
    }
    return byGroup;
  }, [faculty, roleCategoryCounts, totalCount]);

  // Unit Page v2 — "APPOINTMENT" label + 28px pills. Active: slate fill, white
  // text, count at 0.85 opacity. Inactive: strong-border white pill, muted
  // count, surface-2 hover. `aria-pressed` carries the toggle state.
  return (
    <div role="group" aria-label="Appointment" className="flex flex-wrap items-center gap-2">
      <span className="mr-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Appointment
      </span>
      {ROLE_GROUPS.map((g) => {
        const count = counts.get(g.label) ?? 0;
        // Omit chips with 0 count except "All" which is always shown.
        if (g.label !== "All" && count === 0) return null;
        const isActive = g.label === active;
        return (
          <button
            key={g.label}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(g.label)}
            className={`inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-full border px-3 text-[13.5px] leading-none transition-colors duration-[120ms] ease-out ${
              isActive
                ? "border-apollo-slate bg-apollo-slate text-white"
                : "border-apollo-border-strong bg-white text-foreground hover:bg-apollo-surface-2"
            }`}
          >
            <span>{g.label}</span>
            <span className={isActive ? "opacity-85" : "text-muted-foreground"}>
              {count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Helper consumed by department-faculty-client.tsx to filter the in-memory faculty list:
export function filterByRoleCategory<T extends { roleCategory: string | null }>(
  faculty: T[],
  cat: RoleCategory,
): T[] {
  const group = ROLE_GROUPS.find((g) => g.label === cat);
  if (!group) return faculty;
  return faculty.filter((f) => group.matches(f.roleCategory));
}
