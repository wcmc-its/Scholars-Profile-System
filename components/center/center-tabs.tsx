/**
 * Underline-style tabs for the center page. Two tabs only — People (default)
 * and Publications. Same visual treatment as DeptTabs so the dept and center
 * pages feel consistent.
 */
import Link from "next/link";
import type { Route } from "next";

type TabKey = "people" | "publications";

export function CenterTabs({
  active,
  basePath,
  peopleCount,
  publicationsCount,
}: {
  active: TabKey;
  basePath: string;
  peopleCount: number;
  publicationsCount: number;
}) {
  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "people", label: "People", count: peopleCount },
    { key: "publications", label: "Publications", count: publicationsCount },
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
          t.key === "people"
            ? (basePath as Route)
            : (`${basePath}?tab=${t.key}` as Route);
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
