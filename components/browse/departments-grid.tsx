/**
 * Departments section — compact expandable list.
 *
 * One row per department, grouped by category (Clinical, Basic-science,
 * Basic & Clinical, Administrative). Each row collapses to name + chair +
 * counts; expanding reveals the full set of division and research-area
 * chips plus a deep link into the department page.
 *
 * Administrative departments are flat (no divisions/topics) and render as
 * a non-expanding link row.
 */
import Link from "next/link";
import type { BrowseDepartment, CategorizedDepartments } from "@/lib/api/browse";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "@/lib/department-categories";

export function DepartmentsGrid({
  departments,
  departmentsByCategory,
}: {
  departments: BrowseDepartment[];
  departmentsByCategory: CategorizedDepartments;
}) {
  if (departments.length === 0) {
    return (
      <section id="departments" className="mt-0">
        <h2 className="text-lg font-semibold">Departments</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Department data temporarily unavailable.
        </p>
      </section>
    );
  }
  return (
    <section id="departments" className="mt-0">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Departments</h2>
        <span className="text-xs text-muted-foreground">
          {departments.length} departments
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Clinical and research departments at Weill Cornell Medicine. Click
        through to a department&rsquo;s scholars, publications, divisions, and
        grants.
      </p>

      {CATEGORY_ORDER.map((catKey) => {
        const list = departmentsByCategory[catKey];
        if (list.length === 0) return null;
        return <DeptGroupSection key={catKey} categoryKey={catKey} departments={list} />;
      })}
    </section>
  );
}

function DeptGroupSection({
  categoryKey,
  departments,
}: {
  categoryKey: keyof typeof CATEGORY_LABELS;
  departments: BrowseDepartment[];
}) {
  const isLean = categoryKey === "administrative";
  return (
    <>
      <div className="mt-8 mb-2 flex items-baseline gap-3 border-b border-border pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          {CATEGORY_LABELS[categoryKey]}
        </h3>
        <span className="text-xs text-muted-foreground">
          {departments.length}
          {departments.length === 1 ? " department" : " departments"}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {departments.map((d) => (
          <li key={d.code}>
            {isLean ? <DeptRowFlat dept={d} /> : <DeptRowExpandable dept={d} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function DeptRowFlat({ dept }: { dept: BrowseDepartment }) {
  return (
    <Link
      href={`/departments/${dept.slug}`}
      className="flex items-center gap-3 py-3 hover:no-underline"
    >
      <span className="inline-block w-3" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-foreground hover:text-[var(--color-accent-slate)]">
          {dept.name}
        </div>
        {dept.chairName && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Chair:</span>{" "}
            {dept.chairName}
          </div>
        )}
      </div>
    </Link>
  );
}

function DeptRowExpandable({ dept }: { dept: BrowseDepartment }) {
  const summaryParts: string[] = [];
  if (dept.divisions.length > 0) {
    summaryParts.push(
      `${dept.divisions.length} ${dept.divisions.length === 1 ? "division" : "divisions"}`,
    );
  }
  if (dept.topResearchAreas.length > 0) {
    summaryParts.push(
      `${dept.topResearchAreas.length} ${dept.topResearchAreas.length === 1 ? "research area" : "research areas"}`,
    );
  }

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-3 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <span className="inline-block w-3 text-[10px] text-muted-foreground transition-transform group-open:rotate-90">
          ▶
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/departments/${dept.slug}`}
            className="text-base font-semibold text-foreground hover:text-[var(--color-accent-slate)]"
          >
            {dept.name}
          </Link>
          {dept.chairName && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/70">Chair:</span>{" "}
              {dept.chairName}
            </div>
          )}
        </div>
        {summaryParts.length > 0 && (
          <div className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
            {summaryParts.join(" · ")}
          </div>
        )}
      </summary>
      <div className="pb-4 pl-6">
        {dept.divisions.length > 0 && (
          <div className="mt-1">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Divisions
            </div>
            <div className="flex flex-wrap gap-1">
              {dept.divisions.map((div) => (
                <Link
                  key={div.code}
                  href={`/departments/${dept.slug}/divisions/${div.slug}`}
                  className="rounded-full border border-[var(--color-accent-slate)] bg-white px-2 py-[2px] text-[11px] text-[var(--color-accent-slate)] hover:bg-[var(--color-accent-slate)] hover:text-white hover:no-underline"
                >
                  {div.name}
                </Link>
              ))}
            </div>
          </div>
        )}
        {dept.topResearchAreas.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Top research
            </div>
            <div className="flex flex-wrap gap-1">
              {dept.topResearchAreas.map((t) => (
                <Link
                  key={t.topicSlug}
                  href={`/topics/${t.topicSlug}`}
                  className="rounded-full bg-[#f6f3ee] px-2 py-[2px] text-[11px] text-foreground hover:bg-[#ede5d6] hover:no-underline"
                >
                  {t.topicLabel}
                </Link>
              ))}
            </div>
          </div>
        )}
        <Link
          href={`/departments/${dept.slug}`}
          className="mt-3 inline-block text-sm text-[var(--color-accent-slate)] hover:underline"
        >
          View {dept.name} &rarr;
        </Link>
      </div>
    </details>
  );
}
