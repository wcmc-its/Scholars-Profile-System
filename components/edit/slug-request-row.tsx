/**
 * One pending Profile-URL request in the "Requests to review" card of
 * `/edit/slugs` (Profile URLs; #497 PR-3c, U3, `slug-personalization-ui-spec.md`
 * § 3.3-3.5). Client island: Approve runs the decision endpoint's
 * reconcile+override transaction; Deny opens an inline required-note form (the
 * note is emailed to the requester). On either success the row reports up to
 * the queue, which removes it and refreshes.
 *
 * Layout (design canvas "Profile URLs", 2026-09-25): one grid row — the
 * requested URL over the current one; the scholar over "cwid · asked <date>";
 * an availability check (Available / Taken / Reserved) with a one-line note;
 * then Deny and Approve. The scholar's own note, when they wrote one, sits
 * under the row.
 *
 * A collision/reserved check **disables Approve** — v1 has no incumbent-swap,
 * so the reviewer denies (UI-SPEC § 3.4). A `collision` here is the race case
 * (free at request, taken by now); if the slug is taken in the window between
 * load and the click, the decision endpoint's `slug_guard` fails closed and
 * returns `409`, which flips the check to Taken inline.
 */
"use client";

import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";
import { cn } from "@/lib/utils";

export type SlugRequestRowProps = {
  request: SlugRequestQueueRow;
  /** Called with the request id after a successful approve or decline. */
  onDecided: (id: string) => void;
};

const DECISION_PATH = (id: string) => `/api/edit/slug-request/${id}/decision`;

/** The check pill: green when free, red when it blocks approval. */
const CHECK_OK =
  "bg-apollo-green-tint text-apollo-green-foreground border-apollo-green-tint-border";
const CHECK_BLOCKED = "bg-apollo-red-tint text-destructive border-apollo-red-tint-border";

export function SlugRequestRow({ request, onDecided }: SlugRequestRowProps) {
  const [approving, setApproving] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);
  const [declineOpen, setDeclineOpen] = React.useState(false);
  const [declineNote, setDeclineNote] = React.useState("");
  // The slug was taken between this list's load and the Approve click — the
  // server's UNIQUE guard caught it (409). Treat it like a collision warning.
  const [raceCollision, setRaceCollision] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const warning: "collision" | "reserved" | null = raceCollision ? "collision" : request.warning;
  const approveDisabled = approving || warning !== null;

  async function decide(body: Record<string, unknown>): Promise<Response> {
    return fetch(DECISION_PATH(request.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function handleApprove() {
    if (approveDisabled) return;
    setError(null);
    setApproving(true);
    try {
      const res = await decide({ decision: "approve" });
      if (res.status === 409) {
        // Collision (taken since load) — keep the row, surface the warning.
        setRaceCollision(true);
        return;
      }
      const data = (await res.json()) as { ok: true } | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't approve this request. Please try again.");
        return;
      }
      onDecided(request.id);
    } catch {
      setError("We couldn't approve this request. Please try again.");
    } finally {
      setApproving(false);
    }
  }

  async function handleDecline() {
    const note = declineNote.trim();
    if (declining || note.length === 0) return;
    setError(null);
    setDeclining(true);
    try {
      const res = await decide({ decision: "reject", note });
      const data = (await res.json()) as { ok: true } | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't decline this request. Please try again.");
        return;
      }
      onDecided(request.id);
    } catch {
      setError("We couldn't decline this request. Please try again.");
    } finally {
      setDeclining(false);
    }
  }

  const check =
    warning === "collision"
      ? {
          testId: "slug-request-collision-warning",
          label: "Taken",
          tone: CHECK_BLOCKED,
          note: `${
            request.collidesWith
              ? `In use by another scholar (${request.collidesWith})`
              : "Held by another scholar's pinned or former URL"
          }. Deny and ask for another; v1 doesn't swap.${raceCollision ? " It was taken since this list loaded." : ""}`,
        }
      : warning === "reserved"
        ? {
            testId: "slug-request-reserved-warning",
            label: "Reserved",
            tone: CHECK_BLOCKED,
            note: "Reserved word — cannot be used as a URL.",
          }
        : {
            testId: "slug-request-check",
            label: "Available",
            tone: CHECK_OK,
            note:
              request.currentSlug && /-\d+$/.test(request.currentSlug)
                ? "Drops the -N suffix; the current URL will redirect"
                : "Current URL will redirect",
          };

  return (
    <div
      data-slot="slug-request-row"
      data-testid={`slug-request-row-${request.id}`}
      className="flex flex-col gap-3 px-5 py-3.5"
    >
      <div className="grid grid-cols-1 gap-x-[18px] gap-y-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto] md:items-center">
        <div
          className="flex min-w-0 flex-col gap-0.5 font-mono"
          data-testid="slug-request-change-line"
        >
          <span className="text-sm font-semibold [overflow-wrap:anywhere]">
            /scholars/{request.requestedSlug}
          </span>
          <span className="text-muted-foreground text-[12.5px] [overflow-wrap:anywhere]">
            now /scholars/{request.currentSlug ?? "—"}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">{request.name ?? request.cwid}</span>
          <span className="text-muted-foreground text-[12.5px]" data-testid="slug-request-meta">
            {request.cwid}
            {request.department && ` · ${request.department}`} · asked{" "}
            {formatDate(request.createdAt)}
          </span>
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1" data-testid={check.testId}>
          <span
            className={cn(
              "rounded-full border px-[9px] py-0.5 text-[12.5px] font-medium",
              check.tone,
            )}
          >
            {check.label}
          </span>
          <span className="text-muted-foreground text-[12.5px]">{check.note}</span>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDeclineOpen((o) => !o)}
            disabled={declining}
            aria-expanded={declineOpen}
            className="border-apollo-border-strong bg-apollo-surface hover:bg-apollo-surface-2 text-[13.5px]"
            data-testid="slug-request-decline-open"
          >
            Deny
          </Button>
          <Button
            type="button"
            variant="apollo"
            size="sm"
            onClick={handleApprove}
            disabled={approveDisabled}
            title={warning !== null ? "This URL isn't free" : undefined}
            className="text-[13.5px]"
            data-testid="slug-request-approve"
          >
            {approving ? "Approving…" : "Approve"}
          </Button>
        </div>
      </div>

      {request.reason && request.reason.trim().length > 0 && (
        <p className="text-muted-foreground text-[13px]" data-testid="slug-request-reason">
          Scholar&apos;s note: &ldquo;{request.reason}&rdquo;
        </p>
      )}

      {declineOpen && (
        <div
          className="bg-apollo-page border-apollo-border flex flex-col gap-2 rounded-[10px] border p-3.5"
          data-testid="slug-request-decline-form"
        >
          <label htmlFor={`slug-decline-${request.id}`} className="text-sm font-medium">
            Reason for denying (sent to the scholar)
          </label>
          <textarea
            id={`slug-decline-${request.id}`}
            className="border-apollo-border-strong bg-apollo-surface placeholder:text-muted-foreground focus-visible:ring-ring min-h-16 rounded-md border px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-none"
            value={declineNote}
            onChange={(e) => setDeclineNote(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Why this URL can't be used"
            data-testid="slug-request-decline-note"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDecline}
              disabled={declining || declineNote.trim().length === 0}
              data-testid="slug-request-decline-send"
            >
              {declining ? "Sending…" : "Send and deny"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeclineOpen(false);
                setDeclineNote("");
              }}
              disabled={declining}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive" data-testid="slug-request-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** "Sep 18, 2026". */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
