/**
 * Home-page Browse all research areas grid. Server Component renders a
 * 3-col, column-major (A–Z top-to-bottom per column) list of parent topics
 * with publication counts and a subtle divider between rows.
 * Per D-12 this surface NEVER hides; an empty `items` array renders the
 * "Research areas temporarily unavailable" error state.
 */
import Link from "next/link";
import type { ParentTopic } from "@/lib/api/home";

const COLUMNS = 3;

export function BrowseAllResearchAreasGrid({
  items,
}: {
  items: ParentTopic[];
}) {
  if (items.length === 0) {
    return (
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Browse all research areas</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Research areas temporarily unavailable.{" "}
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

  // Column-major split: items already arrive A–Z, so each column is a
  // contiguous alphabetical slice. Reading order is top-to-bottom, then
  // next column.
  const colSize = Math.ceil(items.length / COLUMNS);
  const columns = Array.from({ length: COLUMNS }, (_, i) =>
    items.slice(i * colSize, (i + 1) * colSize),
  );

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Browse all research areas</h2>
      <p className="mt-1 mb-6 text-[14px] text-muted-foreground">
        All {items.length} research areas at WCM, with publication counts.
      </p>
      <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
        {columns.map((col, ci) => (
          <ul key={ci} className="divide-y divide-border">
            {col.map((t) => (
              <li
                key={t.slug}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <a
                  href={`/topics/${t.slug}`}
                  className="text-base font-medium text-foreground hover:underline"
                >
                  {t.name}
                </a>
                <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                  {t.publicationCount.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </section>
  );
}
