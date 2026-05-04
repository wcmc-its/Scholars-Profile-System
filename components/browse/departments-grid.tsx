/**
 * Departments section — UI-SPEC §6.3.
 * Server Component: 3-col responsive card grid (2-col tablet, 1-col mobile).
 * Chair line renders only when chairName + chairSlug are both non-null
 * (absence-as-default per UI-SPEC §6.3).
 */
import type { BrowseDepartment } from "@/lib/api/browse";

export function DepartmentsGrid({
  departments,
}: {
  departments: BrowseDepartment[];
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
      <h2 className="text-lg font-semibold">Departments</h2>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-6">
        {departments.map((dept) => (
          <li
            key={dept.code}
            className="rounded-lg border border-border p-4 hover:bg-accent transition-colors flex flex-col gap-1"
          >
            <a
              href={`/departments/${dept.slug}`}
              className="text-base font-semibold hover:underline hover:text-[var(--color-accent-slate)]"
            >
              {dept.name}
            </a>
            <span className="text-sm text-muted-foreground">
              {dept.scholarCount === 1
                ? "1 scholar"
                : `${dept.scholarCount} scholars`}
            </span>
            {dept.chairName && dept.chairSlug && (
              <span className="text-sm text-muted-foreground">
                Chair:{" "}
                <a
                  href={`/scholars/${dept.chairSlug}`}
                  className="text-[var(--color-accent-slate)] hover:underline"
                >
                  {dept.chairName}
                </a>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
