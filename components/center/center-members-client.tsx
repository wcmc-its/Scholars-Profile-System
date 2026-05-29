"use client";

import { useEffect, useMemo, useState } from "react";
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
  if (result.mode === "grouped") {
    return <GroupedRoster groups={result.groups} total={result.total} />;
  }
  return <FlatMembers result={result} centerSlug={centerSlug} />;
}

type IndexedGroup = CenterMemberGroup & { id: string };

/**
 * Programmed center: a sticky two-row sub-nav (PROGRAM = scroll-spy jump list,
 * APPOINTMENT = faculty-type filter) over anchored program sections, all
 * active members rendered (no pagination — #552 §6.2 "grouped = single page").
 * The APPOINTMENT filter reshapes the program sections + their chip counts
 * (empty sections drop out); the PROGRAM row only navigates.
 */
function GroupedRoster({
  groups,
  total,
}: {
  groups: CenterMemberGroup[];
  total: number;
}) {
  const [appointment, setAppointment] = useState<RoleCategory>("All");

  // Stable per-group anchor ids (kept across appointment filtering so the
  // scroll-spy + jump targets don't shift).
  const indexed = useMemo<IndexedGroup[]>(
    () => groups.map((g, i) => ({ ...g, id: `center-prog-${i}` })),
    [groups],
  );
  const allMembers = useMemo(
    () => groups.flatMap((g) => g.members),
    [groups],
  );

  // Reshape by appointment: filter each section, drop the now-empty ones.
  const sections = useMemo(
    () =>
      indexed
        .map((g) => ({
          ...g,
          members: filterByRoleCategory(g.members, appointment),
        }))
        .filter((g) => g.members.length > 0),
    [indexed, appointment],
  );

  // The PROGRAM nav only earns its keep when there are ≥2 sections to jump
  // between; presence is based on the unfiltered grouping so it doesn't blink
  // in and out as the appointment filter narrows things.
  const showProgramNav = indexed.length >= 2;

  const [activeId, setActiveId] = useState<string | null>(null);
  const sectionKey = sections.map((s) => s.id).join("|");

  // Scroll-spy: highlight the program chip for the section currently under the
  // sticky nav. Mirrors the mockup's offsetTop walk; rAF-throttled.
  useEffect(() => {
    if (!showProgramNav) return;
    const ids = sectionKey ? sectionKey.split("|") : [];
    if (ids.length === 0) return;
    setActiveId((prev) => (prev && ids.includes(prev) ? prev : ids[0]));

    let frame = 0;
    const STICKY_OFFSET = 180; // global header (60) + sticky sub-nav (~120)
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY + STICKY_OFFSET;
        let current = ids[0];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top + window.scrollY <= y) {
            current = id;
          }
        }
        setActiveId(current);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [showProgramNav, sectionKey]);

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  };

  const navLabel =
    "min-w-[72px] shrink-0 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground";

  return (
    <>
      {showProgramNav ? (
        <div className="sticky top-[60px] z-30 -mx-6 border-b border-border bg-background px-6 py-3">
          <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
            <span className={navLabel}>Program</span>
            {sections.map((g) => {
              const isActive = g.id === activeId;
              const isOther = g.label === "Other";
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => jumpTo(g.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] ${
                    isActive
                      ? "border-border bg-card font-medium text-foreground shadow-xs"
                      : "border-border/60 bg-transparent text-muted-foreground hover:bg-accent"
                  } ${isOther ? "italic" : ""}`}
                >
                  {g.label}
                  <span className="text-[11px] text-muted-foreground">
                    {g.members.length}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
            <span className={navLabel}>Appointment</span>
            <RoleChipRow
              faculty={allMembers}
              active={appointment}
              onChange={setAppointment}
            />
          </div>
        </div>
      ) : (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className={navLabel}>Appointment</span>
          <RoleChipRow
            faculty={allMembers}
            active={appointment}
            onChange={setAppointment}
          />
        </div>
      )}

      <div className={`flex flex-col gap-8 ${showProgramNav ? "mt-6" : ""}`}>
        {sections.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No members match this appointment filter.
          </p>
        ) : (
          sections.map((g) => (
            <section key={g.id} id={g.id} className="scroll-mt-40">
              <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2">
                <h2 className="text-[12px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {g.label}
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {g.members.length} {g.members.length === 1 ? "member" : "members"}
                </span>
              </div>
              <div className="flex flex-col">
                {g.members.map((hit) => (
                  <PersonRow key={hit.cwid} hit={hit} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {sections.reduce((n, g) => n + g.members.length, 0)} of {total} members
        shown
      </p>
    </>
  );
}

/** Unprogrammed center: flat list, paginated (today's behavior). */
function FlatMembers({
  result,
  centerSlug,
}: {
  result: Extract<CenterMembersResult, { mode: "flat" }>;
  centerSlug: string;
}) {
  const { hits, total, page, pageSize } = result;
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");
  const filtered = filterByRoleCategory(hits, activeCategory);

  const buildHref = (p: number) =>
    p === 1 ? `/centers/${centerSlug}` : `/centers/${centerSlug}?page=${p}`;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (hits.length === 0) {
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No members listed</h3>
        <p className="text-sm text-muted-foreground">
          Membership data for this center is not yet loaded.
        </p>
      </div>
    );
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <>
      <div className="mb-4 text-sm text-muted-foreground">
        Showing {start}&ndash;{end} of {total.toLocaleString()} members
      </div>
      <div className="mb-6">
        <RoleChipRow
          faculty={hits}
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
