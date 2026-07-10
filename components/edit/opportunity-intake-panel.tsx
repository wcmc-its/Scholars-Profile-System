"use client";

/**
 * Opportunity URL intake — the submit-a-URL panel on `/edit/find-researchers`
 * (`docs/opportunity-url-intake-spec.md` §5/§10, flag `OPPORTUNITY_URL_INTAKE`).
 *
 * Submitting queues the URL for ReciterAI's pipeline; nothing is scraped or
 * scored here, so the panel's promise is honest: "appears in the matcher once
 * processed, typically the next business day." The whole team's submissions
 * render below the form (newest-first) with their pending/processed/rejected
 * outcomes, so nobody re-submits a URL a colleague already queued — the API
 * also 409s on a duplicate and the handler surfaces which row it collided with.
 *
 * Accidental submissions get per-row cleanup (confirm step included): Delete
 * (pending/rejected — the item is simply removed) and Suppress (processed —
 * status flips to `suppressed`; ReciterAI's drain companion honors that by
 * removing the produced GRANT# items — separate ReciterAI PR in flight — and
 * the rows fall out of the matcher on the next nightly projection).
 */
import { useCallback, useEffect, useState } from "react";

import {
  type OpportunitySubmission,
  type SubmissionStatus,
} from "@/lib/edit/opportunity-submission";

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; submissions: OpportunitySubmission[] }
  | { kind: "error" };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  https_required: "Enter an https:// URL.",
  invalid_url: "That doesn't look like a valid URL.",
  queue_unavailable: "The submission queue isn't reachable right now. Please try again.",
  queue_write_failed: "The submission queue isn't reachable right now. Please try again.",
  write_failed: "The submission couldn't be recorded. Please try again.",
};

function errorMessage(error: string | undefined, existing?: { opportunityId?: string }): string {
  if (error === "duplicate_url") {
    return `Already in the corpus${existing?.opportunityId ? ` (${existing.opportunityId})` : ""} — search for it on the Browse tab.`;
  }
  if (error === "duplicate_submission") {
    return "That URL has already been submitted — see the list below.";
  }
  return ERROR_MESSAGES[error ?? ""] ?? "Something went wrong. Please try again.";
}

const STATUS_STYLES: Record<SubmissionStatus, string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  processed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  // Retracted-after-processing — deliberately muted, not alarming.
  suppressed: "bg-zinc-100 text-zinc-600 border-zinc-300",
};

type RowActionKind = "delete" | "suppress";

/** The one in-flight (or confirm-pending) row action — at most one at a time. */
type RowAction = { submissionId: string; kind: RowActionKind; phase: "confirm" | "busy" };

const ROW_ACTION_ERRORS: Record<string, string> = {
  submission_processed:
    "The pipeline already processed this one — use Suppress to retract it instead.",
  not_processed: "Only a processed submission can be suppressed — delete it instead.",
  already_suppressed: "Already suppressed.",
  not_found: "That submission no longer exists — refreshing the list.",
  queue_unavailable: "The submission queue isn't reachable right now. Please try again.",
  queue_write_failed: "The submission queue isn't reachable right now. Please try again.",
  write_failed: "The change couldn't be recorded. Please try again.",
};

function rowActionErrorMessage(error: string | undefined): string {
  return ROW_ACTION_ERRORS[error ?? ""] ?? "Something went wrong. Please try again.";
}

function formatSubmitted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function OpportunityIntakePanel() {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/edit/opportunity-intake", { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as { submissions?: OpportunitySubmission[] };
        setList({ kind: "ok", submissions: data.submissions ?? [] });
      })
      .catch(() => setList({ kind: "error" }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submit.kind === "submitting") return;
    setSubmit({ kind: "submitting" });
    try {
      const r = await fetch("/api/edit/opportunity-intake", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, note: note.trim() || undefined }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        existing?: { opportunityId?: string };
      };
      if (!r.ok) {
        setSubmit({ kind: "error", message: errorMessage(data.error, data.existing) });
        return;
      }
      setUrl("");
      setNote("");
      setSubmit({ kind: "queued" });
      refresh();
    } catch {
      setSubmit({ kind: "error", message: errorMessage(undefined) });
    }
  }

  /** The confirmed row action — DELETE removes the item, PATCH suppresses it. */
  async function performRowAction(action: RowAction) {
    setRowAction({ ...action, phase: "busy" });
    setRowActionError(null);
    try {
      const r = await fetch("/api/edit/opportunity-intake", {
        method: action.kind === "delete" ? "DELETE" : "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action.kind === "delete"
            ? { submissionId: action.submissionId }
            : { submissionId: action.submissionId, action: "suppress" },
        ),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setRowActionError(rowActionErrorMessage(data.error));
        // A stale row (already processed / already gone) means the list is
        // out of date — refresh alongside the message either way.
        refresh();
      } else {
        refresh();
      }
    } catch {
      setRowActionError(rowActionErrorMessage(undefined));
    } finally {
      setRowAction(null);
    }
  }

  return (
    <section className="border-border mt-10 rounded-lg border p-5" data-slot="opportunity-intake">
      <h2 className="text-lg font-semibold tracking-tight">Submit a funding opportunity URL</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Not in the Browse list? Paste the opportunity&rsquo;s web page. It goes through the same
        pipeline as the rest of the corpus — scraped, checked for duplicates, classified, and
        scored — and shows up in the matcher once processed, typically the next business day.
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://sponsor.org/research-grants"
          aria-label="Funding opportunity URL"
          required
          className="border-border h-9 w-96 max-w-full rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          aria-label="Note for the pipeline operator (optional)"
          maxLength={500}
          className="border-border h-9 w-64 max-w-full rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={submit.kind === "submitting"}
          className="h-9 rounded-md bg-[var(--color-accent-slate)] px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {submit.kind === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </form>

      {submit.kind === "queued" && (
        <p className="mt-2 text-sm text-emerald-700" role="status">
          Queued — it will appear in the list below as it moves through the pipeline.
        </p>
      )}
      {submit.kind === "error" && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {submit.message}
        </p>
      )}

      <div className="mt-5">
        {rowActionError && (
          <p className="mb-2 text-sm text-red-700" role="alert" data-testid="intake-row-action-error">
            {rowActionError}
          </p>
        )}
        {list.kind === "loading" && <p className="text-muted-foreground text-sm">Loading submissions…</p>}
        {list.kind === "error" && (
          <p className="text-muted-foreground text-sm">Couldn&rsquo;t load submissions.</p>
        )}
        {list.kind === "ok" && list.submissions.length === 0 && (
          <p className="text-muted-foreground text-sm">No submissions yet.</p>
        )}
        {list.kind === "ok" && list.submissions.length > 0 && (
          <ul className="divide-border divide-y">
            {list.submissions.map((s) => (
              <li key={s.submissionId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]}`}
                >
                  {s.status}
                </span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="max-w-full truncate break-all underline decoration-dotted underline-offset-2"
                >
                  {s.url}
                </a>
                <span className="text-muted-foreground">
                  {s.submittedBy} · {formatSubmitted(s.submittedAt)}
                </span>
                {s.status === "processed" && s.producedOpportunityIds.length > 0 && (
                  <span className="text-muted-foreground">
                    →{" "}
                    {s.producedOpportunityIds.map((id) => (
                      <code key={id} className="mr-1 rounded bg-muted px-1 py-0.5 text-xs">
                        {id}
                      </code>
                    ))}
                  </span>
                )}
                {s.status === "rejected" && s.rejectReason && (
                  <span className="text-red-700">{s.rejectReason}</span>
                )}
                {s.note && <span className="text-muted-foreground italic">“{s.note}”</span>}
                <RowActions
                  submission={s}
                  rowAction={rowAction}
                  onArm={(kind) =>
                    setRowAction({ submissionId: s.submissionId, kind, phase: "confirm" })
                  }
                  onCancel={() => setRowAction(null)}
                  onConfirm={(action) => void performRowAction(action)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Per-row cleanup: Delete on a pending/rejected row (the pipeline never
 * consumed it), Suppress on a processed one (retracts its produced
 * opportunities via the drain — see the module doc). A `suppressed` row gets
 * neither: it IS the retraction record. Destructive either way, so a click
 * arms an inline confirm ("sure?" → Confirm/Cancel) instead of firing.
 */
function RowActions({
  submission,
  rowAction,
  onArm,
  onCancel,
  onConfirm,
}: {
  submission: OpportunitySubmission;
  rowAction: RowAction | null;
  onArm: (kind: RowActionKind) => void;
  onCancel: () => void;
  onConfirm: (action: RowAction) => void;
}) {
  const kind: RowActionKind | null =
    submission.status === "pending" || submission.status === "rejected"
      ? "delete"
      : submission.status === "processed"
        ? "suppress"
        : null;
  if (!kind) return null;

  const mine = rowAction?.submissionId === submission.submissionId ? rowAction : null;
  const label = kind === "delete" ? "Delete" : "Suppress";

  if (mine?.phase === "busy") {
    return (
      <span className="text-muted-foreground ml-auto text-xs" data-testid="intake-action-busy">
        {kind === "delete" ? "Deleting…" : "Suppressing…"}
      </span>
    );
  }
  if (mine?.phase === "confirm") {
    return (
      <span className="ml-auto inline-flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {kind === "delete"
            ? "Remove this submission?"
            : "Retract it from the matcher (next pipeline run)?"}
        </span>
        <button
          type="button"
          onClick={() => onConfirm(mine)}
          className="rounded-md border border-red-300 px-2 py-0.5 font-medium text-red-700 hover:bg-red-50"
          data-testid="intake-action-confirm"
        >
          {label}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground px-1 py-0.5"
          data-testid="intake-action-cancel"
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onArm(kind)}
      // Any authorized viewer may clean up any row (shared team queue) — the
      // API enforces the same superuser-OR-developer gate as the submit.
      disabled={rowAction !== null}
      className="text-muted-foreground hover:text-foreground ml-auto text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
      data-testid={`intake-action-${kind}`}
    >
      {label}
    </button>
  );
}
