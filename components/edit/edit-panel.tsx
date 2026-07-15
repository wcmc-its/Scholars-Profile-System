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
import { Pencil } from "lucide-react";

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
  /**
   * Render as a SUBSECTION under a sibling panel's h2 — an eyebrow `<h3>` label
   * (rhyming with the rail's "FROM WCM RECORDS") instead of the dominant h2 +
   * brand rule. Gets its own heading id (default `${slot}-heading`) so a tab
   * that stacks several panels (Appointments) doesn't emit duplicate
   * `panel-heading` ids. The provenance cue (owned badge / Source line) stays.
   */
  subsection?: boolean;
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
  headingId,
  attribute,
  sourceLabel,
  owned = false,
  subsection = false,
  description,
  headerAction,
  slot = "edit-panel",
  className,
  children,
  ...rest
}: EditPanelProps) {
  // A subsection gets its own id so a tab stacking several panels doesn't emit
  // duplicate `panel-heading` ids — only the dominant panel keeps that id, which
  // `<main aria-labelledby="panel-heading">` points at.
  const resolvedHeadingId =
    headingId ?? (subsection ? `${slot}-heading` : EDIT_PANEL_HEADING_ID);
  return (
    <section data-slot={slot} className={cn("flex flex-col gap-4", className)} {...rest}>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          {subsection ? (
            <h3
              id={resolvedHeadingId}
              className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
            >
              {heading}
            </h3>
          ) : (
            <h2 id={resolvedHeadingId} className="text-xl font-semibold">
              {heading}
            </h2>
          )}
          {headerAction}
        </div>
        {/* Brand rule under the heading — the dominant panel only. Maroon is
            brand, so subsection eyebrows don't repeat it; provenance is carried
            by the badge below, not this rule. */}
        {!subsection && <span aria-hidden className="bg-apollo-maroon h-1 w-10 rounded-full" />}
        {attribute ? (
          <FieldSourceLine attribute={attribute} label={sourceLabel} />
        ) : owned ? (
          <span
            data-slot="ownership-cue"
            className="bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green-foreground inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
          >
            <Pencil className="size-3" aria-hidden />
            Yours to edit
          </span>
        ) : null}
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </header>
      {children}
    </section>
  );
}
