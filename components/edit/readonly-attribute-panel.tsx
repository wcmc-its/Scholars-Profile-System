/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Item-level feedback). These
 * fields aren't suppressible here, so the panel shows only "Request a change":
 * the per-attribute triage (self-service link / route mailto / explanation) in a
 * modal. Link-only; no write path, no new authorization.
 */
"use client";

import { Lock } from "lucide-react";

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
      <span className="bg-apollo-lock-bg border-apollo-border text-muted-foreground inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
        <Lock className="size-3" aria-hidden />
        Locked — managed at its source
      </span>

      {fields && fields.length > 0 && (
        // Read-only display, not a form: a 2-col label/value def-list with row
        // hairlines (was a muted borderless grid). Label left, value emphasized —
        // matches the console mockup's locked-attribute treatment.
        <dl className="border-apollo-border grid grid-cols-[max-content_1fr] gap-x-8 border-t text-sm">
          {fields.map((f) => (
            <div key={f.label} className="border-apollo-border contents [&>*]:border-b [&>*]:py-3.5">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="text-foreground font-medium">{f.value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Lighter than the former filled callout so the sourced values above carry
          more visual weight than the disclaimer (vision-round finding 4.7). */}
      <div className="border-apollo-border flex flex-col items-start gap-2 border-t pt-3">
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
