/**
 * Underline-style tabs for the dept / division page. Server Component —
 * renders <Link>s using the page's `?tab=` searchParam. URL-state means
 * deep links + back-button work without client JS, and SSR is preserved.
 *
 * Tabs with a count of 0 are visually disabled (tertiary text, cursor
 * not-allowed) and rendered as a non-link <span>.
 *
 * §16: the Grants tab is removed from dept pages. Callers omit
 * `grantsCount` to suppress the tab entirely. Division pages still pass
 * it (until slice 3 of issue #52).
 *
 * Department pages may append a countless "Collaboration" tab (Unit Page v2 —
 * last, after Grants) via `showCollaboration`; division pages leave it unset.
 */
import Link from "next/link";
import type { Route } from "next";

type TabKey = "scholars" | "publications" | "grants" | "collaboration";

type Tab = {
  key: TabKey;
  label: string;
  /** `undefined` ⇒ a countless tab (never disabled, no count badge). */
  count?: number;
};

export function DeptTabs({
  active,
  basePath,
  scholarsCount,
  publicationsCount,
  grantsCount,
  showCollaboration = false,
}: {
  active: TabKey;
  basePath: string;
  scholarsCount: number;
  publicationsCount: number;
  /** Omit to suppress the Grants tab entirely (§16, dept pages). */
  grantsCount?: number;
  /** Append the countless Collaboration tab (department pages only). */
  showCollaboration?: boolean;
}) {
  const tabs: Tab[] = [
    { key: "scholars", label: "Scholars", count: scholarsCount },
    { key: "publications", label: "Publications", count: publicationsCount },
    ...(grantsCount !== undefined
      ? [{ key: "grants" as const, label: "Grants", count: grantsCount }]
      : []),
    ...(showCollaboration
      ? [{ key: "collaboration" as const, label: "Collaboration" }]
      : []),
  ];

  return (
    // With Grants + Collaboration the row runs past a 390px phone's column: it
    // scrolls sideways INSIDE itself (scrollbar hidden) rather than the page.
    // `overflow-x-auto` clips y too, so the hairline is an inset shadow the tabs'
    // 2px underline paints over, not a border they overlap with `-mb-px` (same
    // fix as `CenterTabs`).
    <div
      role="tablist"
      className="mb-5 flex gap-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-apollo-border)] [scrollbar-width:none] sm:gap-7 [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const isDisabled = t.count === 0;
        const className = [
          // Unit Page v2: 14px normal weight; the count inherits the label
          // colour (slate when active, foreground otherwise).
          "inline-flex shrink-0 items-baseline gap-[7px] whitespace-nowrap py-3 text-[14px] transition-colors duration-[120ms] ease-out",
          isActive
            ? "border-b-2 border-apollo-slate text-apollo-slate"
            : "border-b-2 border-transparent",
          !isActive && !isDisabled ? "text-foreground hover:text-apollo-slate" : "",
          isDisabled
            ? "cursor-not-allowed text-[var(--color-text-tertiary)]"
            : "",
        ]
          .filter(Boolean)
          .join(" ");

        const content = (
          <>
            {t.label}
            {t.count !== undefined && (
              <span className="text-[13px]">
                {t.count.toLocaleString()}
              </span>
            )}
          </>
        );

        if (isDisabled) {
          return (
            <span key={t.key} role="tab" aria-disabled="true" className={className}>
              {content}
            </span>
          );
        }
        const href =
          t.key === "scholars"
            ? (`${basePath}#tab-content` as Route)
            : (`${basePath}?tab=${t.key}#tab-content` as Route);
        return (
          <Link
            key={t.key}
            href={href}
            role="tab"
            aria-selected={isActive}
            className={`${className} hover:no-underline`}
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}
