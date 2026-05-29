"use client";

import { useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  type RoleCategory,
} from "@/components/department/role-chip-row";
import { PersonRow } from "@/components/department/person-row";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";
import type {
  CenterMemberGroup,
  CenterMembersResult,
} from "@/lib/api/centers";

export function CenterMembersClient({
  result,
  centerSlug,
}: {
  result: CenterMembersResult;
  centerSlug: string;
}) {
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");

  // The role-chip row counts over the full active roster regardless of layout.
  const allMembers = useMemo(
    () =>
      result.mode === "grouped"
        ? result.groups.flatMap((g) => g.members)
        : result.hits,
    [result],
  );

  if (allMembers.length === 0) {
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No members listed</h3>
        <p className="text-sm text-muted-foreground">
          Membership data for this center is not yet loaded.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <RoleChipRow
          faculty={allMembers}
          active={activeCategory}
          onChange={setActiveCategory}
        />
      </div>
      {result.mode === "grouped" ? (
        <GroupedMembers
          groups={result.groups}
          total={result.total}
          activeCategory={activeCategory}
        />
      ) : (
        <FlatMembers
          result={result}
          centerSlug={centerSlug}
          activeCategory={activeCategory}
        />
      )}
    </>
  );
}

/** Programmed center: all active members on one page, sectioned by program. */
function GroupedMembers({
  groups,
  total,
  activeCategory,
}: {
  groups: CenterMemberGroup[];
  total: number;
  activeCategory: RoleCategory;
}) {
  const filtered = groups
    .map((g) => ({
      label: g.label,
      members: filterByRoleCategory(g.members, activeCategory),
    }))
    .filter((g) => g.members.length > 0);

  return (
    <>
      <div className="mb-4 text-sm text-muted-foreground">
        {total.toLocaleString()} {total === 1 ? "member" : "members"}
      </div>
      <div className="flex flex-col gap-8">
        {filtered.map((g) => (
          <section key={g.label}>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {g.label}
            </h2>
            <div className="flex flex-col">
              {g.members.map((hit) => (
                <PersonRow key={hit.cwid} hit={hit} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

/** Unprogrammed center: flat list, paginated (today's behavior). */
function FlatMembers({
  result,
  centerSlug,
  activeCategory,
}: {
  result: Extract<CenterMembersResult, { mode: "flat" }>;
  centerSlug: string;
  activeCategory: RoleCategory;
}) {
  const { hits, total, page, pageSize } = result;
  const filtered = filterByRoleCategory(hits, activeCategory);

  const buildHref = (p: number) =>
    p === 1 ? `/centers/${centerSlug}` : `/centers/${centerSlug}?page=${p}`;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <>
      <div className="mb-4 text-sm text-muted-foreground">
        Showing {start}&ndash;{end} of {total.toLocaleString()} members
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
                      <PaginationLink href={buildHref(p)} isActive={p === page}>
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
