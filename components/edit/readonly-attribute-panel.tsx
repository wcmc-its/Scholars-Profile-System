/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Request a Change). These
 * fields are directory-authoritative and not suppressible, so the panel shows
 * *only* "Request a Change": a per-attribute triage that names the issue type
 * and routes it to the owning office (never a generic mailbox, never an
 * override here). Link-only — no write path, no new authorization.
 *
 * Destinations are `pending` until the operator supplies them (D6); a pending
 * route renders a graceful "routing to be configured" note naming the office,
 * so the panel ships before the addresses land.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  getChangeConfig,
  type ChangeIssue,
  type RequestAttribute,
  type RequestDestination,
} from "@/lib/edit/request-a-change";

export type ReadonlyAttributePanelProps = {
  attribute: RequestAttribute;
  /** Panel heading, e.g. "Name & Title" or "Photo". */
  heading: string;
  /** The explanatory line under the heading. */
  description: string;
  /** Optional read-only values to echo (e.g. the current name). */
  fields?: ReadonlyArray<{ label: string; value: string | null }>;
};

export function ReadonlyAttributePanel({
  attribute,
  heading,
  description,
  fields,
}: ReadonlyAttributePanelProps) {
  const config = getChangeConfig(attribute);
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
          To correct one of these, use Request a Change — it routes to the team that owns the data rather
          than overriding it here.
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

        {pickerOpen && (
          <div className="flex flex-col gap-2" data-slot="request-a-change-picker">
            <p className="text-sm font-medium">{config.heading}</p>
            <ul className="border-border divide-border divide-y rounded-md border bg-[var(--background)]">
              {config.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function IssueRow({ issue }: { issue: ChangeIssue }) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-testid={`rac-issue-${issue.id}`}>
      <span className="text-sm">{issue.label}</span>
      {issue.action.kind === "hide" ? (
        <span className="text-muted-foreground text-xs">{issue.action.note}</span>
      ) : (
        <DestinationLine office={issue.action.route.office} destination={issue.action.route.destination} />
      )}
    </li>
  );
}

function DestinationLine({ office, destination }: { office: string; destination: RequestDestination }) {
  if (destination.type === "email") {
    const href = `mailto:${destination.address}${destination.subjectHint ? `?subject=${encodeURIComponent(destination.subjectHint)}` : ""}`;
    return (
      <a className="text-[var(--apollo-maroon)] text-xs underline" href={href}>
        Email {office}
      </a>
    );
  }
  if (destination.type === "url") {
    return (
      <a className="text-[var(--apollo-maroon)] text-xs underline" href={destination.href} target="_blank" rel="noreferrer">
        {office} →
      </a>
    );
  }
  if (destination.type === "instruction") {
    return <span className="text-muted-foreground text-xs">{destination.text}</span>;
  }
  // pending — D6 not yet supplied.
  return (
    <span className="text-muted-foreground text-xs italic">
      Routes to {office} (contact details coming soon).
    </span>
  );
}
