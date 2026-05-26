/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Item-level feedback). These
 * fields aren't suppressible here, so the panel shows only "Request a change":
 * a per-attribute triage where each issue resolves to one of three shapes —
 * fix-it-yourself (self-service link), email-the-owner (mailto), or an
 * explanation. Link-only; no write path, no new authorization.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  getChangeConfig,
  resolveSelfServiceHref,
  type ChangeIssue,
  type RequestAttribute,
  type RouteAction,
} from "@/lib/edit/request-a-change";

export type ReadonlyAttributePanelProps = {
  attribute: RequestAttribute;
  /** The scholar whose profile this is — used to resolve `{cwid}` links (ORCID). */
  cwid: string;
  /** Panel heading, e.g. "Name & Title" or "Photo". */
  heading: string;
  /** The explanatory line under the heading. */
  description: string;
  /** Optional read-only values to echo (e.g. the current name). */
  fields?: ReadonlyArray<{ label: string; value: string | null }>;
};

// The subject/body format for routed emails is deferred (operator, 2026-05);
// a generic subject ships until then.
function mailtoHref(action: RouteAction): string {
  const params = new URLSearchParams({ subject: "Scholars profile correction request" });
  if (action.cc) params.set("cc", action.cc);
  return `mailto:${action.email}?${params.toString()}`;
}

export function ReadonlyAttributePanel({
  attribute,
  cwid,
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

        {pickerOpen && (
          <div className="flex flex-col gap-2" data-slot="request-a-change-picker">
            <p className="text-sm font-medium">{config.heading}</p>
            <ul className="border-border divide-border divide-y rounded-md border bg-[var(--background)]">
              {config.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} cwid={cwid} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function IssueRow({ issue, cwid }: { issue: ChangeIssue; cwid: string }) {
  const { action } = issue;
  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-testid={`rac-issue-${issue.id}`}>
      <span className="text-sm font-medium">{issue.label}</span>
      {action.kind === "self-service" && (
        <>
          <span className="text-muted-foreground text-xs">{action.instruction}</span>
          <a
            className="text-[var(--apollo-maroon)] text-xs underline"
            href={resolveSelfServiceHref(action.href, cwid)}
            target="_blank"
            rel="noreferrer"
          >
            Open {action.tool}
          </a>
        </>
      )}
      {action.kind === "route" && (
        <>
          {action.note && <span className="text-muted-foreground text-xs">{action.note}</span>}
          <a className="text-[var(--apollo-maroon)] text-xs underline" href={mailtoHref(action)}>
            Email {action.office}
          </a>
        </>
      )}
      {action.kind === "explain" && (
        <>
          <span className="text-muted-foreground text-xs">{action.detail}</span>
          {action.fallbackEmail && (
            <a
              className="text-[var(--apollo-maroon)] text-xs underline"
              href={`mailto:${action.fallbackEmail}?subject=${encodeURIComponent("Scholars profile correction request")}`}
            >
              Still wrong? Contact us
            </a>
          )}
        </>
      )}
    </li>
  );
}
