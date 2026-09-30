/**
 * TAXONOMY_SCHOLAR_CARDS — the selected rail item's scholars (subarea on topic
 * pages, family on method category pages): a "Scholars" heading with a muted
 * count, then the names as plain slate profile links in a wrapping row. No
 * cards, no avatars, no pick-to-filter (mockup `showSubNames`).
 *
 * No hooks and no db imports: the roster arrives from the existing scholars
 * routes via the row components that fetch it.
 */
import type { ReactNode } from "react";
import { profilePath } from "@/lib/profile-url";

export type NameListScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
};

export function ScholarNameList({
  scholars,
  countLabel,
  info,
  footer,
}: {
  scholars: NameListScholar[];
  /** The count shown beside the heading (defaults to the roster length). */
  countLabel?: string;
  /** Optional trailing control on the heading (e.g. a SectionInfoButton). */
  info?: ReactNode;
  /** Rendered after the names, in the same wrapping row ("+ N more →", "View all →"). */
  footer?: ReactNode;
}) {
  const shownCount = countLabel ?? scholars.length.toLocaleString();
  return (
    <section
      aria-label="Scholars"
      className="mb-10 flex min-w-0 flex-col gap-2"
      data-testid="scholar-name-list"
    >
      <div className="flex items-baseline gap-2.5">
        <h3 className="m-0 inline-flex items-center gap-1.5 text-xl font-medium">
          Scholars
          {info}
        </h3>
        <span className="text-muted-foreground text-sm tabular-nums">
          {shownCount}
        </span>
      </div>
      <ul className="flex min-w-0 flex-wrap gap-x-[18px] gap-y-1.5 text-[14.5px]">
        {scholars.map((s) => (
          <li key={s.cwid} className="min-w-0">
            <a
              href={profilePath(s.slug)}
              className="inline-flex min-h-11 items-center text-[var(--color-accent-slate)] underline-offset-4 [overflow-wrap:anywhere] hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)] sm:min-h-0"
            >
              {s.preferredName}
            </a>
          </li>
        ))}
        {footer ? <li className="min-w-0">{footer}</li> : null}
      </ul>
    </section>
  );
}
