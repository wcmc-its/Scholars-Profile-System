"use client";

/**
 * Opportunity browse — the shared opportunity-UI module. `BrowseList` and its
 * private closure were extracted verbatim from the retired
 * `components/edit/find-researchers.tsx` (matcha-admin Phase 3a, a pure
 * mechanical move; no behavior change); Phase 3b moved `ClampedText` and the
 * mockup-4 `OpportunityFactRail` in beside them so the grant-matcha selected
 * view renders opportunity facts from one place. Redesign 2026-08
 * (`Browse Redesign.dc.html`) moved the list from a table to a card per
 * opportunity — Track B is expected to give rows a variable amount of tag
 * data (concepts/methods/eligibility), which a fixed-column table can't hold
 * honestly; cards were the right shape for that even before Track B lands.
 * Client-side paginated (the whole set is already fetched — see `PAGE_SIZE`).
 * The whole card is still the click target via a stretched anchor on the
 * title (a REAL link, so cmd-click / middle-click / copy-link-address all
 * work), never a click handler on the `<li>`.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  X,
} from "lucide-react";

import { PrestigeBadge } from "@/components/edit/prestige-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { Prestige } from "@/lib/funding/prestige";
import { dueUrgency, formatDue } from "@/lib/match-display";

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
  /** Screening spec §3.1, derived server-side. Absent counts as eligible (fail open). */
  facultyPiEligible?: boolean;
  /** Matcha-admin Phase 1b manual suppression — set means hidden from every non-admin surface. */
  suppressedAt?: string | null;
  suppressedBy?: string | null;
  suppressReason?: string | null;
};

const SOURCE_LABELS: Record<string, string> = {
  grants_gov: "Grants.gov",
  nih_guide: "NIH Guide",
  wcm_curated: "WCM curated",
  manual_url: "Submitted URL",
};

export function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

/** One per-source freshness aggregate from `/api/opportunities` (`sources`). */
export type SourceFreshness = {
  source: string | null;
  count: number;
  newestIngestedAt: string | null;
};

export type FreshnessTone = "fresh" | "aging" | "stale";

/** Age buckets for the freshness strip: green under 14 days, amber through 30, red beyond. */
export function freshnessTone(ageDays: number): FreshnessTone {
  if (ageDays < 14) return "fresh";
  if (ageDays <= 30) return "aging";
  return "stale";
}

const MS_PER_DAY = 86_400_000;

function ingestAgeDays(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / MS_PER_DAY));
}

/** "Jul 6" — the strip is about recency, so the year would be noise. */
function ingestDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const FRESHNESS_DOT: Record<FreshnessTone, string> = {
  fresh: "text-green-600 dark:text-green-400",
  aging: "text-apollo-amber",
  stale: "text-red-600 dark:text-red-400",
};

/**
 * Corpus-freshness strip (matcha-admin Phase 1b) — the Browse-tab header on
 * `/edit/grant-matcha`. Headline: the newest ingest across the WHOLE corpus
 * (the pipeline's pulse, warning-toned when stale); per-source rows: count +
 * newest ingest + an age dot. Reads `ingestedAt` ONLY — `lastRefreshedAt` is
 * re-stamped by the nightly upsert and would always read fresh (the Phase 0a
 * lesson, and the reason the corpus froze unnoticed for six weeks).
 */
export function CorpusFreshness({ sources, now }: { sources: SourceFreshness[]; now: number }) {
  const dated = sources.filter(
    (s): s is SourceFreshness & { newestIngestedAt: string } => s.newestIngestedAt !== null,
  );
  if (dated.length === 0) return null;

  // Curated leads (the corpus's reason to exist), then by size.
  const rows = [...dated].sort((a, b) => {
    const ra = a.source === "wcm_curated" ? 0 : 1;
    const rb = b.source === "wcm_curated" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return b.count - a.count;
  });

  const newest = rows.reduce((max, s) =>
    new Date(s.newestIngestedAt).getTime() > new Date(max.newestIngestedAt).getTime() ? s : max,
  );
  const headAge = ingestAgeDays(newest.newestIngestedAt, now);
  const headTone = freshnessTone(headAge);

  return (
    <section
      data-testid="corpus-freshness"
      aria-label="Corpus freshness"
      className="border-apollo-border bg-apollo-surface mb-4 rounded-lg border px-4 py-3 text-sm"
    >
      <p
        data-testid="corpus-freshness-headline"
        data-tone={headTone}
        className={
          headTone === "fresh"
            ? "text-muted-foreground"
            : headTone === "aging"
              ? "font-medium text-apollo-amber"
              : "font-medium text-red-700 dark:text-red-400"
        }
      >
        {headTone !== "fresh" ? (
          <AlertTriangle className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        ) : null}
        Corpus freshness — newest row {ingestDate(newest.newestIngestedAt)}, {headAge} day
        {headAge === 1 ? "" : "s"} ago
      </p>
      <ul className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
        {rows.map((s) => {
          const age = ingestAgeDays(s.newestIngestedAt, now);
          const tone = freshnessTone(age);
          return (
            <li key={s.source ?? "unknown"} data-testid={`freshness-${s.source ?? "unknown"}`}>
              <span className="text-foreground">{sourceLabel(s.source) ?? "Unknown"}</span>{" "}
              {s.count} · {ingestDate(s.newestIngestedAt)} ({age}d){" "}
              <span aria-hidden data-tone={tone} className={FRESHNESS_DOT[tone]}>
                ●
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function formatMoney(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** "$100,000–$500,000" / "Up to $500,000" / "From $100,000" from the floor/ceiling pair. */
export function awardRange(floor: number | null, ceiling: number | null): string | null {
  const lo = formatMoney(floor);
  const hi = formatMoney(ceiling);
  if (lo && hi) return lo === hi ? hi : `${lo}–${hi}`;
  if (hi) return `Up to ${hi}`;
  if (lo) return `From ${lo}`;
  return null;
}

/** Separators a sponsor prefix may be joined to a title with. */
const TITLE_SEPARATOR = /^(\s*)([-–—:|])(\s*)/;

/**
 * The remainder of `rest` after a leading separator, or null when `rest` does
 * not start with one. A separator must carry whitespace on at least one side so
 * a hyphenated word ("NIH-funded…") is never split.
 */
function afterSeparator(rest: string): string | null {
  const m = TITLE_SEPARATOR.exec(rest);
  if (!m) return null;
  if (m[1].length === 0 && m[3].length === 0) return null;
  const out = rest.slice(m[0].length).trim();
  return out.length >= 2 ? out : null;
}

/**
 * Strip a redundant sponsor prefix off an opportunity title.
 *
 * The corpus carries titles that restate the sponsor the row already shows in
 * its own column — e.g. sponsor "National Institutes of Health (NIH)" against
 * title "National Institutes of Health (NIH) - NIH Outstanding New
 * Environmental Scientist (ONES) Award (R01)". With sponsor promoted to a
 * column, that prefix is pure noise.
 *
 * DELIBERATELY CONSERVATIVE — a mangled title is far worse than a duplicated
 * one, so this strips only on an unambiguous match: the title must START with
 * the sponsor (or the sponsor minus its trailing parenthetical, or that
 * parenthetical's contents — "NIH"), AND that prefix must be followed by a real
 * separator, AND a usable remainder must survive. Anything else is returned
 * untouched. "Skin Cancer Foundation Research Grants" keeps its sponsor prefix
 * because there is no separator: the sponsor name is part of the award's name.
 */
export function stripSponsorPrefix(
  title: string | null,
  sponsor: string | null | undefined,
): string | null {
  if (!title || !sponsor) return title;
  const t = title.trim();
  const s = sponsor.trim();
  if (!s) return title;

  // Longest candidate first, so the full sponsor wins over its abbreviation.
  const candidates = [s];
  const paren = /^(.*?)\s*\(([^()]+)\)$/.exec(s);
  if (paren) candidates.push(paren[1].trim(), paren[2].trim());

  for (const c of candidates) {
    if (c.length < 2 || t.length <= c.length) continue;
    if (t.slice(0, c.length).toLowerCase() !== c.toLowerCase()) continue;
    const rest = afterSeparator(t.slice(c.length));
    if (rest) return rest;
  }
  return title;
}

/**
 * Text for the Deadline column.
 *
 * `Opportunity.dueDate` is nullable and the model has NO rolling flag, so a
 * null date on its own does not license the claim "Rolling" — `status` is the
 * only evidence for that, and its vocabulary is open / forecasted / continuous.
 * So: "continuous" is rolling; a dateless forecast is a date not yet announced,
 * NOT a rolling one (the #1608 distinction `grant-recs-card` already draws);
 * anything else dateless gets an em dash, because we genuinely do not know
 * whether it rolls or was simply never captured.
 */
export function deadlineLabel(dueDate: string | null, status: string | null, now: number): string {
  const formatted = formatDue(dueDate);
  if (formatted) return dueUrgency(dueDate, now) === "past" ? `${formatted} (passed)` : formatted;
  const s = (status ?? "").toLowerCase();
  if (s === "continuous") return "Rolling";
  if (s === "forecasted") return "Date TBD";
  return "—";
}

/**
 * Deadline cell: the date toned by urgency (amber inside the 30-day window, a
 * "(passed)" suffix once behind us) so staff can triage actionable vs dead
 * opportunities by scanning one column. The em-dash case carries a spoken
 * equivalent — a bare "—" reaches a screen reader as nothing at all.
 */
function DeadlineCell({ iso, status }: { iso: string | null; status: string | null }) {
  const label = deadlineLabel(iso, status, Date.now());
  if (label === "—") {
    // ponytail: `Browse Redesign.dc.html` draws "Not extracted" here. REJECTED as an
    // unbacked provenance claim, do not re-add it from the artboard:
    //  - `deadlineLabel` above lands on "—" precisely because we do NOT know whether
    //    the award rolls or was simply never captured; "Not extracted" resolves that
    //    documented ambiguity in one direction on no evidence;
    //  - it also lands here for an UNPARSEABLE dueDate (pinned:
    //    `deadlineLabel("not-a-date", "open", now) === "—"`), so a row that HAS a date
    //    would claim nothing was extracted;
    //  - `lib/match-display.ts`'s own `deadlineLabel` — the one matcha-panel and
    //    grant-recs-card render — calls this same null case "Rolling · continuous",
    //    so shipping it would put two surfaces of one product in direct contradiction.
    return (
      <span className="text-muted-foreground">
        <span aria-hidden>—</span>
        <span className="sr-only">No deadline recorded</span>
      </span>
    );
  }
  const urgency = dueUrgency(iso, Date.now());
  return (
    <span
      className={
        urgency === "soon"
          ? "font-medium text-apollo-amber"
          : urgency === "past"
            ? "text-muted-foreground"
            : undefined
      }
    >
      {label}
    </span>
  );
}

/** Shimmer cards while a list loads; the label stays visible so staff know what's happening. */
export function ListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
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

type BrowseStatus =
  | { kind: "loading" }
  | { kind: "ok"; opportunities: OpportunityListItem[]; sources: SourceFreshness[] }
  | { kind: "error"; message: string };

type BrowseSort = "curated" | "deadline";

/** Client-side browse filters (search box + Duke-style sidebar). */
export type BrowseFilters = {
  q: string;
  /** Hide opportunities whose due day is fully behind us (undated stay visible). */
  openOnly: boolean;
  /** Screening spec §3.1 — hide awards no WCM faculty PI can hold. ON by default, relaxable. */
  facultyPiOnly: boolean;
  sponsors: ReadonlySet<string>;
  mechanisms: ReadonlySet<string>;
};

export const EMPTY_BROWSE_FILTERS: BrowseFilters = {
  q: "",
  openOnly: false,
  facultyPiOnly: true,
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
  // Fail open: only an explicit `false` (the server derived the §3.1 gate and it failed) hides a row.
  if (f.facultyPiOnly && o.facultyPiEligible === false) return false;
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

/** Mapped 4xx bodies from `/api/edit/opportunity-admin` (409s mean the list went stale). */
const ADMIN_ACTION_ERRORS: Record<string, string> = {
  already_suppressed: "Already suppressed — refreshing the list.",
  not_suppressed: "Already restored — refreshing the list.",
  not_found: "That opportunity no longer exists — refreshing the list.",
  write_failed: "The change couldn't be recorded. Please try again.",
};

function adminActionErrorMessage(error: string | undefined): string {
  return ADMIN_ACTION_ERRORS[error ?? ""] ?? "Something went wrong. Please try again.";
}

/** Exported so `/edit/grant-matcha` reuses the SAME browse table rather than a second picker. */
export function BrowseList({
  hrefFor,
  freshness = false,
  admin = false,
}: {
  hrefFor: (id: string) => string;
  /** Render the corpus-freshness strip (the grant-matcha Browse header; NOT flag-gated). */
  freshness?: boolean;
  /** `MATCHA_ADMIN` — suppress/restore row actions + the show-suppressed toggle. */
  admin?: boolean;
}) {
  const [includeGrantsGov, setIncludeGrantsGov] = useState(false);
  const [sort, setSort] = useState<BrowseSort>("curated");
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_BROWSE_FILTERS);
  const [status, setStatus] = useState<BrowseStatus>({ kind: "loading" });
  // Matcha-admin Phase 1b. `showSuppressed` can only turn on where the toggle
  // renders (admin), so the non-admin fetch URL is byte-identical to before.
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [suppressTarget, setSuppressTarget] = useState<{
    opportunityId: string;
    title: string;
  } | null>(null);
  const [adminBusyId, setAdminBusyId] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  // Redesign 2026-08 (Browse Redesign.dc.html): cards replace the table, so a
  // real page needs a real page size. Client-side slice of the already-fetched
  // set — no API change, `limit=500` above still fetches everything up front.
  const [page, setPage] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus({ kind: "loading" });
    // The API's default limit of 200 was silently hiding a third of the default corpus (staging
    // 2026-07-24: 304 research, non-honorific, non-grants.gov rows). 500 is the route's MAX_LIMIT
    // and covers it with headroom.
    // ponytail: `includeGrantsGov=1` still overflows (934 rows) — that view is opt-in and
    // duplicates a public site, so it stays truncated. Page it if anyone actually browses it.
    const qs = new URLSearchParams({ limit: "500" });
    if (includeGrantsGov) qs.set("includeGrantsGov", "1");
    if (admin && showSuppressed) qs.set("includeSuppressed", "1");
    fetch(`/api/opportunities?${qs}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => {
        if (r.ok) {
          const data = (await r.json()) as {
            opportunities?: OpportunityListItem[];
            sources?: SourceFreshness[];
          };
          if (active) {
            setStatus({
              kind: "ok",
              opportunities: data.opportunities ?? [],
              sources: data.sources ?? [],
            });
          }
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
  }, [includeGrantsGov, admin, showSuppressed, reloadKey]);

  /**
   * The confirmed suppress/restore — PATCH `/api/edit/opportunity-admin`, then
   * refetch. Refetch on a 4xx too: `already_suppressed` / `not_found` mean the
   * list is stale, and the fresh list IS the corrected picture.
   */
  async function performAdmin(
    opportunityId: string,
    action: "suppress" | "restore",
    reason: string | null,
  ) {
    setAdminBusyId(opportunityId);
    setAdminError(null);
    try {
      const r = await fetch("/api/edit/opportunity-admin", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityId, action, ...(reason ? { reason } : {}) }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setAdminError(adminActionErrorMessage(data.error));
      }
      setReloadKey((k) => k + 1);
    } catch {
      setAdminError(adminActionErrorMessage(undefined));
    } finally {
      setAdminBusyId(null);
    }
  }

  const all = status.kind === "ok" ? status.opportunities : [];
  const now = Date.now();
  let shown = all.filter((o) => matchesBrowseFilters(o, filters, now));
  // Screening spec §6: the counterfactual is explicit. How many rows the faculty-PI gate is
  // holding back RIGHT NOW, under the rest of the current filters — not the corpus-wide 13.2%.
  const gateHides = filters.facultyPiOnly
    ? all.filter((o) => matchesBrowseFilters(o, { ...filters, facultyPiOnly: false }, now)).length -
      shown.length
    : 0;
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

  // ponytail: fixed page size, not a setting — tune the constant if 20 ever feels wrong.
  const PAGE_SIZE = 20;
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageStart = clampedPage * PAGE_SIZE;
  const pageItems = shown.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div>
      {freshness && status.kind === "ok" ? (
        <CorpusFreshness sources={status.sources} now={now} />
      ) : null}
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
        {admin ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={(e) => setShowSuppressed(e.target.checked)}
              className="size-4 accent-[var(--color-accent-slate)]"
            />
            <span title="Fold manually-suppressed rows back in, muted, with a Restore action.">
              Show suppressed
            </span>
          </label>
        ) : null}
      </div>

      {adminError ? (
        <p
          className="mb-2 text-sm text-red-700"
          role="alert"
          data-testid="opportunity-admin-error"
        >
          {adminError}
        </p>
      ) : null}

      {/* Redesign 2026-08: a 250px rail and a 20px gutter, top-aligned so the rail
          never stretches to the length of the results column. */}
      <div className="flex flex-col gap-x-5 gap-y-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <ActiveFilterChips filters={filters} setFilters={setFilters} />
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
                {/* The relax control lives ON the counterfactual rather than in the rail: the
                    sentence that admits rows are hidden is exactly where the officer wants the
                    control that reveals them. */}
                {gateHides > 0 ? (
                  <>
                    {" · "}
                    {gateHides} hidden — no Weill Cornell faculty PI can hold{" "}
                    {gateHides === 1 ? "it" : "them"}{" "}
                    <button
                      type="button"
                      onClick={() => setFilters((f) => ({ ...f, facultyPiOnly: false }))}
                      className="text-[var(--color-accent-slate)] hover:underline"
                    >
                      show
                    </button>
                  </>
                ) : null}
                {!filters.facultyPiOnly ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => setFilters((f) => ({ ...f, facultyPiOnly: true }))}
                      className="text-[var(--color-accent-slate)] hover:underline"
                    >
                      hide awards no faculty PI can hold
                    </button>
                  </>
                ) : null}
              </p>
              {/* Redesign 2026-08 (Browse Redesign.dc.html): cards, not a table row per
                  opportunity — each card's own heading is the a11y equivalent of a table
                  caption + row, so `<ul>` is the honest shape here instead. */}
              <ul aria-label="Funding opportunities" className="flex flex-col gap-3">
                {pageItems.map((o) => (
                  <OpportunityCard
                    key={o.opportunityId}
                    o={o}
                    href={hrefFor(o.opportunityId)}
                    admin={admin}
                    actionBusy={adminBusyId === o.opportunityId}
                    onSuppress={() =>
                      setSuppressTarget({
                        opportunityId: o.opportunityId,
                        title: stripSponsorPrefix(o.title, o.sponsor) ?? o.opportunityId,
                      })
                    }
                    onRestore={() => void performAdmin(o.opportunityId, "restore", null)}
                  />
                ))}
              </ul>
              {pageCount > 1 ? (
                <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
                  <span>
                    Showing {pageStart + 1}–{pageStart + pageItems.length} of {shown.length}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setPage(clampedPage - 1)}
                      disabled={clampedPage === 0}
                      className="text-[var(--color-accent-slate)] hover:underline disabled:pointer-events-none disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span>
                      Page {clampedPage + 1} of {pageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage(clampedPage + 1)}
                      disabled={clampedPage >= pageCount - 1}
                      className="text-[var(--color-accent-slate)] hover:underline disabled:pointer-events-none disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : null}
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

      {admin ? (
        <SuppressOpportunityDialog
          target={suppressTarget}
          onOpenChange={(open) => {
            if (!open) setSuppressTarget(null);
          }}
          onConfirm={async (reason) => {
            if (!suppressTarget) return;
            await performAdmin(suppressTarget.opportunityId, "suppress", reason);
            setSuppressTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Matcha-admin Phase 1b suppress confirm (mockup 2). Cancel is the
 * default-focused element, never Suppress — `confirm-dialog.tsx`'s safety
 * invariant. Reason is optional free text; the server trims and caps it.
 */
function SuppressOpportunityDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  target: { opportunityId: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string | null) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const open = target !== null;

  // Re-opening starts fresh — a stale reason must never carry across rows.
  useEffect(() => {
    if (open) {
      setReason("");
      setPending(false);
    }
  }, [open]);

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm(reason.trim() || null);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suppress this opportunity?</DialogTitle>
          <DialogDescription>&ldquo;{target?.title}&rdquo;</DialogDescription>
        </DialogHeader>
        <p className="text-foreground/90 text-sm">
          Hidden immediately from browse; cached detail pages can linger up to ~15 minutes (CDN).
          Matching surfaces that read the search index clear on the next nightly run. The nightly
          sync will NOT undo this; restore any time from Browse.
        </p>
        <div className="flex flex-col gap-2">
          <label htmlFor="suppress-opportunity-reason" className="text-sm font-medium">
            Reason (optional)
          </label>
          <Textarea
            id="suppress-opportunity-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why this row shouldn't surface"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            autoFocus
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
            data-testid="suppress-opportunity-confirm"
          >
            {pending ? "Working…" : "Suppress"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Chip prefixes — the same words the rail uses as its `FacetGroup` legends. */
const FACET_GROUP_LABEL = { sponsors: "Sponsor", mechanisms: "Mechanism" } as const;

/** Immutably drop one value from a checkbox facet group. */
function withoutFacet(
  f: BrowseFilters,
  group: "sponsors" | "mechanisms",
  value: string,
): BrowseFilters {
  const next = new Set(f[group]);
  next.delete(value);
  return { ...f, [group]: next };
}

/**
 * Active-filter chips (redesign 2026-08) — one removable chip per filter that is
 * currently narrowing the list, sitting above the results count so the reason a
 * short list is short is visible without opening the rail.
 *
 * This is NARROWER than `FilterRail`'s `active` test, which also counts a RELAXED
 * faculty-PI gate (`!filters.facultyPiOnly`). The gate is deliberately un-chipped
 * in both of its states: it is ON by default, so chipping it would put a chip on
 * every resting render, and relaxed it does not narrow anything. Its relax/re-apply
 * control already lives on the counterfactual sentence below — the one line that
 * admits rows are hidden.
 *
 * 🔴 Because the gate has no chip, BOTH reset controls — this row's "Clear all" and
 * the rail's "reset all" — must CARRY IT THROUGH rather than reset it:
 * `EMPTY_BROWSE_FILTERS.facultyPiOnly` is `true`, so spreading it blind silently
 * re-applies a gate that hides ~13.2% of the corpus and makes the list SHORTER, with
 * no chip having represented that state. They are always on screen together, so the
 * two must agree; each is pinned by its own test.
 */
function ActiveFilterChips({
  filters,
  setFilters,
}: {
  filters: BrowseFilters;
  setFilters: React.Dispatch<React.SetStateAction<BrowseFilters>>;
}) {
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.openOnly) {
    chips.push({
      key: "availability",
      label: "Availability: Only open",
      clear: () => setFilters((f) => ({ ...f, openOnly: false })),
    });
  }
  for (const group of ["sponsors", "mechanisms"] as const) {
    for (const value of [...filters[group]]) {
      chips.push({
        key: `${group}:${value}`,
        // Group-prefixed, matching the rail's own legends: a bare facet value leaves a
        // Sponsor chip and a Mechanism chip carrying the same string indistinguishable,
        // on screen and to a screen reader reading the remove button's name.
        label: `${FACET_GROUP_LABEL[group]}: ${value}`,
        clear: () => setFilters((f) => withoutFacet(f, group, value)),
      });
    }
  }
  if (chips.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Filtering by:</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className="border-apollo-border bg-apollo-surface inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5"
        >
          <span className="min-w-0 truncate">{c.label}</span>
          <button
            type="button"
            onClick={c.clear}
            aria-label={`Remove filter: ${c.label}`}
            className="text-muted-foreground hover:bg-apollo-red-tint hover:text-apollo-maroon shrink-0 rounded-full p-0.5"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <button
        type="button"
        // `facultyPiOnly` is carried through, not reset — see the 🔴 note above.
        onClick={() =>
          setFilters((f) => ({
            ...EMPTY_BROWSE_FILTERS,
            q: f.q,
            facultyPiOnly: f.facultyPiOnly,
          }))
        }
        className="text-[var(--color-accent-slate)] hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}

// Duke-style right-rail filters: availability, then checkbox facet groups with
// counts. All client-side over the fetched corpus.
//
// 🔴 The deadline-range inputs that used to sit here were DELETED (#1920): `dueDate` is null on
// 99.0% of the corpus, and the range test rejects an undated row, so setting either bound
// silently hid almost everything while appearing to narrow. A filter over a field that does not
// exist is worse than no filter. Restore it when typed deadline extraction lands, not before.
//
// `Browse Redesign.dc.html` draws Availability / Sponsor / Research area / Eligibility; the rail
// below is Availability / Sponsor / Mechanism / Sources. Research area and Eligibility were
// considered and declined on DATA, not taste, and the artboard is not evidence they can be built:
//   - Research area would key off `primaryTopicId`, which `app/api/opportunities/route.ts` does
//     not select — the browse rows never carry it;
//   - `eligibility` and `eligibilityFlags` ARE selected there, then deliberately destructured out
//     before the response (they exist only to derive `facultyPiEligible`), so they are not on the
//     wire either;
//   - and two of the artboard's six eligibility labels ("MD/PhD", "Tenure track") have no
//     corresponding `career_stages` value in `lib/funding/screening.ts` at all.
// Land the field on the wire first; do not re-raise either group from the artboard alone.
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
    !filters.facultyPiOnly ||
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

  // R4 (surface language): the filter column is a rail — one greige unit with its
  // own edge. --apollo-rail-border is the strong value; the hairline reads
  // 1.035:1 on the rail and dies.
  return (
    <aside
      className="bg-apollo-rail border-apollo-rail-border w-full shrink-0 space-y-5 rounded-[var(--apollo-radius-card)] border p-4 lg:order-first lg:w-[250px]"
      aria-label="Filter opportunities"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Filters</h3>
        {active ? (
          <button
            type="button"
            // `facultyPiOnly` is carried through, exactly as the chip row's "Clear all"
            // does. `active` below is a SUPERSET of the chip row's render test, so both
            // controls are always on screen together; resetting the gate here while the
            // chip row carries it would leave two adjacent controls disagreeing about
            // one piece of state.
            onClick={() =>
              setFilters((f) => ({
                ...EMPTY_BROWSE_FILTERS,
                q: f.q,
                facultyPiOnly: f.facultyPiOnly,
              }))
            }
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
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.has(value)}
              onChange={() => onToggle(value)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent-slate)]"
            />
            <span className="min-w-0 flex-1 break-words" title={value}>
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

/**
 * One opportunity as a card.
 *
 * THE WHOLE ROW IS THE CLICK TARGET, and it gets there the boring way: the
 * title is a real `<Link>` whose `after:absolute after:inset-0` pseudo-element
 * covers the `relative` row. No onClick/onKeyDown/role="button" on the `<tr>` —
 * that would forfeit cmd-click, middle-click, right-click "copy link address",
 * tab focus and the screen-reader "link" announcement, all of which an anchor
 * gives for free. `focus-within` puts the focus ring on the row so keyboard
 * users see what they are about to open.
 *
 * If a secondary control is ever added to a row it MUST carry `relative z-10`,
 * or the stretched pseudo-element will sit on top of it and swallow the click.
 */
function OpportunityCard({
  o,
  href,
  admin = false,
  actionBusy = false,
  onSuppress,
  onRestore,
}: {
  o: OpportunityListItem;
  href: string;
  /** Matcha-admin Phase 1b — render the Suppress/Restore action. */
  admin?: boolean;
  actionBusy?: boolean;
  onSuppress?: () => void;
  onRestore?: () => void;
}) {
  const award = awardRange(o.awardFloor ?? null, o.awardCeiling ?? null);
  // Sponsor's shown in the meta row now, so a title that restates it is noise.
  const title = stripSponsorPrefix(o.title, o.sponsor) ?? o.opportunityId;
  // Only the includeSuppressed=1 admin fetch ever returns a suppressed row.
  const suppressed = Boolean(o.suppressedAt);
  return (
    <li
      className={`border-apollo-border bg-apollo-surface hover:border-apollo-border-strong hover:bg-apollo-surface-2 focus-within:outline-apollo-maroon relative flex items-center gap-3 rounded-[var(--apollo-radius-card)] border p-4 shadow-[var(--apollo-shadow-card)] transition-colors focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 ${
        suppressed ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <span className="flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            Deadline: <DeadlineCell iso={o.dueDate} status={o.status} />
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {o.sponsor ? (
              <span className="flex items-center gap-1">
                <Building2 className="size-3.5" aria-hidden />
                {o.sponsor}
              </span>
            ) : null}
            <SourceBadge source={o.source} />
            <PrestigeBadge prestige={o.prestige} />
            {admin ? (
              // `relative z-10` — without it the card's stretched anchor (below)
              // sits on top and swallows the click.
              <button
                type="button"
                onClick={suppressed ? onRestore : onSuppress}
                disabled={actionBusy}
                className="text-muted-foreground hover:text-foreground relative z-10 disabled:opacity-50"
                aria-label={actionBusy ? "Working…" : suppressed ? "Restore" : "Suppress"}
                title={actionBusy ? "Working…" : suppressed ? "Restore" : "Suppress"}
                data-testid={`opportunity-${suppressed ? "restore" : "suppress"}`}
              >
                {suppressed ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </button>
            ) : null}
          </span>
        </div>
        <Link
          href={href}
          className="font-medium leading-snug text-[var(--color-accent-slate)] after:absolute after:inset-0 after:content-[''] hover:underline focus:outline-none"
        >
          {title}
        </Link>
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          {o.mechanism ? <span>{o.mechanism}</span> : null}
          {award ? <span>{award}</span> : null}
        </div>
        {suppressed && o.suppressedAt ? (
          <span className="text-muted-foreground mt-1 block text-xs" data-testid="suppressed-note">
            suppressed {formatSuppressedDate(o.suppressedAt)}
            {o.suppressedBy ? ` by ${o.suppressedBy}` : ""}
            {o.suppressReason ? ` — “${o.suppressReason}”` : ""}
          </span>
        ) : null}
      </div>
      {/* Affordance only — decorative, so it stays out of the a11y tree: the card
          already announces itself through the title link. Non-interactive, so it
          needs no `relative z-10` escape from the stretched pseudo-element. */}
      <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
    </li>
  );
}

function formatSuppressedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Curated-vs-external source pill — inline beside whatever it qualifies (a row title, the
 *  grant-matcha selected header). Renders nothing for a null source. */
export function SourceBadge({ source }: { source: string | null }) {
  const label = sourceLabel(source);
  if (!label) return null;
  const curated = source === "wcm_curated";
  return (
    <span
      className={
        curated
          ? "shrink-0 rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent-slate)]"
          : "border-apollo-border-strong text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs"
      }
    >
      {label}
    </span>
  );
}

/**
 * Long NOFO prose (synopsis, eligibility) collapsed behind a Show-more toggle,
 * mirroring the abstract clamp in `components/funding/expanded-grant.tsx`, so
 * the content below stays near the fold. `lines` picks the clamp height —
 * the grant-matcha selected header clamps at three lines (mockup 4); the
 * reverse-matcher card keeps its original four.
 */
// ponytail: char-count heuristic for "long", not measured lines.
const CLAMP_THRESHOLD = 400;

// Literal class names — Tailwind can't see a computed `line-clamp-${n}`.
const CLAMP_CLASS: Record<3 | 4, string> = { 3: "line-clamp-3", 4: "line-clamp-4" };

export function ClampedText({ text, lines = 4 }: { text: string; lines?: 3 | 4 }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > CLAMP_THRESHOLD;
  return (
    <div>
      <p
        className={`whitespace-pre-line text-sm leading-relaxed text-foreground/90 ${
          long && !expanded ? CLAMP_CLASS[lines] : ""
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


/**
 * Mockup-4 fact rail for the grant-matcha selected view — a standalone
 * Duke-style right column (that surface renders its own header + synopsis)
 * with EVERY row always present: a missing value
 * renders the muted dash rather than silently dropping the row, so the officer
 * can tell "not recorded" from "not shown". Values come straight off
 * `/api/opportunities/[id]`; nothing here is ever invented.
 */
export function OpportunityFactRail({
  awardFloor,
  awardCeiling,
  estimatedFunding,
  numberOfAwards,
  openDate,
  dueDate,
  cfdaList,
  sourceUrl,
}: {
  awardFloor: number | null;
  awardCeiling: number | null;
  estimatedFunding: number | null;
  numberOfAwards: number | null;
  /** ISO dates as the detail route serializes its `@db.Date` columns. */
  openDate: string | null;
  dueDate: string | null;
  cfdaList: string[];
  sourceUrl: string | null;
}) {
  const due = formatDue(dueDate);
  const urgency = dueUrgency(dueDate, Date.now());
  const facts: Array<{ label: string; value: string | null; className?: string; warn?: boolean }> =
    [
      { label: "Award", value: awardRange(awardFloor, awardCeiling) },
      { label: "Est. total funding", value: formatMoney(estimatedFunding) },
      { label: "Awards", value: numberOfAwards != null ? `~${numberOfAwards}` : null },
      { label: "Opens", value: formatDue(openDate) },
      {
        label: "Due",
        value: due ? (urgency === "past" ? `${due} (passed)` : due) : null,
        className: urgency === "soon" ? "font-medium text-apollo-amber" : undefined,
        warn: urgency === "soon",
      },
      { label: "CFDA", value: cfdaList.length > 0 ? cfdaList.join(", ") : null },
    ];

  return (
    <aside
      data-testid="opportunity-fact-rail"
      aria-label="Opportunity facts"
      className="w-full shrink-0 space-y-4 sm:w-56"
    >
      <dl className="space-y-3">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-muted-foreground text-xs uppercase tracking-wide">{f.label}</dt>
            {f.value !== null ? (
              <dd className={`text-sm ${f.className ?? "text-foreground"}`}>
                {f.value}
                {f.warn ? (
                  <AlertTriangle
                    className="text-apollo-amber ml-1 inline size-3.5 align-[-2px]"
                    aria-hidden
                  />
                ) : null}
              </dd>
            ) : (
              // The em-dash case carries a spoken equivalent — a bare "—"
              // reaches a screen reader as nothing at all (the DeadlineCell
              // precedent above).
              <dd className="text-muted-foreground text-sm">
                <span aria-hidden>—</span>
                <span className="sr-only">Not recorded</span>
              </dd>
            )}
          </div>
        ))}
      </dl>
      {sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent-slate)] px-3 text-sm font-medium text-white hover:opacity-90"
        >
          <ExternalLink className="size-3.5" aria-hidden /> More information
        </a>
      ) : null}
    </aside>
  );
}
