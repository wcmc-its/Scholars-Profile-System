/**
 * `/methods` hub grid — the supercategory analog of
 * `components/home/browse-all-research-areas-grid.tsx`. Server Component renders
 * the method supercategories (those with at least one publicly-visible family) as
 * a multi-column masonry of GROUPS: each group is a supercategory heading (linking
 * to its page) above its families, and every family deep-links to that family on
 * the supercategory page via `?family={familySlug}` (which scrolls the panel into
 * view — UX feedback B5/B6). The deep-link carries the STABLE family slug, not the
 * bare re-minted `fam_NNNN` id, so cached links self-heal across A2 rebuilds (#940).
 * Empty `items` → an unavailable state.
 */
import Link from "next/link";
import type { SupercategoryHubEntry } from "@/lib/api/methods";
import { familySegmentFor } from "@/lib/method-url";

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

  const totalFamilies = items.reduce((sum, sc) => sum + sc.familyCount, 0);

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Browse all research methods</h2>
      <p className="mt-1 mb-6 text-[14px] text-muted-foreground">
        All {items.length} method categories at WCM — {totalFamilies.toLocaleString()}{" "}
        method families. Jump straight to any family.
      </p>
      <div className="gap-x-10 sm:columns-2 lg:columns-3">
        {items.map((sc) => (
          <div key={sc.id} className="mb-7 break-inside-avoid">
            <a
              href={`/methods/${sc.slug}`}
              className="group flex items-baseline justify-between gap-2"
            >
              <span className="text-base font-semibold text-foreground group-hover:underline">
                {sc.label}
              </span>
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {sc.familyCount.toLocaleString()}
              </span>
            </a>
            {sc.families.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-l border-border pl-3">
                {sc.families.map((f) => (
                  <li key={f.familyId}>
                    <a
                      href={`/methods/${sc.slug}?family=${encodeURIComponent(familySegmentFor(f.familyLabel, f.familyId))}`}
                      className="block text-sm leading-snug text-muted-foreground transition-colors hover:text-[var(--color-accent-slate)] hover:underline"
                    >
                      {f.familyLabel}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
