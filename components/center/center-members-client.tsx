"use client";

import { useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  type RoleCategory,
} from "@/components/department/role-chip-row";
import { PersonRow } from "@/components/department/person-row";
import {
  RosterFacet,
  type FacetOption,
} from "@/components/center/center-roster-facets";
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
  CenterMemberHit,
  CenterMembershipType,
  CenterMembersResult,
} from "@/lib/api/centers";

export function CenterMembersClient({
  result,
  centerSlug,
  programPagesEnabled = false,
  singleProgram = false,
}: {
  result: CenterMembersResult;
  centerSlug: string;
  /** #1105 — when on, eligible (non-excluded) program section headers link to
   *  the dedicated `/centers/[slug]/programs/[code]` page. */
  programPagesEnabled?: boolean;
  /** #1105 — rendered on a dedicated program page (a single group). The Program
   *  facet auto-hides (one option) and the lone section header is suppressed,
   *  since it would just echo the page title. */
  singleProgram?: boolean;
}) {
  if (result.mode === "grouped") {
    return (
      <GroupedRoster
        groups={result.groups}
        total={result.total}
        centerSlug={centerSlug}
        programPagesEnabled={programPagesEnabled}
        singleProgram={singleProgram}
      />
    );
  }
  return <FlatMembers result={result} centerSlug={centerSlug} />;
}

/**
 * #1105 — program codes that have no dedicated page (the `ZY` "Non-aligned
 * Clinical" catch-all). Mirrors `lib/api/centers.ts` `PROGRAM_PAGE_EXCLUDED_CODES`
 * — duplicated as a literal here to keep this a client component (no server
 * import). Keep the two in sync.
 */
const PROGRAM_PAGE_EXCLUDED_CODES: ReadonlySet<string> = new Set(["ZY"]);

/** Research/Clinical pill rendered after a member's role tag in the roster. */
function MembershipBadge({ type }: { type: CenterMembershipType | null }) {
  if (!type) return null;
  const research = type === "research";
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-[6px] text-[11px] font-medium leading-[1.4] ${
        research
          ? "border-[#c7d6e2] bg-[#eef3f7] text-[#2c4f6e]"
          : "border-[#e6cdd0] bg-[#f7eef0] text-[var(--color-primary-cornell-red)]"
      }`}
    >
      {research ? "Research" : "Clinical"}
    </span>
  );
}

type RowWithProgram = CenterMemberHit & { programLabel: string };

const TYPE_ORDER: CenterMembershipType[] = ["research", "clinical"];
const NO_DEPT = "—";
const NO_RANK = "—";

/**
 * Programmed center: a left facet sidebar (Program / Membership type /
 * Methods & tools / Organizational unit) over program-grouped member sections, plus the existing
 * Appointment (role) chip row. All active members are on one page (#552 §6.2),
 * so faceting is client-side. Facets multi-select (OR within a facet, AND
 * across facets); counts reflect the other active facets. Empty program
 * sections drop out as filters narrow.
 */
function GroupedRoster({
  groups,
  total,
  centerSlug,
  programPagesEnabled,
  singleProgram = false,
}: {
  groups: CenterMemberGroup[];
  total: number;
  centerSlug: string;
  programPagesEnabled: boolean;
  singleProgram?: boolean;
}) {
  const [appointment, setAppointment] = useState<RoleCategory>("All");
  const [selPrograms, setSelPrograms] = useState<ReadonlySet<string>>(new Set());
  const [selTypes, setSelTypes] = useState<ReadonlySet<string>>(new Set());
  const [selDepts, setSelDepts] = useState<ReadonlySet<string>>(new Set());
  // #962 — "Methods & tools" facet selection (family overlay-key values).
  const [selMethods, setSelMethods] = useState<ReadonlySet<string>>(new Set());
  // #1570 — "Professorial rank" facet selection (ASMS rank values).
  const [selRanks, setSelRanks] = useState<ReadonlySet<string>>(new Set());

  // Flatten to rows tagged with the program section they belong to; keep the
  // (sorted) program order for both the facet and the section layout.
  const allRows = useMemo<RowWithProgram[]>(
    () => groups.flatMap((g) => g.members.map((m) => ({ ...m, programLabel: g.label }))),
    [groups],
  );
  const programOrder = useMemo(() => groups.map((g) => g.label), [groups]);
  // #1105 — program code per section label, for the optional page link on the
  // section header. The synthetic "Other" group has a null code (no page).
  const codeByLabel = useMemo(
    () => new Map(groups.map((g) => [g.label, g.code])),
    [groups],
  );

  const deptKey = (m: RowWithProgram) => m.departmentName || NO_DEPT;
  const rankKey = (m: RowWithProgram) => m.professorialRank || NO_RANK;
  const typeKey = (m: RowWithProgram): string => m.membershipType ?? "";
  // #962 — the family overlay-key values a member belongs to (facet membership).
  const methodValues = (m: RowWithProgram): string[] =>
    (m.methodFamilies ?? []).map((f) => f.value);

  // Appointment (role) is the outer filter; the sidebar facets compose on top.
  const base = useMemo(
    () => filterByRoleCategory(allRows, appointment),
    [allRows, appointment],
  );

  // A row passes every selected facet EXCEPT the named one (so a facet's own
  // counts don't collapse when you select within it).
  const passes = (
    m: RowWithProgram,
    except: "program" | "type" | "dept" | "method" | "rank" | null,
  ): boolean =>
    (except === "program" || selPrograms.size === 0 || selPrograms.has(m.programLabel)) &&
    (except === "type" || selTypes.size === 0 || selTypes.has(typeKey(m))) &&
    (except === "dept" || selDepts.size === 0 || selDepts.has(deptKey(m))) &&
    (except === "rank" || selRanks.size === 0 || selRanks.has(rankKey(m))) &&
    // #962 — OR within the Methods facet: a member with families {A,B} matches a
    // {A} selection. AND across facets, like the other three.
    (except === "method" ||
      selMethods.size === 0 ||
      methodValues(m).some((v) => selMethods.has(v)));

  const finalRows = useMemo(
    () => base.filter((m) => passes(m, null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, selPrograms, selTypes, selDepts, selMethods, selRanks],
  );

  const programOptions = useMemo<FacetOption[]>(
    () =>
      programOrder.map((label) => ({
        value: label,
        label,
        count: base.filter((m) => m.programLabel === label && passes(m, "program")).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, programOrder, selTypes, selDepts, selMethods, selRanks],
  );

  const typeOptions = useMemo<FacetOption[]>(
    () =>
      TYPE_ORDER.filter((t) => allRows.some((m) => m.membershipType === t)).map((t) => ({
        value: t,
        label: t === "research" ? "Research" : "Clinical",
        count: base.filter((m) => typeKey(m) === t && passes(m, "type")).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, allRows, selPrograms, selDepts, selMethods, selRanks],
  );

  const deptOptions = useMemo<FacetOption[]>(
    () =>
      Array.from(new Set(allRows.map(deptKey)))
        .map((name) => ({
          value: name,
          label: name === NO_DEPT ? "No department" : name,
          count: base.filter((m) => deptKey(m) === name && passes(m, "dept")).length,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, allRows, selPrograms, selTypes, selMethods, selRanks],
  );

  // #1570 — "Professorial rank" facet, derived exactly like deptOptions: a
  // sentinel bucket for members without an ASMS rank, sorted count-desc.
  // `passes(m,"rank")` excludes this facet from its own counts (smart-count).
  const rankOptions = useMemo<FacetOption[]>(
    () =>
      Array.from(new Set(allRows.map(rankKey)))
        .map((rank) => ({
          value: rank,
          label: rank === NO_RANK ? "No rank" : rank,
          count: base.filter((m) => rankKey(m) === rank && passes(m, "rank")).length,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, allRows, selPrograms, selTypes, selDepts, selMethods],
  );

  // #962 — "Methods & tools" facet: family-level options (value = stable overlay
  // key, label = familyLabel so they align 1:1 with the row chips), sorted by
  // member-count desc. `passes(m,"method")` excludes the Methods facet from its
  // own counts (smart-count, same contract as the other three). Empty when no
  // member carries families (flag off or no data) → the facet vanishes.
  const methodOptions = useMemo<FacetOption[]>(() => {
    const labelByValue = new Map<string, string>();
    for (const m of allRows)
      for (const f of m.methodFamilies ?? [])
        if (!labelByValue.has(f.value)) labelByValue.set(f.value, f.familyLabel);
    return Array.from(labelByValue.entries())
      .map(([value, label]) => ({
        value,
        label,
        count: base.filter((m) => methodValues(m).includes(value) && passes(m, "method")).length,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, allRows, selPrograms, selTypes, selDepts, selRanks]);

  // Re-group the surviving rows under their program headers (original order).
  const sections = useMemo(
    () =>
      programOrder
        .map((label) => ({
          label,
          members: finalRows.filter((m) => m.programLabel === label),
        }))
        .filter((s) => s.members.length > 0),
    [finalRows, programOrder],
  );

  const makeToggle =
    (set: ReadonlySet<string>, setSet: (s: ReadonlySet<string>) => void) =>
    (value: string) => {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      setSet(next);
    };

  // Once the Program facet is narrowed to a single program, the lone section
  // header just echoes the active filter — drop it (option A redundancy fix).
  // On a dedicated program page (#1105, `singleProgram`) the header is likewise
  // redundant with the page title, so it's always hidden.
  const hideHeaders = singleProgram || selPrograms.size === 1;
  const anySelected =
    selPrograms.size + selTypes.size + selDepts.size + selMethods.size + selRanks.size > 0;
  const clearAll = () => {
    setSelPrograms(new Set());
    setSelTypes(new Set());
    setSelDepts(new Set());
    setSelMethods(new Set());
    setSelRanks(new Set());
  };

  return (
    <div className="mt-6 flex flex-col gap-8 md:flex-row">
      <aside className="md:w-[200px] md:shrink-0">
        <div className="md:sticky md:top-[76px] md:max-h-[calc(100vh-76px)] md:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Filter
            </span>
            {anySelected && (
              <button
                type="button"
                onClick={clearAll}
                className="cursor-pointer text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          {programOptions.length >= 2 && (
            <RosterFacet
              title="Program"
              options={programOptions}
              selected={selPrograms}
              onToggle={makeToggle(selPrograms, setSelPrograms)}
            />
          )}
          {/* #1570 — hide the Membership-type facet when every shown member shares
              a single type (Meyer is all-Research): a one-option facet can't filter
              anything. Mirrors the Program facet's ≥2 guard. */}
          {typeOptions.length >= 2 && (
            <RosterFacet
              title="Membership type"
              options={typeOptions}
              selected={selTypes}
              onToggle={makeToggle(selTypes, setSelTypes)}
            />
          )}
          {/* #962 — Methods & tools ranks above Department. Vanishes when
              no member carries a public family (flag off or no data), since
              `methodOptions` is then empty. */}
          {methodOptions.length > 0 && (
            <RosterFacet
              title="Methods & tools"
              options={methodOptions}
              selected={selMethods}
              onToggle={makeToggle(selMethods, setSelMethods)}
              collapseAfter={8}
              searchable
              searchPlaceholder="Search methods…"
              noMatchLabel="No methods match"
            />
          )}
          {/* #1570 — "Organizational unit" relabeled to "Department" per Cancer
              Center feedback. */}
          <RosterFacet
            title="Department"
            options={deptOptions}
            selected={selDepts}
            onToggle={makeToggle(selDepts, setSelDepts)}
            collapseAfter={8}
          />
          {/* #1570 — "Professorial rank" renders LAST. Hidden unless ≥2 distinct
              ranks are present: rankKey always buckets a missing rank under the
              NO_RANK sentinel, so rankOptions is never empty when rows exist, and
              a one-option facet can't filter anything. Mirrors the ≥2 guards above. */}
          {rankOptions.length >= 2 && (
            <RosterFacet
              title="Professorial rank"
              options={rankOptions}
              selected={selRanks}
              onToggle={makeToggle(selRanks, setSelRanks)}
            />
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="min-w-[72px] shrink-0 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
            Appointment
          </span>
          <RoleChipRow faculty={allRows} active={appointment} onChange={setAppointment} />
        </div>

        {sections.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No members match these filters.
          </p>
        ) : (
          <div className="flex flex-col gap-8">
            {sections.map((g) => {
              // #1105 — link the section header to the dedicated program page
              // when the flag is on and the program is page-eligible (has a code,
              // not the excluded ZY catch-all / the synthetic "Other" bucket).
              const code = codeByLabel.get(g.label) ?? null;
              const linked =
                programPagesEnabled &&
                !!code &&
                !PROGRAM_PAGE_EXCLUDED_CODES.has(code);
              return (
              <section key={g.label}>
                {!hideHeaders && (
                  <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2">
                    <h2 className="text-[12px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      {linked ? (
                        <a
                          href={`/centers/${centerSlug}/programs/${code}`}
                          className="hover:underline"
                          style={{ textDecoration: "none" }}
                        >
                          {g.label}
                        </a>
                      ) : (
                        g.label
                      )}
                    </h2>
                    <span className="text-[11px] text-muted-foreground">
                      {g.members.length} {g.members.length === 1 ? "member" : "members"}
                    </span>
                  </div>
                )}
                <div className="flex flex-col">
                  {g.members.map((m) => (
                    <PersonRow
                      key={m.cwid}
                      hit={m}
                      trailingBadge={<MembershipBadge type={m.membershipType} />}
                      methodChips={m.topMethods}
                    />
                  ))}
                </div>
              </section>
              );
            })}
          </div>
        )}

        <p className="sr-only" aria-live="polite">
          {finalRows.length} of {total} members shown
        </p>
      </div>
    </div>
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
