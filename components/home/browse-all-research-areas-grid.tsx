/**
 * Home-page Browse all research areas grid. Server Component renders a
 * 4-col grid (responsive 4→2→1) of parent topic links with active-scholar
 * counts. Per D-12 this surface NEVER hides; an empty `items` array
 * renders the "Research areas temporarily unavailable" error state.
 */
import Link from "next/link";
import type { ParentTopic } from "@/lib/api/home";

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
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Browse all research areas</h2>
      <ul className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((t) => (
          <li
            key={t.slug}
            className="flex items-baseline justify-between gap-2"
          >
            <a
              href={`/topics/${t.slug}`}
              className="text-base font-semibold hover:underline"
            >
              {t.name}
            </a>
            <span className="text-muted-foreground text-sm">
              {t.scholarCount} scholars
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
