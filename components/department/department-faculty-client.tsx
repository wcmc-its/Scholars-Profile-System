"use client";

import { useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  type RoleCategory,
} from "@/components/department/role-chip-row";
import { PersonRow } from "@/components/department/person-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

export function DepartmentFacultyClient({
  faculty,
  total,
  page,
  pageSize,
  deptSlug,
  divisionSlug,
}: {
  faculty: DepartmentFacultyHit[];
  total: number;
  page: number;
  pageSize: number;
  deptSlug: string;
  divisionSlug: string | null;
}) {
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");
  const [sortOrder, setSortOrder] = useState<"name-asc" | "name-desc">("name-asc");

  const filtered = useMemo(() => {
    const base = filterByRoleCategory(faculty, activeCategory);
    return sortOrder === "name-desc"
      ? [...base].sort((a, b) => b.preferredName.localeCompare(a.preferredName))
      : base;
  }, [faculty, activeCategory, sortOrder]);

  // Pagination URL builder — preserves division path; appends ?page=
  const buildHref = (p: number) => {
    const base = divisionSlug
      ? `/departments/${deptSlug}/divisions/${divisionSlug}`
      : `/departments/${deptSlug}`;
    return p === 1 ? base : `${base}?page=${p}`;
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (faculty.length === 0) {
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No faculty listed</h3>
        <p className="text-sm text-muted-foreground">
          {divisionSlug
            ? "Faculty in this division will appear after the next ETL refresh."
            : "Faculty in this department will appear after the next ETL refresh."}
        </p>
      </div>
    );
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const scholarsLabel = total === 1 ? "scholar" : "scholars";

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">
          Showing {start}–{end} of {total.toLocaleString()} {scholarsLabel}
        </span>
        <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as typeof sortOrder)}>
          <SelectTrigger className="h-8 w-[160px] text-sm">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name-asc">Name A–Z</SelectItem>
            <SelectItem value="name-desc">Name Z–A</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mb-6">
        <RoleChipRow
          faculty={faculty}
          active={activeCategory}
          onChange={setActiveCategory}
        />
      </div>
      <div className="flex flex-col">
        {filtered.map((hit) => (
          <PersonRow key={hit.cwid} hit={hit} />
        ))}
      </div>
      {totalPages > 1 && (
        <div className="mt-8">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href={buildHref(Math.max(1, page - 1))}
                  aria-disabled={page <= 1}
                />
              </PaginationItem>
              {/* Windowed pagination: ≤6 numbered, ≥7 ellipsis */}
              {(() => {
                const pages: (number | "ellipsis")[] = [];
                if (totalPages <= 6) {
                  for (let i = 1; i <= totalPages; i++) pages.push(i);
                } else {
                  const win: number[] = [];
                  for (
                    let i = Math.max(2, page - 2);
                    i <= Math.min(totalPages - 1, page + 2);
                    i++
                  )
                    win.push(i);
                  pages.push(1);
                  if (win[0] > 2) pages.push("ellipsis");
                  win.forEach((p) => pages.push(p));
                  if (win[win.length - 1] < totalPages - 1)
                    pages.push("ellipsis");
                  pages.push(totalPages);
                }
                return pages.map((p, i) =>
                  p === "ellipsis" ? (
                    <PaginationItem key={`e${i}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={p}>
                      <PaginationLink
                        href={buildHref(p)}
                        isActive={p === page}
                      >
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                );
              })()}
              <PaginationItem>
                <PaginationNext
                  href={buildHref(Math.min(totalPages, page + 1))}
                  aria-disabled={page >= totalPages}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </>
  );
}
