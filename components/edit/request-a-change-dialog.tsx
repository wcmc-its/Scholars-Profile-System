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
 * The dialog is a FIXED SHELL: the header (kicker + close X) and footer (one
 * destination-labelled action) are pinned and only the option list scrolls, so
 * an expanded row can never push them out of the viewport. The guidance for the
 * selected issue renders in a callout under its row, so it reads as a response
 * to the choice. Link/mailto only — no write path, no new authorization; CRLF is
 * stripped from every interpolated value before composition (header-injection
 * guard).
 */
"use client";

import * as React from "react";
import { ArrowRight, Flag, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { PubTitle } from "@/components/publication/pub-html";
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
  appointments: "Positions & appointments",
  education: "Education",
  funding: "Funding",
  "funding-reporter": "Funding",
  publications: "Publications",
  "org-unit": "Org Unit",
  coi: "Conflicts of Interest",
  mentees: "Mentees",
  "profile-url": "Profile URL",
};

/** The footer verb for an action (its config `cta`, else a sensible default). */
function ctaFor(action: ChangeAction, fallbackRevealed: boolean): string {
  if (action.kind === "self-service") return action.cta ?? `Open ${action.tool}`;
  if (action.kind === "route") return action.cta ?? `Send to ${action.office}`;
  return fallbackRevealed ? "Email us" : (action.cta ?? "Got it");
}

/**
 * The quiet caption on the SELECTED row — demotes "where this goes" to a label
 * so it never competes with the footer's single action (the mixed-signal fix).
 */
function captionFor(action: ChangeAction): string | null {
  if (action.kind === "self-service") return `Managed in ${action.tool}`;
  if (action.kind === "route") return `Routes to ${action.office}`;
  return null; // explain — the body carries the explanation; no destination caption
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
  /**
   * Pre-select this issue when the dialog opens (e.g. a per-row "Not mine?"
   * affordance opening straight onto `publication-not-mine`). Defaults to no
   * selection (the scholar picks). The issue must belong to `attribute`'s config.
   */
  initialIssueId?: string;
  /**
   * Render a custom trigger instead of the default "Request a change" outline
   * button. Receives an `open` callback to wire to the element's click. Used for
   * the quiet per-row "Not mine?" affordance (vision-round finding 4.9 — not a
   * third equal-weight button).
   */
  trigger?: (open: () => void) => React.ReactNode;
};

export function RequestAChangeDialog({
  attribute,
  cwid,
  itemLabel,
  triggerTestId,
  initialIssueId,
  trigger,
}: RequestAChangeDialogProps) {
  const config = getChangeConfig(attribute);
  const attributeLabel = ATTRIBUTE_LABEL[attribute];

  const [open, setOpen] = React.useState(false);
  const [issueId, setIssueId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState("");
  const [revealFallback, setRevealFallback] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  /** How the request was sent — drives the confirmation copy. */
  const [sentVia, setSentVia] = React.useState<"server" | "mailto" | null>(null);
  /** Opt-out of the courtesy email receipt (default = receipt sent). */
  const [noReceipt, setNoReceipt] = React.useState(false);
  /** The selected row — scrolled into view when it expands, so a row low in the
   *  list doesn't hide its textarea below the fold of the scrolling body. */
  const selectedRowRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (open) {
      setIssueId(initialIssueId ?? null);
      setDetail("");
      setRevealFallback(false);
      setSubmitted(false);
      setConfirmDiscard(false);
      setSending(false);
      setSentVia(null);
      setNoReceipt(false);
    }
  }, [open, initialIssueId]);

  // Keep the just-expanded row visible inside the scrolling list.
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [issueId, revealFallback]);

  const issue = config.issues.find((i) => i.id === issueId) ?? null;
  const action = issue?.action ?? null;

  const showRouteBox =
    action?.kind === "route" || (action?.kind === "explain" && revealFallback);
  const hasUnsavedText = showRouteBox && detail.trim().length > 0 && !submitted;

  function selectIssue(id: string) {
    // Don't switch issues while a route submit is in flight: the resolving POST
    // flips `submitted` against the current selection, so a mid-flight switch
    // would render a stale / wrong-office confirmation. The list re-enables
    // once `sending` clears.
    if (sending) return;
    // Switching issues discards any typed detail (edge case 2).
    setIssueId(id);
    setDetail("");
    setRevealFallback(false);
    setSubmitted(false);
    setSentVia(null);
    setNoReceipt(false);
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

  /**
   * Submit a `route` request. Phase 2: POST to the server mailer; on success the
   * confirmation reads "Request sent." On ANY non-2xx (incl. `503 send_disabled`
   * while the mailer is dark) or a network error, fall back to the Phase-1
   * `mailto:` + its banner — so behavior never regresses before the flag flips.
   */
  async function handleRouteSubmit() {
    if (!issue || !submitTarget) return;
    setSending(true);
    try {
      const res = await fetch("/api/edit/request-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attribute,
          issueId: issue.id,
          itemId: itemLabel,
          detail,
          targetCwid: cwid,
          noReceipt,
        }),
      });
      if (res.ok) {
        setSentVia("server");
        setSubmitted(true);
        return;
      }
    } catch {
      // network error — fall through to the mailto: fallback
    } finally {
      setSending(false);
    }
    // Phase-1 fallback: hand off to the user's own mail client.
    window.location.href = routeMailto();
    setSentVia("mailto");
    setSubmitted(true);
  }

  const cta = action ? ctaFor(action, revealFallback) : null;
  const isAck = action?.kind === "explain" && !revealFallback; // dead-end "Got it"
  const inRouter = !(submitted && submitTarget) && !confirmDiscard;
  // The footer caption matches the single action the footer offers, so the
  // bottom of the dialog never tells a second story.
  const footerHint =
    inRouter && action
      ? showRouteBox
        ? "We’ll route this to the right team."
        : action.kind === "self-service"
          ? "Opens in a new tab."
          : null
      : null;

  return (
    <>
      {trigger ? (
        trigger(() => setOpen(true))
      ) : (
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
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          data-testid="request-a-change-dialog"
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl data-[state=open]:slide-in-from-bottom-2"
        >
          {/* Pinned header — kicker + close X stay put, so an expanded row can
              never clip them off the top. */}
          <DialogHeader className="border-apollo-border flex-none gap-1 border-b px-6 pt-6 pb-4 text-left">
            <DialogTitle className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Request a change
              {/* Visible label stays the eyebrow; the accessible name gains the
                  attribute + item so SR users don't hear an identical title for
                  every panel (vision-round T1.8). Radix wires aria-labelledby to
                  this node, so an aria-label on DialogContent would be a no-op. */}
              <span className="sr-only">
                {` to ${attributeLabel}${itemLabel ? `: ${itemLabel}` : ""}`}
              </span>
            </DialogTitle>
            {itemLabel && (
              <p className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground shrink-0">Regarding</span>
                <PubTitle
                  value={itemLabel}
                  title={itemLabel}
                  className="line-clamp-1 font-medium"
                />
              </p>
            )}
            {inRouter && (
              <div className="mt-1 flex flex-col gap-1">
                <p id={`rac-q-${attribute}`} className="text-lg font-semibold">
                  {config.heading}
                </p>
                <DialogDescription>
                  Pick one — we&apos;ll point you to the right place, or route it to the team that
                  owns it.
                </DialogDescription>
              </div>
            )}
          </DialogHeader>

          {/* Scrollable middle — only the option list scrolls. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {submitted && submitTarget ? (
              /* ---- post-submit confirmation (route) ---- */
              <div className="flex flex-col gap-2" role="status" aria-live="polite">
                {sentVia === "server" ? (
                  <>
                    <p className="text-base font-medium">Request sent.</p>
                    <p className="text-muted-foreground text-sm">
                      We&apos;ve routed your request
                      {submitTarget.office ? ` to ${submitTarget.office}` : ""}. They&apos;ll follow
                      up if they need more detail.
                    </p>
                  </>
                ) : (
                  <>
                    {/* Not a success claim: the mailer is dark, so nothing was sent
                        server-side — the request only completes once the user sends
                        from their own client (vision-round T1.9). */}
                    <p className="text-base font-medium">Almost there — finish in your email app.</p>
                    <p className="text-muted-foreground text-sm">
                      We opened a pre-filled message
                      {submitTarget.office ? ` to ${submitTarget.office}` : ""}. If nothing opened,
                      copy this address into your email and send it from there:
                    </p>
                    <a
                      className="text-apollo-slate w-fit font-medium underline"
                      href={`mailto:${submitTarget.email}`}
                    >
                      {submitTarget.email}
                    </a>
                  </>
                )}
              </div>
            ) : confirmDiscard ? (
              /* ---- unsaved-text discard guard (edge case 3) ---- */
              <div className="flex flex-col gap-2">
                <p className="text-base font-medium">Discard your request?</p>
                <p className="text-muted-foreground text-sm">The detail you typed will be lost.</p>
              </div>
            ) : (
              /* ---- the router: the option list scrolls under the pinned header ---- */
              <RadioGroup
                aria-labelledby={`rac-q-${attribute}`}
                value={issueId ?? ""}
                onValueChange={selectIssue}
                className="gap-2.5"
              >
                {config.issues.map((i) => {
                  const selected = i.id === issueId;
                  const a = i.action;
                  const hint = a.kind === "explain" ? null : ctaFor(a, false);
                  const caption = captionFor(a);
                  return (
                    <div
                      key={i.id}
                      ref={selected ? selectedRowRef : undefined}
                      data-testid={`rac-issue-${i.id}`}
                      className={cn(
                        "overflow-hidden rounded-md border transition-colors",
                        selected
                          ? "bg-apollo-red-tint border-apollo-red-tint-border"
                          : "border-apollo-border hover:border-apollo-border-strong hover:bg-apollo-surface-2",
                      )}
                    >
                      <label
                        htmlFor={`rac-${i.id}`}
                        className="flex cursor-pointer items-center gap-3 px-4 py-3.5"
                      >
                        <RadioGroupItem
                          id={`rac-${i.id}`}
                          value={i.id}
                          className={cn(
                            "border-apollo-border-strong",
                            selected &&
                              "border-apollo-maroon text-apollo-maroon [&_svg]:fill-apollo-maroon",
                          )}
                        />
                        <span className={cn("flex-1 text-base", selected && "font-semibold")}>
                          {i.label}
                        </span>
                        {selected
                          ? caption && (
                              <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
                                {caption}
                              </span>
                            )
                          : hint && (
                              <span className="text-apollo-slate flex shrink-0 items-center gap-1.5 text-sm">
                                {hint}
                                <ArrowRight className="size-3.5" />
                              </span>
                            )}
                      </label>

                      {selected && (
                        <div className="border-apollo-red-tint-border flex flex-col gap-2.5 border-t px-4 pt-3 pb-4">
                          {a.kind === "self-service" && (
                            <p className="text-apollo-slate text-[13px] leading-relaxed">
                              {a.instruction}
                            </p>
                          )}
                          {a.kind === "route" && a.note && (
                            <p className="text-apollo-slate text-[13px] leading-relaxed">{a.note}</p>
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
                                  className="text-apollo-slate w-fit text-sm hover:underline"
                                  onClick={() => setRevealFallback(true)}
                                >
                                  Still wrong? Email us
                                </button>
                              )}
                            </>
                          )}

                          {showRouteBox && (
                            <div className="flex flex-col gap-3">
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
                                  className="bg-apollo-surface border-apollo-border-strong"
                                />
                              </div>
                              <label
                                htmlFor="rac-no-receipt"
                                className="text-muted-foreground flex items-center gap-2.5 text-sm"
                              >
                                <Checkbox
                                  id="rac-no-receipt"
                                  checked={noReceipt}
                                  onCheckedChange={(v) => setNoReceipt(v === true)}
                                  className="bg-apollo-surface"
                                />
                                Don&apos;t email me a copy
                              </label>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </RadioGroup>
            )}
          </div>

          {/* Pinned footer — one destination-labelled action, always reachable. */}
          <DialogFooter
            className={cn(
              "border-apollo-border flex-none border-t px-6 py-4 sm:items-center",
              footerHint ? "sm:justify-between" : "sm:justify-end",
            )}
          >
            {footerHint && (
              <span className="text-muted-foreground hidden text-xs sm:block">{footerHint}</span>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {submitted ? (
                <Button type="button" variant="apollo" onClick={() => setOpen(false)}>
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
                    <Button asChild variant="apollo" data-testid="request-a-change-open">
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
                    <Button
                      type="button"
                      variant="apollo"
                      data-testid="request-a-change-submit"
                      disabled={sending}
                      onClick={handleRouteSubmit}
                    >
                      {sending ? "Sending…" : cta}
                    </Button>
                  )}
                  {isAck && (
                    <Button
                      type="button"
                      variant="apollo"
                      data-testid="request-a-change-ack"
                      onClick={() => setOpen(false)}
                    >
                      {cta}
                    </Button>
                  )}
                </>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
