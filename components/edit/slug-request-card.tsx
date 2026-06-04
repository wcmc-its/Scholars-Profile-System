/**
 * The scholar-facing "Profile URL" request card (#497 PR-3 surfaces U1+U2,
 * `docs/slug-personalization-ui-spec.md` § 2). The self-arm sibling of
 * `slug-card.tsx`: a superuser sets a slug directly (`slug-card`), a scholar
 * *requests* one here and a Scholars administrator approves it.
 *
 * One component, a state machine driven by the scholar's current slug and their
 * latest `SlugRequest` (both server-fetched at page load):
 *
 *   - **Idle**        — no pending request: input + "Request this URL".
 *   - **Pending**     — latest request `pending`: status notice + "Withdraw" (no input).
 *   - **Rejected**    — latest request `rejected`: reviewer note + re-request input.
 *   - **Just-approved** — latest request `approved`: a transient success banner
 *                         that collapses to Idle showing the new current URL.
 *
 * `superseded` / `withdrawn` never surface (a newer request, or the scholar's own
 * cancellation, replaced them) — they render as Idle.
 *
 * Live format validation reuses `validateSlugFormat` (the same function the
 * server uses). Collision is NOT checked live; the request POST is the gate and
 * surfaces `400 collision` inline (the shipped endpoint rejects a colliding
 * request rather than queuing a doomed one). The card mounts an
 * `UnsavedChangesGuard` whose `dirty` bit is `input !== ""`.
 *
 * Endpoints (#497 PR-3a, flag-gated `SELF_EDIT_SLUG_REQUEST`):
 *   POST /api/edit/slug-request                 { requestedSlug, reason? }
 *   POST /api/edit/slug-request/[id]/withdraw    {}
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type SlugRequestSummary } from "@/lib/edit/slug-request";
import { validateSlugFormat, type SlugFormatResult } from "@/lib/edit/validators";

/** Re-exported for the pages that pass it down (`/edit`, `/edit/scholar/[cwid]`). */
export type { SlugRequestSummary };

/** The public host the personalized URL hangs off (root-alias form, PR-2). */
const SITE_HOST = "scholars.weill.cornell.edu";

export type SlugRequestCardProps = {
  /** The scholar's cwid — the request endpoint always acts on the session cwid;
   *  passed for parity with `slug-card` and to key the card. */
  cwid: string;
  /** The live `scholar.slug` the public profile resolves at today (override-aware). */
  currentSlug: string;
  /** The scholar's latest request, or `null` if they have never filed one. */
  latestRequest: SlugRequestSummary | null;
};

type Phase = "idle" | "pending" | "rejected" | "approved";
type FormatError = "format" | "too_long" | "reserved";

function initialPhase(req: SlugRequestSummary | null): Phase {
  switch (req?.status) {
    case "pending":
      return "pending";
    case "rejected":
      return "rejected";
    case "approved":
      return "approved";
    default:
      // null, superseded, withdrawn → nothing actionable to show.
      return "idle";
  }
}

export function SlugRequestCard({
  cwid,
  currentSlug,
  latestRequest,
}: SlugRequestCardProps) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>(() => initialPhase(latestRequest));
  // The request the Pending/Rejected views read (id for withdraw, note + slug
  // for re-request). Seeded from props; replaced on submit, cleared on withdraw.
  const [request, setRequest] = React.useState<SlugRequestSummary | null>(latestRequest);
  // Rejected re-request prefills the rejected value; otherwise the input is empty.
  const [inputValue, setInputValue] = React.useState<string>(
    latestRequest?.status === "rejected" ? latestRequest.requestedSlug : "",
  );
  const [reasonOpen, setReasonOpen] = React.useState(false);
  const [reasonValue, setReasonValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const trimmed = inputValue.trim();
  const formatResult: SlugFormatResult | null =
    trimmed.length === 0 ? null : validateSlugFormat(trimmed);
  const formatError: FormatError | null =
    formatResult && !formatResult.ok ? formatResult.error : null;

  // The input only exists in Idle / Rejected / Just-approved; in Pending it is
  // absent so `dirty` is always false there (inputValue stays "").
  const dirty = inputValue !== "";

  // The just-approved banner persists: it is the only positive confirmation the
  // scholar gets that their requested URL went live, so we keep it visible (it
  // clears on the next page load, once `latestRequest` is no longer `approved`,
  // or as soon as the scholar files a new request). The Idle request input is
  // shown alongside it (see `showInput`), so the card stays fully usable.

  // "Request this URL" is enabled iff non-empty, format-valid, and different
  // from the current slug (requesting your own live slug is a no-op).
  const canSubmit =
    !submitting &&
    formatResult !== null &&
    formatResult.ok &&
    trimmed.length > 0 &&
    formatResult.value !== currentSlug;

  function handleInputChange(value: string) {
    setInputValue(value);
    if (error) setError(null);
  }

  async function handleSubmit() {
    if (!canSubmit || formatResult === null || !formatResult.ok) return;
    setError(null);
    setSubmitting(true);
    try {
      const reason = reasonValue.trim();
      const res = await fetch("/api/edit/slug-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reason.length > 0
            ? { requestedSlug: formatResult.value, reason }
            : { requestedSlug: formatResult.value },
        ),
      });
      if (res.status === 429) {
        setError(RATE_LIMITED_MESSAGE);
        return;
      }
      const data = (await res.json()) as
        | { ok: true; id: string; status: string; requestedSlug: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        setError(submitErrorMessage("error" in data ? data.error : "unknown"));
        return;
      }
      // Optimistic → Pending; `router.refresh()` reconciles the server's view.
      setRequest({
        id: data.id,
        status: "pending",
        requestedSlug: data.requestedSlug,
        reason: reason.length > 0 ? reason : null,
        decisionNote: null,
        createdAt: new Date().toISOString(),
      });
      setPhase("pending");
      setInputValue("");
      setReasonValue("");
      setReasonOpen(false);
      router.refresh();
    } catch {
      setError(submitErrorMessage("unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWithdraw() {
    if (request === null || withdrawing) return;
    setError(null);
    setWithdrawing(true);
    try {
      const res = await fetch(`/api/edit/slug-request/${request.id}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as { ok: true } | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(WITHDRAW_FAILED_MESSAGE);
        return;
      }
      setRequest(null);
      setPhase("idle");
      setInputValue("");
      router.refresh();
    } catch {
      setError(WITHDRAW_FAILED_MESSAGE);
    } finally {
      setWithdrawing(false);
    }
  }

  const showInput = phase === "idle" || phase === "rejected" || phase === "approved";

  return (
    <EditPanel
      slot="slug-request-card"
      heading="Profile URL"
      owned
      description="Request a personalized web address for your public profile. A Scholars administrator reviews every request."
      headerAction={phase !== "idle" ? <StatusTag phase={phase} /> : undefined}
    >
      <UnsavedChangesGuard dirty={dirty} />
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="text-muted-foreground">Your current URL: </span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {SITE_HOST}/{currentSlug}
          </code>
        </p>

        {phase === "rejected" && request && (
          <Alert variant="destructive" data-testid="slug-request-rejected">
            <AlertDescription>
              Your request for <code>/{request.requestedSlug}</code> wasn&apos;t
              approved.{" "}
              {request.decisionNote && request.decisionNote.trim().length > 0 && (
                <>
                  <strong>Note from the reviewer:</strong> &ldquo;
                  {request.decisionNote}&rdquo;{" "}
                </>
              )}
              You can submit a different address below.
            </AlertDescription>
          </Alert>
        )}

        {phase === "approved" && (
          <Alert variant="info" data-testid="slug-request-approved">
            <AlertDescription>
              Your URL is now{" "}
              <code>
                {SITE_HOST}/{currentSlug}
              </code>
              . The old address redirects automatically.
            </AlertDescription>
          </Alert>
        )}

        {phase === "pending" && request && (
          <>
            <Alert variant="info" data-testid="slug-request-pending">
              <AlertDescription>
                You requested{" "}
                <code>
                  {SITE_HOST}/{request.requestedSlug}
                </code>{" "}
                on {formatDate(request.createdAt)}. A Scholars administrator will
                review it — you&apos;ll get an email when it&apos;s decided. Your
                current URL stays active until then.
              </AlertDescription>
            </Alert>
            <div>
              <Button
                type="button"
                variant="ghost"
                onClick={handleWithdraw}
                disabled={withdrawing}
                data-testid="slug-request-withdraw"
              >
                {withdrawing ? "Withdrawing…" : "Withdraw request"}
              </Button>
            </div>
          </>
        )}

        {showInput && (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="slug-request-input" className="text-sm font-medium">
                Requested address
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="text-muted-foreground select-none whitespace-nowrap text-sm"
                  data-slot="slug-request-prefix"
                >
                  {SITE_HOST}/
                </span>
                <Input
                  id="slug-request-input"
                  type="text"
                  value={inputValue}
                  onChange={(e) => handleInputChange(e.target.value)}
                  aria-invalid={formatError !== null}
                  aria-describedby={
                    formatError ? "slug-request-format-error" : "slug-request-hint"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="slug-request-input"
                />
              </div>
              {formatError ? (
                <p
                  id="slug-request-format-error"
                  role="alert"
                  className="text-destructive text-sm"
                  data-testid="slug-request-format-error"
                >
                  {formatErrorMessage(formatError)}
                </p>
              ) : (
                <p id="slug-request-hint" className="text-muted-foreground text-xs">
                  Lowercase letters, numbers, and hyphens only. Use your own name
                  — optionally with a middle initial or fuller form — not a
                  research area or other handle; requests that aren&apos;t
                  name-based are declined.{" "}
                  <code>/scholars/{formatResult?.ok ? formatResult.value : currentSlug}</code>{" "}
                  will keep working too.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground self-start text-sm underline-offset-2 hover:underline"
                aria-expanded={reasonOpen}
                onClick={() => setReasonOpen((o) => !o)}
                data-testid="slug-request-reason-toggle"
              >
                Add a note for the reviewer (optional)
              </button>
              {reasonOpen && (
                <Textarea
                  value={reasonValue}
                  onChange={(e) => setReasonValue(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Why you'd like this address (optional)"
                  data-testid="slug-request-reason"
                />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="apollo"
                onClick={handleSubmit}
                disabled={!canSubmit}
                data-testid="slug-request-submit"
              >
                {submitting ? "Sending…" : "Request this URL"}
              </Button>
              <span className="text-muted-foreground text-sm">
                Sends to a Scholars administrator for approval.
              </span>
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive" data-testid="slug-request-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </EditPanel>
  );
}

function StatusTag({ phase }: { phase: Exclude<Phase, "idle"> }) {
  const label =
    phase === "pending"
      ? "Pending review"
      : phase === "rejected"
        ? "Not approved"
        : "Approved";
  return (
    <span
      className="text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-normal"
      data-testid="slug-request-status-tag"
    >
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatErrorMessage(error: FormatError): string {
  switch (error) {
    case "too_long":
      return "Use 64 characters or fewer.";
    case "reserved":
      return "That URL segment is reserved — please choose another.";
    case "format":
      return "Use lowercase letters, numbers, and hyphens only — no leading or trailing hyphen, no double hyphens.";
  }
}

const RATE_LIMITED_MESSAGE =
  "You've sent several requests recently — please try again later.";
const WITHDRAW_FAILED_MESSAGE =
  "We couldn't withdraw your request. Please try again.";

/** Map a server `400` error code to an inline message for the request form. */
function submitErrorMessage(code: string): string {
  switch (code) {
    case "collision":
      return "That web address is already taken. Please choose another.";
    case "already_current":
      return "That's already your current web address.";
    case "reserved":
      return "That word is reserved and can't be used as a URL.";
    case "numeric":
      return "Choose an address with at least one letter — numbers alone aren't allowed.";
    case "too_short":
      return "Use at least 2 characters.";
    case "profanity":
      return "Please choose a different address.";
    case "too_long":
      return "Use 64 characters or fewer.";
    case "format":
    case "invalid_slug":
      return "Use lowercase letters, numbers, and hyphens only.";
    default:
      return "We couldn't send your request. Please try again.";
  }
}
