/**
 * The "Request a change" picker (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Item-level feedback). Renders one attribute's
 * issue list, each issue resolving to its action shape (self-service link /
 * route mailto / explanation). Shared by the read-only panels (inline) and the
 * per-row menu on editable panels (in a popover, carrying the item's label).
 *
 * Link-only — no write path, no new authorization. The route mailto carries the
 * item's label in the body so the office knows which item; the exact
 * subject/body format is deferred (operator), so a generic subject ships.
 */
"use client";

import { Flag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  getChangeConfig,
  resolveSelfServiceHref,
  type ChangeIssue,
  type RequestAttribute,
  type RouteAction,
} from "@/lib/edit/request-a-change";

function mailtoHref(action: RouteAction, itemLabel?: string): string {
  // Build the query by hand: URLSearchParams encodes spaces as "+", which mail
  // clients render literally in a mailto body (RFC 6068 wants %20).
  const parts = [`subject=${encodeURIComponent("Scholars profile correction request")}`];
  if (action.cc) parts.push(`cc=${encodeURIComponent(action.cc)}`);
  if (itemLabel) parts.push(`body=${encodeURIComponent(`Regarding: ${itemLabel}`)}`);
  return `mailto:${action.email}?${parts.join("&")}`;
}

export type RequestAChangePickerProps = {
  attribute: RequestAttribute;
  /** Resolves `{cwid}` self-service links (ORCID). */
  cwid: string;
  /** The specific item's label (per-row), prefilled into route emails. */
  itemLabel?: string;
};

export function RequestAChangePicker({ attribute, cwid, itemLabel }: RequestAChangePickerProps) {
  const config = getChangeConfig(attribute);
  return (
    <div className="flex flex-col gap-2" data-slot="request-a-change-picker">
      <p className="text-sm font-medium">{config.heading}</p>
      <ul className="border-border divide-border divide-y rounded-md border bg-[var(--background)]">
        {config.issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} cwid={cwid} itemLabel={itemLabel} />
        ))}
      </ul>
    </div>
  );
}

/** A compact per-row trigger that opens the picker in a popover. */
export function RequestAChangeMenu({ attribute, cwid, itemLabel }: RequestAChangePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-testid="request-a-change-trigger">
          <Flag />
          Request a change
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <RequestAChangePicker attribute={attribute} cwid={cwid} itemLabel={itemLabel} />
      </PopoverContent>
    </Popover>
  );
}

function IssueRow({
  issue,
  cwid,
  itemLabel,
}: {
  issue: ChangeIssue;
  cwid: string;
  itemLabel?: string;
}) {
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
          <a className="text-[var(--apollo-maroon)] text-xs underline" href={mailtoHref(action, itemLabel)}>
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
