"use client";

/**
 * GrantRecs Phase 4 — the "Funding matcher" reverse-matcher admin tool (redesign).
 *
 * An admin enters an `opportunityId` and gets a parsed opportunity card plus a
 * ranked list of researchers from `GET /api/opportunities/[opportunityId]/researchers`
 * (admin-gated to superuser OR development-role). That route now returns the full
 * view-model: the opportunity card fields, the "matching on" topic chips, a
 * slug→label map, and the ranked `results` (each carrying career stage, title /
 * department, and per-topic publication evidence).
 *
 * Display calibration (topic fit 0–100, stage-fit badge, the fact-only row blurb)
 * lives in `lib/match-display.ts`. The two engine axes — `topicFit` and
 * `stageAppeal` — stay distinct; `stageLens` toggles the blend and `sort` re-orders
 * server-side. Recommendations, not endorsements.
 *
 * The opportunity picker, dept/career/funding filters, and CSV export land in
 * follow-on slices; this one keeps the ID input.
 */
import { useEffect, useState, type FormEvent } from "react";

import type { CareerStage } from "@/lib/career-stage";
import { researcherBlurb, stageFit, topicFitScores } from "@/lib/match-display";
import { initials } from "@/lib/utils";

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
};

type OpportunityMeta = {
  title: string | null;
  mechanism: string | null;
  dueDate: string | null;
  sponsor: string | null;
  source: string | null;
  sourceUrl: string | null;
  status: string | null;
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

// Mirror the route's server-side validation so a malformed id never round-trips.
const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

const SOURCE_LABELS: Record<string, string> = {
  grants_gov: "Grants.gov",
  nih_guide: "NIH Guide",
  wcm_curated: "WCM curated list",
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

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; view: MatchView }
  | { kind: "error"; message: string };

export function FindResearchers({ unifiedNav = false }: { unifiedNav?: boolean }) {
  const toolName = unifiedNav ? "Funding matcher" : "Find researchers";
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("fit");
  const [stageLens, setStageLens] = useState(false);
  const [limit, setLimit] = useState<number>(25);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = input.trim();
    if (!OPPORTUNITY_ID_RE.test(id)) {
      setInputError(
        "Enter a valid opportunity ID (letters, digits, and _ : . - ; up to 128 characters).",
      );
      return;
    }
    setInputError(null);
    setSubmittedId(id);
  }

  useEffect(() => {
    if (submittedId === null) return;
    let active = true;
    setStatus({ kind: "loading" });
    const qs = new URLSearchParams({
      sort,
      stageLens: stageLens ? "1" : "0",
      limit: String(limit),
    });
    fetch(`/api/opportunities/${encodeURIComponent(submittedId)}/researchers?${qs}`, {
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
  }, [submittedId, sort, stageLens, limit]);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">{toolName}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter a funding opportunity ID to rank Weill Cornell researchers by topic fit
          and career-stage appeal — the reverse of a scholar&rsquo;s &ldquo;Grants for
          me.&rdquo; Recommendations, not endorsements.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="opportunityId" className="text-xs font-medium text-muted-foreground">
            Opportunity ID
          </label>
          <input
            id="opportunityId"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. PA-25-303"
            className="border-border h-9 w-72 rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
            aria-invalid={inputError !== null}
            aria-describedby={inputError ? "opportunityId-error" : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm">
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

        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent-slate)] px-4 text-sm font-medium text-white hover:opacity-90"
        >
          Find researchers
        </button>
      </form>

      {inputError ? (
        <div id="opportunityId-error" className="mb-4 text-sm text-[var(--apollo-maroon)]">
          {inputError}
        </div>
      ) : null}

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
  const due = formatDue(opportunity?.dueDate ?? null);
  const src = sourceLabel(opportunity?.source ?? null);
  const meta = [opportunity?.mechanism, due ? `Due ${due}` : null, opportunity?.sponsor].filter(
    Boolean,
  ) as string[];

  return (
    <div className="border-border mb-6 rounded-lg border bg-[var(--muted)]/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="border-border-strong rounded-md border px-2 py-0.5 font-mono text-xs text-foreground">
          {opportunityId}
        </span>
        {src ? (
          opportunity?.sourceUrl ? (
            <a
              href={opportunity.sourceUrl}
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

      {opportunity?.title ? (
        <h2 className="mt-2 text-lg font-semibold leading-snug">{opportunity.title}</h2>
      ) : null}

      {meta.length > 0 ? (
        <div className="text-muted-foreground mt-1 text-sm">{meta.join(" · ")}</div>
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
  if (status.kind === "idle") {
    return (
      <div className="text-muted-foreground py-8 text-sm">
        Enter an opportunity ID above to see ranked researchers.
      </div>
    );
  }
  if (status.kind === "loading") {
    return <div className="text-muted-foreground py-8 text-sm">Ranking researchers…</div>;
  }
  if (status.kind === "error") {
    return <div className="text-muted-foreground py-8 text-sm">{status.message}</div>;
  }

  const { opportunityId, opportunity, matchingOn, topicLabels, results } = status.view;
  // 0–100 topic-fit scores are relative to the strongest match across the set.
  const topicFits = topicFitScores(results.map((r) => r.axes.topicFit));

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
          <span className="font-mono text-foreground">{opportunityId}</span>. The opportunity
          may not exist, or it may have no qualifying topics or eligible scholars.
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Researchers for this opportunity</h3>
              <p className="text-muted-foreground text-sm">
                {results.length} matched · recommendations, not endorsements
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Sort</span>
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

          <ul>
            {results.map((r, i) => (
              <li key={r.cwid}>
                <ResearcherRow
                  r={r}
                  rank={i + 1}
                  topicFit={topicFits[i] ?? 0}
                  topicLabels={topicLabels}
                />
              </li>
            ))}
          </ul>
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
}: {
  r: RankedScholar;
  rank: number;
  topicFit: number;
  topicLabels: Record<string, string>;
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
  });
  const stage = stageFit(r.axes.stageAppeal, r.careerStage !== null);

  return (
    <div className="border-t border-border py-4 first:border-t-0">
      <div className="flex gap-3">
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
