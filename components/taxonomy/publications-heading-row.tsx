/**
 * The publication feeds' toolbar (topic feed + method family feed), per the
 * mockup: a "Publications" h3 with a muted count, the Show / Sort controls on
 * the SAME row pushed right, and a hairline divider under the row. Below `sm`
 * the controls wrap under the heading rather than overflow.
 *
 * Presentational only (no hooks); the feeds own the controls' state.
 */
import type { ReactNode } from "react";

export function PublicationsHeadingRow({
  countLabel,
  badge,
  children,
}: {
  /** Muted text beside the heading ("1,234", "12 of 40 articles"); null while loading. */
  countLabel: string | null;
  /** Inline after the heading text (e.g. the curated-sort tag). */
  badge?: ReactNode;
  /** The Show / Sort controls. */
  children: ReactNode;
}) {
  return (
    <header
      className="border-apollo-border flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3"
      data-testid="publications-heading-row"
    >
      <h3 className="m-0 flex items-center gap-2 text-xl font-medium">
        <span>Publications</span>
        {badge}
      </h3>
      <span
        className="text-muted-foreground text-sm tabular-nums"
        data-testid="publications-count"
      >
        {countLabel ?? ""}
      </span>
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">
        {children}
      </div>
    </header>
  );
}
