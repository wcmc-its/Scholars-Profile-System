"use client";

import { useMemo } from "react";

export type RoleCategory =
  | "All"
  | "Full-time faculty"
  | "Affiliated faculty"
  | "Postdocs & non-faculty"
  | "Doctoral students";

const ROLE_GROUPS: {
  label: RoleCategory;
  matches: (role: string | null) => boolean;
}[] = [
  { label: "All", matches: () => true },
  {
    label: "Full-time faculty",
    matches: (r) => r === "Full-time faculty",
  },
  {
    label: "Affiliated faculty",
    matches: (r) =>
      r === "Affiliated faculty" ||
      r === "Voluntary faculty" ||
      r === "Adjunct faculty" ||
      r === "Courtesy faculty" ||
      r === "Faculty emeritus",
  },
  {
    label: "Postdocs & non-faculty",
    matches: (r) =>
      r === "Postdoc" ||
      r === "Fellow" ||
      r === "Research staff" ||
      r === "Instructor" ||
      r === "Lecturer",
  },
  { label: "Doctoral students", matches: (r) => r === "Doctoral student" },
];

export function RoleChipRow({
  faculty,
  active,
  onChange,
}: {
  faculty: Array<{ roleCategory: string | null }>;
  active: RoleCategory;
  onChange: (cat: RoleCategory) => void;
}) {
  const counts = useMemo(() => {
    const byGroup = new Map<RoleCategory, number>();
    for (const group of ROLE_GROUPS) {
      const c =
        group.label === "All"
          ? faculty.length
          : faculty.filter((f) => group.matches(f.roleCategory)).length;
      byGroup.set(group.label, c);
    }
    return byGroup;
  }, [faculty]);

  return (
    <div className="flex flex-wrap gap-2 sm:flex-nowrap sm:overflow-x-auto">
      {ROLE_GROUPS.map((g) => {
        const count = counts.get(g.label) ?? 0;
        // Omit chips with 0 count except "All" which is always shown.
        if (g.label !== "All" && count === 0) return null;
        const isActive = g.label === active;
        return (
          <button
            key={g.label}
            type="button"
            onClick={() => onChange(g.label)}
            className={`rounded-full border px-3 py-1 text-sm ${
              isActive
                ? "border-transparent bg-[var(--color-accent-slate)] text-white"
                : "border-border bg-white text-foreground hover:bg-accent"
            }`}
          >
            <span>{g.label}</span>
            <span
              className={`ml-2 ${isActive ? "text-white" : "text-muted-foreground"}`}
            >
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
