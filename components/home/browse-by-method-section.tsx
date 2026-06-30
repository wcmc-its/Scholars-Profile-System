/**
 * Home-page "Browse by research method" section (spec §5). Bordered-card grid
 * of method CATEGORIES, peer to Browse all research areas. Each card is a
 * single link to /methods/{slug} with an accessible name combining label +
 * family count, a right-aligned muted family count, and a 2–3 family scent
 * line. Footer links into the full /methods directory.
 *
 * Rendered only when getHomeMethodCategories() returns non-null (the caller
 * gates on isMethodPagesEnabled() + data presence); this component itself does
 * NOT re-check the flag and renders nothing for an empty category list.
 */
import { MethodBeaconLink } from "@/components/home/method-beacon-link";
import type { HomeMethodCategories } from "@/lib/api/home";

export function BrowseByMethodSection({ data }: { data: HomeMethodCategories }) {
  const { categories, categoryCount, totalFamilyCount } = data;
  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="browse-by-method-heading" className="mt-12">
      <h2 id="browse-by-method-heading" className="text-lg font-semibold">
        Browse Methods &amp; tools
      </h2>
      <p className="mt-1 mb-6 text-[14px] text-muted-foreground">
        The instruments, assays, datasets, and computational methods &amp; tools
        used at WCM — {categoryCount} categories.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => (
          <MethodBeaconLink
            key={c.slug}
            href={`/methods/${c.slug}`}
            event="home_method_category_click"
            slug={c.slug}
            aria-label={`${c.label}, ${c.familyCount} method families`}
            className="group block rounded-lg border border-border p-4 transition-colors hover:border-[var(--color-accent-slate)]"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-base font-medium text-foreground group-hover:underline">
                {c.label}
              </span>
              <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                {c.familyCount.toLocaleString()}
              </span>
            </div>
            {c.representativeFamilies.length > 0 && (
              <p className="mt-1.5 text-sm leading-snug text-muted-foreground">
                {c.representativeFamilies.join(" · ")}
              </p>
            )}
          </MethodBeaconLink>
        ))}
      </div>

      <p className="mt-6 text-sm">
        <MethodBeaconLink
          href="/methods"
          event="home_methods_explore_all_click"
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Explore all {totalFamilyCount.toLocaleString()} method families →
        </MethodBeaconLink>
      </p>
    </section>
  );
}
