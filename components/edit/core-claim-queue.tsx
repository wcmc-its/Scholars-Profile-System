"use client";

/**
 * Per-core review queue (the owner surface at /edit/core/[coreId]). Mirrors the
 * coi-gap-card pattern: ranked candidate cards with inline evidence and per-row
 * actions that POST to /api/edit/core-claim, with optimistic local state. A
 * confirm/reject removes the row from the "To review" list; a confirm lifts it
 * into the "Confirmed" list. Kept deliberately simpler than coi-gap-card — cores
 * have no dual org/paper view and a binary (confirm/reject) decision.
 */
import { useState } from "react";
import { Check, X } from "lucide-react";
import type { CoreQueueRow, CoreReviewQueue } from "@/lib/api/core-queue";

type Decision = "claimed" | "rejected";

export function CoreClaimQueue({ core, candidates, confirmed }: CoreReviewQueue) {
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  async function decide(pmid: string, status: Decision) {
    setErrors((m) => {
      const next = new Map(m);
      next.delete(pmid);
      return next;
    });
    setPending((s) => new Set(s).add(pmid));
    try {
      const res = await fetch("/api/edit/core-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pmid, coreId: core.id, status }),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => ({}));
        const error =
          data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `HTTP ${res.status}`;
        throw new Error(error);
      }
      setDecided((m) => new Map(m).set(pmid, status));
    } catch (err) {
      setErrors((m) => new Map(m).set(pmid, err instanceof Error ? err.message : "request failed"));
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(pmid);
        return next;
      });
    }
  }

  const open = candidates.filter((c) => !decided.has(c.pmid));
  const sessionConfirmed = candidates.filter((c) => decided.get(c.pmid) === "claimed");
  const confirmedAll = [...sessionConfirmed, ...confirmed];

  return (
    <div data-slot="core-claim-queue">
      <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold">
        To review
        <span className="text-muted-foreground text-sm font-normal tabular-nums">{open.length}</span>
      </h2>

      {open.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
          Nothing to review — every candidate publication for this core has been confirmed or
          rejected.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((row) => (
            <li key={row.pmid}>
              <CandidateCard
                row={row}
                pending={pending.has(row.pmid)}
                error={errors.get(row.pmid)}
                onDecide={(status) => decide(row.pmid, status)}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmedAll.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold">
            Confirmed
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {confirmedAll.length}
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {confirmedAll.map((row) => (
              <li
                key={row.pmid}
                className="text-muted-foreground flex items-baseline gap-2 text-sm"
              >
                <Check className="size-3.5 shrink-0 translate-y-0.5 text-emerald-600" aria-hidden />
                <span className="text-foreground">{row.title}</span>
                {row.year ? <span className="text-xs">· {row.year}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CandidateCard({
  row,
  pending,
  error,
  onDecide,
}: {
  row: CoreQueueRow;
  pending: boolean;
  error: string | undefined;
  onDecide: (status: Decision) => void;
}) {
  const likelihoodPct = Math.round(row.likelihood * 100);
  return (
    <div className="rounded-lg border border-apollo-border p-4" data-pmid={row.pmid}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-[15px] font-medium">{row.title}</h3>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            {[row.journal, row.year].filter(Boolean).join(" · ") || "—"}
          </p>
          {row.authorsString ? (
            <p className="text-muted-foreground mt-1 line-clamp-1 text-xs">{row.authorsString}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("claimed")}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            <Check className="size-3.5" aria-hidden /> Confirm
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("rejected")}
            className="border-border-strong text-muted-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden /> Reject
          </button>
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="evidence">
        <EvidenceChip label={`${likelihoodPct}% likely`} />
        {row.ackAlias ? <EvidenceChip label={`Named: ${row.ackAlias}`} /> : null}
        {row.coauthors.length > 0 ? (
          <EvidenceChip
            label={`${row.coauthors.length} core-staff co-author${row.coauthors.length > 1 ? "s" : ""}`}
          />
        ) : null}
        {row.llmScore !== null ? <EvidenceChip label={`LLM ${row.llmScore}/10`} /> : null}
      </ul>

      {row.ackSnippet ? (
        <p className="text-muted-foreground mt-2 line-clamp-2 text-xs italic">“{row.ackSnippet}”</p>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Could not save: {error}
        </p>
      ) : null}
    </div>
  );
}

function EvidenceChip({ label }: { label: string }) {
  return (
    <li className="border-apollo-border text-muted-foreground inline-flex items-center rounded-full border px-2 py-px text-[11px]">
      {label}
    </li>
  );
}
