"use client";

/**
 * GrantRecs Phase 4 — the "Find researchers" reverse-matcher admin tool.
 *
 * An admin enters an `opportunityId` and gets a ranked list of researchers from
 * `GET /api/opportunities/[opportunityId]/researchers` (the Phase 2 reverse
 * matcher, admin-gated to superuser OR development-role). The two engine axes —
 * `topicFit` and `stageAppeal` — stay DISTINCT columns alongside the
 * `defaultScore` blend; `stageLens` toggles the blend ("who could apply" vs.
 * "who would this suit") and `sort` re-orders server-side (no client-side axis
 * mutation). Each row expands to its per-topic `topicContributions`.
 *
 * Same-origin fetch: the page is server-gated (`/edit/find-researchers`) and the
 * route reads the viewer's SPS session cookie directly — no proxy, no token.
 *
 * The axis/score numbers have no fixed 0..1 range (they depend on the Variant-B
 * curve, the topic gate, and appeal-by-stage), so the bars are scaled RELATIVE
 * to the max in the current result set — a within-result visual aid, never an
 * absolute scale. Raw values are always shown.
 */
import { useEffect, useState, type FormEvent } from "react";

type RankedScholar = {
  cwid: string;
  slug: string;
  preferredName?: string;
  axes: { topicFit: number; stageAppeal: number };
  topicContributions: { topicId: string; contribution: number }[];
  defaultScore: number;
};

type Sort = "fit" | "stage";

const SORT_TABS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: "fit", label: "Fit" },
  { key: "stage", label: "Stage" },
];

const LIMITS: readonly number[] = [25, 50, 100];

// Mirror the route's server-side validation so a malformed id never round-trips.
const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; opportunityId: string; results: RankedScholar[] }
  | { kind: "error"; message: string };

export function FindResearchers({ unifiedNav = false }: { unifiedNav?: boolean }) {
  // The tool's name tracks the account-menu label so the dropdown and the page
  // agree (account-dropdown-nav handoff, Workstream B): "Funding matcher" when
  // the unified-nav flag is on, the legacy "Find researchers" when off. The
  // submit button stays "Find researchers" — that's the action, not the name.
  const toolName = unifiedNav ? "Funding matcher" : "Find researchers";
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // The opportunityId of the last valid submit. Drives the fetch effect; control
  // changes (sort / lens / limit) re-query only once a search has been run.
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
    // A new object identity even when the id is unchanged would NOT re-run the
    // effect (string compare), so re-submitting the same id intentionally does
    // nothing; changing a control re-queries. To force a refetch of the same id,
    // the controls are the lever.
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
          const data = (await r.json()) as { opportunityId: string; results?: RankedScholar[] };
          if (active) {
            setStatus({
              kind: "ok",
              opportunityId: data.opportunityId,
              results: data.results ?? [],
            });
          }
          return;
        }
        // 400 carries a flat { error }; 403 has an empty body (admin gate).
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

  const { opportunityId, results } = status;
  if (results.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-sm">
        No researchers ranked for{" "}
        <span className="font-mono text-foreground">{opportunityId}</span>. The opportunity
        may not exist, or it may have no qualifying topics or eligible scholars.
      </div>
    );
  }

  // Per-column maxima for the relative bars (within this result set only).
  const maxTopic = Math.max(...results.map((r) => r.axes.topicFit), 0);
  const maxStage = Math.max(...results.map((r) => r.axes.stageAppeal), 0);
  const maxScore = Math.max(...results.map((r) => r.defaultScore), 0);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-muted-foreground text-sm">
          {results.length} researcher{results.length === 1 ? "" : "s"} for{" "}
          <span className="font-mono text-foreground">{opportunityId}</span>
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
        {results.map((r) => (
          <li key={r.cwid}>
            <ResearcherRow
              r={r}
              maxTopic={maxTopic}
              maxStage={maxStage}
              maxScore={maxScore}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResearcherRow({
  r,
  maxTopic,
  maxStage,
  maxScore,
}: {
  r: RankedScholar;
  maxTopic: number;
  maxStage: number;
  maxScore: number;
}) {
  const [open, setOpen] = useState(false);
  const name = r.preferredName ?? r.slug ?? r.cwid;
  const contributions = [...r.topicContributions].sort((a, b) => b.contribution - a.contribution);

  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={`/edit/scholar/${encodeURIComponent(r.cwid)}`}
          className="text-base font-medium leading-snug text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          {name}
        </a>
        <span className="text-muted-foreground whitespace-nowrap font-mono text-xs">
          {r.cwid}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
        <ScoreMeter label="topic fit" value={r.axes.topicFit} max={maxTopic} />
        <ScoreMeter label="stage appeal" value={r.axes.stageAppeal} max={maxStage} />
        <ScoreMeter label="default score" value={r.defaultScore} max={maxScore} strong />
      </div>

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
            <div className="mt-2 ml-4 border-l border-border pl-4">
              <ul className="space-y-1">
                {contributions.map((c) => (
                  <li
                    key={c.topicId}
                    className="text-muted-foreground flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="font-mono text-foreground">{c.topicId}</span>
                    <span className="font-mono text-xs">{c.contribution.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A labelled score with a within-result relative bar. `max` of 0 hides the bar. */
function ScoreMeter({
  label,
  value,
  max,
  strong = false,
}: {
  label: string;
  value: number;
  max: number;
  strong?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${value.toFixed(2)}`}>
      <span className="text-muted-foreground w-24 text-[11px] uppercase tracking-wide">
        {label}
      </span>
      <span className="bg-muted inline-block h-1.5 w-16 overflow-hidden rounded-full">
        <span
          className="block h-1.5 rounded-full bg-[var(--color-accent-slate)]"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={`font-mono text-xs ${strong ? "text-foreground font-semibold" : "text-muted-foreground"}`}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
}
