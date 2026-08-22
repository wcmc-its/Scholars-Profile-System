"use client";

/**
 * Opportunity URL intake — the submit-a-URL panel on `/edit/grant-matcha`
 * (`docs/opportunity-url-intake-spec.md` §5/§10, flag `OPPORTUNITY_URL_INTAKE`).
 *
 * Submitting queues each URL (one per line — a pasted digest is the common
 * batch case) for ReciterAI's pipeline; nothing is scraped or scored here, so
 * the panel's promise is honest: "appears in the matcher once processed,
 * typically the next business day." The whole team's submissions render below
 * the form (newest-first) with their pending/processed/rejected outcomes, so
 * nobody re-submits a URL a colleague already queued — the API also 409s on a
 * duplicate and the handler surfaces which row it collided with.
 *
 * Accidental submissions get per-row cleanup (confirm step included): Delete
 * (pending/rejected — the item is simply removed) and Suppress (processed —
 * status flips to `suppressed`; ReciterAI's drain companion honors that by
 * removing the produced GRANT# items — separate ReciterAI PR in flight — and
 * the rows fall out of the matcher on the next nightly projection).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, Mail } from "lucide-react";

import {
  type OpportunitySubmission,
  type SubmissionStatus,
} from "@/lib/edit/opportunity-submission";

const ALL_STATUSES: SubmissionStatus[] = ["pending", "processed", "rejected", "suppressed"];

/**
 * Redesign 2026-08 (`Submissions Redesign.dc.html`): group consecutive
 * submissions that share the same note + submitter into one batch card — a
 * copy-pasted digest of URLs gets the same note on every line today, so this
 * is a front-end reorganization of data already on each row, not new data.
 * A `note`-less submission (the common one-off case) gets no batch header.
 */
type SubmissionGroup = {
  key: string;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  items: OpportunitySubmission[];
};

function groupSubmissions(items: OpportunitySubmission[]): SubmissionGroup[] {
  const groups: SubmissionGroup[] = [];
  for (const s of items) {
    const last = groups[groups.length - 1];
    if (last && s.note && last.note === s.note && last.submittedBy === s.submittedBy) {
      last.items.push(s);
      continue;
    }
    groups.push({
      key: s.submissionId,
      note: s.note ?? null,
      submittedBy: s.submittedBy,
      submittedAt: s.submittedAt,
      items: [s],
    });
  }
  return groups;
}

type ListState =
  | { kind: "loading" }
  | {
      kind: "ok";
      submissions: OpportunitySubmission[];
      /** Produced-opportunity id → corpus title (the GET's batch join). A
       *  produced id with no entry has no surviving row — its chip degrades
       *  to the raw slug. */
      titles: Record<string, string>;
      /** Submitter cwid → preferred name (same fail-soft join posture) — the
       *  batch header renders "Name (cwid)" when resolvable, else the cwid. */
      names: Record<string, string>;
    }
  | { kind: "error" };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "queued"; count: number }
  | { kind: "error"; messages: string[] };

const ERROR_MESSAGES: Record<string, string> = {
  https_required: "Enter an https:// URL.",
  invalid_url: "That doesn't look like a valid URL.",
  queue_unavailable: "The submission queue isn't reachable right now. Please try again.",
  queue_write_failed: "The submission queue isn't reachable right now. Please try again.",
  write_failed: "The submission couldn't be recorded. Please try again.",
};

function errorMessage(
  error: string | undefined,
  existing?: { opportunityId?: string; suppressedAt?: string | null },
): string {
  if (error === "duplicate_url") {
    const id = existing?.opportunityId ? ` (${existing.opportunityId})` : "";
    // A suppressed duplicate does NOT appear on the Browse tab — pointing the
    // user at a search that can't find it would be misdirection.
    if (existing?.suppressedAt != null) {
      return `Already in the corpus${id} but suppressed — restore it from the Browse tab's "show suppressed" view if it should be visible again.`;
    }
    return `Already in the corpus${id} — search for it on the Browse tab.`;
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

/**
 * Split-URL treatment (redesign 2026-08): bold domain + muted one-line
 * ellipsized path, the whole thing ONE external link. `www.` is transport
 * chrome, not identity — stripped for display only; the href keeps the URL
 * exactly as submitted.
 */
function splitUrl(raw: string): { domain: string; path: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The API validated this as a URL, but a defensive read renders SOMETHING.
    return { domain: raw, path: "" };
  }
  return {
    domain: url.hostname.replace(/^www\./, ""),
    path: `${url.pathname === "/" ? "" : url.pathname}${url.search}`,
  };
}

function SubmissionUrl({ url }: { url: string }) {
  const { domain, path } = splitUrl(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full min-w-0 items-baseline hover:underline"
    >
      <span className="shrink-0 text-[14px] font-semibold text-[#1a1a1a]">{domain}</span>
      {path ? <span className="min-w-0 truncate text-[#8b857b]">{path}</span> : null}
      <ExternalLink
        className="text-muted-foreground ml-1 size-3.5 shrink-0 self-center"
        aria-hidden
      />
    </a>
  );
}

/**
 * Rejected-row reason — the drain's single free-text `reject_reason` string
 * (one string is the upstream contract; parsing structure out of it is
 * rejected scope). A short reason sits inline as the bold maroon label; a
 * long one gets the tinted box, clamped to ~2 lines behind a Show more
 * toggle so a rambling scraper trace can't swallow the list.
 */
// ponytail: char-count heuristic for "long", not measured lines (ClampedText precedent).
const REJECT_CLAMP_THRESHOLD = 160;

function RejectReason({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  if (reason.length <= REJECT_CLAMP_THRESHOLD) {
    return <span className="text-apollo-maroon text-[12.5px] font-semibold">{reason}</span>;
  }
  return (
    <div className="bg-apollo-lock-bg w-full rounded-lg px-3 py-[9px]">
      <p className={`text-[13px] leading-[1.55] text-[#5c574d] ${expanded ? "" : "line-clamp-2"}`}>
        {reason}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

export function OpportunityIntakePanel() {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SubmissionStatus | "all">("all");

  const refresh = useCallback(() => {
    fetch("/api/edit/opportunity-intake", { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as {
          submissions?: OpportunitySubmission[];
          opportunityTitles?: Record<string, string>;
          submitterNames?: Record<string, string>;
        };
        setList({
          kind: "ok",
          submissions: data.submissions ?? [],
          titles: data.opportunityTitles ?? {},
          names: data.submitterNames ?? {},
        });
      })
      .catch(() => setList({ kind: "error" }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * One POST per non-blank line — the POST contract stays `{ url, note }` per
   * submission (the batch is a client-side loop, not a new API shape), and the
   * shared note is exactly what groups the rows into one batch card below.
   * Sequential on purpose: the queue's sort keys are time-prefixed, so the
   * batch lands in pasted order. Failed lines stay in the textarea for a
   * fix-and-resubmit; queued ones leave it.
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submit.kind === "submitting") return;
    const urls = url
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (urls.length === 0) {
      // Whitespace-only passes the native `required` check — say so instead of no-oping.
      setSubmit({ kind: "error", messages: ["Enter at least one https:// URL."] });
      return;
    }
    setSubmit({ kind: "submitting" });
    const noteValue = note.trim() || undefined;
    const failures: { url: string; message: string }[] = [];
    for (const one of urls) {
      try {
        const r = await fetch("/api/edit/opportunity-intake", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: one, note: noteValue }),
        });
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          existing?: { opportunityId?: string };
        };
        if (!r.ok) failures.push({ url: one, message: errorMessage(data.error, data.existing) });
      } catch {
        failures.push({ url: one, message: errorMessage(undefined) });
      }
    }
    setUrl(failures.map((f) => f.url).join("\n"));
    if (failures.length === 0) {
      setNote("");
      setNoteOpen(false);
      setSubmit({ kind: "queued", count: urls.length });
    } else {
      setSubmit({
        kind: "error",
        // A single-line submit keeps the bare message (no redundant echo of
        // the one URL the user just typed).
        messages: failures.map((f) => (urls.length > 1 ? `${f.url} — ${f.message}` : f.message)),
      });
    }
    refresh();
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
    <section className="border-apollo-border bg-apollo-surface mt-10 rounded-lg border p-5" data-slot="opportunity-intake">
      <h2 className="text-[17px] font-semibold tracking-tight">Submit funding opportunities</h2>
      <span aria-hidden className="bg-apollo-maroon mt-2 block h-[3px] w-8 rounded-full" />
      <p className="text-muted-foreground mt-3 text-sm">
        Not in the Browse list? Paste the opportunity&rsquo;s web page, or several at once with
        one URL per line. Everything goes through the same pipeline as the rest of the corpus:
        scraped, checked for duplicates, classified, and scored. It shows up in the matcher once
        processed, typically the next business day.
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
        <textarea
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://sponsor.org/research-grants"
          aria-label="Funding opportunity URLs, one per line"
          required
          rows={3}
          className="border-border w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          autoComplete="off"
          spellCheck={false}
        />
        {/* Bottom-right cluster (artboard): the batch-note disclosure beside a
            right-aligned Submit. The note is rare enough that a permanent
            input just widens the form; the link opens it on demand. */}
        <div className="flex flex-wrap items-center justify-end gap-4">
          {noteOpen ? (
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Description (optional)"
              aria-label="Description for this batch (optional)"
              maxLength={500}
              className="border-border h-9 w-96 max-w-full rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
              autoComplete="off"
            />
          ) : (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="text-sm text-[var(--color-accent-slate)] hover:underline"
            >
              Add a description for this batch (optional)
            </button>
          )}
          <button
            type="submit"
            disabled={submit.kind === "submitting"}
            className="bg-apollo-maroon text-apollo-maroon-foreground hover:bg-apollo-maroon-press h-9 rounded-md px-4 text-sm font-medium disabled:opacity-50"
          >
            {submit.kind === "submitting" ? "Submitting…" : "Submit"}
          </button>
        </div>
      </form>

      {submit.kind === "queued" && (
        <p className="mt-2 text-sm text-emerald-700" role="status">
          {submit.count === 1
            ? "Queued — it will appear in the list below as it moves through the pipeline."
            : `Queued ${submit.count} URLs — they will appear in the list below as they move through the pipeline.`}
        </p>
      )}
      {submit.kind === "error" && (
        <div className="mt-2 text-sm text-red-700" role="alert">
          {submit.messages.map((m, i) => (
            // Index key: two identical failed lines produce identical messages.
            <p key={i}>{m}</p>
          ))}
        </div>
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
          <>
            {/* Redesign 2026-08: status tabs — only shown for a status with ≥1 row, "All"
                always present. Counts come from the UNFILTERED list, so they don't shift
                as you switch tabs. */}
            <div className="bg-apollo-surface-2 mb-3 inline-flex flex-wrap gap-0.5 rounded-lg p-0.5 text-sm">
              {(["all", ...ALL_STATUSES] as const)
                .filter((s) => s === "all" || list.submissions.some((x) => x.status === s))
                .map((s) => {
                  const count =
                    s === "all"
                      ? list.submissions.length
                      : list.submissions.filter((x) => x.status === s).length;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatusFilter(s)}
                      className={`rounded-md px-2.5 py-1 ${
                        statusFilter === s
                          ? "bg-apollo-surface text-foreground font-medium shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)} {count}
                    </button>
                  );
                })}
            </div>
            {(() => {
              const filtered =
                statusFilter === "all"
                  ? list.submissions
                  : list.submissions.filter((s) => s.status === statusFilter);
              if (filtered.length === 0) {
                return <p className="text-muted-foreground text-sm">No submissions match.</p>;
              }
              return (
                <div className="flex flex-col gap-3">
                  {groupSubmissions(filtered).map((g) => {
                    // A batch card is for a genuine multi-item batch — a lone submission that
                    // happens to carry a note isn't a "batch of one," it's the same one-off row
                    // as always, with its note shown inline like before.
                    const isBatch = g.note !== null && g.items.length > 1;
                    return (
                    <div
                      key={g.key}
                      data-testid="intake-group"
                      className="border-apollo-border overflow-hidden rounded-lg border"
                    >
                      {isBatch ? (
                        <div className="bg-apollo-surface-2 border-apollo-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <Mail className="size-3.5 shrink-0" aria-hidden />
                            <span className="truncate text-[13.5px] font-semibold">{g.note}</span>
                            {/* The batch is inferred from a shared note, not a real upstream
                                batch id — the badge owns up to that. */}
                            <span className="border-apollo-border-strong bg-apollo-surface text-muted-foreground shrink-0 rounded border px-1.5 py-px text-[10px] font-medium tracking-wide uppercase">
                              stopgap batch
                            </span>
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {g.items.length} submissions ·{" "}
                            {list.names[g.submittedBy]
                              ? `${list.names[g.submittedBy]} (${g.submittedBy})`
                              : g.submittedBy}{" "}
                            ·{" "}
                            {formatSubmitted(g.submittedAt)}
                          </span>
                        </div>
                      ) : null}
                      <ul className="divide-border divide-y">
                        {g.items.map((s) => (
                          <li
                            key={s.submissionId}
                            className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2 text-sm"
                          >
                            <span
                              className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]}`}
                            >
                              {s.status}
                            </span>
                            {/* Middle column (artboard): the URL line, then the Created
                                chips / rejection reason stacked beneath it, clear of the
                                status-badge gutter. */}
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                                <SubmissionUrl url={s.url} />
                                {/* Not part of a batch card — attribution has nowhere else
                                    to live, so it stays on the row. */}
                                {!isBatch && (
                                  <span className="text-muted-foreground">
                                    {s.submittedBy} · {formatSubmitted(s.submittedAt)}
                                  </span>
                                )}
                                {!isBatch && s.note && (
                                  <span className="text-muted-foreground italic">“{s.note}”</span>
                                )}
                              </span>
                              {/* Created chips carry the produced opportunity's TITLE (the
                                  GET's batch join) and deep-link its Browse view; a produced
                                  id with no surviving corpus row degrades to the raw slug.
                                  Also on suppressed rows — the retraction record still says
                                  what it retracted. */}
                              {s.producedOpportunityIds.length > 0 && (
                                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                                    Created
                                  </span>
                                  {s.producedOpportunityIds.map((id) =>
                                    s.status === "suppressed" ? (
                                      // Unlinked on a suppressed submission — the detail
                                      // route 404s suppressed rows, so the link would land
                                      // on "Couldn't load that opportunity".
                                      <span
                                        key={id}
                                        className="text-apollo-slate bg-apollo-surface-2 max-w-64 truncate rounded-md px-[9px] py-[3px] text-[12.5px] font-medium"
                                      >
                                        {list.titles[id] ?? id}
                                      </span>
                                    ) : (
                                      <Link
                                        key={id}
                                        href={`/edit/grant-matcha?opp=${encodeURIComponent(id)}` as Route}
                                        className="text-apollo-slate bg-apollo-surface-2 max-w-64 truncate rounded-md px-[9px] py-[3px] text-[12.5px] font-medium hover:underline"
                                      >
                                        {list.titles[id] ?? id}
                                      </Link>
                                    ),
                                  )}
                                </span>
                              )}
                              {s.status === "rejected" && s.rejectReason && (
                                <RejectReason reason={s.rejectReason} />
                              )}
                            </div>
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
                    </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
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
      className={`ml-auto rounded-md px-2 py-1 text-xs ${
        kind === "delete"
          ? "text-apollo-maroon hover:bg-apollo-surface-2"
          : "text-muted-foreground hover:bg-apollo-surface-2 hover:text-foreground"
      } disabled:opacity-50`}
      data-testid={`intake-action-${kind}`}
    >
      {label}
    </button>
  );
}
