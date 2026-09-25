/**
 * `/edit/data-sharing` — S-Index Phase 1 admin/CTSA reporting dashboard.
 * Three sections as in-page anchors (`#rollup` / `#repos` / `#faculty`),
 * mirroring `~/Downloads/s-index-ui-proposal.html`'s IA — not its markup, this
 * reuses the existing table/`Badge` primitives the other Insights dashboards
 * use (`etl-status`, `usage`). Server component; the only interactive bit is
 * the "Copy paragraph" clipboard button, an existing client island.
 *
 * v1 scope: COUNTS ONLY (distinct datasets, depositing faculty, link volume).
 * Strict-only: every count here is the confirmed-deposit floor
 * (`DatasetDeposit.confidence` is only ever `'high'` in what's persisted
 * today — see the 2026-08-12 plan's "Strict/generous band" section). Named
 * faculty (§3) ships identically to §1–2 — one flag, no lock, no redaction
 * (decided 2026-08-12).
 *
 * Share rate (added after v1): "n/N (x%)" of confirmed first/last-authored
 * WCM pubs since `SHARE_RATE_YEAR_FLOOR` with a detected deposit — the
 * MeSH-free fallback denominator, see `lib/api/data-sharing-report.ts`'s
 * header. Deliberately never rendered as a bare percentage — see the Rollup
 * section's stat card. Still no full-text coverage stat.
 *
 * S-Index v2 (this PR): Open / Controlled / Registry columns on the
 * department table (§2), Open / Controlled on the faculty table (§3), and a
 * new §4 funding lens (NIH-funded vs. not-NIH-funded pub counts). See
 * `lib/api/data-sharing-report.ts`'s header for the exact bucketing rule.
 *
 * S-Index v2, risk tier (this PR, stacked on the above): a "Repositories by
 * risk tier" table and a Tier column on the existing repository table in
 * §3, a tier spectrum row on §1 Rollup, and Concerning/Foreign-hosted
 * columns on the §4 faculty table. Tier is host jurisdiction × access model,
 * a pure function of `repository` (`@/lib/repository-tier`, a partial port
 * of `catalog.py`). SPEC "Amended 08-13": "concerning" here is TIER-DERIVED
 * ONLY — country-of-concern host or foreign-hosted repository. It does NOT
 * include sensitive-data-type detection (needs raw MeSH per citing pub, cut
 * this session) — every place this flag is visible says so, don't soften or
 * drop that caveat.
 *
 * S-Index v2, granular sub-types (this PR, stacked on the above): a new §5
 * "Deposits by data sub-type" — deposit-instance counts per granular
 * sub-type (e.g. "genomic:WGS/WES"), grouped by coarse category, from
 * `report.bySubtype` (`lib/api/data-sharing-report.ts`'s `aggregateBySubtype`).
 * Same deposit-INSTANCE grain as the link counts elsewhere on this page —
 * not distinct datasets. Dark (empty table, section hidden) until the
 * companion ReCiterDB columns are live and `etl/data-sharing` has re-run.
 *
 * Recent activity (2026-08-15): a new §6, item-level (one row per
 * (person, dataset) link, same grain as the CSV export — a multi-author
 * dataset can appear more than once). "Recent" means `depositYear`, NOT
 * "when SPS detected this" — this data model has no per-item discovery
 * timestamp (`report.dataAsOf`'s doc comment explains why
 * `lastRefreshedAt` can't stand in for one). Says so on the page, not just
 * in code. Reuses `TierChip`/`AccessChip` for the same severity coloring as
 * §3, per the existing convention: no new color system for this table
 * either.
 *
 * Mockup design pass (2026-08-16): adopted the v2 mockup's tier color
 * palette (`TIER_COLORS`) page-wide — colored tier dots instead of gray
 * Badge variants, a proportional §1 spectrum bar (`TierSpectrum`), per-repo
 * counts inline in the tier table, and a `FACULTY_ROW_CAP` "+N more" cut on
 * §4. Decision record: the DECISION 2026-08-16 section of the Projects
 * handoff doc this mockup ships with.
 *
 * Follow-up pass (same day): ArrowUpRight on every external link
 * (`ExternalA`), a per-table "Download CSV" (`DownloadLink` →
 * `?section=` on the export route), the methodology prose + copy-paragraph
 * block folded into a Methods dialog (`data-sharing-methods.tsx`), a PMIDs
 * column on §6 (the only table naming specific pubs), and `AccessChip`
 * de-pilled to plain text.
 *
 * v3 stakeholder pass (2026-08-16, this PR): (1) two PMC cards on §1 — "In
 * PMC" and "PMC-covered share rate", the denominator the full-text scan can
 * actually see (`overall.pmcCoveredPubs`/`.pmcDepositedPubs`, see the report
 * lib's `pmcCoverage`). (2) The tier table renders its now-zero-padded rows
 * (muted count, "none detected") — "Country of concern · 0" must READ as a
 * deliberate statement, per the same `paddedTiers` rationale upstream. (3)
 * The tier table's inline repo chips link out via `urlOf`. (4) A per-table
 * "Download items CSV" (`?grain=items`) beside each aggregate CSV link. (5)
 * The mockup's `.newcol` exposure-column tint (`exposureColClass`). (6) §6
 * enriched per the "cryptic" complaint: an Accession column deep-linking via
 * `resolveDatasetUrl` (the profile Datasets section's own resolver), plus
 * Title/Type/Sub-types columns. (7) A new §7 Compliance view — the
 * concerning-instances number moves there from the old §4 footnote, next to
 * three placeholder cards the COC-coauthor pull will eventually fill (the
 * stakeholder explicitly wants the section present before the data exists).
 * (8) `DefinedTerm` dotted-underline hovers over key terms, definitions from
 * the same `DATA_SHARING_TERMS` glossary the Methods dialog renders in full.
 * (9) The Methods dialog rebuilt on `buildMethodsDoc` — the dashboard builds
 * the doc server-side and passes it down, see `data-sharing-methods.tsx`.
 *
 * 2026-09 page revision (the "Data Sharing" design-canvas mockup): a
 * two-column layout — an "On this page" rail (`DataSharingRail`: audience
 * chips, numbered sections with a headline stat each, scroll-spy) beside the
 * body; "Data as of" + the FTE-denominator note as pills; a filter bar of
 * segmented Deposit-years presets / NIH / tier chips (plain GET links; the
 * custom from/to year form lives behind "Custom"); KPI tiles; the year chart
 * and tier bars side by side; ONE funding × access table with totals (it
 * carries all four old funding cards' numbers); Repositories and Departments
 * split into their own sections; the department Open/Controlled/Registry
 * columns folded into an access-mix bar; sub-types as per-category cards; a
 * condensed Recent deposits table; and Methods rendered inline at the foot
 * of the page instead of in a dialog. Every caveat the notes above call
 * load-bearing (tier-only "concerning", strict floor, the PMC gap, the
 * attribution-scope paragraph, n/N beside every rate) is still on the page.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { CopyButton } from "@/components/publication/copy-button";
import { DataSharingMethodsSection } from "@/components/edit/data-sharing-methods";
import { DataSharingRail, ShowMoreRows, type RailItem } from "@/components/edit/data-sharing-rail";
import { DefinedTerm } from "@/components/edit/data-sharing-term";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { resolveDatasetUrl } from "@/components/profile/datasets-section";
import {
  parseSensitiveSubtypes,
  SHARE_RATE_YEAR_FLOOR,
  type DataSharingReport,
  type DepartmentRollup,
  type NamedFacultyRow,
} from "@/lib/api/data-sharing-report";
import { buildMethodsDoc } from "@/lib/edit/data-sharing-methods-doc";
import {
  FACULTY_ROW_CAP,
  type DataSharingUiParams,
  type DepartmentSortKey,
  type FacultySortKey,
  type SortDir,
} from "@/lib/edit/data-sharing-dashboard";
import { effectiveTierOf, urlOf } from "@/lib/repository-tier";
import { cn } from "@/lib/utils";

/** Card chrome shared by every tile, chart and table on the page. */
const cardClass = "border-apollo-border-strong bg-apollo-surface rounded-[13px] border";
/** Table shell: the card, clipped, scrolling sideways at phone width. */
const tableWrapClass = `${cardClass} overflow-x-auto`;
const theadClass =
  "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground border-b text-left text-[11.5px] font-medium tracking-[.06em] uppercase";
const thClass = "px-3 py-2.5 font-medium first:pl-[18px] last:pr-[18px]";
const tdClass = "px-3 py-2 first:pl-[18px] last:pr-[18px]";
const rowClass = "border-apollo-border hover:bg-apollo-page border-t first:border-t-0";
const linkActionClass = "text-apollo-slate text-[13px] hover:underline";

/** Percent label for a share rate — a nonzero numerator that rounds to 0%
 *  reads "<1%" (2026-08-16 review: "0%" next to a nonzero numerator reads as
 *  an arithmetic error). `null` for no data / zero denominator. */
function ratePct(numerator: number | undefined, denominator: number | undefined): string | null {
  if (numerator === undefined || denominator === undefined || denominator === 0) return null;
  const pct = Math.round((numerator / denominator) * 100);
  return pct === 0 && numerator > 0 ? "<1%" : `${pct}%`;
}

/** Share rate as the percentage WITH its "n/N" beside it — deliberately
 *  never a bare percentage (a past review flagged that a naked percent on a
 *  small denominator implies false precision). No data → "—". */
function ShareRateCell({
  numerator,
  denominator,
}: {
  numerator: number | undefined;
  denominator: number | undefined;
}) {
  const pct = ratePct(numerator, denominator);
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-baseline justify-end gap-2 whitespace-nowrap">
      <span className="font-medium tabular-nums">{pct}</span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {numerator!.toLocaleString()}/{denominator!.toLocaleString()}
      </span>
    </span>
  );
}

/** Acronyms preserved as-is when `displayDepartmentName` title-cases an
 *  all-caps department string — 2026-08-16 adversarial-review finding: the
 *  fix's OWN motivating example, "WCMC QATAR," contains one (WCMC) that the
 *  naive title-case would mangle to "Wcmc." Bounded allowlist, not a general
 *  acronym detector — add an entry only when a real all-caps department name
 *  surfaces one. */
const PRESERVED_DEPARTMENT_ACRONYMS = new Set(["WCMC", "ICU", "NIH"]);

/** Title-cases a department name if it's stored fully uppercase (e.g. "WCMC
 *  QATAR" → "WCMC Qatar"), otherwise passes it through untouched. Within an
 *  all-caps string, a token in `PRESERVED_DEPARTMENT_ACRONYMS` stays
 *  uppercase. */
function displayDepartmentName(department: string): string {
  if (department !== department.toUpperCase() || department === department.toLowerCase())
    return department;
  return department
    .split(" ")
    .map((word) => {
      if (PRESERVED_DEPARTMENT_ACRONYMS.has(word)) return word;
      const lower = word.toLowerCase();
      return lower.length > 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** Repositories whose accession convention is a fixed-prefix uppercase code
 *  (GSExxxx, SRRxxxx…) — uppercased for display when the stored value isn't
 *  already. Deliberately NOT applied to every repository: DOI-bearing
 *  repositories use `accessionOrDoi` for a real DOI, and dbGaP's own
 *  convention is a LOWERCASE "phs" prefix (2026-08-16 adversarial-review
 *  finding: dbGaP was wrongly included here). */
const UPPERCASE_ACCESSION_REPOSITORIES = new Set(["GEO", "SRA", "GenBank", "BioProject/BioSample"]);

function displayAccession(repository: string, accession: string): string {
  return UPPERCASE_ACCESSION_REPOSITORIES.has(repository) ? accession.toUpperCase() : accession;
}

/** `report.dataAsOf` — when the weekly data-sharing bridge last fully synced. */
function formatDate(d: Date | null): string {
  if (d === null) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Plain text since the 08-16 follow-up pass — the filled Badge pills read
 *  too heavy against the tier-color scheme. Don't reintroduce a pill here. */
function AccessChip({ accessModel }: { accessModel: string | null }) {
  if (accessModel === null) return <span className="text-muted-foreground">—</span>;
  return <span>{accessModel === "open" ? "Open" : "Controlled"}</span>;
}

/** External <a> with the console's ArrowUpRight affordance — for links that
 *  leave SPS. */
function ExternalA({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-0.5 hover:underline", className)}
    >
      {children}
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
}

/** Per-table CSV link — a plain <a> because the target is a download route
 *  handler; <Link>'s client nav + prefetch would fetch the file itself. Every
 *  call site passes an `href` already carrying the active filter via
 *  `withFilters` (2026-08-16, GitHub #2470), and the export route applies it,
 *  so the label just says what the link does. */
function DownloadLink({
  href,
  label = "Download CSV",
  className = linkActionClass,
  testId,
  title,
}: {
  href: string;
  label?: string;
  className?: string;
  testId?: string;
  title?: string;
}) {
  return (
    <a href={href} className={className} data-testid={testId} title={title}>
      {label}
    </a>
  );
}

/** `ui.filters` → the exact query-param shape `parseDataSharingParams` reads
 *  back (2026-08-16 adversarial-review fix): `DataSharingReportFilters.tiers`
 *  is plural but the URL param is singular `tier=` (repeated once per value).
 *  This is the one place that translation happens. */
function filterQueryParams(
  filters: DataSharingUiParams["filters"],
): Record<string, string | number | readonly string[] | undefined> {
  return {
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    tier: filters.tiers,
    nihFunded: filters.nihFunded === undefined ? undefined : String(filters.nihFunded),
  };
}

/** Builds a query string, dropping `undefined`/empty-array values — the one
 *  place every sort/filter/pagination href on this page assembles its params. */
function buildQuery(
  params: Record<string, string | number | readonly string[] | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, v);
    } else {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** Appends the active filter onto an existing download href, merging with
 *  whatever query string the href already carries (2026-08-16, GitHub #2470).
 *  Filter keys never collide with a drill-down key, so this is a plain merge. */
function withFilters(href: string, filters: DataSharingUiParams["filters"]): string {
  const [path, query = ""] = href.split("?");
  const sp = new URLSearchParams(query);
  for (const [key, value] of Object.entries(filterQueryParams(filters))) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, v);
    } else {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** "Is any filter currently active" — the filter bar's Clear link and caption
 *  share this one definition. */
function hasActiveFilters(filters: DataSharingUiParams["filters"]): boolean {
  return (
    filters.yearFrom !== undefined ||
    filters.yearTo !== undefined ||
    !!filters.tiers?.length ||
    filters.nihFunded !== undefined
  );
}

/** A sortable `<th>` — a plain link that reloads the page with the sort param
 *  toggled, not a client island (see `parseDataSharingParams`'s doc comment).
 *  Preserves every other active filter/sort param via `otherParams`. Clicking
 *  the active column flips direction; clicking another switches to it —
 *  descending first for numbers, A–Z first for the name column. */
function SortableTh({
  label,
  sortKey,
  activeSort,
  activeDir,
  otherParams,
  sortParamName,
  dirParamName,
  align = "right",
  title,
}: {
  label: string;
  sortKey: string;
  activeSort: string | undefined;
  activeDir: SortDir;
  otherParams: Record<string, string | number | readonly string[] | undefined>;
  sortParamName: string;
  dirParamName: string;
  align?: "left" | "right";
  title?: string;
}) {
  const isActive = activeSort === sortKey;
  const firstDir: SortDir = sortKey === "name" ? "asc" : "desc";
  const nextDir: SortDir = isActive ? (activeDir === "desc" ? "asc" : "desc") : firstDir;
  const href = buildQuery({ ...otherParams, [sortParamName]: sortKey, [dirParamName]: nextDir });
  return (
    <th
      className={cn(thClass, align === "right" && "text-right")}
      aria-sort={isActive ? (activeDir === "desc" ? "descending" : "ascending") : undefined}
    >
      <a
        href={href}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 hover:underline",
          isActive && "text-foreground font-semibold",
        )}
      >
        {label}
        {isActive && <span aria-hidden>{activeDir === "desc" ? "↓" : "↑"}</span>}
      </a>
    </th>
  );
}

/** Short display label per `tierOf` value (`@/lib/repository-tier`). Falls
 *  through to the bare tier string for any future tier. */
const TIER_LABELS: Record<string, string> = {
  CONCERN: "Country of concern",
  FOREIGN_OPEN: "Foreign-hosted, open",
  FOREIGN_CTRL: "Foreign-hosted, controlled",
  US_OPEN: "US-hosted, open",
  US_CTRL: "US-hosted, controlled",
  REGISTRY: "Registry (not microdata)",
  UNKNOWN: "Unclassified",
};

/** Compact tier labels for the filter-bar chips (the full label is the chip's
 *  tooltip). */
const TIER_SHORT_LABELS: Record<string, string> = {
  CONCERN: "Concern",
  FOREIGN_OPEN: "Foreign · open",
  FOREIGN_CTRL: "Foreign · controlled",
  US_OPEN: "US · open",
  US_CTRL: "US · controlled",
  REGISTRY: "Registry",
};

/** Tier palette from the v2 mockup (adopted per the 2026-08-16 decision) —
 *  one hue per tier, severity-ordered warm→cool. The single source for every
 *  tier color on this page: dots, chips, bars, and the access-mix bar (open =
 *  US_OPEN, controlled = US_CTRL, registry = REGISTRY). */
const TIER_COLORS: Record<string, string> = {
  CONCERN: "#B31B1B",
  FOREIGN_OPEN: "#D97B29",
  FOREIGN_CTRL: "#C9A227",
  US_OPEN: "#3E6FB0",
  US_CTRL: "#2E7D52",
  REGISTRY: "#8A90A0",
  UNKNOWN: "#C3C7D1",
};

/** Tier → `DATA_SHARING_TERMS` glossary key for the `DefinedTerm` hover.
 *  FOREIGN_OPEN/FOREIGN_CTRL each get their OWN entry (2026-08-16 fix). US
 *  tiers and UNKNOWN are absent on purpose — an absent key renders plain. */
const TIER_GLOSSARY_TERM: Record<string, string> = {
  CONCERN: "Country of concern",
  FOREIGN_OPEN: "Foreign-hosted, open",
  FOREIGN_CTRL: "Foreign-hosted, controlled",
  REGISTRY: "Registry",
};

function TierDot({ tier, className }: { tier: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: TIER_COLORS[tier] ?? TIER_COLORS.UNKNOWN }}
    />
  );
}

/** Tier label with its glossary hover when the tier has one. */
function TierLabel({ tier }: { tier: string }) {
  const label = TIER_LABELS[tier] ?? tier;
  const term = TIER_GLOSSARY_TERM[tier];
  return term ? <DefinedTerm term={term}>{label}</DefinedTerm> : <>{label}</>;
}

/** Colored tier dot + label. */
function TierChip({ tier }: { tier: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <TierDot tier={tier} />
      <TierLabel tier={tier} />
    </span>
  );
}

/** Whether a tier is inside the active tier filter (every tier is, with no
 *  tier filter) — out-of-filter tier rows render dimmed. */
function tierInFilter(filters: DataSharingUiParams["filters"], tier: string): boolean {
  return !filters.tiers?.length || filters.tiers.includes(tier);
}

/** Section heading row: title, a muted one-line description, and the
 *  section's actions (downloads) pushed right. */
function SectionHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-xl font-semibold">{title}</h2>
      {sub ? <span className="text-muted-foreground text-[13px]">{sub}</span> : null}
      {actions ? (
        <span className="ml-auto flex flex-wrap items-baseline gap-x-3.5 gap-y-1">{actions}</span>
      ) : null}
    </div>
  );
}

/** One headline number. */
function Kpi({
  label,
  value,
  sub,
  subClassName,
  testId,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  subClassName?: string;
  testId?: string;
}) {
  return (
    <div className={cn(cardClass, "flex flex-col gap-[3px] px-4 py-3.5")}>
      <span className="text-muted-foreground text-xs font-medium tracking-[.08em] uppercase">
        {label}
      </span>
      <span
        className="text-[28px] leading-tight font-semibold tracking-[-.01em] tabular-nums"
        data-testid={testId}
      >
        {value}
      </span>
      <span className={cn("text-muted-foreground text-[12.5px] leading-snug", subClassName)}>
        {sub}
      </span>
    </div>
  );
}

/** Tier-labelled horizontal bars, one per tier against one shared 0–max axis
 *  (small multiples, NOT a stacked bar — 2026-08-16 review: a publication
 *  counted in more than one tier is "counted in each," so a stacked bar's
 *  total would promise a partition it doesn't have). Zero-count tiers still
 *  get a row — "Country of concern 0" stays a visible statement. */
function TierBars({
  rows,
  filters,
}: {
  rows: DataSharingReport["pubsByTier"];
  filters: DataSharingUiParams["filters"];
}) {
  const max = Math.max(1, ...rows.map((t) => t.pubs));
  return (
    <div className="flex flex-col gap-2.5" data-testid="ds-tier-bars">
      {rows.map((t) => (
        <div
          key={t.tier}
          className={cn(
            "grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_40px] items-center gap-2.5 text-[13px]",
            !tierInFilter(filters, t.tier) && "opacity-35",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-[7px]">
            <TierDot tier={t.tier} />
            <span className="truncate">
              <TierLabel tier={t.tier} />
            </span>
          </span>
          <div className="bg-apollo-surface-2 h-2.5 overflow-hidden rounded-full">
            {t.pubs > 0 && (
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(t.pubs / max) * 100}%`,
                  backgroundColor: TIER_COLORS[t.tier] ?? TIER_COLORS.UNKNOWN,
                }}
              />
            )}
          </div>
          <span className="text-right font-medium tabular-nums">{t.pubs.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** Datasets-by-deposit-year bars (no chart library). Ascending years; a year
 *  outside the active year filter greys out, the current (partial) year is
 *  hatched and labelled YTD, and the "Unknown year" bucket, if present,
 *  renders last and muted so it reads as a caveat, not a trend point. */
function DepositsByYearChart({
  rows,
  filters,
  currentYear,
}: {
  rows: DataSharingReport["byYear"];
  filters: DataSharingUiParams["filters"];
  currentYear: number;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.datasets));
  const hasYtd = rows.some((r) => r.year === currentYear);
  const inRange = (y: number) =>
    (filters.yearFrom === undefined || y >= filters.yearFrom) &&
    (filters.yearTo === undefined || y <= filters.yearTo);
  const label = (y: number | null) =>
    y === null ? "Unknown" : y === currentYear ? `${y} YTD` : String(y);
  return (
    <div className={cn(cardClass, "flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-[18px]")}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold">Datasets by deposit year</h3>
        <span className="text-muted-foreground text-[12.5px]">
          Repository metadata, or publication year as a fallback.
          {hasYtd ? ` ${currentYear} is year to date.` : ""}
        </span>
      </div>
      <div className="flex h-40 items-end gap-1.5 pt-4 sm:gap-2.5">
        {rows.map((r) => (
          <div
            key={r.year ?? "unknown"}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          >
            <span className="text-[12.5px] font-medium tabular-nums">
              {r.datasets.toLocaleString()}
            </span>
            <div
              className={cn(
                "w-full rounded-t",
                r.year === null
                  ? "bg-apollo-border-strong"
                  : inRange(r.year)
                    ? "bg-apollo-slate"
                    : "bg-apollo-surface-2",
              )}
              style={{
                height: `${Math.max(2, (r.datasets / max) * 100)}%`,
                backgroundImage:
                  r.year === currentYear
                    ? "repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,.35) 5px 8px)"
                    : undefined,
              }}
              title={`${label(r.year)}: ${r.datasets.toLocaleString()} datasets`}
            />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground flex gap-1.5 text-xs sm:gap-2.5" aria-hidden>
        {rows.map((r) => (
          <span key={r.year ?? "unknown"} className="min-w-0 flex-1 text-center">
            {label(r.year)}
          </span>
        ))}
      </div>
    </div>
  );
}

function RollupSection({
  report,
  doc,
  filters,
  currentYear,
}: {
  report: DataSharingReport;
  /** Built once in `DataSharingDashboard` (server side) and passed down —
   *  the Copy summary shortcut and the Methods section read the same doc. */
  doc: ReturnType<typeof buildMethodsDoc>;
  filters: DataSharingUiParams["filters"];
  currentYear: number;
}) {
  const { overall } = report;
  const sharePct = ratePct(overall.shareRateNumerator, overall.shareRateDenominator);
  const pmcPct = ratePct(overall.pmcCoveredPubs, overall.shareRateDenominator);
  return (
    <section id="rollup" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Institutional rollup"
        sub="Headline numbers for research leadership and grant reporting"
        actions={
          <>
            {/* Shortcut to the Methods section's "One paragraph for
                reporting" — same CopyButton + paragraph, not a second
                citation-text mechanism. */}
            <span className="text-apollo-slate inline-flex items-center gap-1 text-[13px]">
              <CopyButton value={doc.paragraph} label="Copy summary paragraph" />
              Copy summary
            </span>
            <DownloadLink
              href={withFilters("/edit/data-sharing/export", filters)}
              testId="ds-export-link"
            />
          </>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Kpi
          label="Distinct datasets"
          value={overall.datasets.toLocaleString()}
          sub={<DefinedTerm term="Strict floor">Strict floor</DefinedTerm>}
        />
        <Kpi
          label="Depositing faculty"
          value={overall.faculty.toLocaleString()}
          sub="with at least one deposit"
        />
        <Kpi
          label="Departments"
          value={report.byDepartment.length.toLocaleString()}
          sub="represented"
        />
        <Kpi
          label="Share rate"
          value={sharePct ?? "—"}
          testId="ds-share-rate"
          sub={
            sharePct === null
              ? "no confirmed first/last-author pubs in the corpus"
              : `${overall.shareRateNumerator.toLocaleString()} of ${overall.shareRateDenominator.toLocaleString()} confirmed first/last-author, full-time-faculty pubs since ${SHARE_RATE_YEAR_FLOOR}`
          }
        />
        {/* PMC coverage (collapsed to ONE card 2026-08-16): kept as a raw
            number, explicitly flagged as a known data-quality gap rather than
            presented as a working denominator — see `overall.pmcCoveredPubs`'s
            doc comment in the report lib. */}
        <Kpi
          label="In PMC"
          value={pmcPct ?? "—"}
          testId="ds-pmc"
          subClassName="text-apollo-amber"
          sub={
            <>
              {pmcPct !== null
                ? `${overall.pmcCoveredPubs.toLocaleString()} of ${overall.shareRateDenominator.toLocaleString()}. `
                : ""}
              Known data-quality gap; see{" "}
              <a href="#methods" className="underline">
                Methods
              </a>
            </>
          }
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] items-stretch gap-3.5">
        <DepositsByYearChart rows={report.byYear} filters={filters} currentYear={currentYear} />
        <div className={cn(cardClass, "flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-[18px]")}>
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[15px] font-semibold">Publications by repository risk tier</h3>
            <span className="text-muted-foreground text-[12.5px]">
              Host jurisdiction × access model. A publication with deposits in several tiers counts
              in each.
            </span>
          </div>
          <TierBars rows={report.pubsByTier} filters={filters} />
        </div>
      </div>
    </section>
  );
}

/** §2 as ONE table: access model (rows) × NIH funding (columns) with a Total
 *  column and a Publications total row — the four old stat cards' numbers
 *  (open/controlled/NIH/not-NIH publications) are its margins. An active NIH
 *  filter tints its column and mutes the other. */
function FundingSection({
  report,
  filters,
}: {
  report: DataSharingReport;
  filters: DataSharingUiParams["filters"];
}) {
  const { overall, accessFundingCrossTab: cross } = report;
  // Shared non-registry deposited-publication population both lenses are
  // built from — stated explicitly (2026-08-16 fix) so a reader doesn't
  // subtract this from the rollup denominator: DIFFERENT populations by
  // design, not a subset relationship.
  const sharedTotal = overall.nihFundedPubs + overall.notNihFundedPubs;
  const nih = filters.nihFunded;
  const colTint = (col: "nih" | "not") =>
    (col === "nih" && nih === true) || (col === "not" && nih === false)
      ? "bg-apollo-slate-tint"
      : "";
  const colMute = (col: "nih" | "not") =>
    (col === "nih" && nih === false) || (col === "not" && nih === true)
      ? "text-muted-foreground/60"
      : "";
  const rows: { label: string; nih: number; not: number; total: number; strong?: boolean }[] = [
    { label: "Open access", nih: cross.openNih, not: cross.openNotNih, total: overall.openPubs },
    {
      label: "Controlled access",
      nih: cross.controlledNih,
      not: cross.controlledNotNih,
      total: overall.controlledPubs,
    },
    {
      label: "Publications",
      nih: overall.nihFundedPubs,
      not: overall.notNihFundedPubs,
      total: sharedTotal,
      strong: true,
    },
  ];
  return (
    <section id="funding" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Funding & access"
        sub={`${sharedTotal.toLocaleString()} non-registry deposited publications: a broader population than the rollup share rate, not a subset of it`}
      />
      <div className={tableWrapClass}>
        <table className="w-full min-w-[480px] text-[15px]" data-testid="ds-funding-table">
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>
                <span className="sr-only">Access model</span>
              </th>
              <th className={cn(thClass, "text-right", colTint("nih"))}>NIH-funded</th>
              <th className={cn(thClass, "text-right", colTint("not"))}>Not NIH-funded</th>
              <th className={cn(thClass, "text-right")}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className={cn(
                  "border-apollo-border border-t first:border-t-0",
                  r.strong && "bg-apollo-page",
                )}
              >
                <th
                  scope="row"
                  className={cn(
                    tdClass,
                    "py-3 text-left",
                    r.strong ? "font-semibold" : "font-medium",
                  )}
                >
                  {r.label}
                </th>
                <td
                  className={cn(
                    tdClass,
                    "py-3 text-right tabular-nums",
                    colTint("nih"),
                    colMute("nih"),
                    r.strong && "font-semibold",
                  )}
                >
                  {r.nih.toLocaleString()}
                </td>
                <td
                  className={cn(
                    tdClass,
                    "py-3 text-right tabular-nums",
                    colTint("not"),
                    colMute("not"),
                    r.strong && "font-semibold",
                  )}
                >
                  {r.not.toLocaleString()}
                </td>
                <td className={cn(tdClass, "py-3 text-right font-semibold tabular-nums")}>
                  {r.total.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground max-w-[100ch] text-[12.5px] leading-normal">
        &ldquo;Not NIH-funded&rdquo; is not the same as non-federal: other federal funders (CDC, NSF
        and the like) aren&rsquo;t tracked separately and count here. A publication with deposits
        under both access models counts in each row, so rows can exceed the total.
      </p>
    </section>
  );
}

/** Sorts a copy of `byDepartment` — a plain server-side sort, not client
 *  state. `"shareRate"` sorts by the computed percentage (0 when the row has
 *  no denominator); `"name"` A–Z. Undefined `key` keeps the report's own
 *  datasets-desc order. */
function sortDepartments(
  rows: readonly DepartmentRollup[],
  key: DepartmentSortKey | undefined,
  dir: SortDir,
): DepartmentRollup[] {
  if (!key) return [...rows];
  if (key === "name") {
    const sorted = [...rows].sort((a, b) =>
      displayDepartmentName(a.department).localeCompare(displayDepartmentName(b.department)),
    );
    return dir === "desc" ? sorted.reverse() : sorted;
  }
  const rate = (d: DepartmentRollup) =>
    d.shareRateDenominator && d.shareRateDenominator > 0
      ? (d.shareRateNumerator ?? 0) / d.shareRateDenominator
      : 0;
  const value = (d: DepartmentRollup) =>
    key === "datasets" ? d.datasets : key === "faculty" ? d.faculty : rate(d);
  const sorted = [...rows].sort((a, b) => value(a) - value(b));
  return dir === "desc" ? sorted.reverse() : sorted;
}

/** Same shape as `sortDepartments`, over `byFaculty`. `"concerning"` sorts by
 *  `concerningDeposits` (the union column, same one the table shows). */
function sortFaculty(
  rows: readonly NamedFacultyRow[],
  key: FacultySortKey | undefined,
  dir: SortDir,
): NamedFacultyRow[] {
  if (!key) return [...rows];
  const rate = (f: NamedFacultyRow) =>
    f.shareRateDenominator && f.shareRateDenominator > 0
      ? (f.shareRateNumerator ?? 0) / f.shareRateDenominator
      : 0;
  const value = (f: NamedFacultyRow) =>
    key === "datasets" ? f.datasets : key === "concerning" ? f.concerningDeposits : rate(f);
  const sorted = [...rows].sort((a, b) => value(a) - value(b));
  return dir === "desc" ? sorted.reverse() : sorted;
}

function RepositoriesSection({
  report,
  ui,
}: {
  report: DataSharingReport;
  ui: DataSharingUiParams;
}) {
  // Contradiction check (2026-08-16 review): does any repository's
  // tier-implied access model disagree with its actually-observed Access
  // column? Synapse (the original trigger) is resolved by #2471's
  // access-aware `effectiveTierOf`; kept as a general safety net.
  const tierAccessMismatch = report.byRepository.some((r) => {
    const tierImpliesOpen = TIER_LABELS[r.tier]?.includes("open");
    const tierImpliesControlled = TIER_LABELS[r.tier]?.includes("controlled");
    return (
      (tierImpliesOpen && r.accessModel === "controlled") ||
      (tierImpliesControlled && r.accessModel === "open")
    );
  });
  return (
    <section id="repos" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Repositories"
        sub="For the library / RDM team: DMS training and repository support"
        actions={
          <DownloadLink href={withFilters("/edit/data-sharing/export?section=tiers", ui.filters)} />
        }
      />
      <div className={cn(cardClass, "overflow-hidden")} data-testid="ds-repo-tiers">
        {report.byRepositoryTier.map((t) => {
          // Per-repo counts inline, from byRepository (already datasets-desc).
          // Each repo name links out via `urlOf`; the count is SPS's number.
          const repos = report.byRepository.filter((r) => r.tier === t.tier);
          // Zero rows arrive from the report on purpose (`paddedTiers`):
          // "Country of concern · 0" is a deliberate compliance statement.
          return (
            <div
              key={t.tier}
              className={cn(
                "border-apollo-border grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2 border-t px-4 py-3 first:border-t-0 sm:grid-cols-[190px_minmax(0,1fr)_60px] sm:px-[18px]",
                !tierInFilter(ui.filters, t.tier) && "opacity-35",
              )}
            >
              <span className="inline-flex items-center gap-[7px] text-sm font-medium">
                <TierDot tier={t.tier} />
                <TierLabel tier={t.tier} />
              </span>
              <span
                className={cn(
                  "text-right text-[15px] font-semibold tabular-nums sm:order-last",
                  t.datasets === 0 && "text-muted-foreground",
                )}
              >
                {t.datasets.toLocaleString()}
              </span>
              <div className="col-span-2 flex flex-wrap gap-1.5 sm:col-span-1">
                {repos.length === 0 ? (
                  <span className="text-muted-foreground text-[13px]">None detected</span>
                ) : (
                  repos.map((r) => {
                    const url = urlOf(r.repository);
                    const pill =
                      "border-apollo-border-strong bg-apollo-page inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px]";
                    const inner = (
                      <>
                        {r.repository}
                        <span className="text-muted-foreground tabular-nums">
                          {r.datasets.toLocaleString()}
                        </span>
                      </>
                    );
                    return url ? (
                      <a
                        key={r.repository}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(pill, "hover:text-apollo-slate")}
                      >
                        {inner}
                      </a>
                    ) : (
                      <span key={r.repository} className={pill}>
                        {inner}
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground max-w-[100ch] text-[12.5px] leading-normal">
        Tier is by host and access model only. It doesn&rsquo;t fold in sensitive-data-type
        detection; see{" "}
        <a href="#subtypes" className="underline">
          Sub-types
        </a>{" "}
        for that lens.
      </p>

      {/* The per-repository table (observed access model + a per-repository
          items CSV) predates this layout; kept behind a disclosure so the
          tier card leads. */}
      <details className="group">
        <summary className="text-apollo-slate cursor-pointer text-[13px] hover:underline">
          All {report.byRepository.length.toLocaleString()} repositories: access model and items
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap justify-end gap-x-3.5">
            <DownloadLink
              href={withFilters("/edit/data-sharing/export?section=repositories", ui.filters)}
            />
            <DownloadLink
              href={withFilters(
                "/edit/data-sharing/export?section=repositories&grain=items",
                ui.filters,
              )}
              label="Items CSV"
            />
          </div>
          <div className={tableWrapClass}>
            <table className="w-full min-w-[560px] text-sm" data-testid="ds-repo-table">
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Repository</th>
                  <th className={thClass}>Tier</th>
                  <th className={thClass}>Access</th>
                  <th className={cn(thClass, "text-right")}>Datasets</th>
                  <th className={thClass}>
                    <span className="sr-only">Items</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.byRepository.map((r) => {
                  const url = urlOf(r.repository);
                  return (
                    <tr key={r.repository} className={rowClass}>
                      <td className={cn(tdClass, "font-medium")}>
                        {url ? <ExternalA href={url}>{r.repository}</ExternalA> : r.repository}
                      </td>
                      <td className={tdClass}>
                        <TierChip tier={r.tier} />
                      </td>
                      <td className={tdClass}>
                        <AccessChip accessModel={r.accessModel} />
                      </td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>
                        {r.datasets.toLocaleString()}
                      </td>
                      <td className={cn(tdClass, "text-right")}>
                        <DownloadLink
                          href={withFilters(
                            `/edit/data-sharing/export?section=repositories&grain=items&repository=${encodeURIComponent(r.repository)}`,
                            ui.filters,
                          )}
                          label="Items"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {tierAccessMismatch && (
            <p className="text-muted-foreground text-[12.5px]">
              Tier is the shared risk catalog&apos;s platform-level classification (host
              jurisdiction × typical access model), not a per-deposit fact — a repository&apos;s
              Access column (the actually observed access model on WCM&apos;s deposits there) can
              disagree with what its tier name implies, e.g. a repository tiered &ldquo;open&rdquo;
              whose WCM deposits observed today are all controlled.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

/** Colors for the department access-mix bar and its legend — the tier
 *  palette's US hues plus the registry grey, so "open"/"controlled" read the
 *  same as the tier dots elsewhere on the page. */
const MIX = [
  { key: "open", label: "Open", color: TIER_COLORS.US_OPEN },
  { key: "controlled", label: "Controlled", color: TIER_COLORS.US_CTRL },
  { key: "registry", label: "Registry", color: TIER_COLORS.REGISTRY },
] as const;

/** Rows visible before "Show all" in the department table. */
const DEPARTMENT_ROWS_SHOWN = 12;

function DepartmentsSection({
  report,
  ui,
}: {
  report: DataSharingReport;
  ui: DataSharingUiParams;
}) {
  const otherParams = {
    ...filterQueryParams(ui.filters),
    facSort: ui.facSort,
    facDir: ui.facDir,
    facPage: ui.facPage,
  };
  const sorted = sortDepartments(report.byDepartment, ui.deptSort, ui.deptDir);
  const sortLabel =
    ui.deptSort === "name"
      ? "Sorted by name"
      : ui.deptSort === "faculty"
        ? "Sorted by faculty"
        : ui.deptSort === "shareRate"
          ? "Sorted by share rate"
          : "Sorted by datasets";
  const sortTh = (
    label: string,
    sortKey: DepartmentSortKey,
    align: "left" | "right",
    title?: string,
  ) => (
    <SortableTh
      label={label}
      sortKey={sortKey}
      activeSort={ui.deptSort ?? "datasets"}
      activeDir={ui.deptDir}
      otherParams={otherParams}
      sortParamName="deptSort"
      dirParamName="deptDir"
      align={align}
      title={title}
    />
  );
  return (
    <section id="departments" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Departments"
        sub={`${sortLabel}. Click a column to sort.`}
        actions={
          <>
            <DownloadLink
              href={withFilters("/edit/data-sharing/export?section=departments", ui.filters)}
            />
            <DownloadLink
              href={withFilters(
                "/edit/data-sharing/export?section=departments&grain=items",
                ui.filters,
              )}
              label="Items CSV"
            />
          </>
        }
      />
      <div className={tableWrapClass}>
        <table className="w-full min-w-[620px] text-sm" data-testid="ds-dept-table">
          <thead className={theadClass}>
            <tr>
              {sortTh("Department", "name", "left")}
              {sortTh("Datasets", "datasets", "right")}
              {sortTh("Faculty", "faculty", "right", "Depositing faculty")}
              <th className={thClass} title="Open, controlled, registry">
                Access mix
              </th>
              {sortTh(
                "Share rate",
                "shareRate",
                "right",
                "Confirmed first/last-authored full-time-faculty pubs with a detected deposit",
              )}
              <th className={thClass}>
                <span className="sr-only">Items</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <ShowMoreRows initial={DEPARTMENT_ROWS_SHOWN} colSpan={6}>
              {sorted.map((d) => {
                const counts = {
                  open: d.openDatasets,
                  controlled: d.controlledDatasets,
                  registry: d.registryDatasets,
                };
                const tot = Math.max(1, d.openDatasets + d.controlledDatasets + d.registryDatasets);
                const mixText = `${d.openDatasets.toLocaleString()} open · ${d.controlledDatasets.toLocaleString()} controlled · ${d.registryDatasets.toLocaleString()} registry`;
                return (
                  <tr key={d.department} className={rowClass}>
                    <td className={cn(tdClass, "font-medium [overflow-wrap:anywhere]")}>
                      {displayDepartmentName(d.department)}
                    </td>
                    <td className={cn(tdClass, "text-right font-semibold tabular-nums")}>
                      {d.datasets.toLocaleString()}
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {d.faculty.toLocaleString()}
                    </td>
                    <td className={cn(tdClass, "w-[22%] min-w-[90px]")}>
                      <div
                        className="bg-apollo-surface-2 flex h-2 overflow-hidden rounded-full"
                        title={mixText}
                        aria-hidden
                      >
                        {MIX.map((m) => (
                          <div
                            key={m.key}
                            style={{
                              width: `${(counts[m.key] / tot) * 100}%`,
                              backgroundColor: m.color,
                            }}
                          />
                        ))}
                      </div>
                      <span className="sr-only">{mixText}</span>
                    </td>
                    <td className={cn(tdClass, "text-right")}>
                      <ShareRateCell
                        numerator={d.shareRateNumerator}
                        denominator={d.shareRateDenominator}
                      />
                    </td>
                    <td className={cn(tdClass, "text-right")}>
                      <DownloadLink
                        href={withFilters(
                          `/edit/data-sharing/export?section=departments&grain=items&department=${encodeURIComponent(d.department)}`,
                          ui.filters,
                        )}
                        label="Items"
                        className="text-apollo-slate text-xs hover:underline"
                      />
                    </td>
                  </tr>
                );
              })}
            </ShowMoreRows>
          </tbody>
        </table>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px]">
        {MIX.map((m) => (
          <span key={m.key} className="inline-flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: m.color }}
              aria-hidden
            />
            {m.label}
          </span>
        ))}
      </div>
      <details className="group">
        <summary className="text-apollo-slate cursor-pointer text-[12.5px] hover:underline">
          Why these don&rsquo;t add up
        </summary>
        <div
          className={cn(
            cardClass,
            "text-apollo-ink-2 mt-2 flex flex-col gap-1.5 rounded-[10px] px-4 py-3 text-[13px] leading-relaxed",
          )}
        >
          <p>
            Department counts don&rsquo;t sum to the institutional total: a dataset with co-authors
            in two departments counts once in each. Open, Controlled and Registry don&rsquo;t sum to
            Datasets either; a deposit with no recorded access model is in none.
          </p>
          <p>
            Datasets and depositing faculty count whoever holds the deposit. Share rate counts
            whoever confirmed first/last authorship of the underlying publication — different scopes
            on purpose. A publication can show a detected deposit even when the depositing scholar
            is a co-author in a different department, so a department can show a nonzero share rate
            with zero datasets of its own, or datasets with a 0% share rate. Neither is an error.
          </p>
        </div>
      </details>
    </section>
  );
}

/** Fixed caption text for the Concerning/Foreign-hosted columns — matches the
 *  SPEC's "Amended 08-13" caveat framing exactly. Don't soften or drop this;
 *  it's the boundary between the tier-only flag actually shipped here and the
 *  fuller 3-way "concerning" definition the SPEC defers. */
const CONCERNING_CAVEAT =
  "Tier-based only — country-of-concern host or foreign-hosted repository; does not include sensitive data-type detection.";

function FacultySection({ report, ui }: { report: DataSharingReport; ui: DataSharingUiParams }) {
  const sorted = sortFaculty(report.byFaculty, ui.facSort, ui.facDir);
  const totalPages = Math.max(1, Math.ceil(sorted.length / FACULTY_ROW_CAP));
  // Clamped, not raw `ui.facPage` (2026-08-16 adversarial-review finding): a
  // stale facPage past the end falls back to the last real page.
  const facPage = Math.min(Math.max(ui.facPage, 1), totalPages);
  const start = (facPage - 1) * FACULTY_ROW_CAP;
  const rows = sorted.slice(start, start + FACULTY_ROW_CAP);
  // Includes facSort/facDir too: the Prev/Next links use this SAME object and
  // have no sort override (2026-08-16 adversarial-review finding).
  const otherParams = {
    ...filterQueryParams(ui.filters),
    deptSort: ui.deptSort,
    deptDir: ui.deptDir,
    facSort: ui.facSort,
    facDir: ui.facDir,
  };
  // Concerning == Foreign-hosted by construction while country-of-concern is
  // 0 institution-wide (2026-08-16 review): collapse to one column; the split
  // comes back automatically once a CONCERN-tier deposit is detected.
  const hasCountryOfConcern = report.byRepositoryTier.some(
    (t) => t.tier === "CONCERN" && t.datasets > 0,
  );
  const zeroInk = (n: number) => (n === 0 ? "text-muted-foreground/60" : "");
  return (
    <section id="faculty" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Faculty"
        sub={
          <>
            {sorted.length.toLocaleString()} depositing faculty. &ldquo;Concerning&rdquo; =
            country-of-concern host or foreign-hosted repository (tier-based only; no sensitive
            data-type detection).
          </>
        }
        actions={
          <>
            <DownloadLink
              href={withFilters("/edit/data-sharing/export?section=faculty", ui.filters)}
            />
            <DownloadLink
              href={withFilters(
                "/edit/data-sharing/export?section=faculty&grain=items",
                ui.filters,
              )}
              label="Items CSV"
            />
          </>
        }
      />
      <div className={tableWrapClass}>
        <table className="w-full min-w-[720px] text-sm" data-testid="ds-faculty-table">
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Faculty</th>
              <th className={thClass}>Department</th>
              <SortableTh
                label="Datasets"
                sortKey="datasets"
                activeSort={ui.facSort}
                activeDir={ui.facDir}
                otherParams={otherParams}
                sortParamName="facSort"
                dirParamName="facDir"
              />
              <th className={cn(thClass, "text-right")}>Open</th>
              <th className={cn(thClass, "text-right")} title="Controlled">
                Ctrl.
              </th>
              <th className={cn(thClass, "text-right")}>
                {/* "Concerning", not "Country of concern": this column counts
                    the union of the highest-severity tiers. The hover carries
                    the tier-only caveat (SPEC "Amended 08-13"). */}
                <DefinedTerm term="Concerning" caveat={CONCERNING_CAVEAT}>
                  Concerning
                </DefinedTerm>
              </th>
              {hasCountryOfConcern && (
                <th className={cn(thClass, "text-right")}>
                  {/* Neutral "Foreign-hosted" glossary entry: this column
                      SUMS both FOREIGN_OPEN and FOREIGN_CTRL instances. */}
                  <DefinedTerm term="Foreign-hosted" caveat={CONCERNING_CAVEAT}>
                    Foreign-hosted
                  </DefinedTerm>
                </th>
              )}
              <SortableTh
                label="Share rate"
                sortKey="shareRate"
                activeSort={ui.facSort}
                activeDir={ui.facDir}
                otherParams={otherParams}
                sortParamName="facSort"
                dirParamName="facDir"
              />
              <th className={thClass}>
                <span className="sr-only">Items</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.cwid} className={rowClass}>
                <td className={cn(tdClass, "font-medium")}>
                  <ScholarHoverCard cwid={f.cwid}>
                    <Link
                      href={`/scholar/${f.slug}`}
                      className="hover:text-apollo-slate hover:underline"
                    >
                      {f.name}
                    </Link>
                  </ScholarHoverCard>
                </td>
                <td className={cn(tdClass, "text-muted-foreground text-[13px]")}>
                  {f.department ? displayDepartmentName(f.department) : "—"}
                </td>
                <td className={cn(tdClass, "text-right font-semibold tabular-nums")}>
                  {f.datasets.toLocaleString()}
                </td>
                <td className={cn(tdClass, "text-right tabular-nums", zeroInk(f.openDatasets))}>
                  {f.openDatasets.toLocaleString()}
                </td>
                <td
                  className={cn(tdClass, "text-right tabular-nums", zeroInk(f.controlledDatasets))}
                >
                  {f.controlledDatasets.toLocaleString()}
                </td>
                <td
                  className={cn(
                    tdClass,
                    "text-right tabular-nums",
                    f.concerningDeposits > 0 ? "text-apollo-amber font-semibold" : zeroInk(0),
                  )}
                >
                  {f.concerningDeposits.toLocaleString()}
                </td>
                {hasCountryOfConcern && (
                  <td
                    className={cn(
                      tdClass,
                      "text-right tabular-nums",
                      zeroInk(f.foreignHostedDeposits),
                    )}
                  >
                    {f.foreignHostedDeposits.toLocaleString()}
                  </td>
                )}
                <td className={cn(tdClass, "text-right")}>
                  <ShareRateCell
                    numerator={f.shareRateNumerator}
                    denominator={f.shareRateDenominator}
                  />
                </td>
                <td className={cn(tdClass, "text-right")}>
                  <DownloadLink
                    href={withFilters(
                      `/edit/data-sharing/export?section=faculty&grain=items&cwid=${encodeURIComponent(f.cwid)}`,
                      ui.filters,
                    )}
                    label="Items"
                    className="text-apollo-slate text-xs hover:underline"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-apollo-border bg-apollo-page text-muted-foreground flex min-w-[720px] items-center justify-between gap-3 border-t px-[18px] py-2.5 text-[13px]">
          <span>
            Page {facPage} of {totalPages}
          </span>
          <span className="flex gap-4">
            {facPage > 1 && (
              <a
                href={buildQuery({ ...otherParams, facPage: facPage - 1 })}
                className="text-apollo-slate hover:underline"
              >
                ← Previous
              </a>
            )}
            {facPage < totalPages && (
              <a
                href={buildQuery({ ...otherParams, facPage: facPage + 1 })}
                className="text-apollo-slate hover:underline"
              >
                Next →
              </a>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}

/** Display label per coarse sensitive category — the `sensitiveSubtypes`
 *  category prefix. Falls through to the raw category string. */
const SUBTYPE_CATEGORY_LABELS: Record<string, string> = {
  genomic: "Genomic",
  omic_other: "Other ’omic",
  health: "Health data",
  biometric: "Biometric",
  geolocation: "Geolocation",
};

function SubtypesSection({
  report,
  filters,
}: {
  report: DataSharingReport;
  filters: DataSharingUiParams["filters"];
}) {
  if (report.bySubtype.length === 0) return null;
  // One card per coarse category, biggest first; sub-types biggest first.
  const groups = new Map<string, { subtype: string; count: number }[]>();
  for (const s of report.bySubtype) {
    const g = groups.get(s.category) ?? [];
    g.push({ subtype: s.subtype, count: s.count });
    groups.set(s.category, g);
  }
  const cards = [...groups.entries()]
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => b.count - a.count),
      total: items.reduce((a, x) => a + x.count, 0),
    }))
    .sort((a, b) => b.total - a.total);
  const { subtypeClassifiedInstances: classified, links } = report.overall;
  const pct = ratePct(classified, links);
  return (
    <section id="subtypes" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Sensitive data sub-types"
        sub="Deposit instances, not distinct datasets"
        actions={
          <>
            <DownloadLink
              href={withFilters("/edit/data-sharing/export?section=subtypes", filters)}
            />
            <DownloadLink
              href={withFilters("/edit/data-sharing/export?section=subtypes&grain=items", filters)}
              label="Items CSV"
            />
          </>
        }
      />
      <div className="bg-apollo-amber-tint border-apollo-amber-tint-border flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-[10px] border px-3 py-2 text-[13px]">
        <span className="text-apollo-amber font-semibold whitespace-nowrap">
          Floor, not a census
        </span>
        <span>
          Only {classified.toLocaleString()} of {links.toLocaleString()} deposit instances
          {pct ? ` (${pct})` : ""} carry any sub-type at all. A deposit spanning several sub-types
          counts once in each.
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] items-start gap-3">
        {cards.map((g) => {
          const max = Math.max(1, ...g.items.map((x) => x.count));
          return (
            <div key={g.category} className={cn(cardClass, "flex flex-col gap-2 px-4 py-3.5")}>
              <div className="flex items-baseline justify-between">
                <h3 className="text-[14.5px] font-semibold">
                  {SUBTYPE_CATEGORY_LABELS[g.category] ?? g.category}
                </h3>
                <span className="text-muted-foreground text-[13px] tabular-nums">
                  {g.total.toLocaleString()}
                </span>
              </div>
              {g.items.map((s) => (
                <div
                  key={s.subtype}
                  className="grid grid-cols-[minmax(0,1fr)_34px] items-center gap-2 text-[13px]"
                >
                  <div className="relative overflow-hidden rounded px-1.5 py-0.5">
                    <div
                      className="bg-apollo-slate-tint absolute inset-y-0 left-0"
                      style={{ width: `${(s.count / max) * 100}%` }}
                      aria-hidden
                    />
                    <DownloadLink
                      href={withFilters(
                        `/edit/data-sharing/export?section=subtypes&grain=items&category=${encodeURIComponent(g.category)}&subtype=${encodeURIComponent(s.subtype)}`,
                        filters,
                      )}
                      label={s.subtype}
                      title="Download this sub-type's items CSV"
                      className="hover:text-apollo-slate relative hover:underline"
                    />
                  </div>
                  <span className="text-right font-medium tabular-nums">
                    {s.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RecentDepositsSection({
  report,
  filters,
}: {
  report: DataSharingReport;
  filters: DataSharingUiParams["filters"];
}) {
  return (
    <section id="recent" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Recent deposits"
        sub="One row per person–dataset link, newest deposit year first"
        // Item grain — the default (no-section) export IS this table, in full.
        actions={<DownloadLink href={withFilters("/edit/data-sharing/export", filters)} />}
      />
      <div className={tableWrapClass}>
        <table className="w-full min-w-[760px] text-[13.5px]" data-testid="ds-recent-table">
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Dataset</th>
              <th className={thClass}>Title · type</th>
              <th className={thClass}>Publication</th>
              <th className={thClass}>Tier</th>
              <th className={cn(thClass, "text-right")}>Year</th>
            </tr>
          </thead>
          <tbody>
            {report.recentItems.map((r) => {
              const url = urlOf(r.repository);
              // Per-accession deep link via the profile Datasets section's own
              // resolver; unresolvable → plain text.
              const accessionUrl = r.accessionOrDoi
                ? resolveDatasetUrl({ repository: r.repository, accessionOrDoi: r.accessionOrDoi })
                : null;
              const subtypeLabels = parseSensitiveSubtypes(r.sensitiveSubtypes).map(
                (s) => s.subtype,
              );
              const typeLine = [r.dataType ?? r.resourceType, ...subtypeLabels]
                .filter(Boolean)
                .join(" · ");
              return (
                // (cwid, datasetId) is PersonDatasetDeposit's own primary key.
                <tr key={`${r.datasetId}|${r.cwid}`} className={cn(rowClass, "align-top")}>
                  <td className={cn(tdClass, "py-2.5")}>
                    <div className="flex min-w-0 flex-col gap-px">
                      <span className="font-medium">
                        {url ? <ExternalA href={url}>{r.repository}</ExternalA> : r.repository}
                      </span>
                      {r.accessionOrDoi ? (
                        accessionUrl ? (
                          <ExternalA
                            href={accessionUrl}
                            className="text-apollo-slate font-mono text-xs [overflow-wrap:anywhere]"
                          >
                            {displayAccession(r.repository, r.accessionOrDoi)}
                          </ExternalA>
                        ) : (
                          <span className="font-mono text-xs [overflow-wrap:anywhere]">
                            {displayAccession(r.repository, r.accessionOrDoi)}
                          </span>
                        )
                      ) : null}
                    </div>
                  </td>
                  <td className={cn(tdClass, "max-w-xs py-2.5")}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {/* Truncated with a native title= for the full text
                          (long ClinicalTrials.gov titles blew row heights). */}
                      <span
                        className={cn("line-clamp-2", !r.title && "text-muted-foreground")}
                        title={r.title ?? undefined}
                      >
                        {r.title || "Untitled in repository metadata"}
                      </span>
                      {typeLine ? (
                        <span className="text-muted-foreground text-[12.5px]">{typeLine}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className={cn(tdClass, "py-2.5")}>
                    <div className="flex flex-col gap-0.5">
                      {/* Citing pubs for this (person, dataset) link — the only
                          table naming specific publications. */}
                      {r.pmids?.length ? (
                        <span className="font-mono text-xs">
                          {r.pmids.map((p, i) => (
                            <span key={p} className="whitespace-nowrap">
                              {i > 0 && ", "}
                              <ExternalA
                                href={`https://pubmed.ncbi.nlm.nih.gov/${p}/`}
                                className="text-apollo-slate"
                              >
                                {`PMID ${p}`}
                              </ExternalA>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <span className="text-muted-foreground text-[12.5px]">
                        <Link href={`/scholar/${r.scholarSlug}`} className="hover:underline">
                          {r.scholarName}
                        </Link>
                        {r.department ? ` · ${displayDepartmentName(r.department)}` : ""}
                      </span>
                    </div>
                  </td>
                  <td className={cn(tdClass, "py-2.5")}>
                    <TierChip tier={effectiveTierOf(r)} />
                  </td>
                  <td
                    className={cn(tdClass, "text-muted-foreground py-2.5 text-right tabular-nums")}
                  >
                    {r.depositYear ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="border-apollo-border bg-apollo-page text-muted-foreground min-w-[760px] border-t px-[18px] py-2.5 text-[12.5px]">
          Deposit year is the only per-item recency signal. Every row carries the same weekly sync
          time, so this week&rsquo;s finds and older ones look alike.
        </p>
      </div>
    </section>
  );
}

/** The three COC-coauthor placeholder cards — one list so they can't drift
 *  while they wait on the same missing input. */
const COC_PENDING_CARDS = [
  "Pubs with a COC-affiliated coauthor",
  "Combined exposure",
  "Faculty on COC-coauthor pubs",
];
const COC_PULL_PENDING = "Needs the country-of-concern coauthor pull";

/** Compliance view: one real number — `overall.concerningDepositInstances` —
 *  beside three placeholder cards (dashed, "Pending") that stay until the
 *  country-of-concern coauthor pull is ingested; the stakeholder wants the
 *  section's shape present before the data exists. The closing caveat is the
 *  section's point as much as the numbers — a flag here locates a QUESTION,
 *  it never determines a violation; don't drop or soften it. */
function ComplianceSection({ report }: { report: DataSharingReport }) {
  return (
    <section id="compliance" className="flex scroll-mt-32 flex-col gap-3.5">
      <SectionHead
        title="Compliance"
        sub="Where the DOJ Bulk Data Rule covered-person-access question could arise. A screening lens, not a determination."
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3">
        <div className={cn(cardClass, "flex flex-col gap-1 px-4 py-3.5")}>
          <span className="text-muted-foreground text-xs font-medium tracking-[.08em] uppercase">
            Concerning deposit instances
          </span>
          <span
            className="text-[28px] leading-tight font-semibold tabular-nums"
            data-testid="ds-concerning"
          >
            {report.overall.concerningDepositInstances.toLocaleString()}
          </span>
          <span className="text-muted-foreground text-[12.5px] leading-snug">
            Country-of-concern or foreign-hosted repository. Tier-derived only; instances, not
            distinct datasets.
          </span>
        </div>
        {COC_PENDING_CARDS.map((label) => (
          <div
            key={label}
            aria-disabled="true"
            data-pending="true"
            className="border-apollo-border-strong flex flex-col gap-1 rounded-[13px] border border-dashed px-4 py-3.5"
          >
            <span className="text-muted-foreground text-xs font-medium tracking-[.08em] uppercase">
              {label}
            </span>
            <span className="text-muted-foreground mt-1 text-[13px]">
              <span className="bg-apollo-surface-2 mr-1.5 rounded px-1.5 py-px text-[11px] font-semibold tracking-[.06em]">
                PENDING
              </span>
              {COC_PULL_PENDING}
            </span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground max-w-[100ch] text-[12.5px] leading-normal">
        A concerning flag or a COC-affiliated coauthor marks where the question arises. It is not a
        violation determination: much academic collaboration is exempt, and each case needs a look
        at actual access and transaction type.
      </p>
    </section>
  );
}

/** Tier codes offered as filter chips, in severity order — `UNKNOWN` excluded
 *  (a port-lag bucket, not a real filterable category). */
const FILTERABLE_TIERS = [
  "CONCERN",
  "FOREIGN_OPEN",
  "FOREIGN_CTRL",
  "US_OPEN",
  "US_CTRL",
  "REGISTRY",
] as const;

const segGroupClass = "bg-apollo-surface-2 border-apollo-border flex rounded-lg border p-[3px]";
function segClass(on: boolean): string {
  return cn(
    "rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap",
    on
      ? "bg-apollo-surface text-foreground shadow-[0_1px_2px_rgba(34,30,28,.12)]"
      : "text-muted-foreground hover:text-foreground",
  );
}

/** "2020–26". */
function yearSpan(from: number, to: number): string {
  return `${from}–${String(to).slice(-2)}`;
}

/** Filter bar (sticky at `lg`): Deposit-years presets, NIH funding, tier
 *  chips — each a plain GET link to the same page with that one filter
 *  changed (every other filter and both tables' sorts preserved; the faculty
 *  page resets, since the row count under a new filter makes it
 *  meaningless). The typed from/to year range is kept behind "Custom" as the
 *  same plain GET form it always was. No client state anywhere. */
function FilterBar({
  ui,
  bounds,
}: {
  ui: DataSharingUiParams;
  /** True min/max deposit year across the FULL corpus — the presets' span,
   *  and each custom year input's ghost text + native min/max clamp (null
   *  when no row carries a depositYear). */
  bounds: DataSharingReport["depositYearBounds"];
}) {
  const f = ui.filters;
  const sortParams = {
    deptSort: ui.deptSort,
    deptDir: ui.deptDir,
    facSort: ui.facSort,
    facDir: ui.facDir,
  };
  const hrefWith = (next: DataSharingUiParams["filters"]) =>
    buildQuery({ ...filterQueryParams(next), ...sortParams }) || "?";
  const active = hasActiveFilters(f);

  const presets: { label: string; yearFrom: number | undefined }[] = [];
  if (bounds) {
    presets.push({ label: yearSpan(bounds.min, bounds.max), yearFrom: undefined });
    for (const back of [4, 2]) {
      const from = bounds.max - back;
      if (from > bounds.min) presets.push({ label: yearSpan(from, bounds.max), yearFrom: from });
    }
  }
  const presetActive = (p: { yearFrom: number | undefined }) =>
    f.yearTo === undefined && f.yearFrom === p.yearFrom;
  const customActive =
    (f.yearFrom !== undefined || f.yearTo !== undefined) && !presets.some(presetActive);

  const toggleTier = (tier: string) => {
    const cur = f.tiers ?? [];
    const next = cur.includes(tier) ? cur.filter((t) => t !== tier) : [...cur, tier];
    return hrefWith({ ...f, tiers: next.length ? next : undefined });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="ds-filter-bar">
      <div className="bg-apollo-page/95 border-apollo-border-strong z-10 -mx-1 flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b px-1 py-2.5 backdrop-blur-sm lg:sticky lg:top-14">
        <span className="text-muted-foreground text-[13px]">Deposit years</span>
        <div className={segGroupClass} role="group" aria-label="Deposit years">
          {presets.map((p) => (
            <a
              key={p.label}
              href={hrefWith({ ...f, yearFrom: p.yearFrom, yearTo: undefined })}
              className={segClass(presetActive(p))}
              aria-current={presetActive(p) ? "true" : undefined}
            >
              {p.label}
            </a>
          ))}
          <details className="relative">
            <summary
              className={cn(
                segClass(customActive),
                "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
              )}
            >
              {customActive
                ? yearSpan(f.yearFrom ?? bounds?.min ?? 0, f.yearTo ?? bounds?.max ?? 0)
                : "Custom"}
            </summary>
            <form
              method="get"
              className="border-apollo-border-strong bg-apollo-surface absolute top-[calc(100%+6px)] left-0 z-20 flex w-max items-end gap-2 rounded-[10px] border p-3 text-xs shadow-md"
            >
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">From</span>
                <input
                  type="number"
                  name="yearFrom"
                  defaultValue={f.yearFrom}
                  placeholder={bounds ? String(bounds.min) : undefined}
                  min={bounds?.min}
                  max={bounds?.max}
                  className="border-apollo-border-strong w-20 rounded border px-2 py-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">To</span>
                <input
                  type="number"
                  name="yearTo"
                  defaultValue={f.yearTo}
                  placeholder={bounds ? String(bounds.max) : undefined}
                  min={bounds?.min}
                  max={bounds?.max}
                  className="border-apollo-border-strong w-20 rounded border px-2 py-1"
                />
              </label>
              {/* Carry every other filter and both sorts across the submit. */}
              {f.tiers?.map((t) => (
                <input key={t} type="hidden" name="tier" value={t} />
              ))}
              {f.nihFunded !== undefined && (
                <input type="hidden" name="nihFunded" value={String(f.nihFunded)} />
              )}
              {ui.deptSort && <input type="hidden" name="deptSort" value={ui.deptSort} />}
              <input type="hidden" name="deptDir" value={ui.deptDir} />
              {ui.facSort && <input type="hidden" name="facSort" value={ui.facSort} />}
              <input type="hidden" name="facDir" value={ui.facDir} />
              <button
                type="submit"
                className="border-apollo-border-strong hover:bg-apollo-surface-2 rounded border px-3 py-1.5"
              >
                Apply
              </button>
            </form>
          </details>
        </div>

        <span className="text-muted-foreground text-[13px]">NIH</span>
        <div className={segGroupClass} role="group" aria-label="NIH funding">
          {(
            [
              [undefined, "Any"],
              [true, "NIH-funded"],
              [false, "Not NIH"],
            ] as const
          ).map(([value, label]) => (
            <a
              key={label}
              href={hrefWith({ ...f, nihFunded: value })}
              className={segClass(f.nihFunded === value)}
              aria-current={f.nihFunded === value ? "true" : undefined}
              data-nih={value === undefined ? "any" : String(value)}
            >
              {label}
            </a>
          ))}
        </div>

        <span className="text-muted-foreground text-[13px]">Tier</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Tier">
          {FILTERABLE_TIERS.map((tier) => {
            const on = !!f.tiers?.includes(tier);
            return (
              <a
                key={tier}
                href={toggleTier(tier)}
                title={TIER_LABELS[tier]}
                aria-current={on ? "true" : undefined}
                data-tier={tier}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] whitespace-nowrap",
                  on ? "border-apollo-slate bg-apollo-surface" : "border-apollo-border-strong",
                  !tierInFilter(f, tier) && "opacity-45",
                )}
              >
                <TierDot tier={tier} />
                {TIER_SHORT_LABELS[tier]}
              </a>
            );
          })}
        </div>

        {active && (
          <Link
            href="/edit/data-sharing"
            className="text-apollo-slate ml-auto text-[13px] hover:underline"
          >
            Clear filters
          </Link>
        )}
      </div>
      {active && (
        <p className="text-muted-foreground text-xs leading-normal">
          Narrows the datasets/repositories/faculty/tier tables below, and the funding totals. Every
          CSV download on this page (aggregate and per-row items alike) narrows the same way. Share
          rate and PMC coverage stay institution-wide on purpose: pairing a filtered numerator with
          the unfiltered denominator would read as sharing collapsing when nothing changed.
        </p>
      )}
    </div>
  );
}

export function DataSharingDashboard({
  report,
  ui,
  currentYear = new Date().getFullYear(),
}: {
  report: DataSharingReport;
  ui: DataSharingUiParams;
  /** The year the YTD bar marks — injectable for tests. */
  currentYear?: number;
}) {
  // Built once: the Copy summary shortcut and the Methods section share it.
  const doc = buildMethodsDoc(report, { shareRateYearFloor: SHARE_RATE_YEAR_FLOOR });
  const { overall } = report;
  const railItems: RailItem[] = [
    { id: "rollup", label: "Rollup", stat: overall.datasets.toLocaleString(), audiences: ["lead"] },
    {
      id: "funding",
      label: "Funding & access",
      stat: (overall.nihFundedPubs + overall.notNihFundedPubs).toLocaleString(),
      audiences: ["lead"],
    },
    {
      id: "repos",
      label: "Repositories",
      stat: report.byRepository.length.toLocaleString(),
      audiences: ["rdm"],
    },
    {
      id: "departments",
      label: "Departments",
      stat: report.byDepartment.length.toLocaleString(),
      audiences: ["lead", "rdm"],
    },
    {
      id: "faculty",
      label: "Faculty",
      stat: report.byFaculty.length.toLocaleString(),
      audiences: ["lead", "rdm"],
    },
    // Sub-types hides itself when there's nothing to show; so does its rail row.
    ...(report.bySubtype.length > 0
      ? [
          {
            id: "subtypes",
            label: "Sub-types",
            stat: overall.subtypeClassifiedInstances.toLocaleString(),
            audiences: ["rdm", "comp"] as const,
          },
        ]
      : []),
    { id: "recent", label: "Recent deposits", stat: "", audiences: ["rdm"] },
    {
      id: "compliance",
      label: "Compliance",
      stat: overall.concerningDepositInstances.toLocaleString(),
      audiences: ["comp"],
    },
  ];
  return (
    <div className="grid items-start gap-[22px] lg:grid-cols-[170px_minmax(0,1fr)]">
      <DataSharingRail items={railItems} />
      <div className="flex min-w-0 flex-col gap-9">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
            <span className="border-apollo-border-strong bg-apollo-surface rounded-full border px-2.5 py-[3px] whitespace-nowrap">
              Data as of {formatDate(report.dataAsOf)}
            </span>
            {/* Permanent methodology note (2026-08-16), NOT conditional on
                filter state — a fixed historical marker: the FTE-narrowed
                share-rate denominator roughly doubled every rate, and a reader
                reconciling an old percentage needs the answer at the source. */}
            <span
              className="bg-apollo-amber-tint text-apollo-amber rounded-full px-2.5 py-[3px]"
              data-testid="ds-fte-note"
            >
              Aug 2026: share-rate denominator narrowed to full-time faculty; rates roughly doubled
              vs. earlier published figures
            </span>
          </div>
          <FilterBar ui={ui} bounds={report.depositYearBounds} />
        </div>
        <RollupSection report={report} doc={doc} filters={ui.filters} currentYear={currentYear} />
        <FundingSection report={report} filters={ui.filters} />
        <RepositoriesSection report={report} ui={ui} />
        <DepartmentsSection report={report} ui={ui} />
        <FacultySection report={report} ui={ui} />
        <SubtypesSection report={report} filters={ui.filters} />
        <RecentDepositsSection report={report} filters={ui.filters} />
        <ComplianceSection report={report} />
        <DataSharingMethodsSection doc={doc} />
      </div>
    </div>
  );
}
