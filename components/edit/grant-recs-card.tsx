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
 */
import { useEffect, useState } from "react";

import { PrestigeBadge } from "@/components/edit/prestige-badge";
import type { Prestige } from "@/lib/funding/prestige";
import {
  deadlineLabel,
  dueUrgency,
  fitTier,
  formatUsd,
  type FitTierLabel,
} from "@/lib/match-display";

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

export function GrantRecsCard({ cwid }: { cwid: string }) {
  const [sort, setSort] = useState<Sort>("fit");
  const [items, setItems] = useState<Opportunity[] | null>(null);
  const [errored, setErrored] = useState(false);

  // Strongest default blend in the returned set — the fit tiers are RELATIVE
  // to it (the raw score is internal and never renders, #1608).
  const maxScore = items?.length ? Math.max(...items.map((i) => i.defaultScore)) : 0;

  useEffect(() => {
    let active = true;
    // No `cache: "no-store"` here (deliberate, #1608): the route serves
    // `Cache-Control: public, max-age=300`, so flipping sort chips back and
    // forth re-reads the browser cache instead of re-running the full match.
    fetch(
      `/api/scholars/${encodeURIComponent(cwid)}/opportunities?sort=${sort}&limit=${LIMIT}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { results?: Opportunity[] } | null) => {
        if (active) {
          setItems(data?.results ?? []);
          setErrored(false);
        }
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
  }, [cwid, sort]);

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
                    onClick={() => setSort(key)}
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
          {items.map((o) => (
            <li key={o.opportunityId}>
              <OpportunityRow o={o} tier={fitTier(o.defaultScore, maxScore)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityRow({ o, tier }: { o: Opportunity; tier: FitTierLabel }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
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
            urgency === "soon" ? "font-medium text-amber-700 dark:text-amber-400" : undefined
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

      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)]"
      >
        <span
          className={`text-muted-foreground inline-block w-3 text-[10px] transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="group-hover:underline">Details</span>
      </button>

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
