/**
 * One pending Profile-URL request in the superuser approval queue (#497 PR-3c,
 * U3, `slug-personalization-ui-spec.md` § 3.3-3.5). Client island: Approve runs
 * the decision endpoint's reconcile+override transaction; Decline opens an
 * inline required-note form (the note is emailed to the requester). On either
 * success the row reports up to the queue, which removes it and refreshes.
 *
 * A collision/reserved warning **disables Approve** — v1 has no incumbent-swap,
 * so the reviewer declines (UI-SPEC § 3.4). A `collision` here is the race case
 * (free at request, taken by now); if the slug is taken in the window between
 * load and the click, the decision endpoint's `slug_guard` fails closed and
 * returns `409`, which flips the warning on inline.
 */
"use client";

import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";

export type SlugRequestRowProps = {
  request: SlugRequestQueueRow;
  /** Called with the request id after a successful approve or decline. */
  onDecided: (id: string) => void;
};

const DECISION_PATH = (id: string) => `/api/edit/slug-request/${id}/decision`;

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

  return (
    <Card data-slot="slug-request-row" data-testid={`slug-request-row-${request.id}`}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate">
              <span className="font-medium">{request.name ?? request.cwid}</span>
              {request.name && <span className="text-muted-foreground"> · {request.cwid}</span>}
              {request.department && (
                <span className="text-muted-foreground"> · {request.department}</span>
              )}
            </p>
            <p className="text-sm" data-testid="slug-request-change-line">
              <span className="text-muted-foreground line-through">
                {request.currentSlug ?? "—"}
              </span>{" "}
              → <span className="font-semibold">{request.requestedSlug}</span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              onClick={handleApprove}
              disabled={approveDisabled}
              data-testid="slug-request-approve"
            >
              {approving ? "Approving…" : "Approve"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeclineOpen((o) => !o)}
              disabled={declining}
              data-testid="slug-request-decline-open"
            >
              Decline…
            </Button>
          </div>
        </div>

        <p
          className="bg-muted/50 text-muted-foreground rounded px-3 py-2 text-sm"
          data-testid="slug-request-reason"
        >
          {request.reason && request.reason.trim().length > 0 ? (
            <>&ldquo;{request.reason}&rdquo;</>
          ) : (
            "(no note)"
          )}
        </p>

        {warning === "collision" && (
          <Alert variant="destructive" data-testid="slug-request-collision-warning">
            <AlertDescription>
              {request.requestedSlug} is already in use by another scholar
              {request.collidesWith ? ` (${request.collidesWith})` : ""}. Decline and ask the
              scholar to choose another — v1 doesn&apos;t auto-swap.
              {raceCollision && " It was taken since this list loaded."}
            </AlertDescription>
          </Alert>
        )}
        {warning === "reserved" && (
          <Alert variant="destructive" data-testid="slug-request-reserved-warning">
            <AlertDescription>Reserved word — cannot be used as a URL.</AlertDescription>
          </Alert>
        )}

        {declineOpen && (
          <div className="flex flex-col gap-2" data-testid="slug-request-decline-form">
            <label htmlFor={`slug-decline-${request.id}`} className="text-sm font-medium">
              Reason for declining
            </label>
            <textarea
              id={`slug-decline-${request.id}`}
              className="border-input bg-transparent placeholder:text-muted-foreground focus-visible:ring-ring min-h-16 rounded-md border px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-none"
              value={declineNote}
              onChange={(e) => setDeclineNote(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Reason for declining (sent to the scholar)"
              data-testid="slug-request-decline-note"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={handleDecline}
                disabled={declining || declineNote.trim().length === 0}
                data-testid="slug-request-decline-send"
              >
                {declining ? "Sending…" : "Send decline"}
              </Button>
              <Button
                type="button"
                variant="ghost"
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

        <p className="text-muted-foreground text-xs" data-testid="slug-request-meta">
          Requested {formatDate(request.createdAt)}
        </p>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
