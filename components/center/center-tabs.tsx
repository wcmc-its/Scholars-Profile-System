/**
 * Underline-style tabs for the center page: Scholars (default), Publications,
 * Grants. §16 (#52, f978bbe8) dropped the tab when Spotlight replaced the
 * highlights rows; #556 re-enabled dept/division and left center parity to
 * #481(b); reinstated here with #2066 project grouping and #160/#481(b)
 * suppression. #1137 adds an optional
 * "Collaboration" tab (countless) for centers with a program taxonomy when the
 * flag is on.
 */
import Link from "next/link";
import type { Route } from "next";

type TabKey = "scholars" | "publications" | "grants" | "collaboration";

export function CenterTabs({
  active,
  basePath,
  scholarsCount,
  publicationsCount,
  grantsCount,
  showCollaboration = false,
  scholarsLabel = "Scholars",
}: {
  active: TabKey;
  basePath: string;
  scholarsCount: number;
  publicationsCount: number;
  grantsCount: number;
  showCollaboration?: boolean;
  /** "Members" when the count includes external (no-profile) members. */
  scholarsLabel?: string;
}) {
  // `count: undefined` ⇒ a countless tab (never disabled, no count badge).
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "scholars", label: scholarsLabel, count: scholarsCount },
    { key: "publications", label: "Publications", count: publicationsCount },
    { key: "grants", label: "Grants", count: grantsCount },
    ...(showCollaboration
      ? [{ key: "collaboration" as const, label: "Collaboration" }]
      : []),
  ];

  return (
    // Four tabs (Scholars / Publications / Grants / Collaboration) run ~480px,
    // past a 390px phone's 358px column: the row scrolls sideways INSIDE itself
    // (scrollbar hidden) rather than the page. `overflow-x-auto` clips y too, so
    // the hairline is an inset shadow the tabs' 2px underline paints over, not a
    // border they overlap with `-mb-px` (which would be clipped).
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
