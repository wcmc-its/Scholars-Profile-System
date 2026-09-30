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
import { MethodFinder } from "@/components/home/method-finder";
import { SectionHeading } from "@/components/home/section-heading";
import type { HomeMethodCategories } from "@/lib/api/home";

export function BrowseByMethodSection({ data }: { data: HomeMethodCategories }) {
  const { categories, categoryCount, totalFamilyCount } = data;
  if (categories.length === 0) return null;
  // "Other Methods" is the catch-all; it sorts last, the rest A–Z.
  const sorted = [...categories].sort(
    (a, b) => Number(a.label === "Other Methods") - Number(b.label === "Other Methods") || a.label.localeCompare(b.label),
  );

  return (
    <section aria-labelledby="browse-by-method-heading" className="mt-18 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_420px]">
          <SectionHeading id="browse-by-method-heading">Browse methods &amp; tools</SectionHeading>
          <p className="text-muted-foreground mt-1 text-[14px]">
            {totalFamilyCount.toLocaleString()} method families used at WCM, from instruments and assays to
            datasets and computational methods, grouped into {categoryCount} categories.
          </p>
        </div>
        <MethodFinder />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((c) => (
          <MethodBeaconLink
            key={c.slug}
            href={`/methods/${c.slug}`}
            event="home_method_category_click"
            slug={c.slug}
            aria-label={`${c.label}, ${c.familyCount} method families`}
            className="group border-apollo-border bg-apollo-surface hover:border-apollo-border-strong focus-visible:border-apollo-border-strong hover:shadow-[0_2px_4px_rgba(34,30,28,.06),0_4px_12px_rgba(34,30,28,.06)] focus-visible:shadow-[0_2px_4px_rgba(34,30,28,.06),0_4px_12px_rgba(34,30,28,.06)] block rounded-[var(--apollo-radius-card)] border px-[18px] py-4 shadow-[var(--apollo-shadow-card)] transition-[border-color,box-shadow] duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apollo-ring)]"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-base font-medium text-foreground transition-colors duration-[120ms] ease-out group-hover:text-apollo-slate group-focus-visible:text-apollo-slate">
                {c.label}
              </span>
              <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                {c.familyCount.toLocaleString()} {c.familyCount === 1 ? "family" : "families"}
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

      <p className="text-sm">
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
