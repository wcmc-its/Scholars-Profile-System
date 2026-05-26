/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Item-level feedback). These
 * fields aren't suppressible here, so the panel shows only "Request a change":
 * the per-attribute triage (self-service link / route mailto / explanation),
 * expanded inline. Link-only; no write path, no new authorization.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { RequestAChangePicker } from "@/components/edit/request-a-change-picker";
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
  const [pickerOpen, setPickerOpen] = React.useState(false);

  return (
    <section data-slot="readonly-attribute-panel" data-attribute={attribute} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </header>

      {fields && fields.length > 0 && (
        <dl className="border-border divide-border divide-y rounded-md border">
          {fields.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground text-sm">{f.label}</dt>
              <dd className="text-sm font-medium">{f.value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="bg-muted/40 border-border flex flex-col gap-3 rounded-md border p-4">
        <p className="text-sm font-medium">This section is not editable.</p>
        <p className="text-muted-foreground text-sm">
          These fields come from WCM systems of record. Use Request a Change to fix one at its source.
        </p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPickerOpen((o) => !o)}
            aria-expanded={pickerOpen}
            data-testid="request-a-change-toggle"
          >
            Request a Change
          </Button>
        </div>

        {pickerOpen && <RequestAChangePicker attribute={attribute} cwid={cwid} />}
      </div>
    </section>
  );
}
