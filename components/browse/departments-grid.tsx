/**
 * Departments section — four-group structure per design spec.
 *
 * Renders one labeled section per category (Clinical, Basic-science,
 * Basic & Clinical, Administrative) in fixed order. Empty groups are
 * skipped silently.
 *
 * Each card shows: name, chair line, division chip-row (if any), and
 * up to two top research-area chips. Administrative cards skip
 * divisions and topics (lean treatment).
 */
import type { BrowseDepartment, CategorizedDepartments } from "@/lib/api/browse";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "@/lib/department-categories";

const DIV_CHIP_LIMIT = 8;

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
      <div className="mt-8 mb-3 flex items-baseline gap-3 border-b border-border pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)]">
          {CATEGORY_LABELS[categoryKey]}
        </h3>
        <span className="text-xs text-muted-foreground">
          {departments.length}
          {departments.length === 1 ? " department" : " departments"}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {departments.map((d) => (
          <li key={d.code}>
            <a
              href={`/departments/${d.slug}`}
              className="block rounded-md border border-border bg-white p-4 transition-all hover:border-[var(--color-accent-slate)] hover:shadow-sm hover:no-underline"
            >
              <div className="text-base font-semibold text-foreground leading-snug">
                {d.name}
              </div>
              {d.chairName && (
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/70">Chair:</span>{" "}
                  {d.chairName}
                </div>
              )}
              {!isLean && d.divisions.length > 0 && (
                <>
                  <div className="mt-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {d.divisions.length}
                    {d.divisions.length === 1 ? " division" : " divisions"}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {d.divisions.slice(0, DIV_CHIP_LIMIT).map((div) => (
                      <span
                        key={div.code}
                        className="rounded-full border border-[var(--color-accent-slate)] bg-white px-2 py-[2px] text-[11px] text-[var(--color-accent-slate)]"
                      >
                        {div.name}
                      </span>
                    ))}
                    {d.divisions.length > DIV_CHIP_LIMIT && (
                      <span className="rounded-full border border-border bg-background px-2 py-[2px] text-[11px] text-muted-foreground">
                        …{d.divisions.length - DIV_CHIP_LIMIT} more
                      </span>
                    )}
                  </div>
                </>
              )}
              {!isLean && d.topResearchAreas.length > 0 && (
                <>
                  <div className="mt-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    Top research
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {d.topResearchAreas.map((t) => (
                      <span
                        key={t.topicSlug}
                        className="rounded-full bg-[#f6f3ee] px-2 py-[2px] text-[11px] text-foreground"
                      >
                        {t.topicLabel}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
