/**
 * The "Request a change" modal (#160 UI follow-up,
 * `docs/self-edit-request-change-modal.md`). Supersedes the popover-of-links
 * (`request-a-change-picker.tsx`). One Apollo-style modal that keeps the
 * three-shape routing brain from `lib/edit/request-a-change.ts`:
 *
 *   - `self-service` — primary action is a link to the owning tool (new tab);
 *   - `route` — a free-text box + Submit that composes a STRUCTURED `mailto:`
 *     (Phase 1: the user's own mail client sends; Phase 2 will POST to a
 *     server mailer + issue a receipt) and shows an in-dialog confirmation;
 *   - `explain` — an in-place explanation, optionally revealing a route box.
 *
 * Link/mailto only — no write path, no new authorization. Free text never
 * reaches a header field (subject/recipient are derived from server-trusted
 * config + a fixed attribute-label map), and CRLF is stripped from every
 * interpolated value before composition (header-injection guard).
 */
"use client";

import * as React from "react";
import { Flag } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  getChangeConfig,
  resolveSelfServiceHref,
  type RequestAttribute,
} from "@/lib/edit/request-a-change";

/** Human label per attribute — drives the dialog title + email subject. */
const ATTRIBUTE_LABEL: Record<RequestAttribute, string> = {
  "name-title": "Name & Title",
  photo: "Photo",
  appointments: "Appointments",
  education: "Education",
  funding: "Funding",
  publications: "Publications",
};

/** Strip CR/LF so a value can't break out of its field (header-injection guard). */
function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildMailto(opts: {
  email: string;
  cc?: string;
  attributeLabel: string;
  issueLabel: string;
  itemLabel?: string;
  sourceSystem?: string;
  detail: string;
}): string {
  // The subject is derived from a fixed map (never user free text), so no
  // header-injection vector. URLSearchParams renders spaces as "+", which mail
  // clients show literally; RFC 6068 wants %20 — so encode by hand.
  const subject = `Scholars profile correction — ${opts.attributeLabel}`;
  const lines = [
    `Issue: ${sanitize(opts.issueLabel)}`,
    `Item: ${opts.itemLabel ? sanitize(opts.itemLabel) : "(whole section)"}`,
  ];
  if (opts.sourceSystem) lines.push(`Source: ${sanitize(opts.sourceSystem)}`);
  lines.push("", sanitize(opts.detail) || "(no additional detail provided)", "");
  lines.push("— Sent from the WCM Scholars profile editor.");

  const parts = [`subject=${encodeURIComponent(subject)}`];
  if (opts.cc) parts.push(`cc=${encodeURIComponent(opts.cc)}`);
  parts.push(`body=${encodeURIComponent(lines.join("\n"))}`);
  return `mailto:${opts.email}?${parts.join("&")}`;
}

export type RequestAChangeDialogProps = {
  attribute: RequestAttribute;
  /** Resolves `{cwid}` self-service links (ORCID). */
  cwid: string;
  /** The specific row's label (entity panels); absent for section-level panels. */
  itemLabel?: string;
  /** Trigger `data-testid` (default `request-a-change-trigger`). */
  triggerTestId?: string;
};

export function RequestAChangeDialog({
  attribute,
  cwid,
  itemLabel,
  triggerTestId,
}: RequestAChangeDialogProps) {
  const config = getChangeConfig(attribute);
  const attributeLabel = ATTRIBUTE_LABEL[attribute];

  const [open, setOpen] = React.useState(false);
  const [issueId, setIssueId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState("");
  const [revealFallback, setRevealFallback] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  // Re-opening starts fresh.
  React.useEffect(() => {
    if (open) {
      setIssueId(null);
      setDetail("");
      setRevealFallback(false);
      setSubmitted(false);
      setConfirmDiscard(false);
    }
  }, [open]);

  const issue = config.issues.find((i) => i.id === issueId) ?? null;
  const action = issue?.action ?? null;

  // A `route` body, or an `explain` body once its fallback is revealed.
  const showRouteBox =
    action?.kind === "route" || (action?.kind === "explain" && revealFallback);
  const hasUnsavedText = showRouteBox && detail.trim().length > 0 && !submitted;

  function selectIssue(id: string) {
    // Switching issues discards any typed detail (edge case 2).
    setIssueId(id);
    setDetail("");
    setRevealFallback(false);
    setSubmitted(false);
  }

  // Single choke point for every close path (Esc / scrim / X / Cancel).
  function handleOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      return;
    }
    if (hasUnsavedText) {
      setConfirmDiscard(true);
      return;
    }
    setOpen(false);
  }

  // The recipient shown in the post-submit confirmation.
  const submitTarget: { email: string; office: string | null } | null =
    action?.kind === "route"
      ? { email: action.email, office: action.office }
      : action?.kind === "explain" && action.fallbackEmail
        ? { email: action.fallbackEmail, office: null }
        : null;

  function routeMailto(): string {
    if (action?.kind === "route") {
      return buildMailto({
        email: action.email,
        cc: action.cc,
        attributeLabel,
        issueLabel: issue!.label,
        itemLabel,
        sourceSystem: action.sourceSystem,
        detail,
      });
    }
    // explain → fallback
    if (action?.kind === "explain" && action.fallbackEmail) {
      return buildMailto({
        email: action.fallbackEmail,
        attributeLabel,
        issueLabel: issue!.label,
        itemLabel,
        detail,
      });
    }
    return "#";
  }

  const title = `Request a change — ${itemLabel ?? attributeLabel}`;
  const hasPrimary = action?.kind === "self-service" || showRouteBox;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={triggerTestId ?? "request-a-change-trigger"}
        onClick={() => setOpen(true)}
      >
        <Flag />
        Request a change
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent data-testid="request-a-change-dialog">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              We&apos;ll point you to the right place to fix it, or route it to the team that owns it.
            </DialogDescription>
          </DialogHeader>

          {/* ---- post-submit confirmation (route) ---- */}
          {submitted && submitTarget ? (
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              <p className="text-sm">
                Your email client should have opened a pre-filled message
                {submitTarget.office ? ` to ${submitTarget.office}` : ""}. If nothing
                opened, email{" "}
                <a className="underline" href={`mailto:${submitTarget.email}`}>
                  {submitTarget.email}
                </a>{" "}
                directly.
              </p>
            </div>
          ) : confirmDiscard ? (
            /* ---- unsaved-text discard guard (edge case 3) ---- */
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Discard your request?</p>
              <p className="text-muted-foreground text-sm">
                The detail you typed will be lost.
              </p>
            </div>
          ) : (
            /* ---- the form ---- */
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <p id={`rac-q-${attribute}`} className="text-sm font-medium">
                  {config.heading}
                </p>
                <RadioGroup
                  aria-labelledby={`rac-q-${attribute}`}
                  value={issueId ?? ""}
                  onValueChange={selectIssue}
                >
                  {config.issues.map((i) => (
                    <label
                      key={i.id}
                      htmlFor={`rac-${i.id}`}
                      data-testid={`rac-issue-${i.id}`}
                      className="flex cursor-pointer items-start gap-2 py-1"
                    >
                      <RadioGroupItem id={`rac-${i.id}`} value={i.id} className="mt-0.5" />
                      <span className="text-sm">{i.label}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              {/* contextual body for the selected issue */}
              {action?.kind === "self-service" && (
                <p className="text-muted-foreground text-sm">{action.instruction}</p>
              )}

              {action?.kind === "route" && action.note && (
                <p className="text-muted-foreground text-sm">{action.note}</p>
              )}

              {action?.kind === "explain" && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">{action.detail}</p>
                  {action.fallbackEmail && !revealFallback && (
                    <button
                      type="button"
                      className="text-[var(--apollo-maroon)] w-fit text-sm hover:underline"
                      onClick={() => setRevealFallback(true)}
                    >
                      Still wrong? Email us
                    </button>
                  )}
                </div>
              )}

              {showRouteBox && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="rac-detail" className="text-sm font-medium">
                    Add any detail (optional)
                  </label>
                  <Textarea
                    id="rac-detail"
                    value={detail}
                    onChange={(e) => setDetail(e.target.value)}
                    placeholder="What should change, and to what?"
                    rows={4}
                  />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {submitted ? (
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : confirmDiscard ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  autoFocus
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setConfirmDiscard(false);
                    setOpen(false);
                  }}
                >
                  Discard
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  {hasPrimary ? "Cancel" : "Close"}
                </Button>
                {action?.kind === "self-service" && (
                  <Button asChild>
                    <a
                      href={resolveSelfServiceHref(action.href, cwid)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpen(false)}
                    >
                      Fix it in {action.tool}
                    </a>
                  </Button>
                )}
                {showRouteBox && (
                  <Button asChild data-testid="request-a-change-submit">
                    <a href={routeMailto()} onClick={() => setSubmitted(true)}>
                      Submit
                    </a>
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
