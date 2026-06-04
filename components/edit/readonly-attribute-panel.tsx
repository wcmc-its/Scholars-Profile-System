/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Item-level feedback). These
 * fields aren't suppressible here, so the panel shows only "Request a change":
 * the per-attribute triage (self-service link / route mailto / explanation) in a
 * modal. Link-only; no write path, no new authorization.
 */
"use client";

import { EditPanel } from "@/components/edit/edit-panel";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

export type ReadonlyAttributePanelProps = {
  attribute: RequestAttribute;
  /** The scholar whose profile this is — resolves `{cwid}` links (ORCID). */
  cwid: string;
  /** Panel heading, e.g. "Name & Title" or "Photo". */
  heading: string;
  /** The explanatory line under the heading. */
  description: string;
  /** Optional read-only values to echo (e.g. the current name). */
  fields?: ReadonlyArray<{ label: string; value: string | null }>;
};

export function ReadonlyAttributePanel({
  attribute,
  cwid,
  heading,
  description,
  fields,
}: ReadonlyAttributePanelProps) {
  return (
    <EditPanel
      slot="readonly-attribute-panel"
      data-attribute={attribute}
      attribute={attribute}
      heading={heading}
      description={description}
    >
      {fields && fields.length > 0 && (
        // Read-only display, not a form: a muted, borderless key/value grid with
        // both columns left-aligned (was a bordered `justify-between` table that
        // read as editable rows and pushed values to the right edge).
        <dl className="bg-muted/40 grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2 rounded-md px-4 py-3 text-sm">
          {fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="text-foreground font-medium">{f.value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Lighter than the former filled callout so the sourced values above carry
          more visual weight than the disclaimer (vision-round finding 4.7). */}
      <div className="border-border flex flex-col items-start gap-2 border-t pt-3">
        <p className="text-sm font-medium">This section is not editable.</p>
        <p className="text-muted-foreground text-sm">
          These fields come from WCM systems of record. Use Request a Change to fix one at its source.
        </p>
        <RequestAChangeDialog
          attribute={attribute}
          cwid={cwid}
          triggerTestId="request-a-change-toggle"
        />
      </div>
    </EditPanel>
  );
}
