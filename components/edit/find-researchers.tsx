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
 */
import { useEffect, useState } from "react";

import { PrestigeBadge } from "@/components/edit/prestige-badge";
import type { CareerStage } from "@/lib/career-stage";
import type { Prestige } from "@/lib/funding/prestige";
import {
  buildResearcherCsv,
  careerStageLabel,
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
};

function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

export function FindResearchers({ unifiedNav = false }: { unifiedNav?: boolean }) {
  const toolName = unifiedNav ? "Funding matcher" : "Find researchers";
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">{toolName}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Browse funding opportunities — the hand-curated WCM awards first — and open one
          to rank Weill Cornell researchers by topic fit and career-stage appeal.
          Recommendations, not endorsements.
        </p>
      </div>

      {selectedId === null ? (
        <BrowseList onSelect={setSelectedId} />
      ) : (
        <MatchedView opportunityId={selectedId} onBack={() => setSelectedId(null)} />
      )}
    </div>
  );
}

type BrowseStatus =
  | { kind: "loading" }
  | { kind: "ok"; opportunities: OpportunityListItem[] }
  | { kind: "error"; message: string };

function BrowseList({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [includeGrantsGov, setIncludeGrantsGov] = useState(false);
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
  const q = query.trim().toLowerCase();
  const shown = q
    ? all.filter(
        (o) =>
          (o.title ?? "").toLowerCase().includes(q) || (o.sponsor ?? "").toLowerCase().includes(q),
      )
    : all;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search funding opportunities"
          aria-label="Search funding opportunities"
          className="border-border h-9 w-80 rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          autoComplete="off"
          spellCheck={false}
        />
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
      </div>

      {status.kind === "loading" ? (
        <div className="text-muted-foreground py-8 text-sm">Loading opportunities…</div>
      ) : status.kind === "error" ? (
        <div className="text-muted-foreground py-8 text-sm">{status.message}</div>
      ) : shown.length === 0 ? (
        <div className="text-muted-foreground py-8 text-sm">
          No opportunities match{q ? ` “${query.trim()}”` : ""}.
        </div>
      ) : (
        <>
          <p className="text-muted-foreground mb-2 text-xs">
            {shown.length} opportunit{shown.length === 1 ? "y" : "ies"}
          </p>
          <ul>
            {shown.map((o) => (
              <li key={o.opportunityId}>
                <OpportunityRow o={o} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function OpportunityRow({
  o,
  onSelect,
}: {
  o: OpportunityListItem;
  onSelect: (id: string) => void;
}) {
  const due = formatDue(o.dueDate);
  const meta = [o.mechanism, due ? `Due ${due}` : null, o.sponsor].filter(Boolean) as string[];
  return (
    <button
      type="button"
      onClick={() => onSelect(o.opportunityId)}
      className="block w-full border-t border-border py-3 text-left first:border-t-0 hover:bg-[var(--muted)]/40"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium leading-snug text-foreground">{o.title ?? o.opportunityId}</span>
          <PrestigeBadge prestige={o.prestige} />
        </span>
        <SourceBadge source={o.source} />
      </div>
      {meta.length > 0 ? (
        <div className="text-muted-foreground mt-0.5 text-sm">{meta.join(" · ")}</div>
      ) : null}
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
  const [limit, setLimit] = useState<number>(25);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setStatus({ kind: "loading" });
    const qs = new URLSearchParams({
      sort,
      stageLens: stageLens ? "1" : "0",
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
  }, [opportunityId, sort, stageLens, limit]);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
      >
        <span aria-hidden>←</span> Back to opportunities
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

  // Compact subtitle under the title; the rest of the metadata lives in the grid.
  const subtitle = [o?.sponsor, o?.mechanism, o?.status].filter(Boolean) as string[];

  // Fact grid — only the cells we actually have a value for.
  const facts: Array<{ label: string; value: string }> = [];
  if (open) facts.push({ label: "Opens", value: open });
  if (due) facts.push({ label: "Due", value: due });
  if (award) facts.push({ label: "Award", value: award });
  if (estimated) facts.push({ label: "Est. total funding", value: estimated });
  if (o?.numberOfAwards != null) facts.push({ label: "Awards", value: `~${o.numberOfAwards}` });
  if (cfda) facts.push({ label: "CFDA", value: cfda });

  return (
    <div className="border-border mb-6 rounded-lg border bg-[var(--muted)]/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="border-border-strong rounded-md border px-2 py-0.5 font-mono text-xs text-foreground">
          {opportunityId}
        </span>
        {src ? (
          o?.sourceUrl ? (
            <a
              href={o.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground inline-flex items-center gap-1 text-xs hover:text-[var(--color-accent-slate)] hover:underline"
            >
              Parsed from {src} <span aria-hidden>↗</span>
            </a>
          ) : (
            <span className="text-muted-foreground text-xs">Parsed from {src}</span>
          )
        ) : null}
      </div>

      {o?.title ? (
        <h2 className="mt-2 text-lg font-semibold leading-snug">{o.title}</h2>
      ) : null}

      {subtitle.length > 0 ? (
        <div className="text-muted-foreground mt-1 text-sm">{subtitle.join(" · ")}</div>
      ) : null}

      {o?.synopsis ? (
        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
          {o.synopsis}
        </p>
      ) : null}

      {facts.length > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">{f.label}</dt>
              <dd className="text-sm text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {o?.eligibilityRaw ? (
        <div className="mt-3">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">Eligibility</span>
          <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
            {o.eligibilityRaw}
          </p>
        </div>
      ) : null}

      {matchingOn.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">Matching on</span>
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
    return <div className="text-muted-foreground py-8 text-sm">Ranking researchers…</div>;
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
                <span aria-hidden>↓</span> Export ({selectedCount})
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
                <span
                  className={`text-muted-foreground inline-block w-3 text-[10px] transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
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
      {fit.tone === "strong" ? <span aria-hidden>✓</span> : null}
      {fit.label}
    </span>
  );
}
