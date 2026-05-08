/**
 * Underline-style tabs for the dept page. Server Component — renders three
 * <Link>s using the page's `?tab=` searchParam. URL-state means deep links
 * + back-button work without client JS, and SSR is preserved.
 *
 * Tabs with a count of 0 are visually disabled (tertiary text, cursor
 * not-allowed) and rendered as a non-link <span>.
 */
import Link from "next/link";
import type { Route } from "next";

type TabKey = "scholars" | "publications" | "grants";

type Tab = {
  key: TabKey;
  label: string;
  count: number;
};

export function DeptTabs({
  active,
  basePath,
  scholarsCount,
  publicationsCount,
  grantsCount,
}: {
  active: TabKey;
  basePath: string;
  scholarsCount: number;
  publicationsCount: number;
  grantsCount: number;
}) {
  const tabs: Tab[] = [
    { key: "scholars", label: "Scholars", count: scholarsCount },
    { key: "publications", label: "Publications", count: publicationsCount },
    { key: "grants", label: "Grants", count: grantsCount },
  ];

  return (
    <div
      role="tablist"
      className="mb-5 flex gap-7 border-b border-[var(--color-border)]"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const isDisabled = t.count === 0;
        const className = [
          "-mb-px py-2.5 text-sm transition-colors",
          isActive
            ? "border-b-2 border-[var(--color-accent-slate)] font-medium text-[var(--color-accent-slate)]"
            : "border-b-2 border-transparent",
          !isActive && !isDisabled
            ? "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            : "",
          isDisabled
            ? "cursor-not-allowed text-[var(--color-text-tertiary)]"
            : "",
        ]
          .filter(Boolean)
          .join(" ");

        const content = (
          <>
            {t.label}
            <span className="ml-1.5 text-[12px] text-[var(--color-text-tertiary)]">
              {t.count.toLocaleString()}
            </span>
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
