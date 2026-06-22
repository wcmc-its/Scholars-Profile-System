"use client";

/**
 * Per-core review queue (the owner surface at /edit/core/[coreId]). Mirrors the
 * coi-gap-card pattern: ranked candidate cards with inline evidence and per-row
 * actions that POST to /api/edit/core-claim, with optimistic local state. A
 * confirm/reject removes the row from the "To review" list; a confirm lifts it
 * into the "Confirmed" list. Kept deliberately simpler than coi-gap-card — cores
 * have no dual org/paper view and a binary (confirm/reject) decision.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, ExternalLink, Undo2, X } from "lucide-react";
import type { CoreQueueRow, CoreReviewQueue, QueueScholar } from "@/lib/api/core-queue";

type Decision = "claimed" | "rejected";
type FilterKey = "all" | "ack" | "coauthored" | "llm";
type SortKey = "likelihood" | "llm";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ack", label: "Acknowledged" },
  { key: "coauthored", label: "Co-authored" },
  { key: "llm", label: "LLM-flagged" },
];

/** Does a candidate match the active filter? `all` keeps everything. */
function matchesFilter(row: CoreQueueRow, filter: FilterKey): boolean {
  switch (filter) {
    case "ack":
      return row.signalAck || row.ackAlias !== null;
    case "coauthored":
      return row.coauthors.length > 0;
    case "llm":
      return row.llmScore !== null;
    default:
      return true;
  }
}

export function CoreClaimQueue({ core, candidates, confirmed }: CoreReviewQueue) {
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("likelihood");
  // Polite SR announcement of the last outcome — the success path is otherwise
  // silent (the card swaps in place with no focus move), mirroring coi-gap-card.
  const [announce, setAnnounce] = useState("");

  // Post a decision (claimed/rejected) or a revoke (undo) and reflect it locally.
  async function send(pmid: string, status: Decision | "revoked") {
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
      setDecided((m) => {
        const next = new Map(m);
        if (status === "revoked") next.delete(pmid);
        else next.set(pmid, status);
        return next;
      });
      const title = candidates.find((c) => c.pmid === pmid)?.title ?? "this publication";
      setAnnounce(
        status === "revoked"
          ? "Undone."
          : `${status === "claimed" ? "Confirmed" : "Rejected"} ${title}.`,
      );
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

  // Remaining review work (decided rows stay visible for undo but don't count).
  const remaining = candidates.filter((c) => !decided.has(c.pmid)).length;
  // Apply the filter (but always keep a just-decided row visible so undo stays
  // reachable), then sort. Likelihood is the loader's order; LLM re-sorts by score.
  const visible = candidates
    .filter((c) => decided.has(c.pmid) || matchesFilter(c, filter))
    .slice()
    .sort((a, b) =>
      sort === "llm" ? (b.llmScore ?? -1) - (a.llmScore ?? -1) : b.likelihood - a.likelihood,
    );

  return (
    <div data-slot="core-claim-queue">
      <div aria-live="polite" className="sr-only" data-testid="core-claim-live">
        {announce}
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-[15px] font-semibold">
          To review
          <span className="text-muted-foreground text-sm font-normal tabular-nums">{remaining}</span>
        </h2>
        {candidates.length > 0 ? (
          <QueueControls filter={filter} onFilter={setFilter} sort={sort} onSort={setSort} />
        ) : null}
      </div>

      {candidates.length > 0 ? (
        <p className="text-muted-foreground mb-3 text-xs">
          Shortcuts (focused card): <Kbd>a</Kbd> confirm · <Kbd>r</Kbd> reject · <Kbd>u</Kbd> undo ·{" "}
          <Kbd>↑</Kbd>/<Kbd>↓</Kbd> move.
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
          Nothing to review — every candidate publication for this core has been confirmed or
          rejected.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
          No candidates match this filter.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((row) => (
            <li key={row.pmid}>
              <CandidateCard
                row={row}
                decided={decided.get(row.pmid)}
                pending={pending.has(row.pmid)}
                error={errors.get(row.pmid)}
                onDecide={(status) => send(row.pmid, status)}
                onUndo={() => send(row.pmid, "revoked")}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmed.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold">
            Confirmed
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {confirmed.length}
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {confirmed.map((row) => (
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

function QueueControls({
  filter,
  onFilter,
  sort,
  onSort,
}: {
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1" role="group" aria-label="Filter candidates">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => onFilter(f.key)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              filter === f.key
                ? "border-transparent bg-[var(--color-accent-slate)] text-white"
                : "border-apollo-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <span className="sr-only">Sort by</span>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="border-apollo-border rounded-md border bg-background px-2 py-0.5 text-xs"
        >
          <option value="likelihood">Likelihood</option>
          <option value="llm">LLM score</option>
        </select>
      </label>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-apollo-border rounded border px-1 py-px font-mono text-[10px]">
      {children}
    </kbd>
  );
}

// Focusable shell shared by the active and decided card states — carries the
// keyboard contract (a/r/u + ↑/↓), firing only when the card itself is focused
// (not a child button/link), so its inner controls keep their native behavior.
const CARD_SHELL =
  "rounded-lg border border-apollo-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)]";

function CandidateCard({
  row,
  decided,
  pending,
  error,
  onDecide,
  onUndo,
}: {
  row: CoreQueueRow;
  decided: Decision | undefined;
  pending: boolean;
  error: string | undefined;
  onDecide: (status: Decision) => void;
  onUndo: () => void;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // only when the shell itself is focused
    const k = e.key.toLowerCase();
    if (k === "arrowdown" || k === "arrowup") {
      e.preventDefault();
      const li = e.currentTarget.closest("li");
      const sibling = k === "arrowdown" ? li?.nextElementSibling : li?.previousElementSibling;
      (sibling?.querySelector("[data-card]") as HTMLElement | null)?.focus();
      return;
    }
    if (pending) return;
    if (!decided && k === "a") {
      e.preventDefault();
      onDecide("claimed");
    } else if (!decided && k === "r") {
      e.preventDefault();
      onDecide("rejected");
    } else if (decided && k === "u") {
      e.preventDefault();
      onUndo();
    }
  }

  if (decided) {
    return (
      <div
        className={`${CARD_SHELL} flex items-center justify-between gap-3 p-4`}
        data-card
        data-pmid={row.pmid}
        tabIndex={0}
        role="group"
        aria-label={`${decided === "claimed" ? "Confirmed" : "Rejected"}: ${row.title}`}
        aria-keyshortcuts="u ArrowUp ArrowDown"
        onKeyDown={onKeyDown}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {decided === "claimed" ? (
            <Check className="size-4 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <X className="text-muted-foreground size-4 shrink-0" aria-hidden />
          )}
          <span className="text-muted-foreground shrink-0">
            {decided === "claimed" ? "Confirmed" : "Rejected"}
          </span>
          <span className="text-foreground truncate">{row.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? (
            <span className="text-xs text-red-600" role="alert">
              Could not save: {error}
            </span>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={onUndo}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm disabled:opacity-50"
          >
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
        </div>
      </div>
    );
  }

  const likelihoodPct = Math.round(row.likelihood * 100);
  return (
    <div
      className={`${CARD_SHELL} p-4`}
      data-card
      data-pmid={row.pmid}
      tabIndex={0}
      role="group"
      aria-label={`Candidate: ${row.title}`}
      aria-keyshortcuts="a r ArrowUp ArrowDown"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-[15px] font-medium">{row.title}</h3>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            {[row.journal, row.year].filter(Boolean).join(" · ") || "—"}
          </p>
          {row.authorsString ? (
            <p className="text-muted-foreground mt-1 line-clamp-1 text-xs">{row.authorsString}</p>
          ) : null}
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {row.pubmedUrl ? (
              <a
                href={row.pubmedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
              >
                PubMed <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
            {row.doi ? (
              <a
                href={`https://doi.org/${row.doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
              >
                DOI <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
            <span className="tabular-nums">
              {row.citationCount} citation{row.citationCount === 1 ? "" : "s"}
            </span>
          </div>
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

      {row.synopsis ? (
        <p className="text-muted-foreground mt-2 text-[13px] leading-snug">{row.synopsis}</p>
      ) : null}

      {row.llmRationale ? (
        <p className="text-foreground mt-2.5 text-[13px] leading-snug">{row.llmRationale}</p>
      ) : null}

      {/* Per-signal breakdown: combined headline % + whichever of the 4 signals fired. */}
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="evidence">
        <EvidenceChip label={`${likelihoodPct}% likely`} />
        {row.authorAffinity !== null ? (
          <EvidenceChip label={`Repeat-user ${Math.round(row.authorAffinity * 100)}%`} />
        ) : null}
        {row.coauthors.length > 0 ? (
          <EvidenceChip
            label={`${row.coauthors.length} core-staff co-author${row.coauthors.length > 1 ? "s" : ""}`}
          />
        ) : null}
        {row.ackAlias ? (
          <EvidenceChip label={`Named: ${row.ackAlias}`} />
        ) : row.signalAck ? (
          <EvidenceChip label="Acknowledged in text" />
        ) : null}
        {row.llmScore !== null ? <EvidenceChip label={`LLM ${row.llmScore}/10`} /> : null}
      </ul>

      {row.ackSnippet ? (
        <p className="text-muted-foreground mt-2 line-clamp-2 text-xs italic">“{row.ackSnippet}”</p>
      ) : null}

      <CoreStaffLine coauthorScholars={row.coauthorScholars} coauthors={row.coauthors} />

      {row.abstract || row.fullAuthorsString || row.wcmAuthors.length > 0 ? (
        <details className="group mt-2.5">
          <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-xs select-none">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Details
          </summary>
          <div className="mt-2 flex flex-col gap-3 border-l border-apollo-border pl-3">
            {row.abstract ? (
              <p className="text-muted-foreground text-xs leading-relaxed">{row.abstract}</p>
            ) : null}
            {row.fullAuthorsString ? (
              <p className="text-muted-foreground text-xs">
                <span className="font-medium text-foreground">Authors: </span>
                {row.fullAuthorsString}
              </p>
            ) : null}
            {row.wcmAuthors.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                <span className="font-medium text-foreground">WCM authors: </span>
                {row.wcmAuthors.map((s, i) => (
                  <span key={s.cwid}>
                    {i > 0 ? ", " : ""}
                    <ScholarLink scholar={s} />
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Could not save: {error}
        </p>
      ) : null}
    </div>
  );
}

/** A core-staff co-author (signal 2): named + linked when resolved, else the bare CWID. */
function CoreStaffLine({
  coauthorScholars,
  coauthors,
}: {
  coauthorScholars: QueueScholar[];
  coauthors: string[];
}) {
  if (coauthors.length === 0) return null;
  const resolved = new Set(coauthorScholars.map((s) => s.cwid));
  const unresolved = coauthors.filter((c) => !resolved.has(c));
  return (
    <p className="text-muted-foreground mt-2 text-xs">
      <span className="font-medium text-foreground">Core staff on byline: </span>
      {coauthorScholars.map((s, i) => (
        <span key={s.cwid}>
          {i > 0 ? ", " : ""}
          <ScholarLink scholar={s} />
          {s.dept ? <span className="text-muted-foreground"> ({s.dept})</span> : null}
        </span>
      ))}
      {unresolved.length > 0 ? (
        <span>
          {coauthorScholars.length > 0 ? ", " : ""}
          {unresolved.join(", ")}
        </span>
      ) : null}
    </p>
  );
}

/** Link to a scholar's public profile (`/{slug}`), opening in a new tab. */
function ScholarLink({ scholar }: { scholar: QueueScholar }) {
  return (
    <a
      href={`/${scholar.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground hover:underline"
    >
      {scholar.name}
    </a>
  );
}

function EvidenceChip({ label }: { label: string }) {
  return (
    <li className="border-apollo-border text-muted-foreground inline-flex items-center rounded-full border px-2 py-px text-[11px]">
      {label}
    </li>
  );
}
