"use client";

/**
 * GrantRecs Phase 4 — the "Funding matcher" reverse-matcher admin tool (redesign).
 *
 * Browse-first: the front door is a list of funding opportunities, led by the
 * hand-curated WCM awards (`source = "wcm_curated"`) — the corpus's reason to
 * exist, since those aren't widely known. Grants.gov NOFOs are off by default
 * (a toggle folds them in). Selecting an opportunity drills into the reverse
 * match: a parsed card + researchers ranked by topic fit and career-stage appeal
 * (`GET /api/opportunities/[id]/researchers`, admin-gated). Recommendations, not
 * endorsements.
 *
 * Display calibration (topic fit 0–100, stage-fit badge, the fact-only row blurb)
 * lives in `lib/match-display.ts`. Dept/career/funding filters + CSV export are a
 * follow-on slice.
 *
 * The selected opportunity lives in the URL (`?opp=<id>`), not component state,
 * so browser Back returns to the list and a colleague can be linked straight to
 * an opportunity's matches.
 *
 * Browse cards and the detail layout are modeled on Duke Research Funding
 * (researchfunding.duke.edu): deadline-led card meta, award amount on the card,
 * and a right-rail fact column with a "More information" button on the detail.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, Download, ExternalLink } from "lucide-react";

import { PrestigeBadge } from "@/components/edit/prestige-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { CareerStage } from "@/lib/career-stage";
import type { Prestige } from "@/lib/funding/prestige";
import {
  buildResearcherCsv,
  careerStageLabel,
  dueUrgency,
  fundingStatusLabel,
  researcherBlurb,
  stageFit,
  topicFitScores,
  type FundingStatus,
  type ResearcherCsvInput,
} from "@/lib/match-display";
import { initials } from "@/lib/utils";

const CAREER_STAGES: readonly CareerStage[] = ["grad", "postdoc", "early", "mid", "senior"];

/** Trigger a client-side CSV download (the matcher is admin-only; no server hop). */
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type TopicContribution = {
  topicId: string;
  contribution: number;
  pubCount: number;
  minYear: number | null;
};

type RankedScholar = {
  cwid: string;
  slug: string;
  preferredName?: string;
  careerStage: CareerStage | null;
  title?: string | null;
  department?: string | null;
  axes: { topicFit: number; stageAppeal: number };
  topicContributions: TopicContribution[];
  defaultScore: number;
  esiEligible?: boolean;
  yearsSinceDegree?: number | null;
  fundingStatus?: FundingStatus;
  inMyTopMatches?: boolean;
};

type OpportunityMeta = {
  title: string | null;
  synopsis: string | null;
  mechanism: string | null;
  openDate: string | null;
  dueDate: string | null;
  sponsor: string | null;
  source: string | null;
  sourceUrl: string | null;
  status: string | null;
  eligibilityRaw: string | null;
  cfdaList: string[];
  awardCeiling: number | null;
  awardFloor: number | null;
  estimatedFunding: number | null;
  numberOfAwards: number | null;
};

type OpportunityListItem = {
  opportunityId: string;
  title: string | null;
  sponsor: string | null;
  mechanism: string | null;
  dueDate: string | null;
  source: string | null;
  status: string | null;
  prestige?: Prestige | null;
  isHonorific?: boolean | null;
  awardCeiling?: number | null;
  awardFloor?: number | null;
};

type MatchingTopic = { topicId: string; label: string; score: number };

type MatchView = {
  opportunityId: string;
  count: number;
  opportunity: OpportunityMeta | null;
  matchingOn: MatchingTopic[];
  topicLabels: Record<string, string>;
  results: RankedScholar[];
};

type Sort = "fit" | "stage";

const SORT_TABS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: "fit", label: "Blended fit" },
  { key: "stage", label: "Stage fit" },
];

const LIMITS: readonly number[] = [25, 50, 100];

const SOURCE_LABELS: Record<string, string> = {
  grants_gov: "Grants.gov",
  nih_guide: "NIH Guide",
  wcm_curated: "WCM curated",
  manual_url: "Submitted URL",
};

function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Date-only DB columns arrive as midnight UTC; format in UTC so the day
  // doesn't shift back one in US-Eastern.
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatMoney(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** "$100,000–$500,000" / "Up to $500,000" / "From $100,000" from the floor/ceiling pair. */
function awardRange(floor: number | null, ceiling: number | null): string | null {
  const lo = formatMoney(floor);
  const hi = formatMoney(ceiling);
  if (lo && hi) return lo === hi ? hi : `${lo}–${hi}`;
  if (hi) return `Up to ${hi}`;
  if (lo) return `From ${lo}`;
  return null;
}

/**
 * "Due Jun 12, 2026" toned by urgency: amber inside the 30-day window, a
 * "(passed)" suffix once behind us — so staff can triage actionable vs dead
 * opportunities at a glance. Null when there is no parseable due date.
 */
function DueDate({ iso }: { iso: string | null }) {
  const due = formatDue(iso);
  if (!due) return null;
  const urgency = dueUrgency(iso, Date.now());
  return (
    <span className={urgency === "soon" ? "font-medium text-amber-700 dark:text-amber-400" : undefined}>
      Due {due}
      {urgency === "past" ? " (passed)" : ""}
    </span>
  );
}

/**
 * Long NOFO prose (synopsis, eligibility) collapsed behind a Show-more toggle,
 * mirroring the abstract clamp in `components/funding/expanded-grant.tsx`, so
 * the ranked researcher list stays near the fold.
 */
// ponytail: char-count heuristic for "long", not measured lines.
const CLAMP_THRESHOLD = 400;

function ClampedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > CLAMP_THRESHOLD;
  return (
    <div>
      <p
        className={`whitespace-pre-line text-sm leading-relaxed text-foreground/90 ${
          long && !expanded ? "line-clamp-4" : ""
        }`}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** Shimmer cards while a list loads; the label stays visible so staff know what's happening. */
function ListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div aria-busy="true">
      <p className="text-muted-foreground py-3 text-sm">{label}</p>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="border-border rounded-lg border p-4">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="mt-2 h-4 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FindResearchers() {
  // Selection lives in the URL (`?opp=`) — deep-linkable, and browser Back
  // returns to the list instead of leaving the console. The page is
  // force-dynamic, so `useSearchParams` needs no Suspense boundary.
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = useSearchParams().get("opp");
  const setSelectedId = (id: string | null) => {
    router.push(id ? `${pathname}?opp=${encodeURIComponent(id)}` : pathname);
  };

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Funding matcher</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Browse funding opportunities — the hand-curated WCM awards first — and open one
          to rank Weill Cornell researchers by topic fit and career-stage appeal.
          Recommendations, not endorsements.
        </p>
      </div>

      {selectedId === null ? (
        <BrowseList onSelect={setSelectedId} />
      ) : (
        <MatchedView key={selectedId} opportunityId={selectedId} onBack={() => setSelectedId(null)} />
      )}
    </div>
  );
}

type BrowseStatus =
  | { kind: "loading" }
  | { kind: "ok"; opportunities: OpportunityListItem[] }
  | { kind: "error"; message: string };

type BrowseSort = "curated" | "deadline";

/** Client-side browse filters (search box + Duke-style sidebar). */
export type BrowseFilters = {
  q: string;
  /** Hide opportunities whose due day is fully behind us (undated stay visible). */
  openOnly: boolean;
  /** Due-date range, `yyyy-mm-dd` or "" — a set range only matches dated opportunities. */
  dueFrom: string;
  dueTo: string;
  sponsors: ReadonlySet<string>;
  mechanisms: ReadonlySet<string>;
};

export const EMPTY_BROWSE_FILTERS: BrowseFilters = {
  q: "",
  openOnly: false,
  dueFrom: "",
  dueTo: "",
  sponsors: new Set(),
  mechanisms: new Set(),
};

/**
 * Does one opportunity pass the browse filters? OR within a checkbox group,
 * AND across groups. `skip` omits one group's own selections — used for that
 * group's facet counts, so unchecked options stay discoverable.
 */
export function matchesBrowseFilters(
  o: OpportunityListItem,
  f: BrowseFilters,
  now: number,
  skip?: "sponsors" | "mechanisms",
): boolean {
  const q = f.q.trim().toLowerCase();
  if (
    q &&
    !(o.title ?? "").toLowerCase().includes(q) &&
    !(o.sponsor ?? "").toLowerCase().includes(q)
  ) {
    return false;
  }
  if (f.openOnly && dueUrgency(o.dueDate, now) === "past") return false;
  if (f.dueFrom || f.dueTo) {
    const t = o.dueDate ? new Date(o.dueDate).getTime() : NaN;
    if (Number.isNaN(t)) return false;
    // Date-only strings parse as midnight UTC on both sides, so bounds are inclusive.
    if (f.dueFrom && t < Date.parse(f.dueFrom)) return false;
    if (f.dueTo && t > Date.parse(f.dueTo)) return false;
  }
  if (skip !== "sponsors" && f.sponsors.size > 0 && !f.sponsors.has(o.sponsor ?? "")) return false;
  if (skip !== "mechanisms" && f.mechanisms.size > 0 && !f.mechanisms.has(o.mechanism ?? "")) {
    return false;
  }
  return true;
}

/** `[value, count]` facet options for one group, most-frequent first. */
function facetOptions(
  all: readonly OpportunityListItem[],
  f: BrowseFilters,
  now: number,
  group: "sponsors" | "mechanisms",
  key: (o: OpportunityListItem) => string | null,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const o of all) {
    const k = key(o);
    if (k && matchesBrowseFilters(o, f, now, group)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function BrowseList({ onSelect }: { onSelect: (id: string) => void }) {
  const [includeGrantsGov, setIncludeGrantsGov] = useState(false);
  const [sort, setSort] = useState<BrowseSort>("curated");
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_BROWSE_FILTERS);
  const [status, setStatus] = useState<BrowseStatus>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setStatus({ kind: "loading" });
    const qs = new URLSearchParams({ limit: "200" });
    if (includeGrantsGov) qs.set("includeGrantsGov", "1");
    fetch(`/api/opportunities?${qs}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => {
        if (r.ok) {
          const data = (await r.json()) as { opportunities?: OpportunityListItem[] };
          if (active) setStatus({ kind: "ok", opportunities: data.opportunities ?? [] });
          return;
        }
        if (active) {
          setStatus({
            kind: "error",
            message:
              r.status === 403
                ? "You don't have access to the funding matcher."
                : "Couldn't load opportunities. Please try again.",
          });
        }
      })
      .catch(() => {
        if (active) setStatus({ kind: "error", message: "Couldn't load opportunities. Please try again." });
      });
    return () => {
      active = false;
    };
  }, [includeGrantsGov]);

  const all = status.kind === "ok" ? status.opportunities : [];
  const now = Date.now();
  let shown = all.filter((o) => matchesBrowseFilters(o, filters, now));
  if (sort === "deadline") {
    // Soonest first; undated (rolling) opportunities trail.
    shown = [...shown].sort((a, b) => {
      const ta = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const tb = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return ta - tb;
    });
  }

  const sponsorOptions = facetOptions(all, filters, now, "sponsors", (o) => o.sponsor);
  const mechanismOptions = facetOptions(all, filters, now, "mechanisms", (o) => o.mechanism);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <input
          type="search"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          placeholder="Search funding opportunities"
          aria-label="Search funding opportunities"
          className="border-border h-9 w-80 rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          autoComplete="off"
          spellCheck={false}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground text-xs font-medium">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as BrowseSort)}
            className="border-border h-9 rounded-md border bg-background px-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          >
            <option value="curated">Curated first</option>
            <option value="deadline">Deadline (soonest)</option>
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-x-10 gap-y-6 lg:flex-row">
        <div className="min-w-0 flex-1">
          {status.kind === "loading" ? (
            <ListSkeleton label="Loading opportunities…" />
          ) : status.kind === "error" ? (
            <div className="text-muted-foreground py-8 text-sm">{status.message}</div>
          ) : shown.length === 0 ? (
            <div className="text-muted-foreground py-8 text-sm">
              No opportunities match the current filters.
            </div>
          ) : (
            <>
              <p className="text-muted-foreground mb-2 text-xs">
                {shown.length} opportunit{shown.length === 1 ? "y" : "ies"}
              </p>
              <ul className="space-y-3">
                {shown.map((o) => (
                  <li key={o.opportunityId}>
                    <OpportunityRow o={o} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <FilterRail
          filters={filters}
          setFilters={setFilters}
          sponsorOptions={sponsorOptions}
          mechanismOptions={mechanismOptions}
          includeGrantsGov={includeGrantsGov}
          setIncludeGrantsGov={setIncludeGrantsGov}
        />
      </div>
    </div>
  );
}

const dateInputClass =
  "border-border h-9 w-full rounded-md border bg-background px-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]";

// Duke-style right-rail filters: availability, deadline range, then checkbox
// facet groups with counts. All client-side over the fetched corpus.
function FilterRail({
  filters,
  setFilters,
  sponsorOptions,
  mechanismOptions,
  includeGrantsGov,
  setIncludeGrantsGov,
}: {
  filters: BrowseFilters;
  setFilters: React.Dispatch<React.SetStateAction<BrowseFilters>>;
  sponsorOptions: Array<[string, number]>;
  mechanismOptions: Array<[string, number]>;
  includeGrantsGov: boolean;
  setIncludeGrantsGov: (v: boolean) => void;
}) {
  const active =
    filters.openOnly ||
    filters.dueFrom !== "" ||
    filters.dueTo !== "" ||
    filters.sponsors.size > 0 ||
    filters.mechanisms.size > 0;

  function toggleIn(group: "sponsors" | "mechanisms", value: string) {
    setFilters((f) => {
      const next = new Set(f[group]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...f, [group]: next };
    });
  }

  return (
    <aside className="w-full shrink-0 space-y-5 lg:w-64" aria-label="Filter opportunities">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Filters</h3>
        {active ? (
          <button
            type="button"
            onClick={() => setFilters((f) => ({ ...EMPTY_BROWSE_FILTERS, q: f.q }))}
            className="text-xs text-[var(--color-accent-slate)] hover:underline"
          >
            reset all
          </button>
        ) : null}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-sm font-medium">Availability</legend>
        {(
          [
            [false, "Open and past"],
            [true, "Only open"],
          ] as const
        ).map(([value, label]) => (
          <label key={label} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="availability"
              checked={filters.openOnly === value}
              onChange={() => setFilters((f) => ({ ...f, openOnly: value }))}
              className="size-4 accent-[var(--color-accent-slate)]"
            />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-sm font-medium">Deadline</legend>
        <label className="block text-xs">
          <span className="text-muted-foreground">From</span>
          <input
            type="date"
            value={filters.dueFrom}
            onChange={(e) => setFilters((f) => ({ ...f, dueFrom: e.target.value }))}
            className={dateInputClass}
          />
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">To</span>
          <input
            type="date"
            value={filters.dueTo}
            onChange={(e) => setFilters((f) => ({ ...f, dueTo: e.target.value }))}
            className={dateInputClass}
          />
        </label>
      </fieldset>

      <FacetGroup
        title="Sponsor"
        options={sponsorOptions}
        selected={filters.sponsors}
        onToggle={(v) => toggleIn("sponsors", v)}
      />
      <FacetGroup
        title="Mechanism"
        options={mechanismOptions}
        selected={filters.mechanisms}
        onToggle={(v) => toggleIn("mechanisms", v)}
      />

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Sources</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeGrantsGov}
            onChange={(e) => setIncludeGrantsGov(e.target.checked)}
            className="size-4 accent-[var(--color-accent-slate)]"
          />
          <span title="Off by default — the curated WCM awards are the focus; Grants.gov NOFOs are public and far more numerous.">
            Include Grants.gov
          </span>
        </label>
      </fieldset>
    </aside>
  );
}

// ponytail: fixed collapse threshold; a per-group search box only if a real
// corpus ever makes "show all" unwieldy.
const FACET_COLLAPSED = 8;

function FacetGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: Array<[string, number]>;
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (options.length === 0) return null;
  // Keep checked options visible even when collapsed.
  const shown = showAll
    ? options
    : options.filter(([v], i) => i < FACET_COLLAPSED || selected.has(v));
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{title}</legend>
      <div className="space-y-1">
        {shown.map(([value, count]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.has(value)}
              onChange={() => onToggle(value)}
              className="size-4 shrink-0 accent-[var(--color-accent-slate)]"
            />
            <span className="min-w-0 flex-1 truncate" title={value}>
              {value}
            </span>
            <span className="text-muted-foreground rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums">
              {count}
            </span>
          </label>
        ))}
      </div>
      {options.length > FACET_COLLAPSED ? (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
        >
          {showAll ? "show fewer" : `show all (${options.length})`}
        </button>
      ) : null}
    </fieldset>
  );
}

// Card layout modeled on Duke Research Funding's results list: deadline-led
// meta row, link-blue title, award amount + chevron affordance on the right.
function OpportunityRow({
  o,
  onSelect,
}: {
  o: OpportunityListItem;
  onSelect: (id: string) => void;
}) {
  const due = formatDue(o.dueDate);
  const award = awardRange(o.awardFloor ?? null, o.awardCeiling ?? null);
  return (
    <button
      type="button"
      onClick={() => onSelect(o.opportunityId)}
      className="border-border block w-full rounded-lg border bg-background p-4 text-left shadow-sm transition-shadow hover:border-[var(--color-accent-slate)]/50 hover:shadow"
    >
      {due || o.sponsor || o.source ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <DueDate iso={o.dueDate} />
            {o.sponsor ? <span className="truncate">{o.sponsor}</span> : null}
          </div>
          <SourceBadge source={o.source} />
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center justify-between gap-4">
        <span className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span className="font-semibold leading-snug text-[var(--color-accent-slate)]">
            {o.title ?? o.opportunityId}
          </span>
          <PrestigeBadge prestige={o.prestige} />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {award ? (
            <span className="text-sm font-medium tabular-nums text-foreground">{award}</span>
          ) : null}
          <ChevronRight className="text-muted-foreground size-4" aria-hidden />
        </span>
      </div>
      {o.mechanism ? <div className="text-muted-foreground mt-1 text-sm">{o.mechanism}</div> : null}
    </button>
  );
}

function SourceBadge({ source }: { source: string | null }) {
  const label = sourceLabel(source);
  if (!label) return null;
  const curated = source === "wcm_curated";
  return (
    <span
      className={
        curated
          ? "shrink-0 rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent-slate)]"
          : "border-border-strong text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs"
      }
    >
      {label}
    </span>
  );
}

type Status =
  | { kind: "loading" }
  | { kind: "ok"; view: MatchView }
  | { kind: "error"; message: string };

function MatchedView({
  opportunityId,
  onBack,
}: {
  opportunityId: string;
  onBack: () => void;
}) {
  const [sort, setSort] = useState<Sort>("fit");
  const [stageLens, setStageLens] = useState(false);
  const [esiOnly, setEsiOnly] = useState(false);
  const [limit, setLimit] = useState<number>(25);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setStatus({ kind: "loading" });
    const qs = new URLSearchParams({
      sort,
      stageLens: stageLens ? "1" : "0",
      esiOnly: esiOnly ? "1" : "0",
      limit: String(limit),
    });
    fetch(`/api/opportunities/${encodeURIComponent(opportunityId)}/researchers?${qs}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (r.ok) {
          const data = (await r.json()) as MatchView;
          if (active) setStatus({ kind: "ok", view: data });
          return;
        }
        let message = "Something went wrong fetching researchers. Please try again.";
        if (r.status === 400) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          message = body?.error ? `Invalid request: ${body.error}.` : "Invalid request.";
        } else if (r.status === 403) {
          message = "You don't have access to the researcher matcher.";
        }
        if (active) setStatus({ kind: "error", message });
      })
      .catch(() => {
        if (active) {
          setStatus({
            kind: "error",
            message: "Something went wrong fetching researchers. Please try again.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [opportunityId, sort, stageLens, esiOnly, limit]);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back to opportunities
      </button>

      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={stageLens}
            onChange={(e) => setStageLens(e.target.checked)}
            className="size-4 accent-[var(--color-accent-slate)]"
          />
          <span title="Blend career-stage appeal into the default score (who would this suit). Researchers with an unknown career stage score 0 under the lens.">
            Weight by career-stage fit
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={esiOnly}
            onChange={(e) => setEsiOnly(e.target.checked)}
            className="size-4 accent-[var(--color-accent-slate)]"
          />
          <span title="Soft ESI gate: rank early-stage-investigator-eligible faculty above ineligible ones (no one is dropped). Useful for early-career-targeted grants.">
            Prioritize ESI-eligible
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <label htmlFor="limit" className="text-xs font-medium text-muted-foreground">
            Show
          </label>
          <select
            id="limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border-border h-9 rounded-md border bg-background px-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Results status={status} sort={sort} setSort={setSort} />
    </div>
  );
}

function OpportunityCard({
  opportunityId,
  opportunity,
  matchingOn,
}: {
  opportunityId: string;
  opportunity: OpportunityMeta | null;
  matchingOn: MatchingTopic[];
}) {
  const o = opportunity;
  const src = sourceLabel(o?.source ?? null);
  const open = formatDue(o?.openDate ?? null);
  const due = formatDue(o?.dueDate ?? null);
  const award = awardRange(o?.awardFloor ?? null, o?.awardCeiling ?? null);
  const estimated = formatMoney(o?.estimatedFunding ?? null);
  const cfda = o?.cfdaList?.length ? o.cfdaList.join(", ") : null;

  // Compact subtitle under the title; the rest of the metadata lives in the rail.
  const subtitle = [o?.sponsor, o?.mechanism, o?.status].filter(Boolean) as string[];

  // Fact rail (Duke-style right column) — only entries we actually have a value
  // for, amount first, deadline toned by urgency.
  const facts: Array<{ label: string; value: string; className?: string }> = [];
  if (award) facts.push({ label: "Award", value: award });
  if (estimated) facts.push({ label: "Est. total funding", value: estimated });
  if (o?.numberOfAwards != null) facts.push({ label: "Awards", value: `~${o.numberOfAwards}` });
  if (open) facts.push({ label: "Opens", value: open });
  if (due) {
    const urgency = dueUrgency(o?.dueDate ?? null, Date.now());
    facts.push({
      label: "Due",
      value: urgency === "past" ? `${due} (passed)` : due,
      className:
        urgency === "soon" ? "font-medium text-amber-700 dark:text-amber-400" : undefined,
    });
  }
  if (cfda) facts.push({ label: "CFDA", value: cfda });

  return (
    <div className="border-border mb-6 rounded-lg border bg-[var(--muted)]/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="border-border-strong rounded-md border px-2 py-0.5 font-mono text-xs text-foreground">
          {opportunityId}
        </span>
        {src ? <span className="text-muted-foreground text-xs">Parsed from {src}</span> : null}
      </div>

      <div className="mt-2 flex flex-col gap-x-8 gap-y-4 sm:flex-row">
        <div className="min-w-0 flex-1">
          {o?.title ? <h2 className="text-lg font-semibold leading-snug">{o.title}</h2> : null}

          {subtitle.length > 0 ? (
            <div className="text-muted-foreground mt-1 text-sm">{subtitle.join(" · ")}</div>
          ) : null}

          {o?.synopsis ? (
            <div className="mt-3">
              <ClampedText text={o.synopsis} />
            </div>
          ) : null}

          {o?.eligibilityRaw ? (
            <div className="mt-3">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                Eligibility
              </span>
              <div className="mt-0.5">
                <ClampedText text={o.eligibilityRaw} />
              </div>
            </div>
          ) : null}

          {matchingOn.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                Matching on
              </span>
              {matchingOn.map((t) => (
                <span
                  key={t.topicId}
                  className="border-border-strong rounded-full border bg-background px-2.5 py-0.5 text-xs text-foreground"
                >
                  {t.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {o?.sourceUrl || facts.length > 0 ? (
          <div className="w-full shrink-0 space-y-4 sm:w-56">
            {o?.sourceUrl ? (
              <a
                href={o.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent-slate)] px-3 text-sm font-medium text-white hover:opacity-90"
              >
                <ExternalLink className="size-3.5" aria-hidden /> More information
              </a>
            ) : null}
            {facts.length > 0 ? (
              <dl className="space-y-3">
                {facts.map((f) => (
                  <div key={f.label}>
                    <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                      {f.label}
                    </dt>
                    <dd className={`text-sm ${f.className ?? "text-foreground"}`}>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Results({
  status,
  sort,
  setSort,
}: {
  status: Status;
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  // Hooks run unconditionally (before the loading/error returns). Selection is by
  // cwid, so it survives a sort re-fetch (same people, re-ordered); it resets per
  // opportunity because MatchedView remounts on each selection.
  const [dept, setDept] = useState<string>("all");
  const [stage, setStage] = useState<string>("all");
  const [funding, setFunding] = useState<string>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  if (status.kind === "loading") {
    return <ListSkeleton label="Ranking researchers…" />;
  }
  if (status.kind === "error") {
    return <div className="text-muted-foreground py-8 text-sm">{status.message}</div>;
  }

  const { opportunityId, opportunity, matchingOn, topicLabels, results } = status.view;
  // 0–100 topic-fit scores are relative to the strongest match across the FULL set,
  // keyed by cwid so a score doesn't shift when the view is filtered.
  const fitArr = topicFitScores(results.map((r) => r.axes.topicFit));
  const topicFitByCwid = new Map(results.map((r, i) => [r.cwid, fitArr[i] ?? 0]));

  const departments = [
    ...new Set(results.map((r) => r.department).filter((d): d is string => Boolean(d))),
  ].sort((a, b) => a.localeCompare(b));
  const stagesPresent = CAREER_STAGES.filter((s) => results.some((r) => r.careerStage === s));

  const fundingPresent = results.some((r) => r.fundingStatus != null);
  const filtered = results.filter(
    (r) =>
      (dept === "all" || r.department === dept) &&
      (stage === "all" || r.careerStage === stage) &&
      (funding === "all" || r.fundingStatus === funding),
  );
  const selectedCount = filtered.filter((r) => selected.has(r.cwid)).length;
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.cwid));

  function toggle(cwid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (filtered.every((r) => prev.has(r.cwid))) filtered.forEach((r) => next.delete(r.cwid));
      else filtered.forEach((r) => next.add(r.cwid));
      return next;
    });
  }
  function exportSelected() {
    const rows: ResearcherCsvInput[] = filtered
      .filter((r) => selected.has(r.cwid))
      .map((r) => {
        const top = [...r.topicContributions].sort((a, b) => b.contribution - a.contribution)[0];
        return {
          cwid: r.cwid,
          name: r.preferredName ?? r.slug ?? r.cwid,
          title: r.title ?? null,
          department: r.department ?? null,
          careerStage: r.careerStage,
          topicFit: topicFitByCwid.get(r.cwid) ?? 0,
          stageLabel: stageFit(r.axes.stageAppeal, r.careerStage !== null).label,
          esiEligible: r.esiEligible,
          fundingStatus: r.fundingStatus ?? null,
          topTopicLabel: top ? (topicLabels[top.topicId] ?? top.topicId) : "",
          topPubCount: top?.pubCount ?? 0,
        };
      });
    downloadCsv(`researchers-${opportunityId.replace(/[^a-z0-9._-]+/gi, "_")}.csv`, buildResearcherCsv(rows));
  }

  const selectClass =
    "border-border h-9 rounded-md border bg-background px-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]";

  return (
    <div>
      <OpportunityCard
        opportunityId={opportunityId}
        opportunity={opportunity}
        matchingOn={matchingOn}
      />

      {results.length === 0 ? (
        <div className="text-muted-foreground py-8 text-sm">
          No researchers ranked for{" "}
          <span className="font-mono text-foreground">{opportunityId}</span>. This opportunity may
          have no qualifying topics, or no eligible scholars publish in them.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Researchers for this opportunity</h3>
              <p className="text-muted-foreground text-sm">
                {filtered.length}
                {filtered.length !== results.length ? ` of ${results.length}` : ""} matched ·
                recommendations, not endorsements
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportSelected}
                disabled={selectedCount === 0}
                className="border-border-strong inline-flex h-7 items-center gap-1 rounded-md border bg-background px-3 text-sm text-foreground hover:border-[var(--color-accent-slate)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="size-3.5" aria-hidden /> Export ({selectedCount})
              </button>
              <span className="text-muted-foreground ml-1 text-xs">Sort</span>
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
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by department"
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              className={selectClass}
            >
              <option value="all">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by career stage"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className={selectClass}
            >
              <option value="all">Any career stage</option>
              {stagesPresent.map((s) => (
                <option key={s} value={s}>
                  {careerStageLabel(s)}
                </option>
              ))}
            </select>
            {fundingPresent ? (
              <select
                aria-label="Filter by funding status"
                value={funding}
                onChange={(e) => setFunding(e.target.value)}
                className={selectClass}
              >
                <option value="all">Any funding status</option>
                <option value="funded">{fundingStatusLabel("funded")}</option>
                <option value="unfunded">{fundingStatusLabel("unfunded")}</option>
              </select>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <div className="text-muted-foreground py-8 text-sm">
              No researchers match the current filters.
            </div>
          ) : (
            <>
              <label className="text-muted-foreground flex items-center gap-2 border-b border-border py-2 text-xs">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="size-4 accent-[var(--color-accent-slate)]"
                  aria-label="Select all shown researchers"
                />
                Select all ({filtered.length})
              </label>
              <ul>
                {filtered.map((r, i) => (
                  <li key={r.cwid}>
                    <ResearcherRow
                      r={r}
                      rank={i + 1}
                      topicFit={topicFitByCwid.get(r.cwid) ?? 0}
                      topicLabels={topicLabels}
                      selected={selected.has(r.cwid)}
                      onToggle={() => toggle(r.cwid)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ResearcherRow({
  r,
  rank,
  topicFit,
  topicLabels,
  selected,
  onToggle,
}: {
  r: RankedScholar;
  rank: number;
  topicFit: number;
  topicLabels: Record<string, string>;
  selected: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = r.preferredName ?? r.slug ?? r.cwid;
  const contributions = [...r.topicContributions].sort((a, b) => b.contribution - a.contribution);
  const top = contributions[0];
  const blurb = researcherBlurb({
    pubCount: top?.pubCount ?? 0,
    minYear: top?.minYear ?? null,
    topicLabel: top ? (topicLabels[top.topicId] ?? top.topicId) : "",
    careerStage: r.careerStage,
    esiEligible: r.esiEligible,
    yearsSinceDegree: r.yearsSinceDegree,
  });
  const stage = stageFit(r.axes.stageAppeal, r.careerStage !== null);

  return (
    <div className="border-t border-border py-4 first:border-t-0">
      <div className="flex gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent-slate)]"
          aria-label={`Select ${name}`}
        />
        <div className="text-muted-foreground w-5 pt-1 text-right text-sm tabular-nums">{rank}</div>
        <div
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-slate)]/15 text-sm font-medium text-[var(--color-accent-slate)]"
        >
          {initials(name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <a
              href={`/edit/scholar/${encodeURIComponent(r.cwid)}`}
              className="text-base font-semibold leading-snug text-foreground underline-offset-4 hover:underline"
            >
              {name}
            </a>
            {r.title ? <span className="text-muted-foreground text-sm">{r.title}</span> : null}
          </div>
          {r.department ? (
            <div className="text-muted-foreground text-sm">{r.department}</div>
          ) : null}
          {r.fundingStatus || r.inMyTopMatches ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {r.fundingStatus ? (
                <span
                  className={
                    r.fundingStatus === "funded"
                      ? "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      : "rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                  }
                >
                  {fundingStatusLabel(r.fundingStatus)}
                </span>
              ) : null}
              {r.inMyTopMatches ? (
                <span
                  title="This opportunity also ranks among this researcher's own “Grants for me” matches."
                  className="rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs text-[var(--color-accent-slate)]"
                >
                  Also in their Grants for me
                </span>
              ) : null}
            </div>
          ) : null}
          {blurb ? <p className="mt-1.5 text-sm text-foreground/90">{blurb}</p> : null}

          {contributions.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="group mt-2 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)]"
              >
                <ChevronRight
                  aria-hidden
                  className={`text-muted-foreground size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="group-hover:underline">
                  {contributions.length} topic{contributions.length === 1 ? "" : "s"}
                </span>
              </button>
              {open ? (
                <ul className="mt-2 ml-4 space-y-1 border-l border-border pl-4">
                  {contributions.map((c) => (
                    <li
                      key={c.topicId}
                      className="text-muted-foreground flex items-baseline justify-between gap-4 text-sm"
                    >
                      <span className="text-foreground">{topicLabels[c.topicId] ?? c.topicId}</span>
                      <span className="font-mono text-xs">
                        {c.pubCount > 0
                          ? `${c.pubCount} paper${c.pubCount === 1 ? "" : "s"}${c.minYear ? ` since ${c.minYear}` : ""}`
                          : c.contribution.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="w-40 shrink-0 space-y-3">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Topic fit</span>
              <span className="text-sm font-semibold tabular-nums">{topicFit}</span>
            </div>
            <span className="bg-muted mt-1 block h-1.5 w-full overflow-hidden rounded-full">
              <span
                className="block h-1.5 rounded-full bg-[var(--color-accent-slate)]"
                style={{ width: `${topicFit}%` }}
              />
            </span>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wide">Stage fit</div>
            <StageBadge fit={stage} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StageBadge({ fit }: { fit: ReturnType<typeof stageFit> }) {
  const tone: Record<string, string> = {
    strong: "bg-green-600/15 text-green-700 dark:text-green-400",
    moderate: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    weak: "bg-muted text-muted-foreground",
    none: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium ${tone[fit.tone]}`}
    >
      {fit.tone === "strong" ? <Check className="size-3.5" aria-hidden /> : null}
      {fit.label}
    </span>
  );
}
