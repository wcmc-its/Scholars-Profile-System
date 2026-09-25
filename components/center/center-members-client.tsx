"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  ROLE_CATEGORIES,
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
import { HOME_INSTITUTION_CODE, institutionCodeForName, institutionDisplayName } from "@/lib/institutions";
import { RosterToolbar } from "@/components/shared/roster-toolbar";
import {
  isRosterSort,
  matchesRosterQuery,
  normalizeRosterQuery,
  rankRoster,
  type RosterSort,
} from "@/lib/roster-sort";
import {
  applySubunitSelect,
  broadcastSubunitSelection,
  onSubunitSelect,
  urlWithQuery,
} from "@/lib/unit-subunit-filter";

/** Unit Page v2 — mirror the roster toolbar's sort (only when not the default)
 *  and name query into the address bar without a navigation. */
function syncToolbarParams(params: URLSearchParams, sort: RosterSort, q: string) {
  params.delete("sort");
  params.delete("q");
  if (sort !== "last") params.set("sort", sort);
  if (q) params.set("q", q);
}

export function CenterMembersClient({
  result,
  centerSlug,
  centerCode,
  programPagesEnabled = false,
  singleProgram = false,
  initialSort = "last",
}: {
  result: CenterMembersResult;
  centerSlug: string;
  /** #2537 — center's code, for the `FlatMembers` server-filtered `?type=`
   *  fetch (`/api/units/center/[centerCode]/members`). Unused by `GroupedRoster`
   *  (its Appointment chip stays a client-side facet over the already-loaded
   *  page, same as the other sidebar facets) — optional so a caller that only
   *  ever renders the grouped mode (the program page) still type-checks. */
  centerCode?: string;
  /** #1105 — when on, eligible (non-excluded) program section headers link to
   *  the dedicated `/centers/[slug]/programs/[code]` page. */
  programPagesEnabled?: boolean;
  /** #1105 — rendered on a dedicated program page (a single group). The Program
   *  facet auto-hides (one option) and the lone section header is suppressed,
   *  since it would just echo the page title. */
  singleProgram?: boolean;
  /** Unit Page v2 — the roster sort from `?sort=` (parsed server-side). The
   *  flat roster's SSR page is already ranked by it; the grouped roster sorts
   *  each program section in the browser. */
  initialSort?: RosterSort;
}) {
  if (result.mode === "grouped") {
    return (
      <GroupedRoster
        groups={result.groups}
        total={result.total}
        centerSlug={centerSlug}
        programPagesEnabled={programPagesEnabled}
        singleProgram={singleProgram}
        initialSort={initialSort}
      />
    );
  }
  return (
    <FlatMembers
      result={result}
      centerSlug={centerSlug}
      centerCode={centerCode}
      initialSort={initialSort}
    />
  );
}

/**
 * #1105 — program codes that have no dedicated page (the `ZY` "Non-aligned
 * Clinical" catch-all). Mirrors `lib/api/centers.ts` `PROGRAM_PAGE_EXCLUDED_CODES`
 * — duplicated as a literal here to keep this a client component (no server
 * import). Keep the two in sync.
 */
const PROGRAM_PAGE_EXCLUDED_CODES: ReadonlySet<string> = new Set(["ZY"]);

/** Research/Clinical pill rendered after a member's name in the roster
 *  (Unit Page v2: 11px/15px, 1px 6px, 3px radius, Apollo tint tokens). */
function MembershipBadge({ type }: { type: CenterMembershipType | null }) {
  if (!type) return null;
  const research = type === "research";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-[3px] border px-[6px] py-px text-[11px] leading-[15px] ${
        research
          ? "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate"
          : "border-apollo-red-tint-border bg-apollo-red-tint text-[var(--color-primary-cornell-red)]"
      }`}
    >
      {research ? "Research" : "Clinical"}
    </span>
  );
}

/** Vocabulary membership-role badge (e.g. "Core Faculty Fellow") — same
 *  size/shape as `MembershipBadge`, neutral colour. Renders instead of it, a
 *  member never shows both. */
function MembershipRoleBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[3px] border border-apollo-border-strong bg-apollo-surface-2 px-[6px] py-px text-[11px] leading-[15px] text-apollo-ink-2">
      {label}
    </span>
  );
}

function trailingBadgeFor(m: Pick<CenterMemberHit, "membershipType" | "membershipRoleLabel">) {
  return m.membershipRoleLabel ? (
    <MembershipRoleBadge label={m.membershipRoleLabel} />
  ) : (
    <MembershipBadge type={m.membershipType} />
  );
}

type RowWithProgram = CenterMemberHit & { programLabel: string };

const TYPE_ORDER: CenterMembershipType[] = ["research", "clinical"];
const NO_DEPT = "—";
const NO_RANK = "—";
const NO_INST = "—";

/**
 * Programmed center: a left facet sidebar (Program / Membership type /
 * Methods & tools / Department / Professorial rank / Institution) over
 * program-grouped member sections, plus the existing
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
  initialSort = "last",
}: {
  groups: CenterMemberGroup[];
  total: number;
  centerSlug: string;
  programPagesEnabled: boolean;
  singleProgram?: boolean;
  initialSort?: RosterSort;
}) {
  const [appointment, setAppointment] = useState<RoleCategory>("All");
  // Unit Page v2 roster toolbar. Every member is already on the page, so the
  // name filter and sort run in the browser (no debounce needed).
  const [sort, setSort] = useState<RosterSort>(initialSort);
  const [nameQ, setNameQ] = useState("");
  const q = normalizeRosterQuery(nameQ);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const seeded = normalizeRosterQuery(params.get("q"));
    if (seeded) setNameQ(seeded);
    // The program page renders this roster without reading `?sort=` server-side.
    const seededSort = params.get("sort");
    if (isRosterSort(seededSort)) setSort(seededSort);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    syncToolbarParams(params, sort, q);
    const qs = params.toString();
    window.history.replaceState(null, "", urlWithQuery(qs));
  }, [sort, q]);
  const [selPrograms, setSelPrograms] = useState<ReadonlySet<string>>(new Set());
  const [selTypes, setSelTypes] = useState<ReadonlySet<string>>(new Set());
  const [selDepts, setSelDepts] = useState<ReadonlySet<string>>(new Set());
  // #962 — "Methods & tools" facet selection (family overlay-key values).
  const [selMethods, setSelMethods] = useState<ReadonlySet<string>>(new Set());
  // #1570 — "Professorial rank" facet selection (ASMS rank values).
  const [selRanks, setSelRanks] = useState<ReadonlySet<string>>(new Set());
  // "Institution" facet selection (`Scholar.primaryOrgCode` values, #2695).
  const [selInsts, setSelInsts] = useState<ReadonlySet<string>>(new Set());

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
  // Unit Page v2 — the Program facet is keyed by label, the URL (`?program=`)
  // and the hero's program chips by program code. Coded groups only; the
  // synthetic "Other" group has no code and no URL form.
  const labelByCode = useMemo(
    () =>
      new Map(
        groups.filter((g) => g.code !== null).map((g) => [g.code as string, g.label]),
      ),
    [groups],
  );
  // Seed the Program facet from `?program=<code>` (a hero program chip's href
  // followed from another tab, or a shared link) — not on a dedicated program page (one group).
  useEffect(() => {
    if (singleProgram) return;
    const labels = new URLSearchParams(window.location.search)
      .getAll("program")
      .map((c) => labelByCode.get(c))
      .filter((l): l is string => !!l);
    if (labels.length > 0) setSelPrograms(new Set(labels));
    // mount-only, like the toolbar seed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Mirror the Program selection into `?program=` (codes) and to the hero's
  // program chips; apply a chip click to the facet (a known code only —
  // anything else stays unhandled and the chip navigates to its href).
  useEffect(() => {
    if (singleProgram) return;
    const codes = Array.from(selPrograms)
      .map((l) => codeByLabel.get(l))
      .filter((c): c is string => !!c);
    const params = new URLSearchParams(window.location.search);
    params.delete("program");
    for (const c of codes) params.append("program", c);
    window.history.replaceState(null, "", urlWithQuery(params.toString()));
    broadcastSubunitSelection("program", codes);
  }, [singleProgram, selPrograms, codeByLabel]);
  // Unmount (a tab switch soft-navigates away from the roster while the hero's
  // chips stay mounted) ⇒ clear the chips' active state; see the same effect in
  // `DepartmentFacultyClient`.
  useEffect(() => {
    if (singleProgram) return;
    return () => broadcastSubunitSelection("program", []);
  }, [singleProgram]);
  useEffect(() => {
    if (singleProgram) return;
    return onSubunitSelect("program", (code, action) => {
      const label = labelByCode.get(code);
      if (!label) return false;
      setSelPrograms((prev) => applySubunitSelect(prev, label, action));
      return true;
    });
  }, [singleProgram, labelByCode]);

  const deptKey = (m: RowWithProgram) => m.departmentName || NO_DEPT;
  const rankKey = (m: RowWithProgram) => m.professorialRank || NO_RANK;
  // An external member (#2519 Cornell, CTSC feed) has no Scholar row, so no
  // `primaryOrgCode`; bucket it by its institution name (unmapped strings
  // display as-is), or WCM when the feed lists WCM itself.
  const instKey = (m: RowWithProgram) =>
    m.isExternal
      ? m.externalInstitution
        ? (institutionCodeForName(m.externalInstitution) ?? m.externalInstitution)
        : HOME_INSTITUTION_CODE
      : m.primaryOrgCode || NO_INST;
  const typeKey = (m: RowWithProgram): string => m.membershipType ?? "";
  // #962 — the family overlay-key values a member belongs to (facet membership).
  const methodValues = (m: RowWithProgram): string[] =>
    (m.methodFamilies ?? []).map((f) => f.value);

  // Appointment (role) and the name/title query are the outer filters; the
  // sidebar facets compose on top (mock order: appointment, query, facets).
  const base = useMemo(
    () =>
      filterByRoleCategory(allRows, appointment).filter((m) => matchesRosterQuery(m, q)),
    [allRows, appointment, q],
  );

  // A row passes every selected facet EXCEPT the named one (so a facet's own
  // counts don't collapse when you select within it).
  const passes = (
    m: RowWithProgram,
    except: "program" | "type" | "dept" | "method" | "rank" | "inst" | null,
  ): boolean =>
    (except === "program" || selPrograms.size === 0 || selPrograms.has(m.programLabel)) &&
    (except === "type" || selTypes.size === 0 || selTypes.has(typeKey(m))) &&
    (except === "dept" || selDepts.size === 0 || selDepts.has(deptKey(m))) &&
    (except === "rank" || selRanks.size === 0 || selRanks.has(rankKey(m))) &&
    (except === "inst" || selInsts.size === 0 || selInsts.has(instKey(m))) &&
    // #962 — OR within the Methods facet: a member with families {A,B} matches a
    // {A} selection. AND across facets, like the other three.
    (except === "method" ||
      selMethods.size === 0 ||
      methodValues(m).some((v) => selMethods.has(v)));

  const finalRows = useMemo(
    () => base.filter((m) => passes(m, null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, selPrograms, selTypes, selDepts, selMethods, selRanks, selInsts],
  );

  const programOptions = useMemo<FacetOption[]>(
    () =>
      programOrder.map((label) => ({
        value: label,
        label,
        count: base.filter((m) => m.programLabel === label && passes(m, "program")).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, programOrder, selTypes, selDepts, selMethods, selRanks, selInsts],
  );

  const typeOptions = useMemo<FacetOption[]>(
    () =>
      TYPE_ORDER.filter((t) => allRows.some((m) => m.membershipType === t)).map((t) => ({
        value: t,
        label: t === "research" ? "Research" : "Clinical",
        count: base.filter((m) => typeKey(m) === t && passes(m, "type")).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, allRows, selPrograms, selDepts, selMethods, selRanks, selInsts],
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
    [base, allRows, selPrograms, selTypes, selMethods, selRanks, selInsts],
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
    [base, allRows, selPrograms, selTypes, selDepts, selMethods, selInsts],
  );

  // "Institution" facet, derived exactly like rankOptions: a sentinel bucket for
  // members without a `primaryOrgCode`, labels via `institutionDisplayName`
  // (WCMC → "Weill Cornell Medicine"), sorted count-desc. `passes(m,"inst")`
  // excludes this facet from its own counts (smart-count).
  const instOptions = useMemo<FacetOption[]>(
    () =>
      Array.from(new Set(allRows.map(instKey)))
        .map((code) => ({
          value: code,
          label: code === NO_INST ? "No institution" : institutionDisplayName(code),
          count: base.filter((m) => instKey(m) === code && passes(m, "inst")).length,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, allRows, selPrograms, selTypes, selDepts, selMethods, selRanks],
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
  }, [base, allRows, selPrograms, selTypes, selDepts, selRanks, selInsts]);

  // Re-group the surviving rows under their program headers. Sections keep the
  // fixed program (sortOrder, label) order — they don't jump when the sort
  // changes; rows are ranked by the toolbar sort WITHIN each section.
  const sections = useMemo(
    () =>
      programOrder
        .map((label) => ({
          label,
          members: rankRoster(
            finalRows.filter((m) => m.programLabel === label),
            { sort },
          ),
        }))
        .filter((s) => s.members.length > 0),
    [finalRows, programOrder, sort],
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
  const selectedProgramPage = (() => {
    if (singleProgram || selPrograms.size !== 1 || !programPagesEnabled) return null;
    const [label] = selPrograms;
    const code = codeByLabel.get(label) ?? null;
    return code && !PROGRAM_PAGE_EXCLUDED_CODES.has(code)
      ? { label, href: `/centers/${centerSlug}/programs/${code}` }
      : null;
  })();
  const anySelected =
    selPrograms.size +
      selTypes.size +
      selDepts.size +
      selMethods.size +
      selRanks.size +
      selInsts.size >
    0;
  const clearAll = () => {
    setSelPrograms(new Set());
    setSelTypes(new Set());
    setSelDepts(new Set());
    setSelMethods(new Set());
    setSelRanks(new Set());
    setSelInsts(new Set());
    // Mock "Clear all" also resets the name filter (the sort is a view choice).
    setNameQ("");
  };
  // Empty-state "Clear filters": the sidebar facets AND the Appointment chip.
  const clearEverything = () => {
    clearAll();
    setAppointment("All");
  };
  // Unit Page v2 — a program header shows the program's TOTAL size (not the
  // facet-narrowed count), so the number stays stable while filtering.
  const programSize = useMemo(
    () => new Map(groups.map((g) => [g.label, g.members.length])),
    [groups],
  );
  // A member listed in several programs appears once per section; count each
  // scholar once. With no filter active the denominator is the whole roster.
  const shown = useMemo(() => new Set(finalRows.map((m) => m.cwid)).size, [finalRows]);
  const ofTotal = anySelected || appointment !== "All" || q !== "" ? shown : total;

  return (
    <div className="mt-5 flex flex-col gap-8 pt-2 md:flex-row md:flex-wrap md:items-start md:gap-x-14">
      <aside className="md:w-[200px] md:shrink-0 md:grow-0">
        <div className="flex flex-col gap-[22px] md:sticky md:top-[76px] md:max-h-[calc(100vh-76px)] md:overflow-y-auto">
          {anySelected && (
            <button
              type="button"
              onClick={clearAll}
              className="cursor-pointer self-start text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
            >
              Clear
            </button>
          )}
          {(programOptions.length >= 2 || selectedProgramPage) && (
            <div className="flex flex-col gap-1.5">
              {programOptions.length >= 2 && (
                <RosterFacet
                  variant="unit"
                  title="Program"
                  options={programOptions}
                  selected={selPrograms}
                  onToggle={makeToggle(selPrograms, setSelPrograms)}
                />
              )}
              {/* One program selected hides its section header (and with it the
                  header's page link), so the program's own page is linked here
                  instead — the hero chips filter in place now. */}
              {selectedProgramPage && (
                <a
                  href={selectedProgramPage.href}
                  aria-label={`View ${selectedProgramPage.label} program page`}
                  className="self-start text-[12px] text-apollo-slate no-underline hover:underline"
                >
                  View program page →
                </a>
              )}
            </div>
          )}
          {/* #1570 — hide the Membership-type facet when every shown member shares
              a single type (Meyer is all-Research): a one-option facet can't filter
              anything. Mirrors the Program facet's ≥2 guard. */}
          {typeOptions.length >= 2 && (
            <RosterFacet
              variant="unit"
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
              variant="unit"
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
            variant="unit"
            title="Department"
            options={deptOptions}
            selected={selDepts}
            onToggle={makeToggle(selDepts, setSelDepts)}
            collapseAfter={8}
          />
          {/* #1570 — "Professorial rank" renders after Department. Hidden unless ≥2 distinct
              ranks are present: rankKey always buckets a missing rank under the
              NO_RANK sentinel, so rankOptions is never empty when rows exist, and
              a one-option facet can't filter anything. Mirrors the ≥2 guards above. */}
          {rankOptions.length >= 2 && (
            <RosterFacet
              variant="unit"
              title="Professorial rank"
              options={rankOptions}
              selected={selRanks}
              onToggle={makeToggle(selRanks, setSelRanks)}
            />
          )}
          {/* "Institution" (#2695 `primaryOrgCode`) renders after Professorial
              rank, under the same ≥2-options guard. */}
          {instOptions.length >= 2 && (
            <RosterFacet
              variant="unit"
              title="Institution"
              options={instOptions}
              selected={selInsts}
              onToggle={makeToggle(selInsts, setSelInsts)}
            />
          )}
        </div>
      </aside>

      {/* `#people-results` — a hero program chip's scroll (narrow viewports)
          and focus target; see `UnitSubunitChipRow`. */}
      <div
        id="people-results"
        tabIndex={-1}
        className="min-w-0 scroll-mt-16 focus:outline-none md:flex-[1_1_520px]"
      >
        <RosterToolbar query={nameQ} onQueryChange={setNameQ} sort={sort} onSortChange={setSort} />
        <div className="mt-[14px]">
          <RoleChipRow faculty={allRows} active={appointment} onChange={setAppointment} />
        </div>

        <div className="mt-4 text-[13px] text-muted-foreground">
          {shown > 0
            ? `Showing 1–${shown.toLocaleString()} of ${ofTotal.toLocaleString()} ${
                ofTotal === 1 ? "scholar" : "scholars"
              }`
            : null}
        </div>

        {sections.length === 0 ? (
          <p className="mt-5 border-t border-apollo-border py-6 text-[14px] text-muted-foreground">
            No scholars match these filters.{" "}
            <button
              type="button"
              onClick={clearEverything}
              className="cursor-pointer text-apollo-slate hover:underline"
            >
              Clear filters
            </button>
          </p>
        ) : (
          <div className="flex flex-col">
            {sections.map((g) => {
              // #1105 — link the section header to the dedicated program page
              // when the flag is on and the program is page-eligible (has a code,
              // not the excluded ZY catch-all / the synthetic "Other" bucket).
              const code = codeByLabel.get(g.label) ?? null;
              const linked =
                programPagesEnabled &&
                !!code &&
                !PROGRAM_PAGE_EXCLUDED_CODES.has(code);
              const size = programSize.get(g.label) ?? g.members.length;
              return (
              <section key={g.label} className="mt-2">
                {!hideHeaders && (
                  <div className="flex items-baseline justify-between gap-4 whitespace-nowrap border-b border-apollo-border pb-[10px] text-muted-foreground">
                    <h2 className="text-[12px] font-normal uppercase tracking-[0.14em] text-muted-foreground">
                      {linked ? (
                        <a
                          href={`/centers/${centerSlug}/programs/${code}`}
                          className="text-muted-foreground no-underline hover:text-apollo-slate hover:underline"
                        >
                          {g.label}
                        </a>
                      ) : (
                        g.label
                      )}
                    </h2>
                    <span className="text-[12px]">
                      {size.toLocaleString()} {size === 1 ? "member" : "members"}
                    </span>
                  </div>
                )}
                <div className="flex flex-col">
                  {g.members.map((m) => (
                    <PersonRow
                      key={m.cwid}
                      hit={m}
                      trailingBadge={trailingBadgeFor(m)}
                      methodChips={m.topMethods}
                      meshChips={m.topMesh}
                      activeAppointment={appointment}
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

/**
 * Unprogrammed center: flat list, paginated. #2537 — the Appointment chip joins
 * the server-filtered fetch path (mirrors `DepartmentFacultyClient`): selecting
 * a chip other than "All" fetches `/api/units/center/[centerCode]/members?type=`
 * and pagination becomes client-side (`fetchPage`) over the filtered total;
 * "All" keeps today's SSR roster + real-href pagination unchanged. `centerCode`
 * is optional only so a caller without it (none today) still type-checks — when
 * absent the chip degrades to a page-only filter, same as `hasFacet=false` in
 * the department client.
 */
function FlatMembers({
  result,
  centerSlug,
  centerCode,
  initialSort = "last",
}: {
  result: Extract<CenterMembersResult, { mode: "flat" }>;
  centerSlug: string;
  centerCode?: string;
  initialSort?: RosterSort;
}) {
  const { hits, total, page, pageSize, roleCategoryCounts } = result;
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");
  // Unit Page v2 roster toolbar — same contract as `DepartmentFacultyClient`:
  // `nameQ` is the live input, `q` its normalised value debounced 250ms.
  const [sort, setSort] = useState<RosterSort>(initialSort);
  const [nameQ, setNameQ] = useState("");
  const [q, setQ] = useState("");
  const [fetchPage, setFetchPage] = useState(1); // 1-based, like the SSR `page`
  const [filtered, setFiltered] = useState<{
    hits: CenterMemberHit[];
    total: number;
    roleCategoryCounts?: Record<string, number>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from an empty result: a failed type-filter fetch (network / 5xx)
  // must not read as "no members match" — the API returning [] and the request
  // dying are different facts. Drives a retryable error state below.
  const [error, setError] = useState(false);
  // Bumped by the Retry affordance to re-run the fetch effect after a failure
  // (same chip + page, so nothing else in the dep list changes).
  const [retryNonce, setRetryNonce] = useState(0);

  // A chip, a name query, or a sort other than the one the SSR page was ranked
  // by moves the roster onto the server-filtered view.
  const isFiltered =
    Boolean(centerCode) && (activeCategory !== "All" || q !== "" || sort !== initialSort);

  // #2533/#2537 — seed the chip from a `?type=` deep-link param (arrival path);
  // when `centerCode` is present this now also puts the roster into the
  // server-filtered view (the fetch effect below fires once the chip is
  // seeded), so a `?type=X&page=N` link restores the intended filtered page
  // too — the same #991 pattern the department client's deep-link seed uses.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let seededFilteredView = false;
    const type = params.get("type");
    if (type && (ROLE_CATEGORIES as string[]).includes(type)) {
      setActiveCategory(type as RoleCategory);
      seededFilteredView = true;
    }
    // Unit Page v2 — a shared `?q=` link reopens with the name filter applied.
    const seededQ = normalizeRosterQuery(params.get("q"));
    if (seededQ && centerCode) {
      setNameQ(seededQ);
      setQ(seededQ);
      seededFilteredView = true;
    }
    if (seededFilteredView && centerCode) {
      const pageParam = Number.parseInt(params.get("page") ?? "1", 10);
      if (Number.isFinite(pageParam) && pageParam > 1) setFetchPage(pageParam);
    }
    // mount-only; centerCode is stable for a given render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the name input into `q` (250ms); a new query starts at page 1.
  useEffect(() => {
    const next = normalizeRosterQuery(nameQ);
    if (next === q) return;
    const t = setTimeout(() => {
      setQ(next);
      setFetchPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [nameQ, q]);

  // Mirror chip + sort + query + page into the URL (same contract as the
  // department client): the filtered view writes its own `fetchPage`; the
  // unfiltered view reflects the SSR `page` prop, never a stale `?page=`/`?type=`
  // left behind by a filtered view the user has since cleared.
  useEffect(() => {
    if (!centerCode) return;
    const params = new URLSearchParams(window.location.search);
    syncToolbarParams(params, sort, q);
    params.delete("type");
    if (activeCategory !== "All") params.set("type", activeCategory);
    params.delete("page");
    if (isFiltered) {
      if (fetchPage > 1) params.set("page", String(fetchPage));
    } else if (page > 1) {
      params.set("page", String(page));
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [centerCode, sort, q, activeCategory, isFiltered, fetchPage, page]);

  // Fetch the filtered roster whenever the chip, sort, query or page changes.
  // Nothing active (or no `centerCode`) clears the filtered state so the SSR
  // roster renders.
  useEffect(() => {
    if (!isFiltered) {
      setFiltered(null);
      setError(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (activeCategory !== "All") params.set("type", activeCategory);
    if (sort !== "last") params.set("sort", sort);
    if (q) params.set("q", q);
    params.set("page", String(Math.max(0, fetchPage - 1)));
    fetch(`/api/units/center/${centerCode}/members?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(
        (data: {
          hits: CenterMemberHit[];
          total: number;
          roleCategoryCounts?: Record<string, number>;
        }) => {
          setFiltered({
            hits: data.hits,
            total: data.total,
            roleCategoryCounts: data.roleCategoryCounts,
          });
          setLoading(false);
        },
      )
      .catch((err) => {
        if (err?.name === "AbortError") return;
        // Keep the previous `filtered` (don't overwrite with an empty result —
        // that would render as "No members match these filters."). Surface a
        // retryable error instead.
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [isFiltered, centerCode, activeCategory, sort, q, fetchPage, retryNonce]);

  // Changing the chip or the sort resets to the first filtered page.
  const handleCategoryChange = useCallback((cat: RoleCategory) => {
    setActiveCategory(cat);
    setFetchPage(1);
  }, []);
  const handleSortChange = useCallback((next: RosterSort) => {
    setSort(next);
    setFetchPage(1);
  }, []);
  // Empty-state "Clear filters": the chip and the name filter.
  const clearFilters = () => {
    setActiveCategory("All");
    setNameQ("");
    setQ("");
    setFetchPage(1);
  };

  // Pagination URL builder — the unfiltered ("All") case navigates (SSR,
  // cacheable links); preserves the page (when >1) and the active chip (when
  // not "All") so paging in from an unfiltered page doesn't drop it (#2533).
  const buildHref = (p: number) => {
    const qs = new URLSearchParams();
    if (p > 1) qs.set("page", String(p));
    if (activeCategory !== "All") qs.set("type", activeCategory);
    // Unit Page v2 — the SSR page ranks by `?sort=`, so paging keeps the order.
    if (sort !== "last") qs.set("sort", sort);
    const search = qs.toString();
    return search ? `/centers/${centerSlug}?${search}` : `/centers/${centerSlug}`;
  };

  const baseHits = isFiltered ? (filtered?.hits ?? []) : hits;
  const queryCounts = q !== "" && isFiltered ? filtered?.roleCategoryCounts : undefined;
  const chipCounts = queryCounts ?? roleCategoryCounts;
  const chipTotal = queryCounts
    ? Object.values(queryCounts).reduce((a, b) => a + b, 0)
    : total;
  const renderedTotal = isFiltered ? (filtered?.total ?? 0) : total;
  const currentPage = isFiltered ? fetchPage : page;
  // Client-side fallback (no `centerCode`) mirrors the old page-only filter.
  const visible = isFiltered ? baseHits : filterByRoleCategory(baseHits, activeCategory);
  const totalPages = Math.max(1, Math.ceil(renderedTotal / pageSize));

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

  // #2234 regression: `page` is the 1-indexed display page (see the
  // `CenterMembersResult` JSDoc) — page 1 must render "Showing 1–pageSize",
  // never "Showing -{pageSize-1}–0".
  const start = renderedTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, renderedTotal);

  const pagination = (
    <div className="flex justify-center pt-6">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              {...(isFiltered
                ? {
                    href: "#",
                    onClick: (e: React.MouseEvent) => {
                      e.preventDefault();
                      if (currentPage > 1) setFetchPage(currentPage - 1);
                    },
                  }
                : { href: buildHref(Math.max(1, page - 1)) })}
              aria-disabled={currentPage <= 1}
            />
          </PaginationItem>
          {(() => {
            const pages: (number | "ellipsis")[] = [];
            if (totalPages <= 6) {
              for (let i = 1; i <= totalPages; i++) pages.push(i);
            } else {
              const win: number[] = [];
              for (
                let i = Math.max(2, currentPage - 2);
                i <= Math.min(totalPages - 1, currentPage + 2);
                i++
              )
                win.push(i);
              pages.push(1);
              if (win[0] > 2) pages.push("ellipsis");
              win.forEach((p) => pages.push(p));
              if (win[win.length - 1] < totalPages - 1) pages.push("ellipsis");
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
                    {...(isFiltered
                      ? {
                          href: "#",
                          onClick: (e: React.MouseEvent) => {
                            e.preventDefault();
                            setFetchPage(p);
                          },
                        }
                      : { href: buildHref(p) })}
                    isActive={p === currentPage}
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              ),
            );
          })()}
          <PaginationItem>
            <PaginationNext
              {...(isFiltered
                ? {
                    href: "#",
                    onClick: (e: React.MouseEvent) => {
                      e.preventDefault();
                      if (currentPage < totalPages) setFetchPage(currentPage + 1);
                    },
                  }
                : { href: buildHref(Math.min(totalPages, page + 1)) })}
              aria-disabled={currentPage >= totalPages}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );

  return (
    <div className="mt-5 pt-2">
      <RosterToolbar
        query={nameQ}
        onQueryChange={setNameQ}
        sort={sort}
        onSortChange={handleSortChange}
      />
      {/* #2235 — chip counts stay WHOLE-CENTER (`result.roleCategoryCounts`,
          computed server-side over every active member) regardless of the
          active chip or sort, matching the department client's whole-scope
          posture. A name query narrows them to the route's counts over the
          matching members (before the chip). */}
      <div className="mt-[14px]">
        <RoleChipRow
          faculty={baseHits}
          roleCategoryCounts={chipCounts}
          totalCount={chipTotal}
          active={activeCategory}
          onChange={handleCategoryChange}
        />
      </div>
      <div className="mt-4 text-[13px] text-muted-foreground">
        {isFiltered && loading
          ? "Loading…"
          : `Showing ${start}–${end} of ${renderedTotal.toLocaleString()} ${
              renderedTotal === 1 ? "scholar" : "scholars"
            }`}
      </div>
      {isFiltered && error ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Couldn’t load matching members.{" "}
          <button
            type="button"
            onClick={() => {
              setError(false);
              setRetryNonce((n) => n + 1);
            }}
            className="underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </p>
      ) : isFiltered && loading && filtered === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="mt-5 border-t border-apollo-border py-6 text-[14px] text-muted-foreground">
          No scholars match these filters.{" "}
          <button
            type="button"
            onClick={clearFilters}
            className="cursor-pointer text-apollo-slate hover:underline"
          >
            Clear filters
          </button>
        </p>
      ) : (
        <div className="mt-2 flex flex-col">
          {visible.map((hit) => (
            <PersonRow
              key={hit.cwid}
              hit={hit}
              meshChips={hit.topMesh}
              activeAppointment={activeCategory}
              trailingBadge={
                hit.membershipRoleLabel ? (
                  <MembershipRoleBadge label={hit.membershipRoleLabel} />
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      {totalPages > 1 && pagination}
    </div>
  );
}
