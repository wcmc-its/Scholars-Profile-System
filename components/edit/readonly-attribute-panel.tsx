/**
 * The read-only (system-of-record) attribute panel — Name & Title, Photo
 * (#160 UI follow-up, `self-edit-launch-spec.md` § Item-level feedback). These
 * fields aren't suppressible here, so each row carries only "Request a change":
 * the per-attribute triage (self-service link / route mailto / explanation) in a
 * modal, pre-selected to that row's issue. Link-only; no write path, no new
 * authorization.
 *
 * Layout per the "Locked sections, revised" canvas (2026-09-23): a "From
 * <source>" badge in the header instead of a separate Source line, one
 * full-width hairline per row, and no "This section is not editable" footer.
 */
"use client";

import type { ReactNode } from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { Button } from "@/components/ui/button";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { fieldSource } from "@/lib/edit/field-sources";
import type { RequestAttribute } from "@/lib/edit/request-a-change";
import { cn } from "@/lib/utils";

/** One label / value / action row of a locked panel. Shared with the Email card
 *  so the three locked panels line up. `alignTop` is for a tall value (the
 *  title picker, the headshot) where baseline alignment would float the label. */
export function LockedRow({
  label,
  action,
  alignTop = false,
  children,
}: {
  label: string;
  action?: ReactNode;
  alignTop?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-apollo-border grid grid-cols-[140px_minmax(0,1fr)_max-content] gap-4 border-t py-3.5 text-sm",
        alignTop ? "items-start" : "items-baseline",
      )}
    >
      <dt className={cn("text-[#5c574d]", alignTop && "pt-3")}>{label}</dt>
      <dd>{children}</dd>
      <div className={cn("justify-self-end", alignTop && "pt-3")}>{action}</div>
    </div>
  );
}

export type ReadonlyAttributePanelProps = {
  attribute: RequestAttribute;
  /** The scholar whose profile this is: resolves `{cwid}` links (ORCID). */
  cwid: string;
  /** The scholar's display name, echoed into the routed change-request email. */
  scholarName: string;
  /** Panel heading, e.g. "Name & title" or "Photo". */
  heading: string;
  /** The explanatory line under the heading. */
  description: string;
  /** The rows. `null` renders as a muted "None on record"; a node lets one row
   *  carry a control (Title picker, #2719). `alignTop` for tall values. */
  fields: ReadonlyArray<{ label: string; value: ReactNode; issueId?: string; alignTop?: boolean }>;
};

export function ReadonlyAttributePanel({
  attribute,
  cwid,
  scholarName,
  heading,
  description,
  fields,
}: ReadonlyAttributePanelProps) {
  return (
    <EditPanel
      slot="readonly-attribute-panel"
      data-attribute={attribute}
      heading={heading}
      description={description}
      headerAction={<LockedBadge from={fieldSource(attribute)} />}
    >
      {/* Each row carries its own "Request a change", opening the router with
          that row's issue pre-selected (Paul, 2026-09-23). A row with no
          `issueId` opens the full issue list. */}
      <dl>
        {fields.map((f) => (
          <LockedRow
            key={f.label}
            label={f.label}
            alignTop={f.alignTop}
            action={
              <RequestAChangeDialog
                attribute={attribute}
                cwid={cwid}
                scholarName={scholarName}
                initialIssueId={f.issueId}
                trigger={(open) => (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0 text-[13px] whitespace-nowrap text-[#5c574d] hover:text-[#1f1b19]"
                    onClick={open}
                    aria-label={`Request a change to ${f.label}`}
                    data-testid={`request-a-change-row-${f.label.toLowerCase()}`}
                  >
                    Request a change
                  </Button>
                )}
              />
            }
          >
            {f.value ?? <span className="text-muted-foreground">None on record</span>}
          </LockedRow>
        ))}
      </dl>
    </EditPanel>
  );
}
