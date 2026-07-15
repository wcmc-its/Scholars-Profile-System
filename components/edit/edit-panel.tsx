/**
 * The shared detail-panel container for every `/edit` attribute (#160 UI
 * follow-up §2.1 / vision-round T2.1). Before this, editable attributes used a
 * bordered/shadowed `<Card>` while sourced attributes used a bare `<section>` —
 * two visibly different chromes split by which rail item you clicked, with the
 * heading left-edge jumping ~24px between them and the `<Card>` elevation
 * falsely implying "more interactive". `EditPanel` gives ALL panels one flat,
 * consistent treatment:
 *
 *   - exactly one real `<h2 id="panel-heading">` (fixes the broken document
 *     outline a11y defect — Card titles were non-heading `<div>`s — and makes
 *     the panel heading the visually dominant element on the surface);
 *   - a symmetric provenance line: `Source: <system>` for sourced attributes,
 *     a positive "Yours to edit" badge for owned ones, so ownership is no
 *     longer communicated by a *noticed absence*;
 *   - a description slot and an optional trailing `headerAction` (e.g. a
 *     visibility status badge);
 *   - one consistent left inset (no x-jump).
 *
 * `<main>` carries `aria-labelledby="panel-heading"`, so the heading id is
 * stable and unique (only one panel renders per `?attr=` selection).
 */
import * as React from "react";

import { FieldSourceLine } from "@/components/edit/field-source-line";
import { cn } from "@/lib/utils";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

/** The stable heading id `<main aria-labelledby>` points at. */
export const EDIT_PANEL_HEADING_ID = "panel-heading";

export type EditPanelProps = {
  /** Panel title — rendered as the page's dominant `<h2>`. */
  heading: string;
  /** Heading id for `aria-labelledby`. Defaults to the shared constant. */
  headingId?: string;
  /**
   * Provenance cue under the heading. Pass `attribute` for a sourced field
   * ("Source: <system>") or `owned` for a scholar-editable one ("Yours to
   * edit"). Omitting both renders no cue.
   */
  attribute?: RequestAttribute;
  /** Override the "Source: <system>" text — for a multi-source panel like
   *  Funding ("InfoEd and NIH RePORTER"). Falls back to the attribute's single
   *  canonical source when omitted. */
  sourceLabel?: string;
  owned?: boolean;
  /** Explanatory line under the provenance cue. */
  description?: React.ReactNode;
  /** Optional element pinned to the top-right of the header (e.g. a status badge). */
  headerAction?: React.ReactNode;
  /** `data-slot` for tests/styling hooks (e.g. "overview-card"). */
  slot?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"section">, "children" | "className">;

export function EditPanel({
  heading,
  headingId = EDIT_PANEL_HEADING_ID,
  attribute,
  sourceLabel,
  owned = false,
  description,
  headerAction,
  slot = "edit-panel",
  className,
  children,
  ...rest
}: EditPanelProps) {
  // De-grey: a short tier accent bar under the heading — maroon for a
  // scholar-owned panel, slate for a WCM-sourced one — matching the rail's
  // per-group colour so a panel and its rail item read as the same tier.
  const accent = owned ? "bg-apollo-maroon" : attribute ? "bg-apollo-slate" : null;
  return (
    <section data-slot={slot} className={cn("flex flex-col gap-4", className)} {...rest}>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="text-xl font-semibold">
            {heading}
          </h2>
          {headerAction}
        </div>
        {accent && <span aria-hidden className={cn("h-1 w-10 rounded-full", accent)} />}
        {attribute ? (
          <FieldSourceLine attribute={attribute} label={sourceLabel} />
        ) : owned ? (
          <span
            data-slot="ownership-cue"
            className="bg-apollo-maroon/10 text-apollo-maroon inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-xs font-medium"
          >
            Yours to edit
          </span>
        ) : null}
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </header>
      {children}
    </section>
  );
}
