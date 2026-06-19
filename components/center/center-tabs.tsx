/**
 * Underline-style tabs for the center page. §16: Scholars (default) +
 * Publications. The Grants tab is removed; the Spotlight surface above
 * carries the "what's notable here" affordance. #1137 adds an optional
 * "Collaboration" tab (countless) for centers with a program taxonomy when the
 * flag is on.
 */
import Link from "next/link";
import type { Route } from "next";

type TabKey = "scholars" | "publications" | "collaboration";

export function CenterTabs({
  active,
  basePath,
  scholarsCount,
  publicationsCount,
  showCollaboration = false,
}: {
  active: TabKey;
  basePath: string;
  scholarsCount: number;
  publicationsCount: number;
  showCollaboration?: boolean;
}) {
  // `count: undefined` ⇒ a countless tab (never disabled, no count badge).
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "scholars", label: "Scholars", count: scholarsCount },
    { key: "publications", label: "Publications", count: publicationsCount },
    ...(showCollaboration
      ? [{ key: "collaboration" as const, label: "Collaboration" }]
      : []),
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
            {t.count !== undefined && (
              <span className="ml-1.5 text-[12px] text-[var(--color-text-tertiary)]">
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
