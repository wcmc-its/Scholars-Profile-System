"use client";

/**
 * GrantRecs Phase 3 — the "Grants for me" panel on the `/edit` surface.
 *
 * Renders the forward matcher (`GET /api/scholars/[cwid]/opportunities`,
 * Phase 2) as a ranked list of open funding opportunities for the scholar,
 * each card carrying the DISTINCT per-axis sub-scores (topic / stage / mesh /
 * deadline) the engine emits plus the default-blend fit. Sort chips re-query
 * (Fit / Deadline / Stage) — the route re-orders server-side, no client-side
 * axis mutation.
 *
 * No auth gate here: `/edit` is SSO-authenticated and owner-scoped server-side
 * (self → `getEffectiveCwid`; superuser → the `[cwid]` param), and the rail item
 * is gated by `isGrantRecsEnabled()` (`SELF_EDIT_GRANT_RECS`). The card just
 * takes the resolved `cwid` and fetches the public route under the authed page.
 */
import { useEffect, useState } from "react";

type Axes = {
  topicAffinity: number;
  stageAppeal: number;
  meshOverlap: number;
  deadlineProximity: number;
};

type Opportunity = {
  opportunityId: string;
  title: string;
  sponsor: string;
  dueDate: string | null;
  status: string;
  axes: Axes;
  defaultScore: number;
};

type Sort = "fit" | "deadline" | "stage";

const SORT_TABS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: "fit", label: "Fit" },
  { key: "deadline", label: "Deadline" },
  { key: "stage", label: "Stage" },
];

const AXES: ReadonlyArray<{ key: keyof Axes; label: string }> = [
  { key: "topicAffinity", label: "topic" },
  { key: "stageAppeal", label: "stage" },
  { key: "meshOverlap", label: "mesh" },
  { key: "deadlineProximity", label: "deadline" },
];

const LIMIT = 25;

function deadlineLabel(dueDate: string | null, status: string): string {
  if (status === "continuous" || dueDate === null) return "Rolling · continuous";
  const t = Date.parse(dueDate);
  if (Number.isNaN(t)) return "—";
  const formatted = new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return status === "forecasted" ? `Forecasted · ${formatted}` : `Due ${formatted}`;
}

export function GrantRecsCard({ cwid }: { cwid: string }) {
  const [sort, setSort] = useState<Sort>("fit");
  const [items, setItems] = useState<Opportunity[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(
      `/api/scholars/${encodeURIComponent(cwid)}/opportunities?sort=${sort}&limit=${LIMIT}`,
      { cache: "no-store" },
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
                {items.length} recommended
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
        <div className="text-muted-foreground py-8 text-sm">Loading recommendations…</div>
      ) : errored ? (
        <div className="text-muted-foreground py-8 text-sm">
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
              <OpportunityRow o={o} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityRow({ o }: { o: Opportunity }) {
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-base font-medium leading-snug">{o.title}</div>
        <span
          className="text-muted-foreground whitespace-nowrap font-mono text-xs"
          title="Overall fit (default blend over the distinct axes)"
        >
          {o.defaultScore.toFixed(2)}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-sm">
        {o.sponsor} · {deadlineLabel(o.dueDate, o.status)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {AXES.map(({ key, label }) => (
          <AxisMeter key={key} label={label} value={o.axes[key]} />
        ))}
      </div>
    </div>
  );
}

/** A labelled 0..1 sub-score bar — one per distinct matching axis. */
function AxisMeter({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className="flex items-center gap-1.5"
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
