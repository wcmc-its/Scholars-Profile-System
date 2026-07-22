"use client";

/**
 * Sub-tabs on `/edit/find-researchers`, shown only while `OPPORTUNITY_URL_INTAKE`
 * is on (the page renders a bare `<FindResearchers />` otherwise, so a flag-off
 * env never sees a tab strip):
 *
 *   - **Browse** (default) — the reverse matcher, exactly as before.
 *   - **Submissions** — the submit-a-URL intake form + the whole team's queue
 *     history (`OpportunityIntakePanel`), promoted from a below-the-fold panel
 *     to its own surface so staff actually find it.
 *
 * The active tab lives in the URL (`?tab=submissions`), mirroring the `?opp=`
 * convention inside `FindResearchers`: deep-linkable, and browser Back returns
 * to the previous tab. The rest of the query is preserved across switches so
 * Browse → Submissions → Browse lands back on a drilled-in opportunity. The
 * page is force-dynamic, so `useSearchParams` needs no Suspense boundary.
 *
 * Discoverability was the point of this change, so Browse keeps a small
 * "Not in the list? Submit a URL" affordance that jumps to Submissions.
 */
import Link from "next/link";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";

import { FindResearchers } from "@/components/edit/find-researchers";
import { OpportunityIntakePanel } from "@/components/edit/opportunity-intake-panel";

type TabKey = "browse" | "submissions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "browse", label: "Browse" },
  { key: "submissions", label: "Submissions" },
];

export function FindResearchersTabs({ grantMatcha = false }: { grantMatcha?: boolean } = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active: TabKey = searchParams.get("tab") === "submissions" ? "submissions" : "browse";

  // Keep the rest of the query (notably `?opp=`) when switching tabs; Browse
  // is the default, so its href simply drops the `tab` param.
  const hrefFor = (tab: TabKey): Route => {
    const params = new URLSearchParams(searchParams);
    if (tab === "submissions") params.set("tab", "submissions");
    else params.delete("tab");
    const qs = params.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };

  return (
    <div data-slot="find-researchers-tabs">
      <div role="tablist" className="mb-5 flex gap-7 border-b border-[var(--color-border)]">
        {TABS.map((t) => {
          const isActive = t.key === active;
          const className = [
            "-mb-px py-2.5 text-sm transition-colors border-b-2",
            isActive
              ? "border-[var(--color-accent-slate)] font-medium text-[var(--color-accent-slate)]"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline",
          ].join(" ");
          return (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              role="tab"
              aria-selected={isActive}
              className={className}
              data-testid={`find-researchers-tab-${t.key}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      {active === "browse" ? (
        <>
          <FindResearchers grantMatcha={grantMatcha} />
          <p className="text-muted-foreground mt-8 text-sm" data-slot="intake-affordance">
            Not in the list?{" "}
            <Link
              href={hrefFor("submissions")}
              className="text-[var(--color-accent-slate)] underline decoration-dotted underline-offset-2"
            >
              Submit a URL
            </Link>{" "}
            and the pipeline will scrape, classify, and score it.
          </p>
        </>
      ) : (
        <OpportunityIntakePanel />
      )}
    </div>
  );
}
