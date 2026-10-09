"use client";

/**
 * GrantRecs Phase 3 — the "Grants for me" panel on the `/edit` surface.
 *
 * Renders the forward matcher (`GET /api/scholars/[cwid]/opportunities`,
 * Phase 2) as a ranked list of open funding opportunities for the scholar.
 * Each row leads with plain-language explanation chips ("Matches your work on
 * ⟨topic⟩ (N pubs)", #1610) plus a qualitative fit tier (relative to the
 * strongest match in the list — the raw blend never renders), the funding
 * mechanism / deadline / award ceiling inline, and an expandable Details
 * disclosure (lazy-fetched from `GET /api/opportunities/[id]`) with the
 * synopsis, eligibility, award count, a link out, and the four per-axis
 * meters (demoted from the row body). Sort chips re-query (Fit / Deadline /
 * Stage / Prestige) — the route re-orders server-side; repeat chip toggles are
 * absorbed by the browser cache (the route sets `max-age=300`).
 *
 * No auth gate here: `/edit` is SSO-authenticated and owner-scoped server-side
 * (self → `getEffectiveCwid`; superuser → the `[cwid]` param), and the rail item
 * is gated by `isGrantRecsEnabled()` (`SELF_EDIT_GRANT_RECS`). The card just
 * takes the resolved `cwid` and fetches the public routes under the authed page.
 *
 * Feedback loop (#1609). With `feedbackEnabled` (the server page's
 * `SELF_EDIT_GRANT_RECS && (genuine self || genuine superuser)` — the same actor
 * rule `/api/edit/grant-recs/feedback` enforces) each row carries Save and Not
 * relevant toggles. The scholar's feedback is read once from that authed route
 * (never from the public matcher route, which would publish it); Not-relevant
 * items drop out and Saved items pin to the top on each list load
 * (`applyGrantRecFeedback`, over-fetching so the page stays full). Within a
 * load nothing jumps: a dismissed row collapses in place to an Undo line (with
 * an optional "why"), and a save just badges. Every write is optimistic and
 * rolls back with an inline error on failure.
 *
 * Telemetry (#1609) rides the shared `/api/analytics` beacon (the
 * funding-result-row pattern): one `grant_rec_impression` per list load,
 * `grant_rec_details_open`, `grant_rec_outbound_click` and `grant_rec_sort`,
 * each tagged with `surface` (self / superuser) so superuser QA never counts as
 * scholar engagement.
 */
import { useEffect, useRef, useState } from "react";

import { PrestigeBadge } from "@/components/edit/prestige-badge";
import type { Prestige } from "@/lib/funding/prestige";
import {
  applyGrantRecFeedback,
  NOT_RELEVANT_REASON_LABELS,
  NOT_RELEVANT_REASONS,
  overfetchLimit,
  type GrantRecFeedbackEntry,
  type GrantRecFeedbackStatus,
  type NotRelevantReason,
} from "@/lib/grant-recs/feedback";
import {
  deadlineLabel,
  dueUrgency,
  fitTier,
  formatUsd,
  type FitTierLabel,
} from "@/lib/match-display";
import { Caret } from "@/components/ui/caret";

type Axes = {
  topicAffinity: number;
  stageAppeal: number;
  meshOverlap: number;
  deadlineProximity: number;
};

/** Explanation chip (#1610): topic id + resolved label + the scholar's pub
 *  count there. Ids/labels/counts only — no per-topic scores. */
type MatchedTopic = { topicId: string; label: string; pubCount: number };

type Opportunity = {
  opportunityId: string;
  title: string;
  sponsor: string;
  dueDate: string | null;
  status: string;
  axes: Axes;
  defaultScore: number;
  mechanism: string | null;
  awardCeiling: number | null;
  prestige?: Prestige | null;
  matchedTopics?: MatchedTopic[];
};

/** Subset of the `GET /api/opportunities/[id]` row used by the Details disclosure. */
type OpportunityDetail = {
  synopsis?: string;
  sourceUrl?: string;
  eligibilityRaw?: string;
  numberOfAwards?: number | null;
  awardFloor?: number | null;
  awardCeiling?: number | null;
};

type Sort = "fit" | "deadline" | "stage" | "prestige";

const SORT_TABS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: "fit", label: "Fit" },
  { key: "deadline", label: "Deadline" },
  { key: "stage", label: "Stage" },
  { key: "prestige", label: "Prestige" },
];

const AXES: ReadonlyArray<{ key: keyof Axes; label: string }> = [
  { key: "topicAffinity", label: "topic" },
  { key: "stageAppeal", label: "stage" },
  { key: "meshOverlap", label: "mesh" },
  { key: "deadlineProximity", label: "deadline" },
];

const LIMIT = 25;

const FEEDBACK_ERROR = "We couldn’t save that just now. Please try again.";

type Surface = "self" | "superuser";

/** Fire-and-forget analytics beacon (the funding-result-row pattern). Never
 *  throws, never blocks; a no-op where `sendBeacon` is unavailable. */
function grantRecBeacon(event: string, fields: Record<string, unknown>): void {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify({ event, ...fields, ts: Date.now() })], {
        type: "application/json",
      }),
    );
  } catch {
    // Telemetry never blocks the card.
  }
}

/** One row's live feedback. */
type Live = { status: GrantRecFeedbackStatus; reason: NotRelevantReason | null };

/** Per-row feedback handle the card passes down (null ⇒ controls hidden). */
type RowFeedback = {
  live: Live | null;
  error: string | null;
  set: (status: GrantRecFeedbackStatus | null, reason?: NotRelevantReason | null) => void;
};

export function GrantRecsCard({
  cwid,
  feedbackEnabled = false,
  surface = "self",
}: {
  cwid: string;
  /** #1609 — render Save / Not relevant and apply the scholar's feedback. */
  feedbackEnabled?: boolean;
  /** Who is looking — tags the analytics beacons (self vs superuser QA). */
  surface?: Surface;
}) {
  const [sort, setSort] = useState<Sort>("fit");
  const [items, setItems] = useState<Opportunity[] | null>(null);
  const [errored, setErrored] = useState(false);
  // Live feedback (opportunityId → status/reason). `null` until the read lands;
  // the list waits for it so a dismissed item never flashes in.
  const [feedback, setFeedback] = useState<ReadonlyMap<string, Live> | null>(
    feedbackEnabled ? null : new Map(),
  );
  const [rowError, setRowError] = useState<ReadonlyMap<string, string>>(new Map());
  // Mirrors `feedback` for the list effect, which reads it without re-running
  // on every click (ordering only changes on the next load — nothing jumps).
  const feedbackRef = useRef<ReadonlyMap<string, Live>>(new Map());
  // Per-opportunity write sequence: a failed write rolls back only if no newer
  // write for the same row has started since.
  const seq = useRef(new Map<string, number>());

  const feedbackReady = feedback !== null;
  // Strongest default blend in the returned set — the fit tiers are RELATIVE
  // to it (the raw score is internal and never renders, #1608).
  const maxScore = items?.length ? Math.max(...items.map((i) => i.defaultScore)) : 0;

  useEffect(() => {
    if (!feedbackEnabled) return;
    let active = true;
    fetch(`/api/edit/grant-recs/feedback?cwid=${encodeURIComponent(cwid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { feedback?: GrantRecFeedbackEntry[] } | null) => {
        const m = new Map<string, Live>();
        for (const f of d?.feedback ?? []) {
          m.set(f.opportunityId, { status: f.status, reason: f.reason });
        }
        if (active) {
          feedbackRef.current = m;
          setFeedback(m);
        }
      })
      // A failed read degrades to "no feedback yet": the list still renders and
      // the controls still write.
      .catch(() => {
        if (active) setFeedback(new Map());
      });
    return () => {
      active = false;
    };
  }, [cwid, feedbackEnabled]);

  useEffect(() => {
    if (!feedbackReady) return;
    let active = true;
    // Snapshot at load time: decides which items are dropped / pinned until the
    // next load, so a click never reorders the list under the pointer.
    const snapshot = new Map<string, GrantRecFeedbackStatus>();
    for (const [id, f] of feedbackRef.current) snapshot.set(id, f.status);
    const limit = overfetchLimit(LIMIT, snapshot);
    // No `cache: "no-store"` here (deliberate, #1608): the route serves
    // `Cache-Control: private, max-age=300`, so flipping sort chips back and
    // forth re-reads the browser cache instead of re-running the full match.
    fetch(
      `/api/scholars/${encodeURIComponent(cwid)}/opportunities?sort=${sort}&limit=${limit}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { results?: Opportunity[] } | null) => {
        if (!active) return;
        const list = applyGrantRecFeedback(data?.results ?? [], snapshot, LIMIT);
        setItems(list);
        setErrored(false);
        grantRecBeacon("grant_rec_impression", {
          cwid,
          surface,
          mode: sort,
          resultCount: list.length,
          opportunityIds: list.map((o) => o.opportunityId),
        });
      })
      .catch(() => {
        if (active) {
          setItems([]);
          setErrored(true);
        }
      });
    return () => {
      active = false;
    };
  }, [cwid, sort, feedbackReady, surface]);

  function chooseSort(next: Sort) {
    if (next !== sort) grantRecBeacon("grant_rec_sort", { cwid, surface, mode: next });
    setSort(next);
  }

  function putLive(id: string, value: Live | null) {
    const next = new Map(feedbackRef.current);
    if (value) next.set(id, value);
    else next.delete(id);
    feedbackRef.current = next;
    setFeedback(next);
  }
  function putError(id: string, message: string | null) {
    setRowError((m) => {
      const next = new Map(m);
      if (message) next.set(id, message);
      else next.delete(id);
      return next;
    });
  }

  /** Set (or clear, `status: null`) one row's feedback — optimistic, rolled
   *  back with an inline error if the write fails. */
  async function setStatus(
    id: string,
    status: GrantRecFeedbackStatus | null,
    reason: NotRelevantReason | null,
  ) {
    const previous = feedbackRef.current.get(id) ?? null;
    const n = (seq.current.get(id) ?? 0) + 1;
    seq.current.set(id, n);
    putLive(id, status ? { status, reason } : null);
    putError(id, null);
    try {
      const res = await fetch("/api/edit/grant-recs/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwid, opportunityId: id, status, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || data.ok !== true) throw new Error("write_failed");
    } catch {
      if (seq.current.get(id) === n) {
        putLive(id, previous);
        putError(id, FEEDBACK_ERROR);
      }
    }
  }

  return (
    <div>
      <div className="mb-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="flex items-baseline gap-3 text-2xl font-bold tracking-tight">
            Grants for me
            {items && items.length > 0 ? (
              <span className="text-muted-foreground text-sm font-normal tracking-normal">
                {/* A full page = more may exist beyond the requested limit, so
                    "Top N" is honest where "N recommended" would overclaim. */}
                {items.length === LIMIT ? `Top ${LIMIT}` : `${items.length} recommended`}
              </span>
            ) : null}
          </h2>
          {items && items.length > 0 ? (
            <div className="flex items-center gap-2">
              {SORT_TABS.map(({ key, label }) => {
                const active = sort === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => chooseSort(key)}
                    aria-pressed={active}
                    className={
                      active
                        ? "inline-flex h-7 items-center rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white"
                        : "border-border-strong inline-flex h-7 items-center rounded-full border bg-background px-3 text-sm text-zinc-700 hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] dark:text-zinc-200"
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="text-muted-foreground mt-1 text-sm">
          Open funding opportunities matched to your publication topics and career
          stage — recommendations, not awarded grants.
        </div>
      </div>

      {items === null ? (
        <div role="status" className="text-muted-foreground py-8 text-sm">
          Loading recommendations…
        </div>
      ) : errored ? (
        <div role="alert" className="text-muted-foreground py-8 text-sm">
          Recommendations are unavailable right now. Please try again later.
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground py-8 text-sm">
          No matching opportunities yet. As your publication record grows, relevant
          open funding will appear here.
        </div>
      ) : (
        <ul>
          {items.map((o, position) => {
            const id = o.opportunityId;
            const live = feedback?.get(id) ?? null;
            const track = (event: string) =>
              grantRecBeacon(event, { cwid, surface, mode: sort, opportunityId: id, position });
            const fb: RowFeedback | null = feedbackEnabled
              ? {
                  live,
                  error: rowError.get(id) ?? null,
                  set: (status, reason) => void setStatus(id, status, reason ?? null),
                }
              : null;
            return (
              <li key={id}>
                {fb && live?.status === "not_relevant" ? (
                  <DismissedRow o={o} fb={fb} />
                ) : (
                  <OpportunityRow
                    o={o}
                    tier={fitTier(o.defaultScore, maxScore)}
                    fb={fb}
                    onDetailsOpen={() => track("grant_rec_details_open")}
                    onOutboundClick={() => track("grant_rec_outbound_click")}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RowError({ message }: { message: string | null }) {
  return message ? (
    <div role="alert" className="mt-1 text-sm text-destructive">
      {message}
    </div>
  ) : null;
}

/** A row the scholar just marked Not relevant: collapsed in place with Undo and
 *  an optional reason (the calibration label). Gone from the list next load. */
function DismissedRow({ o, fb }: { o: Opportunity; fb: RowFeedback }) {
  const reason = fb.live?.reason ?? null;
  // This row only mounts right after a click on "Not relevant" (items hidden at
  // load are never rendered), and that button just unmounted — hand keyboard
  // focus to Undo instead of dropping it to <body>.
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    undoRef.current?.focus();
  }, []);
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-muted-foreground text-sm">
          <span className="text-foreground">{o.title}</span>
          {" — marked not relevant. It won’t be recommended to you again."}
        </span>
        <button
          ref={undoRef}
          type="button"
          onClick={() => fb.set(null)}
          aria-label={`Undo not relevant: ${o.title}`}
          className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Undo
        </button>
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Why isn’t it relevant? (optional)"
      >
        <span className="text-muted-foreground text-xs" aria-hidden="true">
          Why? (optional)
        </span>
        {NOT_RELEVANT_REASONS.map((r) => {
          const on = reason === r;
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              onClick={() => fb.set("not_relevant", on ? null : r)}
              className={
                on
                  ? "inline-flex h-6 items-center rounded-full bg-[var(--color-accent-slate)] px-2.5 text-xs text-white"
                  : "border-border-strong inline-flex h-6 items-center rounded-full border bg-background px-2.5 text-xs text-foreground hover:border-[var(--color-accent-slate)]"
              }
            >
              {NOT_RELEVANT_REASON_LABELS[r]}
            </button>
          );
        })}
      </div>
      <RowError message={fb.error} />
    </div>
  );
}

function OpportunityRow({
  o,
  tier,
  fb,
  onDetailsOpen,
  onOutboundClick,
}: {
  o: Opportunity;
  tier: FitTierLabel;
  fb: RowFeedback | null;
  onDetailsOpen: () => void;
  onOutboundClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const saved = fb?.live?.status === "saved";

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) onDetailsOpen();
    if (next && detail === null && !loadingDetail) {
      setLoadingDetail(true);
      fetch(`/api/opportunities/${encodeURIComponent(o.opportunityId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: OpportunityDetail) => setDetail(d ?? {}))
        .catch(() => setDetail({}))
        .finally(() => setLoadingDetail(false));
    }
  }

  // Inline at-a-glance facts: sponsor · mechanism · deadline · award ceiling.
  // The deadline renders as its own span so a ≤30-day due date can take the
  // admin surface's amber urgency tone (#1608).
  const lead = [o.sponsor];
  if (o.mechanism) lead.push(o.mechanism);
  const urgency = dueUrgency(o.dueDate, Date.now());
  const chips = o.matchedTopics ?? [];

  const awards =
    detail?.numberOfAwards != null && detail.numberOfAwards > 0
      ? `${detail.numberOfAwards} award${detail.numberOfAwards === 1 ? "" : "s"}`
      : null;
  const metaLine = [detail?.eligibilityRaw, awards].filter(Boolean).join(" · ");

  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-medium leading-snug">{o.title}</span>
          {saved ? (
            <span className="rounded-full bg-[var(--color-accent-slate)] px-2 py-0.5 text-xs text-white">
              Saved
            </span>
          ) : null}
          <PrestigeBadge prestige={o.prestige} />
        </div>
        <span
          className="text-muted-foreground whitespace-nowrap text-xs"
          title="Fit relative to your strongest recommendation in this list"
        >
          {tier}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-sm">
        {`${lead.join(" · ")} · `}
        <span
          className={
            urgency === "soon" ? "font-medium text-apollo-amber" : undefined
          }
        >
          {deadlineLabel(o.dueDate, o.status)}
        </span>
        {o.awardCeiling ? ` · up to ${formatUsd(o.awardCeiling)}` : null}
      </div>
      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {chips.map((t) => (
            <span
              key={t.topicId}
              className="border-border-strong rounded-full border bg-background px-2.5 py-0.5 text-xs text-foreground"
            >
              {`Matches your work on ${t.label}${
                t.pubCount > 0 ? ` (${t.pubCount} ${t.pubCount === 1 ? "pub" : "pubs"})` : ""
              }`}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="group inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)]"
        >
          <Caret open={open} className="text-muted-foreground" />
          <span className="group-hover:underline">Details</span>
        </button>
        {fb ? (
          <>
            {/* Toggle: pressed = saved. The visible text flips with the state;
                the accessible name stays constant ("Save: ⟨title⟩") so the
                pressed state, not a changing name, carries the toggle. */}
            <button
              type="button"
              aria-pressed={saved}
              aria-label={`Save: ${o.title}`}
              onClick={() => fb.set(saved ? null : "saved")}
              className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
            >
              {saved ? "Saved ✓" : "Save"}
            </button>
            <button
              type="button"
              aria-label={`Not relevant: ${o.title}`}
              onClick={() => fb.set("not_relevant")}
              className="text-muted-foreground text-sm underline-offset-4 hover:underline"
            >
              Not relevant
            </button>
          </>
        ) : null}
      </div>
      {fb ? <RowError message={fb.error} /> : null}

      {open ? (
        <div className="mt-2 ml-4 border-l border-border pl-4 text-sm">
          {/* The per-axis meters live here, demoted from the row body — the
              matchedTopics chips are the primary explanation (#1610). */}
          <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1.5">
            {AXES.map(({ key, label }) => (
              <AxisMeter key={key} label={label} value={o.axes[key]} />
            ))}
          </div>
          {loadingDetail ? (
            <div role="status" className="text-muted-foreground py-1">
              Loading details…
            </div>
          ) : (
            <>
              {detail?.synopsis ? (
                <p className="text-foreground/90 leading-relaxed">{detail.synopsis}</p>
              ) : null}
              {metaLine ? (
                <div className="text-muted-foreground mt-2">{metaLine}</div>
              ) : null}
              {detail?.sourceUrl ? (
                <a
                  href={detail.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onOutboundClick}
                  className="mt-2 inline-block text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                >
                  View opportunity ↗
                </a>
              ) : null}
              {!detail?.synopsis && !metaLine && !detail?.sourceUrl ? (
                <div className="text-muted-foreground py-1">No further detail available.</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A labelled 0..1 sub-score bar — one per distinct matching axis. Exposed to
 *  assistive tech as a real meter (the old title-only div was invisible to
 *  screen readers, #1608). */
function AxisMeter({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = clamped * 100;
  return (
    <div
      className="flex items-center gap-1.5"
      role="meter"
      aria-label={`${label} match signal`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(clamped.toFixed(2))}
      title={`${label}: ${value.toFixed(2)}`}
    >
      <span className="text-muted-foreground w-12 text-[11px] uppercase tracking-wide">
        {label}
      </span>
      <span className="bg-muted inline-block h-1.5 w-16 overflow-hidden rounded-full">
        <span
          className="block h-1.5 rounded-full bg-[var(--color-accent-slate)]"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
