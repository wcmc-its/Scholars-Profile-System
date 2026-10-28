"use client";

/**
 * The `/edit/fundable-work` browse UI (mockup `Fundable work/Fundable Work.dc.html`,
 * 2026-10-28): a sticky facet rail, free-text search, sort, removable chips, and
 * one card per work with its score, people, rationale, funding pitch, suggested
 * funders and full abstract.
 *
 * Everything filters in memory: the page ships the whole result set (see
 * `ROW_LIMIT` in the page) and this module counts the facets over it, so a tick
 * is instant and the counts stay honest against the other filters.
 * ponytail: in-memory for a few hundred rows. Past ~1k, move the filtering and
 * the counts into SQL and paginate — the payload, not the JS, is the ceiling.
 *
 * A client module on purpose: Radix HoverCard inside a server component drops
 * the subtree at SSR (see `components/edit/scholar-hover-card.tsx`).
 */
import { useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { FundableWorkFunder } from "@/lib/fundable-work";
import { cn, initials } from "@/lib/utils";

export type FundableWorkAuthorRow = {
  cwid: string;
  name: string;
  slug: string;
  department: string | null;
  /** OpenAlex author position: "first" | "middle" | "last". */
  position: string;
  isPostdoc: boolean;
};

export type FundableWorkRow = {
  id: string;
  type: string;
  title: string;
  url: string;
  venue: string | null;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  score: number;
  stage: string;
  modality: string | null;
  rationale: string;
  pitch: string;
  abstract: string;
  funders: FundableWorkFunder[];
  authors: FundableWorkAuthorRow[];
};

const TYPE_LABEL: Record<string, string> = { "conference-abstract": "Abstract", preprint: "Preprint" };
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t;

const SCORE_OPTS = [1, 2, 3, 4, 5];
const WINDOW_OPTS: Array<[number, string]> = [
  [1, "1 mo"],
  [3, "3 mo"],
  [6, "6 mo"],
  [12, "1 yr"],
  [24, "2 yr"],
];
const DEFAULTS = { minScore: 3, months: 24 };
const PEOPLE_SHOWN = 3;
const MS_PER_MONTH = 30.44 * 86_400_000;

/** The funder-kind pill colours: the facet blue/purple and the eligibility teal. */
const FUNDER_KIND_CLASS: Record<string, string> = {
  pharma:
    "border-[var(--color-facet-topic-border)] bg-[var(--color-facet-topic-fill)] text-[var(--color-facet-topic-text)]",
  biotech:
    "border-[var(--color-facet-method-border)] bg-[var(--color-facet-method-fill)] text-[var(--color-facet-method-text)]",
  foundation: "border-elig-border bg-elig-fill text-elig-text",
};

type FacetKey = "type" | "stage" | "funderKind" | "funder" | "person" | "department" | "personType" | "venue";

type Facet = {
  key: FacetKey;
  title: string;
  /** Every value this row carries in the facet; counted once each. */
  vals: (r: FundableWorkRow) => string[];
  /** Collapse past this many options behind "Show all N". */
  limit?: number;
};

const FACETS: Facet[] = [
  { key: "type", title: "Type", vals: (r) => [typeLabel(r.type)] },
  { key: "stage", title: "Stage", vals: (r) => [r.stage] },
  { key: "funderKind", title: "Funder type", vals: (r) => uniq(r.funders.map((f) => f.kind)) },
  { key: "funder", title: "Suggested funder", vals: (r) => uniq(r.funders.map((f) => f.name)), limit: 5 },
  { key: "person", title: "People", vals: (r) => uniq(r.authors.map((a) => a.name)), limit: 5 },
  {
    key: "department",
    title: "Department",
    vals: (r) => uniq(r.authors.map((a) => a.department).filter((d): d is string => !!d)),
    limit: 5,
  },
  { key: "personType", title: "Person type", vals: (r) => uniq(r.authors.map((a) => (a.isPostdoc ? "Postdoc" : "Faculty"))) },
  { key: "venue", title: "Venue", vals: (r) => (r.venue ? [r.venue] : []), limit: 5 },
];

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

type Selection = Record<FacetKey, string[]>;
const emptySelection = (): Selection =>
  Object.fromEntries(FACETS.map((f) => [f.key, [] as string[]])) as Selection;

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The haystack a search term has to appear in — title, people, funders and the AI text. */
function haystack(r: FundableWorkRow): string {
  return [
    r.title,
    r.modality ?? "",
    r.rationale,
    r.venue ?? "",
    ...r.authors.map((a) => a.name),
    ...r.funders.map((f) => f.name),
  ]
    .join(" ")
    .toLowerCase();
}

export function FundableWorkBrowser({ rows, truncated }: { rows: FundableWorkRow[]; truncated: boolean }) {
  const [q, setQ] = useState("");
  const [minScore, setMinScore] = useState(DEFAULTS.minScore);
  const [months, setMonths] = useState(DEFAULTS.months);
  const [sort, setSort] = useState<"score" | "newest">("score");
  const [sel, setSel] = useState<Selection>(emptySelection);
  const [expanded, setExpanded] = useState<Partial<Record<FacetKey, boolean>>>({});
  const [openPitch, setOpenPitch] = useState<Record<string, boolean>>({});
  const [openAbstract, setOpenAbstract] = useState<Record<string, boolean>>({});
  const [allPeople, setAllPeople] = useState<Record<string, boolean>>({});

  const toggle = (key: FacetKey, v: string) =>
    setSel((s) => ({ ...s, [key]: s[key].includes(v) ? s[key].filter((x) => x !== v) : [...s[key], v] }));
  const clearAll = () => {
    setQ("");
    setMinScore(1);
    setMonths(DEFAULTS.months);
    setSel(emptySelection());
  };

  const { results, facetGroups } = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const cutoff = Date.now() - months * MS_PER_MONTH;
    // `except` leaves one facet out, so its own options count as if unticked —
    // otherwise every unselected option in a used group would read 0.
    const matches = (r: FundableWorkRow, except?: FacetKey) => {
      if (r.score < minScore) return false;
      if (new Date(r.date).getTime() < cutoff) return false;
      if (terms.length) {
        const hay = haystack(r);
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return FACETS.every(
        (f) => f.key === except || sel[f.key].length === 0 || f.vals(r).some((v) => sel[f.key].includes(v)),
      );
    };

    const facetGroups = FACETS.map((f) => {
      const counts = new Map<string, number>();
      for (const r of rows) for (const v of f.vals(r)) counts.set(v, counts.get(v) ?? 0);
      for (const r of rows) if (matches(r, f.key)) for (const v of f.vals(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
      let options = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
      const total = options.length;
      if (f.limit && !expanded[f.key]) {
        const top = options.slice(0, f.limit);
        for (const v of sel[f.key]) if (!top.includes(v)) top.push(v);
        options = top;
      }
      return {
        key: f.key,
        title: f.title,
        total,
        options: options.map((v) => ({ value: v, count: counts.get(v) ?? 0 })),
        collapsible: !!f.limit && total > f.limit,
      };
    }).filter((g) => g.total > 0);

    const results = rows
      .filter((r) => matches(r))
      .sort((a, b) =>
        sort === "newest" ? b.date.localeCompare(a.date) : b.score - a.score || b.date.localeCompare(a.date),
      );
    return { results, facetGroups };
  }, [rows, q, minScore, months, sort, sel, expanded]);

  const chips: Array<{ label: string; remove: () => void }> = [];
  if (q.trim()) chips.push({ label: `“${q.trim()}”`, remove: () => setQ("") });
  for (const f of FACETS)
    for (const v of sel[f.key]) chips.push({ label: sentenceCase(v), remove: () => toggle(f.key, v) });

  // One element tree, rendered in both the desktop rail and the phone sheet.
  const rail = (
    <>
      <RailGroup title="Minimum score">
        <div className="grid grid-cols-5 gap-1">
          {SCORE_OPTS.map((n) => (
            <Button
              key={n}
              variant={minScore === n ? "default" : "outline"}
              size="sm"
              className="min-w-0 px-0"
              aria-pressed={minScore === n}
              onClick={() => setMinScore(n)}
            >
              {n === 5 ? "5" : `${n}+`}
            </Button>
          ))}
        </div>
      </RailGroup>

      <RailGroup title="Published">
        <div className="grid grid-cols-5 gap-1">
          {WINDOW_OPTS.map(([m, label]) => (
            <Button
              key={m}
              variant={months === m ? "default" : "outline"}
              size="sm"
              className="min-w-0 px-0 text-xs"
              aria-pressed={months === m}
              onClick={() => setMonths(m)}
            >
              {label}
            </Button>
          ))}
        </div>
      </RailGroup>

      {facetGroups.map((g) => (
        <RailGroup key={g.key} title={g.title}>
          {g.options.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex cursor-pointer items-center gap-2 text-[13px]",
                o.count === 0 && !sel[g.key].includes(o.value) && "opacity-45",
              )}
            >
              <Checkbox
                checked={sel[g.key].includes(o.value)}
                onCheckedChange={() => toggle(g.key, o.value)}
                aria-label={`${g.title}: ${o.value}`}
              />
              <span className="min-w-0 flex-1 leading-tight">{sentenceCase(o.value)}</span>
              <span className="text-muted-foreground text-xs tabular-nums">{o.count}</span>
            </label>
          ))}
          {g.collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))}
              className="text-apollo-slate self-start text-[13px] hover:underline"
            >
              {expanded[g.key] ? "Show fewer" : `Show all ${g.total}`}
            </button>
          )}
        </RailGroup>
      ))}
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold">Emerging research to fund</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Conference abstracts and preprints by full-time faculty from the last two years, with postdoc co-authors
            listed, scored 1–5 for industry and foundation funding potential. Scores, pitches and funder suggestions
            are an AI first pass; check them before outreach.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCsv(results)} disabled={results.length === 0}>
          Export CSV
        </Button>
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <aside className="bg-apollo-surface border-apollo-border sticky top-4 hidden w-[264px] shrink-0 flex-col rounded-[var(--apollo-radius-card)] border lg:flex">
          <div className="border-apollo-border flex items-center justify-between border-b px-4 py-3.5">
            <div className="text-sm font-semibold">Filters</div>
            <button type="button" onClick={clearAll} className="text-apollo-slate text-[13px] hover:underline">
              Clear all
            </button>
          </div>
          {rail}
        </aside>

        <section className="flex min-w-0 flex-1 basis-[480px] flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <FiltersSheet activeCount={chips.length} testId="fundable-work-filters-sheet">
              <div className="bg-apollo-surface border-apollo-border flex flex-col rounded-[var(--apollo-radius-card)] border">
                <div className="border-apollo-border flex justify-end border-b px-4 py-2">
                  <button type="button" onClick={clearAll} className="text-apollo-slate text-[13px] hover:underline">
                    Clear all
                  </button>
                </div>
                {rail}
              </div>
            </FiltersSheet>
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search titles, authors, targets, funders…"
              aria-label="Search fundable work"
              className="bg-apollo-surface h-9 flex-1 basis-[280px]"
            />
            <div className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
              <span>Sort</span>
              {(["score", "newest"] as const).map((k) => (
                <Button
                  key={k}
                  variant={sort === k ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={sort === k}
                  onClick={() => setSort(k)}
                >
                  {k === "score" ? "Score" : "Newest"}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex min-h-7 flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground mr-1.5 text-[13px]">
              <strong className="text-foreground">{results.length.toLocaleString()}</strong> result
              {results.length === 1 ? "" : "s"}
              {truncated && results.length === rows.length ? " (top scores)" : ""}
            </span>
            {chips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={c.remove}
                className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
              >
                {c.label}
                <X size={12} aria-hidden />
                <span className="sr-only">Remove filter</span>
              </button>
            ))}
          </div>

          {results.length === 0 ? (
            <div className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded-[var(--apollo-radius-card)] border border-dashed p-10 text-center text-sm">
              No work matches these filters.{" "}
              <button type="button" onClick={clearAll} className="text-apollo-slate underline">
                Clear filters
              </button>
            </div>
          ) : (
            results.map((r) => (
              <WorkCard
                key={r.id}
                r={r}
                pitchOpen={!!openPitch[r.id]}
                abstractOpen={!!openAbstract[r.id]}
                showAllPeople={!!allPeople[r.id]}
                onTogglePitch={() => setOpenPitch((s) => ({ ...s, [r.id]: !s[r.id] }))}
                onToggleAbstract={() => setOpenAbstract((s) => ({ ...s, [r.id]: !s[r.id] }))}
                onTogglePeople={() => setAllPeople((s) => ({ ...s, [r.id]: !s[r.id] }))}
                onPickPerson={(name) => setSel((s) => ({ ...s, person: [name] }))}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function RailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-apollo-border flex flex-col gap-2 border-b px-4 py-3.5 last:border-b-0">
      <div className="text-muted-foreground text-xs font-semibold tracking-[0.04em] uppercase">{title}</div>
      {children}
    </div>
  );
}

const SCORE_CLASS = (score: number) =>
  score === 5
    ? "bg-apollo-slate text-white"
    : score === 4
      ? "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate border"
      : "bg-apollo-surface border-apollo-border-strong text-muted-foreground border";

const RAIL_LABEL = "text-muted-foreground text-xs font-semibold tracking-[0.04em] uppercase";

function WorkCard({
  r,
  pitchOpen,
  abstractOpen,
  showAllPeople,
  onTogglePitch,
  onToggleAbstract,
  onTogglePeople,
  onPickPerson,
}: {
  r: FundableWorkRow;
  pitchOpen: boolean;
  abstractOpen: boolean;
  showAllPeople: boolean;
  onTogglePitch: () => void;
  onToggleAbstract: () => void;
  onTogglePeople: () => void;
  onPickPerson: (name: string) => void;
}) {
  const people = showAllPeople ? r.authors : r.authors.slice(0, PEOPLE_SHOWN);
  return (
    <article className="bg-apollo-surface border-apollo-border grid grid-cols-[44px_minmax(0,1fr)] gap-4 rounded-[var(--apollo-radius-card)] border px-5 py-4.5">
      <div className="flex flex-col items-center gap-0.5">
        <div
          className={cn(
            "flex size-10 items-center justify-center rounded-full text-lg font-semibold tabular-nums",
            SCORE_CLASS(r.score),
          )}
          aria-label={`Score ${r.score} of 5`}
        >
          {r.score}
        </div>
        <div className="text-muted-foreground text-[10px] tracking-[0.04em] uppercase">score</div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{typeLabel(r.type)}</Badge>
          <Badge variant="outline">{r.stage}</Badge>
          <span className="text-muted-foreground text-[13px]">
            {r.venue ?? "Unknown venue"} · {r.date}
          </span>
        </div>

        <h2 className="text-[17px] leading-snug font-semibold">
          <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-apollo-slate hover:underline">
            {r.title}
            <ExternalLink size={14} className="text-muted-foreground ml-1.5 inline-block align-[-1px]" aria-hidden />
          </a>
        </h2>

        {r.modality && (
          <div className="text-[13px]">
            <span className="text-muted-foreground font-semibold">Asset type: </span>
            {r.modality}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {people.map((a) => (
            <ScholarHoverCard key={a.cwid} cwid={a.cwid} side="bottom">
              <button
                type="button"
                onClick={() => onPickPerson(a.name)}
                title={`Filter to ${a.name}`}
                className="border-apollo-border-strong bg-apollo-surface hover:bg-apollo-surface-2 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[13px]"
              >
                <span className="bg-apollo-surface-2 text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium">
                  {initials(a.name)}
                </span>
                <span className="truncate">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-muted-foreground">
                    {a.isPostdoc ? " · postdoc" : ""}
                    {a.department ? ` · ${a.department}` : ""}
                  </span>
                </span>
              </button>
            </ScholarHoverCard>
          ))}
          {r.authors.length > PEOPLE_SHOWN && (
            <button type="button" onClick={onTogglePeople} className="text-apollo-slate text-[13px] hover:underline">
              {showAllPeople ? "Show fewer" : `+${r.authors.length - PEOPLE_SHOWN} more`}
            </button>
          )}
        </div>

        <div className="mt-1 flex flex-col gap-1">
          <div className={RAIL_LABEL}>Why it scored {r.score}</div>
          <p className="text-sm leading-relaxed">{r.rationale}</p>
        </div>

        <div className="mt-0.5 flex flex-wrap gap-2">
          <Button variant={pitchOpen ? "secondary" : "outline"} size="sm" onClick={onTogglePitch}>
            {pitchOpen ? "Hide pitch & funders" : `Pitch & ${r.funders.length || "no"} funders`}
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggleAbstract}>
            {abstractOpen ? "Hide abstract" : "Full abstract"}
          </Button>
        </div>

        {pitchOpen && (
          <div className="border-apollo-border mt-1 flex flex-col gap-3 border-t pt-3.5">
            <div className={RAIL_LABEL}>Funding pitch</div>
            <p className="text-sm leading-relaxed">{r.pitch}</p>
            <div className={cn(RAIL_LABEL, "mt-1")}>Possible funders</div>
            {r.funders.length === 0 ? (
              <div className="text-muted-foreground text-[13px]">No funder suggestions yet.</div>
            ) : (
              <div className="border-apollo-border overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-apollo-surface-2 text-left">
                      <th className="w-[28%] px-3 py-2 font-semibold">Funder</th>
                      <th className="w-24 px-3 py-2 font-semibold">Type</th>
                      <th className="px-3 py-2 font-semibold">Why they fit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.funders.map((f) => (
                      <tr key={f.name} className="border-apollo-border border-t align-top">
                        <td className="px-3 py-2.5 font-medium">{f.name}</td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              "inline-block rounded-full border px-2 py-0.5 text-xs font-medium",
                              FUNDER_KIND_CLASS[f.kind] ?? "border-apollo-border-strong text-muted-foreground",
                            )}
                          >
                            {sentenceCase(f.kind)}
                          </span>
                        </td>
                        <td className="text-muted-foreground px-3 py-2.5 leading-relaxed">{f.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {abstractOpen && (
          <div className="bg-apollo-page border-apollo-border text-muted-foreground mt-1 max-h-70 overflow-auto rounded-lg border px-4 py-3.5 text-[13px] leading-relaxed whitespace-pre-line">
            {r.abstract || "No abstract text."}
          </div>
        )}
      </div>
    </article>
  );
}

const CSV_HEADERS = [
  "score",
  "type",
  "stage",
  "modality",
  "title",
  "venue",
  "date",
  "url",
  "authors",
  "rationale",
  "pitch",
  "funders",
];

/** One row per work, the people as names only — never emails or cwids. */
export function toCsv(rows: FundableWorkRow[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        String(r.score),
        typeLabel(r.type),
        r.stage,
        r.modality ?? "",
        r.title,
        r.venue ?? "",
        r.date,
        r.url,
        r.authors.map((a) => `${a.name}${a.department ? ` (${a.department})` : ""}`).join("; "),
        r.rationale,
        r.pitch,
        r.funders.map((f) => `${f.name} [${f.kind}]`).join("; "),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function downloadCsv(rows: FundableWorkRow[]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `fundable-work-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
