"use client";

/**
 * TAXONOMY_SCHOLAR_CARDS — the selected rail item's scholars (subarea on topic
 * pages, family on method category pages): a "Scholars" heading with a muted
 * count, then the scholars as avatar chips in a wrapping row — the same chip
 * the publication rows' author chips use, so a person reads the same way
 * everywhere on the page.
 *
 * Each chip is a profile link. With `popover`, it is also the trigger of the
 * `taxonomy-card` PersonPopover at `md`+ (scope count, recent papers, "Filter
 * publications →", "View profile"), and the picked scholar's chip is
 * highlighted while the others dim — the ScholarCardGrid behavior, in chip
 * form. Below `md` the chip is a plain profile link (no hover there).
 *
 * No db imports: the roster arrives from the existing
 * scholars routes via the row components that fetch it.
 */
import type { ComponentProps, ReactNode } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import type { ScholarCardPopover } from "@/components/taxonomy/scholar-card";
import { ScholarCardPickState } from "@/components/taxonomy/scholar-filter";
import { profilePath } from "@/lib/profile-url";

export type NameListScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
  identityImageEndpoint: string;
};

export function ScholarNameList({
  scholars,
  countLabel,
  info,
  footer,
  popover,
}: {
  scholars: NameListScholar[];
  /** The count shown beside the heading (defaults to the roster length). */
  countLabel?: string;
  /** Optional trailing control on the heading (e.g. a SectionInfoButton). */
  info?: ReactNode;
  /** Rendered after the chips, in the same wrapping row ("+ N more →", "View all →"). */
  footer?: ReactNode;
  /** Hover card scope; omitted ⇒ chips are plain profile links. */
  popover?: ScholarCardPopover;
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
      <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
        {scholars.map((s) => (
          <li key={s.cwid} className="min-w-0">
            {popover ? (
              <ScholarCardPickState cwid={s.cwid}>
                <ScholarChipLink scholar={s} className="inline-flex md:hidden" />
                <PersonPopover
                  cwid={s.cwid}
                  surface="taxonomy-card"
                  contextTopicSlug={popover.topicSlug}
                  contextTopicLabel={popover.label}
                  contextSupercategory={popover.supercategory}
                  contextFamilyLabel={popover.familyLabel}
                  filterable={popover.filterable}
                >
                  <ScholarChipLink scholar={s} className="hidden md:inline-flex" />
                </PersonPopover>
              </ScholarCardPickState>
            ) : (
              <ScholarChipLink scholar={s} className="inline-flex" />
            )}
          </li>
        ))}
        {footer ? <li className="min-w-0">{footer}</li> : null}
      </ul>
    </section>
  );
}

// Forwards the rest props (and ref, a prop in React 19): as the hover trigger's
// `asChild` child it must carry Radix's handlers and data-state onto the <a>.
// Chip skin = AuthorChipRow's default co-author chip, plus the pick highlight
// from ScholarCardPickState.
function ScholarChipLink({
  scholar,
  className,
  ...rest
}: {
  scholar: NameListScholar;
  className: string;
} & ComponentProps<"a">) {
  return (
    <a
      {...rest}
      href={profilePath(scholar.slug)}
      className={`${className} bg-background text-foreground max-w-full min-w-0 items-center gap-1.5 rounded-full border border-zinc-300 px-2 py-0.5 text-xs transition-colors hover:bg-zinc-50 data-[state=open]:bg-zinc-50 group-data-[pick=picked]/pick:border-apollo-slate group-data-[pick=picked]/pick:bg-apollo-slate-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]`}
    >
      <HeadshotAvatar
        size="sm"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
        className="shrink-0"
      />
      <span className="truncate">{scholar.preferredName}</span>
    </a>
  );
}
