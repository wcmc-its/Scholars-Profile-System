/**
 * The "Request a change" modal (#160 UI follow-up,
 * `docs/self-edit-request-change-modal.md`). Supersedes the popover-of-links.
 * A ROUTER, not a form: pick one issue and the modal resolves it to a
 * path-specific action whose footer verb matches —
 *
 *   - `self-service` — primary opens the owning tool (new tab); the callout
 *     gives the precise step. Verb e.g. "Add by PMID", "Update in Web Directory".
 *   - `route` — a free-text box + a verb-named Submit that composes a STRUCTURED
 *     `mailto:` (Phase 1: the user's own client sends; Phase 2 will POST to a
 *     server mailer + issue a receipt). Verb e.g. "Report correction".
 *   - `explain` — an honest dead-end: the callout says what WILL happen (e.g.
 *     auto-pickup if later indexed), the verb is "Got it" (no request is filed).
 *     If it carries a fallback, "Still wrong?" reveals a route box.
 *
 * The guidance for the selected issue renders in a callout directly under its
 * row, so it reads as a response to the choice. Link/mailto only — no write
 * path, no new authorization; CRLF is stripped from every interpolated value
 * before composition (header-injection guard).
 */
"use client";

import * as React from "react";
import { ArrowRight, Flag, Info } from "lucide-react";

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
import { cn } from "@/lib/utils";
import {
  getChangeConfig,
  resolveSelfServiceHref,
  type ChangeAction,
  type RequestAttribute,
} from "@/lib/edit/request-a-change";

/** Human label per attribute — drives the email subject + "Regarding" line. */
const ATTRIBUTE_LABEL: Record<RequestAttribute, string> = {
  "name-title": "Name & Title",
  photo: "Photo",
  appointments: "Appointments",
  education: "Education",
  funding: "Funding",
  publications: "Publications",
};

/** The footer verb for an action (its config `cta`, else a sensible default). */
function ctaFor(action: ChangeAction, fallbackRevealed: boolean): string {
  if (action.kind === "self-service") return action.cta ?? `Open ${action.tool}`;
  if (action.kind === "route") return action.cta ?? `Email ${action.office}`;
  return fallbackRevealed ? "Email us" : (action.cta ?? "Got it");
}

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
  // Subject is derived from a fixed map (never user free text) — no injection
  // vector. URLSearchParams renders spaces as "+", which mail clients show
  // literally; RFC 6068 wants %20, so encode by hand.
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

  const cta = action ? ctaFor(action, revealFallback) : null;
  const isAck = action?.kind === "explain" && !revealFallback; // dead-end "Got it"

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
          <DialogHeader className="gap-1 text-left">
            <DialogTitle className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Request a change
            </DialogTitle>
            {itemLabel && (
              <p className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground shrink-0">Regarding</span>
                <span title={itemLabel} className="line-clamp-1 font-medium">
                  {itemLabel}
                </span>
              </p>
            )}
          </DialogHeader>

          {submitted && submitTarget ? (
            /* ---- post-submit confirmation (route) ---- */
            <div className="flex flex-col gap-2" role="status" aria-live="polite">
              <p className="text-base font-medium">Thanks — here&apos;s what happens next.</p>
              <p className="text-muted-foreground text-sm">
                Your email client should have opened a pre-filled message
                {submitTarget.office ? ` to ${submitTarget.office}` : ""}. If nothing
                opened, email{" "}
                <a className="text-[var(--apollo-maroon)] underline" href={`mailto:${submitTarget.email}`}>
                  {submitTarget.email}
                </a>{" "}
                directly.
              </p>
            </div>
          ) : confirmDiscard ? (
            /* ---- unsaved-text discard guard (edge case 3) ---- */
            <div className="flex flex-col gap-2">
              <p className="text-base font-medium">Discard your request?</p>
              <p className="text-muted-foreground text-sm">The detail you typed will be lost.</p>
            </div>
          ) : (
            /* ---- the router ---- */
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <p id={`rac-q-${attribute}`} className="text-base font-medium">
                  {config.heading}
                </p>
                <DialogDescription>
                  Pick one — we&apos;ll point you to the right place, or route it to the team that
                  owns it.
                </DialogDescription>
              </div>

              <RadioGroup
                aria-labelledby={`rac-q-${attribute}`}
                value={issueId ?? ""}
                onValueChange={selectIssue}
                className="gap-1.5"
              >
                {config.issues.map((i) => {
                  const selected = i.id === issueId;
                  const a = i.action;
                  const hint = a.kind === "explain" ? null : ctaFor(a, false);
                  return (
                    <div
                      key={i.id}
                      data-testid={`rac-issue-${i.id}`}
                      className={cn(
                        "overflow-hidden rounded-md border transition-colors",
                        selected
                          ? "border-[var(--apollo-maroon)] bg-[var(--apollo-maroon)]/[0.04]"
                          : "border-border",
                      )}
                    >
                      <label
                        htmlFor={`rac-${i.id}`}
                        className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5"
                      >
                        <RadioGroupItem id={`rac-${i.id}`} value={i.id} />
                        <span className="flex-1 text-sm">{i.label}</span>
                        {!selected && hint && (
                          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                            {hint}
                            <ArrowRight className="size-3" />
                          </span>
                        )}
                      </label>

                      {selected && (
                        <div className="border-border flex flex-col gap-2 border-t px-3 py-3">
                          {a.kind === "self-service" && (
                            <p className="text-muted-foreground text-sm">{a.instruction}</p>
                          )}
                          {a.kind === "route" && a.note && (
                            <p className="text-muted-foreground text-sm">{a.note}</p>
                          )}
                          {a.kind === "explain" && (
                            <>
                              <div className="flex gap-2">
                                <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                                <p className="text-sm">{a.detail}</p>
                              </div>
                              {a.fallbackEmail && !revealFallback && (
                                <button
                                  type="button"
                                  className="text-[var(--apollo-maroon)] w-fit text-sm hover:underline"
                                  onClick={() => setRevealFallback(true)}
                                >
                                  Still wrong? Email us
                                </button>
                              )}
                            </>
                          )}

                          {selected && showRouteBox && (
                            <div className="flex flex-col gap-1.5">
                              <label htmlFor="rac-detail" className="text-sm font-medium">
                                Add any detail (optional)
                              </label>
                              <Textarea
                                id="rac-detail"
                                value={detail}
                                onChange={(e) => setDetail(e.target.value)}
                                placeholder="What should change, and to what?"
                                rows={3}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </RadioGroup>
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
                  {action ? "Cancel" : "Close"}
                </Button>
                {action?.kind === "self-service" && (
                  <Button asChild data-testid="request-a-change-open">
                    <a
                      href={resolveSelfServiceHref(action.href, cwid)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpen(false)}
                    >
                      {cta}
                    </a>
                  </Button>
                )}
                {showRouteBox && (
                  <Button asChild data-testid="request-a-change-submit">
                    <a href={routeMailto()} onClick={() => setSubmitted(true)}>
                      {cta}
                    </a>
                  </Button>
                )}
                {isAck && (
                  <Button
                    type="button"
                    data-testid="request-a-change-ack"
                    onClick={() => setOpen(false)}
                  >
                    {cta}
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
