/**
 * `/methods` hub grid — the supercategory analog of
 * `components/home/browse-all-research-areas-grid.tsx`. Server Component renders
 * a 3-column, column-major list of the ~14 method supercategories (those with at
 * least one publicly-visible family), each linking to its supercategory page and
 * labeled with its visible-family count. Empty `items` → an unavailable state.
 */
import Link from "next/link";
import type { SupercategoryHubEntry } from "@/lib/api/methods";

const COLUMNS = 3;

export function MethodsHubGrid({ items }: { items: SupercategoryHubEntry[] }) {
  if (items.length === 0) {
    return (
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Browse all research methods</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Research methods temporarily unavailable.{" "}
          <Link
            href="/"
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            Retry
          </Link>
        </p>
      </section>
    );
  }

  // Column-major split: items arrive sorted by label, so each column is a
  // contiguous alphabetical slice. Reading order is top-to-bottom, then next
  // column.
  const colSize = Math.ceil(items.length / COLUMNS);
  const columns = Array.from({ length: COLUMNS }, (_, i) =>
    items.slice(i * colSize, (i + 1) * colSize),
  );

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Browse all research methods</h2>
      <p className="mt-1 mb-6 text-[14px] text-muted-foreground">
        All {items.length} method categories at WCM, with family counts.
      </p>
      <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
        {columns.map((col, ci) => (
          <ul key={ci} className="divide-y divide-border">
            {col.map((sc) => (
              <li key={sc.id} className="flex items-start justify-between gap-3 py-2.5">
                <a
                  href={`/methods/${sc.slug}`}
                  className="text-base font-medium text-foreground hover:underline"
                >
                  {sc.label}
                </a>
                <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                  {sc.familyCount.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </section>
  );
}
