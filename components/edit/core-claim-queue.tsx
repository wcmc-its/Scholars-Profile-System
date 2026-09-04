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
import { useRouter } from "next/navigation";
import {
  Check,
  CheckCheck,
  ChevronRight,
  Download,
  ExternalLink,
  PenLine,
  Plus,
  Quote,
  Repeat,
  Sparkles,
  Tag,
  Undo2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CoreQueueRow, CoreReviewQueue, QueueScholar } from "@/lib/api/core-queue";
import { sanitizePubmedHtml } from "@/lib/utils";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { toCsv } from "@/lib/csv";

/** A pasted block of PMIDs, split on any run of whitespace/commas. Digit-only
 *  tokens are candidates; anything else is reported back so a typo isn't
 *  silently dropped. Pure — unit-tested without the network. */
export function parsePmidBlock(text: string): { pmids: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const pmids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (/^[1-9][0-9]*$/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        pmids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { pmids, invalid };
}

type Decision = "claimed" | "rejected";
/** Which list the segmented control is showing (only when there's history). */
type QueueView = "review" | "confirmed" | "rejected";
/** Exported for the pure-predicate tests; "all" is the reset, never a set member. */
export type FilterKey = "all" | "ack" | "coauthored" | "llm";
type SortKey = "likelihood" | "uncertain" | "strongest" | "llm";

type SignalKind = "ack" | "coauthor" | "llm" | "affinity" | "topic";
interface Signal {
  kind: SignalKind;
  /** 1–4 display strength. */
  dots: number;
  strength: string;
}

/** The five core-usage signals (ack, co-author, LLM, repeat-user, topical MeSH). */
const SIGNAL_COUNT = 5;
const SIGNAL_ICON: Record<SignalKind, LucideIcon> = {
  ack: Quote,
  coauthor: Users,
  llm: Sparkles,
  affinity: Repeat,
  topic: Tag,
};
/** Stable tie-break so equal-strength signals keep a deterministic order. */
const KIND_ORDER: Record<SignalKind, number> = {
  ack: 0,
  coauthor: 1,
  llm: 2,
  affinity: 3,
  topic: 4,
};
/**
 * Which of the five signals fired for a row. Strength is FIXED PER SIGNAL TYPE —
 * how much that *kind* of evidence should move a reviewer — NOT the model's
 * self-score: ack = Direct (4), core-staff co-author = Strong (3),
 * LLM read = Moderate (2) regardless of score, repeat-user prior and topical
 * MeSH prior = Weak (1) — both are indirect priors, not direct evidence about
 * this specific paper. The raw value (8/10, 45%) rides along as a secondary
 * readout in the meter. Pure; ordered strongest-first.
 */
export function buildSignals(row: CoreQueueRow): Signal[] {
  const out: Signal[] = [];
  if (row.signalAck || row.ackAlias) out.push({ kind: "ack", dots: 4, strength: "Direct" });
  if (row.coauthors.length > 0) out.push({ kind: "coauthor", dots: 3, strength: "Strong" });
  if (row.llmScore !== null) out.push({ kind: "llm", dots: 2, strength: "Moderate" });
  if (row.authorAffinity !== null) out.push({ kind: "affinity", dots: 1, strength: "Weak" });
  if (row.topicalPrior !== null) out.push({ kind: "topic", dots: 1, strength: "Weak" });
  return out.sort((a, b) => b.dots - a.dots || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ack", label: "Acknowledged" },
  { key: "coauthored", label: "Co-authored" },
  { key: "llm", label: "LLM-flagged" },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "likelihood", label: "Likelihood (high → low)" },
  { key: "uncertain", label: "Uncertain first" },
  { key: "strongest", label: "Strongest signal" },
  { key: "llm", label: "LLM score" },
];

/** One-click bulk-confirm sweeps open candidates at or above this likelihood. */
const HIGH_CONFIDENCE_LIKELIHOOD = 0.9;

/** Highest single-signal strength on a row (0 when nothing fired). */
function maxSignalDots(row: CoreQueueRow): number {
  return buildSignals(row).reduce((m, s) => Math.max(m, s.dots), 0);
}

/**
 * Order two candidates for the chosen sort. Pure.
 *   likelihood — engine confidence, high→low (default)
 *   uncertain  — closest to 50/50 first, where a reviewer's call matters most
 *   strongest  — by the single strongest signal, then likelihood
 *   llm        — by dense LLM triage score
 */
export function compareBySort(sort: SortKey, a: CoreQueueRow, b: CoreQueueRow): number {
  switch (sort) {
    case "uncertain":
      return Math.abs(a.likelihood - 0.5) - Math.abs(b.likelihood - 0.5);
    case "strongest":
      return maxSignalDots(b) - maxSignalDots(a) || b.likelihood - a.likelihood;
    case "llm":
      return (b.llmScore ?? -1) - (a.llmScore ?? -1);
    default:
      return b.likelihood - a.likelihood;
  }
}

/** Does a candidate match ONE filter key? `all` keeps everything. */
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

/**
 * OR-combined match across the ticked filters: a row shows if ANY of them
 * matches, so "Acknowledged + Co-authored" widens the queue rather than
 * narrowing it to the intersection (a reviewer ticking two kinds of evidence
 * wants both piles, not the rows carrying both). An empty set is the "All"
 * pill — nothing ticked means no narrowing at all. Pure.
 */
export function matchesFilters(row: CoreQueueRow, filters: ReadonlySet<FilterKey>): boolean {
  if (filters.size === 0) return true;
  for (const f of filters) if (matchesFilter(row, f)) return true;
  return false;
}

interface CoreClaimQueueProps {
  core: CoreReviewQueue["core"];
  candidates: CoreQueueRow[];
  confirmed: CoreQueueRow[];
  /** Previously-rejected pairs (server-loaded) for the Rejected tab. Optional so
   *  the simple all-candidates render stays a single prop set. */
  rejected?: CoreQueueRow[];
}

export function CoreClaimQueue({
  core,
  candidates,
  confirmed,
  rejected = [],
}: CoreClaimQueueProps) {
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // Confirmed rows walked back this session — kept visible with an undo.
  const [revokedConfirmed, setRevokedConfirmed] = useState<Set<string>>(new Set());
  // Rejected rows restored this session — kept visible with an undo (mirror of above).
  const [restoredRejected, setRestoredRejected] = useState<Set<string>>(new Set());
  // The active tab. Tabs only render when there's history (confirmed/rejected);
  // land on the first non-empty list so a reviewer with no open work sees content.
  const [view, setView] = useState<QueueView>(() =>
    candidates.length > 0
      ? "review"
      : confirmed.length > 0
        ? "confirmed"
        : rejected.length > 0
          ? "rejected"
          : "review",
  );
  // Ticked evidence filters, OR-combined. The empty set IS "All" — there is no
  // "all" member, the pill just reads as ticked when nothing else is.
  const [filter, setFilter] = useState<ReadonlySet<FilterKey>>(() => new Set());
  // Default to the most-uncertain band: the 96%s don't need a human, the 55–75%s do.
  const [sort, setSort] = useState<SortKey>("uncertain");
  // Polite SR announcement of the last outcome — the success path is otherwise
  // silent (the card swaps in place with no focus move), mirroring coi-gap-card.
  const [announce, setAnnounce] = useState("");
  // Manual PMID add: paste a block of known PMIDs and claim them directly,
  // independent of the engine queue (POST /api/edit/core-claim/bulk — the same
  // endpoint "Confirm N high-confidence" uses).
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);
  const router = useRouter();

  // Tick/untick one filter; the "All" pill clears back to no narrowing.
  const toggleFilter = (key: FilterKey) =>
    setFilter((s) => {
      if (key === "all") return new Set<FilterKey>();
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const markPending = (pmid: string) => setPending((s) => new Set(s).add(pmid));
  const clearPending = (pmid: string) =>
    setPending((s) => {
      const next = new Set(s);
      next.delete(pmid);
      return next;
    });
  const setError = (pmid: string, msg: string) => setErrors((m) => new Map(m).set(pmid, msg));
  const clearError = (pmid: string) =>
    setErrors((m) => {
      const next = new Map(m);
      next.delete(pmid);
      return next;
    });

  // Low-level POST to the claim endpoint; returns ok/error, touches no state.
  async function postClaim(
    pmid: string,
    status: Decision | "revoked",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
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
      return { ok: false, error };
    }
    return { ok: true };
  }

  // Decide a candidate (claimed/rejected) or revoke that decision, reflected locally.
  async function send(pmid: string, status: Decision | "revoked") {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, status);
    if (result.ok) {
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
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  // Bulk-confirm the high-confidence band in one click — clears the easy top so
  // uncertain-first leaves the reviewer only what genuinely needs a call. One
  // request to the bulk endpoint: the upsert + audit + writeback loop runs in a
  // single server transaction (no client-side fan-out / partial-failure spray).
  async function confirmHighConfidence(pmids: string[]) {
    if (pmids.length === 0) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Confirm ${pmids.length} high-confidence publication${pmids.length === 1 ? "" : "s"} for this core?`,
      )
    ) {
      return;
    }
    setPending((s) => new Set([...s, ...pmids]));
    const res = await fetch("/api/edit/core-claim/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids, status: "claimed" }),
    }).catch(() => null);
    const ok = res?.ok === true;
    if (ok) {
      setDecided((m) => {
        const next = new Map(m);
        for (const p of pmids) next.set(p, "claimed");
        return next;
      });
    } else {
      setErrors((m) => {
        const next = new Map(m);
        for (const p of pmids) next.set(p, "bulk confirm failed");
        return next;
      });
    }
    setPending((s) => {
      const next = new Set(s);
      for (const p of pmids) next.delete(p);
      return next;
    });
    setAnnounce(
      ok
        ? `Confirmed ${pmids.length} high-confidence publication${pmids.length === 1 ? "" : "s"}.`
        : "Bulk confirm could not be saved.",
    );
  }

  // Claim a pasted block of known PMIDs directly — the queue's own candidates
  // list plays no part; a pmid the engine never scored (or never will) is
  // claimed anyway, and the server-side existence check catches anything SPS
  // hasn't ingested. Refresh (not local state) so the page re-fetches the newly
  // manual-confirmed rows with their real title/journal/etc.
  async function submitAddPmids() {
    const { pmids, invalid } = parsePmidBlock(addText);
    if (pmids.length === 0) {
      setAddResult(
        invalid.length > 0 ? `No valid PMIDs found (ignored: ${invalid.join(", ")}).` : "Paste at least one PMID.",
      );
      return;
    }
    setAddPending(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-claim/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids, status: "claimed" }),
    }).catch(() => null);
    setAddPending(false);
    if (!res?.ok) {
      setAddResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      written?: number;
      skipped?: number;
      notFound?: string[];
    };
    const parts = [`Claimed ${data.written ?? 0}.`];
    if (data.skipped) parts.push(`Already claimed: ${data.skipped}.`);
    if (data.notFound?.length) parts.push(`Not found in SPS: ${data.notFound.join(", ")}.`);
    if (invalid.length > 0) parts.push(`Ignored: ${invalid.join(", ")}.`);
    setAddResult(parts.join(" "));
    setAnnounce(parts.join(" "));
    setAddText("");
    if ((data.written ?? 0) > 0) router.refresh();
  }

  // Walk back a confirmed row: a human claim soft-revokes ("revoked"); an engine
  // confirmation has no claim, so it needs a "rejected" override instead.
  async function revokeConfirmed(pmid: string, wasClaimed: boolean, title: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, wasClaimed ? "revoked" : "rejected");
    if (result.ok) {
      setRevokedConfirmed((s) => new Set(s).add(pmid));
      setAnnounce(`Revoked ${title}.`);
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  async function undoRevokeConfirmed(pmid: string, wasClaimed: boolean) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, wasClaimed ? "claimed" : "revoked");
    if (result.ok) {
      setRevokedConfirmed((s) => {
        const next = new Set(s);
        next.delete(pmid);
        return next;
      });
      setAnnounce("Undone.");
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  // Restore a rejected row: a rejected pair always has a human 'rejected' claim
  // (the engine has no rejected state), so the soft 'revoked' undo clears it on
  // the server, reverting the pair to its engine status. Like the Confirmed-tab
  // Revoke, the row stays here as a "Restored — …/Undo" line for the session; it
  // re-files into the right list (To review / Confirmed) on the next page load.
  async function restoreRejected(pmid: string, title: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, "revoked");
    if (result.ok) {
      setRestoredRejected((s) => new Set(s).add(pmid));
      setAnnounce(`Restored ${title}.`);
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  async function undoRestoreRejected(pmid: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, "rejected");
    if (result.ok) {
      setRestoredRejected((s) => {
        const next = new Set(s);
        next.delete(pmid);
        return next;
      });
      setAnnounce("Undone.");
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  // Download the queue (both lists) as a CSV citation list, reflecting the current
  // session state. Client-side blob — the rows are already in hand, no API needed.
  function downloadCsv() {
    const headers = [
      "PMID",
      "Title",
      "Authors",
      "Journal",
      "Year",
      "DOI",
      "Status",
      "Likelihood",
      "Citation",
    ];
    const statusOf = (pmid: string, base: "candidate" | "confirmed" | "rejected"): string => {
      if (base === "confirmed") return revokedConfirmed.has(pmid) ? "Revoked" : "Confirmed";
      if (base === "rejected") return restoredRejected.has(pmid) ? "Restored" : "Rejected";
      const d = decided.get(pmid);
      return d === "claimed" ? "Confirmed" : d === "rejected" ? "Rejected" : "To review";
    };
    const toRow = (r: CoreQueueRow, base: "candidate" | "confirmed" | "rejected") => {
      const authors = r.fullAuthorsString ?? r.authorsString ?? "";
      // plain Vancouver-ish citation string, PMID-anchored
      const citation =
        [authors, r.title, r.journal, r.year].filter(Boolean).join(". ") + `. PMID: ${r.pmid}.`;
      return [
        r.pmid,
        r.title,
        authors,
        r.journal ?? "",
        r.year ?? "",
        r.doi ?? "",
        statusOf(r.pmid, base),
        r.likelihood.toFixed(3),
        citation,
      ];
    };
    const csv = toCsv(headers, [
      ...candidates.map((r) => toRow(r, "candidate")),
      ...confirmed.map((r) => toRow(r, "confirmed")),
      ...rejected.map((r) => toRow(r, "rejected")),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `core-${core.id}-publications.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Remaining review work (decided rows stay visible for undo but don't count).
  const open = candidates.filter((c) => !decided.has(c.pmid));
  const remaining = open.length;
  // Per-option counts, over the still-open population only — a decided row is
  // held on screen for its undo and must not inflate a filter. These earn their
  // place: on core 14 today "Acknowledged" and "Co-authored" both match ZERO
  // rows, so without the count a reviewer ticks a box, gets an empty queue and
  // has no way to tell a dead filter from a bug.
  // ponytail: four extra passes over `open`, recomputed every render, no memo.
  // Fine at the sizes cores actually queue, but loadCoreReviewQueue has no
  // LIMIT — if one core ever returns thousands of candidates, fold these into a
  // single reduce or wrap them in useMemo([candidates, decided]).
  const filterCounts: Record<FilterKey, number> = {
    all: open.length,
    ack: open.filter((c) => matchesFilter(c, "ack")).length,
    coauthored: open.filter((c) => matchesFilter(c, "coauthored")).length,
    llm: open.filter((c) => matchesFilter(c, "llm")).length,
  };
  // Apply the filters (but always keep a just-decided row visible so undo stays
  // reachable), then sort. Likelihood is the loader's order; LLM re-sorts by score.
  const visible = candidates
    .filter((c) => decided.has(c.pmid) || matchesFilters(c, filter))
    .slice()
    .sort((a, b) => compareBySort(sort, a, b));
  // Open candidates the engine is most sure of — the one-click bulk-confirm band.
  const highConfidencePmids = open
    .filter((c) => c.likelihood >= HIGH_CONFIDENCE_LIKELIHOOD)
    .map((c) => c.pmid);
  // Tabs only earn their place once there's history to switch to; otherwise the
  // queue is the single "To review" scroll it always was.
  const hasHistory = confirmed.length > 0 || rejected.length > 0;

  return (
    <div data-slot="core-claim-queue">
      <div aria-live="polite" className="sr-only" data-testid="core-claim-live">
        {announce}
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {hasHistory ? (
          <ViewTabs
            view={view}
            onView={setView}
            reviewCount={remaining}
            confirmedCount={confirmed.length}
            rejectedCount={rejected.length}
          />
        ) : (
          <h2 className="flex items-baseline gap-2 text-[15px] font-semibold">
            To review
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {remaining}
            </span>
          </h2>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {view === "review" && highConfidencePmids.length > 0 ? (
            <button
              type="button"
              onClick={() => confirmHighConfidence(highConfidencePmids)}
              className="border-border-strong text-foreground hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm disabled:opacity-50"
            >
              <CheckCheck className="size-4" aria-hidden /> Confirm {highConfidencePmids.length}{" "}
              high-confidence
            </button>
          ) : null}
          {candidates.length > 0 || confirmed.length > 0 || rejected.length > 0 ? (
            <button
              type="button"
              onClick={downloadCsv}
              className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm"
            >
              <Download className="size-4" aria-hidden /> Download CSV
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setAddOpen((v) => !v);
              setAddResult(null);
            }}
            aria-pressed={addOpen}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm"
          >
            <Plus className="size-4" aria-hidden /> Add PMIDs
          </button>
        </div>
      </div>

      {addOpen ? (
        <div className="border-apollo-border bg-apollo-surface mb-3 rounded-lg border p-3">
          <label htmlFor="core-claim-add-pmids" className="text-foreground mb-1.5 block text-sm font-medium">
            Claim known PMIDs directly
          </label>
          <p className="text-muted-foreground mb-2 text-xs">
            One per line, or comma/space-separated. Independent of the review queue — use this for
            a paper you know used this core that our signals never surfaced.
          </p>
          <textarea
            id="core-claim-add-pmids"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="39812345, 38209981&#10;37102244"
            rows={3}
            className="border-border-strong text-foreground bg-apollo-surface focus-visible:ring-apollo-maroon w-full rounded-md border px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={addPending || addText.trim().length === 0}
              onClick={submitAddPmids}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white disabled:opacity-50"
            >
              {addPending ? "Claiming…" : "Claim"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAddText("");
                setAddResult(null);
              }}
              className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-full border bg-background px-3 text-sm"
            >
              Cancel
            </button>
          </div>
          {addResult ? (
            <p className="text-muted-foreground mt-2 text-xs" role="status">
              {addResult}
            </p>
          ) : null}
        </div>
      ) : null}

      {view === "review" ? (
        <>
          {candidates.length > 0 ? (
            <div className="mb-2">
              <QueueControls
                filter={filter}
                onToggleFilter={toggleFilter}
                counts={filterCounts}
                sort={sort}
                onSort={setSort}
              />
            </div>
          ) : null}

          {candidates.length > 0 ? (
            <p className="text-muted-foreground mb-3 text-xs">
              Shortcuts (focused card): <Kbd>a</Kbd> confirm · <Kbd>r</Kbd> reject · <Kbd>u</Kbd>{" "}
              undo · <Kbd>↑</Kbd>/<Kbd>↓</Kbd> move.
            </p>
          ) : null}

          {candidates.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
              Nothing to review — every candidate publication for this core has been confirmed or
              rejected.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
              No candidates match these filters.
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
        </>
      ) : null}

      {view === "confirmed" ? (
        <ul className="flex flex-col gap-1.5">
          {confirmed.map((row) => (
            <ConfirmedRow
              key={row.pmid}
              row={row}
              revoked={revokedConfirmed.has(row.pmid)}
              pending={pending.has(row.pmid)}
              error={errors.get(row.pmid)}
              onRevoke={() => revokeConfirmed(row.pmid, row.claimed, row.title)}
              onUndo={() => undoRevokeConfirmed(row.pmid, row.claimed)}
            />
          ))}
        </ul>
      ) : null}

      {view === "rejected" ? (
        <ul className="flex flex-col gap-1.5">
          {rejected.map((row) => (
            <RejectedRow
              key={row.pmid}
              row={row}
              restored={restoredRejected.has(row.pmid)}
              pending={pending.has(row.pmid)}
              error={errors.get(row.pmid)}
              onRestore={() => restoreRejected(row.pmid, row.title)}
              onUndo={() => undoRestoreRejected(row.pmid)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The segmented view switch (To review / Confirmed / Rejected), shown once the
 *  queue has history. `aria-pressed` pills — same styling as the FILTERS row,
 *  but a single choice, where the filters below are multi-select checkboxes. */
function ViewTabs({
  view,
  onView,
  reviewCount,
  confirmedCount,
  rejectedCount,
}: {
  view: QueueView;
  onView: (v: QueueView) => void;
  reviewCount: number;
  confirmedCount: number;
  rejectedCount: number;
}) {
  const tabs: { key: QueueView; label: string; count: number; show: boolean }[] = [
    { key: "review", label: "To review", count: reviewCount, show: true },
    { key: "confirmed", label: "Confirmed", count: confirmedCount, show: confirmedCount > 0 },
    { key: "rejected", label: "Rejected", count: rejectedCount, show: rejectedCount > 0 },
  ];
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Queue view">
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={view === t.key}
            onClick={() => onView(t.key)}
            className={`focus-visible:ring-apollo-maroon inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 ${
              view === t.key
                ? "bg-apollo-maroon border-transparent text-white"
                : "border-apollo-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            <span className="tabular-nums opacity-80">{t.count}</span>
          </button>
        ))}
    </div>
  );
}

// A confirmed publication with an inline Revoke (kept walk-back-able for the
// session — the one thing this list needs to earn its place below the queue).
function ConfirmedRow({
  row,
  revoked,
  pending,
  error,
  onRevoke,
  onUndo,
}: {
  row: CoreQueueRow;
  revoked: boolean;
  pending: boolean;
  error: string | undefined;
  onRevoke: () => void;
  onUndo: () => void;
}) {
  if (revoked) {
    return (
      <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-baseline gap-2">
          <Undo2 className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="truncate">{row.title}</span>
          {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
          <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
          <span className="shrink-0 text-xs italic">— Revoked, re-files on next load</span>
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={onUndo}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Undo
        </button>
      </li>
    );
  }
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-baseline gap-2">
        <Check className="size-3.5 shrink-0 translate-y-0.5 text-emerald-600" aria-hidden />
        <span className="text-foreground truncate">{row.title}</span>
        {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
        <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
        {row.isManual ? (
          <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs italic">
            <PenLine className="size-3" aria-hidden /> Manually added
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-600" role="alert">
            Could not save: {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={onRevoke}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Revoke
        </button>
      </span>
    </li>
  );
}

// A previously-rejected publication with an inline Restore — the mirror of
// ConfirmedRow's Revoke. Restore soft-revokes the rejection (re-opens for review).
function RejectedRow({
  row,
  restored,
  pending,
  error,
  onRestore,
  onUndo,
}: {
  row: CoreQueueRow;
  restored: boolean;
  pending: boolean;
  error: string | undefined;
  onRestore: () => void;
  onUndo: () => void;
}) {
  if (restored) {
    return (
      <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-baseline gap-2">
          <Undo2 className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="truncate">{row.title}</span>
          {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
          <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
          <span className="shrink-0 text-xs italic">— Restored, re-files on next load</span>
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={onUndo}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Undo
        </button>
      </li>
    );
  }
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-baseline gap-2">
        <X className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5" aria-hidden />
        <span className="text-foreground truncate">{row.title}</span>
        {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
        <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-600" role="alert">
            Could not save: {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={onRestore}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Restore
        </button>
      </span>
    </li>
  );
}

function QueueControls({
  filter,
  onToggleFilter,
  counts,
  sort,
  onSort,
}: {
  filter: ReadonlySet<FilterKey>;
  onToggleFilter: (f: FilterKey) => void;
  counts: Record<FilterKey, number>;
  sort: SortKey;
  onSort: (s: SortKey) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter candidates">
        {FILTERS.map((f) => {
          // "All" is the reset, not a fourth box: it reads as ticked exactly
          // when nothing else is. Buttons keep the native Space/Enter activation
          // the checkbox role expects, so no key handler of our own.
          const checked = f.key === "all" ? filter.size === 0 : filter.has(f.key);
          return (
            <button
              key={f.key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggleFilter(f.key)}
              className={`focus-visible:ring-apollo-maroon rounded-full border px-3 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 ${
                checked
                  ? "bg-apollo-maroon border-transparent text-white"
                  : "border-apollo-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label} <span className="tabular-nums opacity-80">{counts[f.key]}</span>
            </button>
          );
        })}
      </div>
      <label className="text-muted-foreground flex items-center gap-1 text-[13px]">
        <span className="sr-only">Sort by</span>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="border-border-strong bg-apollo-surface focus-visible:ring-apollo-maroon rounded-md border px-2 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              Sort: {s.label}
            </option>
          ))}
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
  "bg-apollo-surface rounded-lg border border-apollo-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-maroon";

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
    // Tint the strip so a confirm vs. reject reads at a glance, not just from the
    // icon — same pattern as opportunity-intake-panel's STATUS_STYLES.
    const tint =
      decided === "claimed"
        ? "border-emerald-200 bg-emerald-50"
        : "border-red-200 bg-red-50";
    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-lg border p-4 ${tint} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-maroon`}
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
            <X className="size-4 shrink-0 text-red-600" aria-hidden />
          )}
          <span className={decided === "claimed" ? "text-emerald-800" : "text-red-800"}>
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
  const signals = buildSignals(row);
  // A 0 on a just-published paper isn't "0 citations", it's "not cited yet".
  const recentlyPublished = row.year !== null && row.year >= new Date().getFullYear() - 1;
  return (
    <div
      className={`${CARD_SHELL} px-5 py-4`}
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
          <Byline row={row} />
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {/* PMID shown verbatim (curators key off it); links to PubMed when present. */}
            {row.pubmedUrl ? (
              <a
                href={row.pubmedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground inline-flex items-center gap-1 tabular-nums hover:underline"
              >
                PMID {row.pmid} <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span className="tabular-nums">PMID {row.pmid}</span>
            )}
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
            {row.citationCount > 0 ? (
              <span className="tabular-nums">
                {row.citationCount} citation{row.citationCount === 1 ? "" : "s"}
              </span>
            ) : recentlyPublished ? (
              <span>No citations yet{row.year ? ` · published ${row.year}` : ""}</span>
            ) : (
              <span className="tabular-nums">0 citations</span>
            )}
            {row.nihPercentile !== null ? (
              <span className="tabular-nums">
                RCR {row.relativeCitationRatio ?? "—"} ({row.nihPercentile}th pct)
              </span>
            ) : null}
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
        <p className="bg-muted/60 border-apollo-border text-muted-foreground mt-3 rounded-md border px-3 py-2 text-[13px] leading-snug">
          {row.synopsis}
        </p>
      ) : null}

      {/* Combined likelihood + the per-signal "why this surfaced" breakdown. */}
      <div className="my-4 flex items-center gap-2.5">
        <span className="text-muted-foreground text-[13px]">Combined likelihood</span>
        <span className="bg-muted block h-1.5 flex-1 overflow-hidden rounded-full">
          <span
            className="block h-1.5 rounded-full bg-[var(--color-accent-slate)]"
            style={{ width: `${likelihoodPct}%` }}
          />
        </span>
        <span className="text-sm font-medium tabular-nums">{likelihoodPct}%</span>
      </div>

      <p className="text-muted-foreground text-xs">
        Why this surfaced · {signals.length} of {SIGNAL_COUNT} signals fired
      </p>

      {signals.length > 0 ? (
        <ul className="mt-1" aria-label="evidence">
          {signals.map((s) => (
            <SignalRow key={s.kind} signal={s} row={row} />
          ))}
        </ul>
      ) : (
        // Reachable for real: batch_screen's own screen_confidence/screen_band
        // outputs can move the combined likelihood without any of the five
        // displayed signals firing — those two fields still aren't mapped into
        // SPS (see docs/core-facility-claim-queue-spec.md, "The signals").
        <p className="text-muted-foreground mt-1 text-xs italic">
          No displayed signal fired — the combined score moved on inputs the queue
          doesn&apos;t label.
        </p>
      )}

      {row.abstract || row.fullAuthorsString || row.wcmAuthors.length > 0 || row.meshTerms.length > 0 ? (
        <details className="group mt-2.5">
          <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-xs select-none">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Details
          </summary>
          <div className="mt-2 flex flex-col gap-3 border-l border-apollo-border pl-3">
            {row.abstract ? (
              // Stored abstracts carry inline PubMed markup (e.g. NaN<sub>3</sub>);
              // sanitizePubmedHtml whitelists only i/em/b/strong/sub/sup.
              <p
                className="text-muted-foreground text-xs leading-relaxed"
                dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(row.abstract) }}
              />
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
            {row.meshTerms.length > 0 ? (
              <div className="text-muted-foreground text-xs">
                <span className="font-medium text-foreground">MeSH</span>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {row.meshTerms.map((m, i) => (
                    // index keeps the key unique — normalizeMeshTerms doesn't dedupe,
                    // so a malformed pub could carry two null-ui terms with one label.
                    <li
                      key={`${m.ui ?? m.label}::${i}`}
                      className="bg-muted text-foreground/80 rounded px-2 py-0.5 text-xs"
                    >
                      {m.label}
                    </li>
                  ))}
                </ul>
              </div>
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

/** One fired signal as an evidence row: icon · lead (+ quote/sub) · strength dots. */
function SignalRow({ signal, row }: { signal: Signal; row: CoreQueueRow }) {
  const Icon = SIGNAL_ICON[signal.kind];
  let lead: ReactNode;
  let sub: ReactNode = null;
  let quote: string | null = null;
  let value: string | undefined; // raw secondary readout shown beneath the tier
  switch (signal.kind) {
    case "ack":
      lead = row.ackAlias ? "Named in the acknowledgments" : "Acknowledged in text";
      if (row.ackSnippet) quote = row.ackSnippet;
      else if (row.ackAlias) sub = `Matched “${row.ackAlias}” in the full text`;
      break;
    case "coauthor":
      lead = <CoauthorLead row={row} />;
      if (row.coauthorScholars.length === 0) sub = "No Scholar profile yet — showing CWID";
      break;
    case "llm":
      lead = "LLM triage";
      sub = row.llmRationale;
      value = `${row.llmScore}/10`;
      break;
    case "affinity":
      lead = "Repeat user of this core";
      sub = "From the author's prior confirmed pubs with this core";
      value = `${Math.round((row.authorAffinity ?? 0) * 100)}%`;
      break;
    case "topic":
      lead = "Topical MeSH match";
      sub = "The paper carries a MeSH descriptor under this core's technique branch";
      value = `${Math.round((row.topicalPrior ?? 0) * 100)}%`;
      break;
  }
  return (
    <li className="border-apollo-border grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-3 border-t pt-3">
      <Icon className="text-muted-foreground mt-0.5 size-4" aria-hidden />
      <div className="min-w-0">
        <div className="text-foreground text-[13px]">{lead}</div>
        {quote ? (
          <p className="border-border-strong text-muted-foreground mt-1 border-l-2 pl-2 text-xs italic">
            “{quote}”
          </p>
        ) : sub ? (
          <div className="text-muted-foreground mt-0.5 text-xs">{sub}</div>
        ) : null}
      </div>
      <StrengthDots dots={signal.dots} strength={signal.strength} value={value} />
    </li>
  );
}

/**
 * Author byline with the core-staff author(s) highlighted as a tinted, linked
 * chip + tooltip — the connection back to the co-author evidence row below.
 * ponytail: best-effort surname match against the flat `authorsString` (the data
 * carries no per-author byline token; this mirrors how profile author-links are
 * overlaid). Unresolved core-staff CWIDs aren't in the byline, so they show only
 * in the evidence row.
 */
function Byline({ row }: { row: CoreQueueRow }) {
  if (!row.authorsString) return null;
  const staffBySurname = new Map<string, QueueScholar>();
  for (const s of row.coauthorScholars) {
    const surname = s.name.trim().split(/\s+/).pop();
    if (surname) staffBySurname.set(surname.toLowerCase(), s);
  }
  if (staffBySurname.size === 0) {
    return <p className="text-muted-foreground mt-1 text-xs">{row.authorsString}</p>;
  }
  const tokens = row.authorsString.split(", ");
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      {tokens.map((tok, i) => {
        const lead = tok.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const staff = staffBySurname.get(lead);
        return (
          <span key={i}>
            {i > 0 ? ", " : ""}
            {staff ? (
              <HoverTooltip
                text={`${staff.name} — core staff${staff.dept ? `, ${staff.dept}` : ""}`}
              >
                {staff.slug ? (
                  <a
                    href={`/${staff.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium"
                  >
                    {tok}
                  </a>
                ) : (
                  <span className="bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium">
                    {tok}
                  </span>
                )}
              </HoverTooltip>
            ) : (
              tok
            )}
          </span>
        );
      })}
    </p>
  );
}

/** "Co-authored with …" — linked scholars (with dept) plus any bare CWIDs. */
function CoauthorLead({ row }: { row: CoreQueueRow }) {
  const resolved = row.coauthorScholars;
  const resolvedSet = new Set(resolved.map((s) => s.cwid.toLowerCase()));
  const unresolved = row.coauthors.filter((c) => !resolvedSet.has(c.toLowerCase()));
  if (resolved.length === 0) {
    return (
      <>
        Co-authored with core staff <span className="font-mono text-[12.5px]">{unresolved.join(", ")}</span>
      </>
    );
  }
  return (
    <>
      Co-authored with{" "}
      {resolved.map((s, i) => (
        <span key={s.cwid}>
          {i > 0 ? ", " : ""}
          <ScholarLink scholar={s} />
          {s.dept ? <span className="text-muted-foreground"> ({s.dept})</span> : null}
        </span>
      ))}
      {unresolved.length > 0 ? <span>, {unresolved.join(", ")}</span> : null}
    </>
  );
}

/** Fixed-width strength meter: dots, the tier word, and an optional raw value,
 *  vertically centered against the row and right-aligned. */
function StrengthDots({
  dots,
  strength,
  value,
}: {
  dots: number;
  strength: string;
  value?: string;
}) {
  return (
    <div className="flex w-20 flex-col items-end gap-1 self-center whitespace-nowrap text-right">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`size-1.5 rounded-full border ${
              i < dots
                ? "border-muted-foreground bg-muted-foreground"
                : "border-muted-foreground/40"
            }`}
          />
        ))}
      </span>
      <span className="text-muted-foreground text-[11px] leading-tight">{strength}</span>
      {value ? (
        <span className="text-muted-foreground/70 text-[11px] leading-tight tabular-nums">
          {value}
        </span>
      ) : null}
    </div>
  );
}

/** Link to a scholar's public profile (`/{slug}`), opening in a new tab. */
function ScholarLink({ scholar }: { scholar: QueueScholar }) {
  // ED-only staff (no Scholar row) have no profile to link to — name only.
  if (!scholar.slug) return <span className="text-foreground">{scholar.name}</span>;
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
