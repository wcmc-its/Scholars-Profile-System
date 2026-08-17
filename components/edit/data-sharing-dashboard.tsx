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
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { CopyButton } from "@/components/publication/copy-button";
import { DataSharingMethodsDialog } from "@/components/edit/data-sharing-methods";
import { DefinedTerm } from "@/components/edit/data-sharing-term";
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
import { tierOf, urlOf } from "@/lib/repository-tier";

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";
const sectionClass =
  "border-apollo-border bg-apollo-surface mt-3 overflow-x-auto rounded-md border";

/** "n/N (x%)" — deliberately never a bare percentage (a past review flagged
 *  that a naked percent on a small denominator implies false precision).
 *  `undefined` (row has no share-rate data merged) or a zero denominator both
 *  render "—" rather than "0/0 (NaN%)" or a misleading "0%". A nonzero
 *  numerator that rounds to 0% reads as "<1%" (2026-08-16 review: several
 *  departments' entire signal was being rounded away, and "0%" next to a
 *  nonzero numerator reads as an arithmetic error, not a small percentage). */
function formatShareRate(numerator: number | undefined, denominator: number | undefined): string {
  if (numerator === undefined || denominator === undefined || denominator === 0) return "—";
  const pct = Math.round((numerator / denominator) * 100);
  const pctLabel = pct === 0 && numerator > 0 ? "<1%" : `${pct}%`;
  return `${numerator.toLocaleString()}/${denominator.toLocaleString()} (${pctLabel})`;
}

/** Acronyms preserved as-is when `displayDepartmentName` title-cases an
 *  all-caps department string — 2026-08-16 adversarial-review finding: the
 *  fix's OWN motivating example, "WCMC QATAR," contains one (WCMC) that the
 *  naive title-case would mangle to "Wcmc," which the doc comment on this
 *  function previously (wrongly) claimed couldn't happen. Bounded allowlist,
 *  not a general acronym detector — add an entry only when a real
 *  all-caps department name surfaces one. */
const PRESERVED_DEPARTMENT_ACRONYMS = new Set(["WCMC", "ICU", "NIH"]);

/** Title-cases a department name if it's stored fully uppercase (e.g. "WCMC
 *  QATAR" → "WCMC Qatar"), otherwise passes it through untouched — 2026-08-16
 *  review: cosmetic, but the audience notices. Bounded to the all-uppercase
 *  case on purpose: a normal Title Case or mixed-case name (which may
 *  legitimately contain an acronym) passes through unchanged. Within an
 *  all-caps string, a token in `PRESERVED_DEPARTMENT_ACRONYMS` stays
 *  uppercase rather than being title-cased along with the rest. */
function displayDepartmentName(department: string): string {
  if (department !== department.toUpperCase() || department === department.toLowerCase()) return department;
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
 *  already (2026-08-16 review: "gse55096" vs GEO's own "GSE55096"
 *  convention). Deliberately NOT applied to every repository: DOI-bearing
 *  repositories (Dryad, Zenodo, figshare, …) use `accessionOrDoi` for a real
 *  DOI, and dbGaP's own convention is a LOWERCASE "phs" prefix (e.g.
 *  "phs000001.v1.p1") — uppercasing it would be wrong, not a fix (2026-08-16
 *  adversarial-review finding: dbGaP was wrongly included here). */
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
 *  too heavy against the new tier-color scheme ("I don't like those dark
 *  pills"). Don't reintroduce a pill here. */
function AccessChip({ accessModel }: { accessModel: string | null }) {
  if (accessModel === null) return <span className="text-muted-foreground">—</span>;
  return <span>{accessModel === "open" ? "Open" : "Controlled"}</span>;
}

/** External <a> with the console's ArrowUpRight affordance (the
 *  email-card/coi-gap-card idiom) — for links that leave SPS. */
function ExternalA({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 hover:underline"
    >
      {children}
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
}

/** Rewrites a `DownloadLink` label when a page-level filter is active. Every
 *  CSV export on this page always reads the FULL unfiltered corpus (see
 *  `FilterBar`'s caption paragraph below), so the button itself should say
 *  so instead of silently mismatching the filtered tables sitting next to it
 *  (2026-08-16 ask). One pure function so every call site gets identical
 *  wording, not an inline ternary repeated, and liable to drift, at each of
 *  the ~16 `DownloadLink` uses on this page. The two named labels are the
 *  aggregate-table defaults (`DownloadLink`'s own `label` default, and the
 *  `?grain=items` drill-down's "Download items CSV"); anything else, like
 *  the compact per-row "Items" links, just gets the caveat appended. */
function downloadLabelForFilters(label: string, filtersActive: boolean | undefined): string {
  if (!filtersActive) return label;
  if (label === "Download CSV") return "Download full CSV (ignores filters)";
  if (label === "Download items CSV") return "Download full items CSV (ignores filters)";
  return `${label} (ignores filters)`;
}

/** Per-table CSV link — a plain <a> because the target is a download route
 *  handler; <Link>'s client nav + prefetch would fetch the file itself.
 *  `label` defaults to the aggregate link's text; the `?grain=items`
 *  drill-down links pass "Download items CSV" (v3 — the stakeholder wants
 *  each table's underlying item rows one click away, not just the rollup).
 *  `filtersActive` (2026-08-16, optional so no call site is forced to pass
 *  it) runs the label through `downloadLabelForFilters` above. */
function DownloadLink({
  href,
  label = "Download CSV",
  className = "text-xs hover:underline",
  testId,
  filtersActive,
}: {
  href: string;
  label?: string;
  className?: string;
  testId?: string;
  filtersActive?: boolean;
}) {
  return (
    <a href={href} className={className} data-testid={testId}>
      {downloadLabelForFilters(label, filtersActive)}
    </a>
  );
}

/** `ui.filters` → the exact query-param shape `parseDataSharingParams`
 *  reads back (2026-08-16 adversarial-review fix): `DataSharingReportFilters
 *  .tiers` is plural (an array FIELD name) but the URL param it round-trips
 *  through is singular `tier=` (repeated once per value, `parseDataSharingParams`
 *  reads `searchParams.tier`) — spreading `...ui.filters` straight into
 *  `buildQuery` emitted a `tiers=` key nothing parses, silently dropping the
 *  active tier filter the instant someone clicked a sort-column or
 *  pagination link built that way. This is the one place that translation
 *  happens, so a sort/pagination href can't drift from the filter form's
 *  own `name="tier"` checkboxes again. */
function filterQueryParams(filters: DataSharingUiParams["filters"]): Record<string, string | number | readonly string[] | undefined> {
  return { yearFrom: filters.yearFrom, yearTo: filters.yearTo, tier: filters.tiers };
}

/** Builds a query string, dropping `undefined`/empty-array values — the one
 *  place every sort-link/filter-form href on this page assembles its
 *  params, so none of them can drift on how a multi-value param (`tier=`)
 *  or an absent one is encoded. */
function buildQuery(params: Record<string, string | number | readonly string[] | undefined>): string {
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

/** "Is any filter currently active", extracted 2026-08-16 out of
 *  `FilterBar`'s own local `active` computation. Its "Clear filters" link
 *  and caption paragraph, and `DataSharingDashboard`'s page-level
 *  `filtersActive` (which every `DownloadLink`'s relabeled caption reads),
 *  now share the exact same one-line definition instead of two copies that
 *  could quietly drift apart. */
function hasActiveFilters(filters: DataSharingUiParams["filters"]): boolean {
  return filters.yearFrom !== undefined || filters.yearTo !== undefined || !!filters.tiers?.length;
}

/** A sortable `<th>` — a plain link that reloads the page with the sort
 *  param toggled, not a client island (see `parseDataSharingParams`'s doc
 *  comment for why). Preserves every other active filter/sort param via
 *  `otherParams`. Clicking the currently-active column flips direction;
 *  clicking a different column switches to it, descending first (matches
 *  every table's current datasets-desc default). */
function SortableTh({
  label,
  sortKey,
  activeSort,
  activeDir,
  otherParams,
  sortParamName,
  dirParamName,
  align = "right",
}: {
  label: string;
  sortKey: string;
  activeSort: string | undefined;
  activeDir: SortDir;
  otherParams: Record<string, string | number | readonly string[] | undefined>;
  sortParamName: string;
  dirParamName: string;
  align?: "left" | "right";
}) {
  const isActive = activeSort === sortKey;
  const nextDir: SortDir = isActive && activeDir === "desc" ? "asc" : "desc";
  const href = buildQuery({ ...otherParams, [sortParamName]: sortKey, [dirParamName]: nextDir });
  return (
    <th className={`${thClass} ${align === "right" ? "text-right" : ""}`}>
      <a href={href} className="inline-flex items-center gap-1 hover:underline">
        {label}
        {isActive && <span aria-hidden>{activeDir === "desc" ? "↓" : "↑"}</span>}
      </a>
    </th>
  );
}

/** The v2 mockup's `.newcol` band (its `#F2F8F4`), restored per the v3 pass:
 *  a faint tint that visually GROUPS the access-model/exposure columns — §3
 *  By department's Open/Controlled/Registry and §4 Named faculty's
 *  Open/Controlled/Concerning/Foreign-hosted, th + td alike — so they read
 *  as one lens over the row rather than four unrelated count columns.
 *  Expressed as the tier palette's US_CTRL green at 5% over the white table
 *  surface (≈ the mockup hex); a fixed color is safe because the /edit shell
 *  is light-theme-only (apollo warm-paper tokens, no dark variant on these
 *  surfaces — `app/globals.css`). ONE shared const on purpose: per-column
 *  copies would drift. */
const exposureColClass = "bg-[#2E7D52]/5";

/** Short display label per `tierOf` value (`@/lib/repository-tier`). Falls
 *  through to the bare tier string for `'UNKNOWN'` or any future tier this
 *  table hasn't been updated for. */
const TIER_LABELS: Record<string, string> = {
  CONCERN: "Country of concern",
  FOREIGN_OPEN: "Foreign-hosted, open",
  FOREIGN_CTRL: "Foreign-hosted, controlled",
  US_OPEN: "US-hosted, open",
  US_CTRL: "US-hosted, controlled",
  REGISTRY: "Registry (not microdata)",
  UNKNOWN: "Unclassified",
};

/** Tier palette from the v2 mockup (`data-sharing-dashboard-v2-mockup.html`,
 *  adopted per the 2026-08-16 decision in the Projects handoff doc) — one hue
 *  per tier, severity-ordered warm→cool. The single source for every tier
 *  color on this page: chips, the §1 spectrum bar, and its legend. */
const TIER_COLORS: Record<string, string> = {
  CONCERN: "#B31B1B",
  FOREIGN_OPEN: "#D97B29",
  FOREIGN_CTRL: "#C9A227",
  US_OPEN: "#3E6FB0",
  US_CTRL: "#2E7D52",
  REGISTRY: "#8A90A0",
  UNKNOWN: "#C3C7D1",
};

/** Tier → `DATA_SHARING_TERMS` glossary key for the `DefinedTerm` hover on
 *  `TierChip` labels (v3 term-hover pass). FOREIGN_OPEN/FOREIGN_CTRL each get
 *  their OWN entry (2026-08-16 fix — a shared "Foreign-hosted" definition
 *  read identically for both tiers, which implied a live distinction that
 *  carried no information; see `DATA_SHARING_TERMS`'s matching split). US
 *  tiers and UNKNOWN are absent on purpose — the glossary defines the risk
 *  vocabulary, and "US-hosted, open" needs no definition; an absent key
 *  renders the label plain, no hover. */
const TIER_GLOSSARY_TERM: Record<string, string> = {
  CONCERN: "Country of concern",
  FOREIGN_OPEN: "Foreign-hosted, open",
  FOREIGN_CTRL: "Foreign-hosted, controlled",
  REGISTRY: "Registry",
};

/** Colored tier dot + label, the mockup's `.tierdot` idiom — replaced the
 *  Badge-variant rendering when the mockup palette was adopted (08-16). The
 *  label carries a `DefinedTerm` glossary hover for the risk tiers
 *  (`TIER_GLOSSARY_TERM`). */
function TierChip({ tier }: { tier: string }) {
  const label = TIER_LABELS[tier] ?? tier;
  const term = TIER_GLOSSARY_TERM[tier];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: TIER_COLORS[tier] ?? TIER_COLORS.UNKNOWN }}
      />
      {term ? <DefinedTerm term={term}>{label}</DefinedTerm> : label}
    </span>
  );
}

/** Per-tier horizontal bars (small multiples) against one shared 0–max axis —
 *  replaced the mockup's single stacked bar (2026-08-16 review): the
 *  caption already admits a publication counted in more than one tier is
 *  "counted in each," so the segments overlap and a STACKED bar's total
 *  length visually promises a partition it doesn't have. Small multiples say
 *  the same numbers without that implied promise. Zero-count tiers still get
 *  a full-width-empty row, not a hidden one — "Country of concern 0" stays a
 *  visible statement, same rationale as the old legend entries. */
function TierSpectrum({ rows }: { rows: DataSharingReport["pubsByTier"] }) {
  const max = Math.max(1, ...rows.map((t) => t.pubs));
  return (
    <div className="mt-3 space-y-1.5">
      {rows.map((t) => (
        <div key={t.tier} className="flex items-center gap-2 text-xs">
          <span className="w-44 shrink-0 truncate text-right">
            {TIER_GLOSSARY_TERM[t.tier] ? (
              <DefinedTerm term={TIER_GLOSSARY_TERM[t.tier]}>
                <span className="text-muted-foreground">{TIER_LABELS[t.tier] ?? t.tier}</span>
              </DefinedTerm>
            ) : (
              <span className="text-muted-foreground">{TIER_LABELS[t.tier] ?? t.tier}</span>
            )}
          </span>
          <div className="border-apollo-border h-3 flex-1 overflow-hidden rounded border">
            {t.pubs > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${(t.pubs / max) * 100}%`,
                  backgroundColor: TIER_COLORS[t.tier] ?? TIER_COLORS.UNKNOWN,
                }}
              />
            )}
          </div>
          <span className="w-10 shrink-0 text-right font-semibold">{t.pubs.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** Small CSS-bar trend chart, same small-multiples idiom as `TierSpectrum` —
 *  no chart library. 2026-08-16 ask: "leadership's first question after 'how
 *  much' is 'is it going up.'" Ascending year order (see `aggregateByYear`'s
 *  doc comment); the "Unknown year" bucket, if present, renders last and
 *  muted so it reads as a caveat, not a real trend point. */
function DepositsByYearChart({ rows }: { rows: DataSharingReport["byYear"] }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.datasets));
  return (
    <div className={`${sectionClass} mt-4 p-4`}>
      <div className="text-sm font-medium">Deposits by year</div>
      <p className="text-muted-foreground mt-1 text-xs">
        Distinct datasets by deposit year (repository metadata, or publication year as a fallback).
      </p>
      <div className="mt-3 flex h-28 items-end gap-1.5">
        {rows.map((r) => (
          <div key={r.year ?? "unknown"} className="flex flex-1 flex-col items-center gap-1">
            <div className="w-full text-center text-xs font-semibold">{r.datasets.toLocaleString()}</div>
            <div
              className={`w-full rounded-t ${r.year === null ? "bg-apollo-border" : "bg-[#3E6FB0]"}`}
              style={{ height: `${Math.max(4, (r.datasets / max) * 100)}%` }}
            />
            <div className="text-muted-foreground text-xs">{r.year ?? "Unknown"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RollupSection({
  report,
  doc,
  filtersActive,
}: {
  report: DataSharingReport;
  /** Built once in `DataSharingDashboard` (server side) and passed down —
   *  the sticky nav (2026-08-16 ask) repeats the same Methods dialog trigger,
   *  so the doc can't be built separately in two places without risking
   *  drift. The dialog itself is a client island and must never import the
   *  report lib directly; `buildMethodsDoc` is pure and `DataSharingReport`
   *  satisfies its structural param type. */
  doc: ReturnType<typeof buildMethodsDoc>;
  /** Whether a year/tier filter is currently active. This section's own
   *  export link is the full-corpus default export, so it needs the same
   *  "ignores filters" relabeling as every other `DownloadLink` on the page. */
  filtersActive: boolean;
}) {
  const { overall } = report;
  return (
    <section id="rollup" className="scroll-mt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">1 · Institutional rollup</h2>
        <span className="inline-flex items-center gap-4">
          {/* The Methods dialog trigger now lives ONLY in the sticky nav
              (2026-08-16 ask: "repeat the Methods link there rather than
              only in section 1's corner") — one trigger, reachable from
              anywhere on the page, not two that could drift or double up
              in an accessibility tree query. */}
          {/* Shortcut to the Methods dialog's "Copy paragraph" (2026-08-16
              ask for a "copy summary" button) — reuses the same CopyButton +
              paragraph rather than a second citation-text mechanism; the
              gap was discoverability (buried in a dialog), not a missing
              feature. */}
          <span className="inline-flex items-center gap-1 text-sm">
            <CopyButton value={doc.paragraph} label="Copy summary paragraph" />
            Copy summary
          </span>
          <DownloadLink
            href="/edit/data-sharing/export"
            className="text-sm hover:underline"
            testId="ds-export-link"
            filtersActive={filtersActive}
          />
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Aggregate headline numbers for research leadership and compliance/grant reporting.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.datasets.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">
            Distinct datasets (<DefinedTerm term="Strict floor">strict floor</DefinedTerm>)
          </div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.faculty.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">Depositing faculty</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{report.byDepartment.length}</div>
          <div className="text-muted-foreground text-xs">Departments represented</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">
            {formatShareRate(overall.shareRateNumerator, overall.shareRateDenominator)}
          </div>
          <div className="text-muted-foreground text-xs">
            Confirmed first/last-author, full-time-faculty pubs with a detected deposit
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">since {SHARE_RATE_YEAR_FLOOR}</div>
        </div>
        {/* PMC coverage (v3, collapsed to ONE card 2026-08-16): both PMC
            cards previously here read the same corpus-wide number twice
            (pmcCoveredPubs == shareRateDenominator today, i.e. "100% in
            PMC," confirmed via a live staging probe as institution-wide,
            not a query bug — see `overall.pmcCoveredPubs`'s doc comment in
            the report lib). Kept as ONE raw-count card, explicitly flagged
            as a known data-quality gap rather than presented as a working
            denominator — restoring the second card only makes sense once
            the upstream PMC-identifier field is verified. */}
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">
            {formatShareRate(overall.pmcCoveredPubs, overall.shareRateDenominator)}
          </div>
          <div className="text-muted-foreground text-xs">
            <DefinedTerm term="PMC">In PMC</DefinedTerm>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            known data-quality gap — see Methods, &ldquo;PMC coverage&rdquo;
          </div>
        </div>
      </div>

      <DepositsByYearChart rows={report.byYear} />

      {/* Methodology prose + the "One paragraph for reporting" copy block
          moved into the Methods dialog above (08-16 follow-up pass). */}
      <div className={`${sectionClass} mt-4 p-4`}>
        <div className="text-sm font-medium">Publications by repository risk tier</div>
        <p className="text-muted-foreground mt-1 text-xs">
          Distinct publications with a detected deposit in a repository of each tier — tier-based
          only (host jurisdiction × access model); a publication with deposits in repositories of
          different tiers is counted in each.
        </p>
        <TierSpectrum rows={report.pubsByTier} />
      </div>
    </section>
  );
}

function FundingSection({ report }: { report: DataSharingReport }) {
  const { overall } = report;
  // Shared non-registry deposited-publication population both lenses below
  // are built from — stated explicitly (2026-08-16 fix) so a reader doesn't
  // subtract this from the §1 headline denominator and find "41 missing
  // pubs": the two totals are DIFFERENT populations by design (this one is
  // every detected non-registry deposit; §1's is scoped to the corpus), not
  // a subset relationship.
  const sharedTotal = overall.nihFundedPubs + overall.notNihFundedPubs;
  const { accessFundingCrossTab: cross } = report;
  return (
    <section id="funding" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">2 · Funding &amp; access</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Access model and NIH funding, both over the same {sharedTotal.toLocaleString()} non-registry
        deposited publications — a different, broader population than the §1 corpus-scoped share
        rate (not a subset of it).
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.openPubs.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">Open-access publications</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.controlledPubs.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">Controlled-access publications</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.nihFundedPubs.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">NIH-funded publications</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.notNihFundedPubs.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">Not NIH-funded publications</div>
        </div>
      </div>

      <p className="text-muted-foreground mt-2 text-xs">
        &quot;Not NIH-funded&quot; is not the same as non-federal: <code>nih_ic</code> is only ever
        populated for NIH awards, so other federal funders (CDC, NSF, and the like) aren&apos;t
        separately tracked here and are counted as not NIH-funded alongside genuinely non-federal
        work. A publication with more than one deposit of different access models can count toward
        both open and controlled — the two access columns don&apos;t need to sum to the total above.
      </p>

      {/* Access × NIH-funding cross-tab (2026-08-16 ask): the methods
          guarantee the two lenses share a denominator; this is where they're
          actually crossed instead of just adjacent. */}
      <h3 className="mt-6 text-sm font-semibold">Access model × NIH funding</h3>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass} />
              <th className={`${thClass} text-right`}>NIH-funded</th>
              <th className={`${thClass} text-right`}>Not NIH-funded</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-apollo-border border-b">
              <td className={`${tdClass} font-medium`}>Open access</td>
              <td className={`${tdClass} text-right`}>{cross.openNih.toLocaleString()}</td>
              <td className={`${tdClass} text-right`}>{cross.openNotNih.toLocaleString()}</td>
            </tr>
            <tr>
              <td className={`${tdClass} font-medium`}>Controlled access</td>
              <td className={`${tdClass} text-right`}>{cross.controlledNih.toLocaleString()}</td>
              <td className={`${tdClass} text-right`}>{cross.controlledNotNih.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Sorts a copy of `byDepartment` — see `SortableTh`'s doc comment for why
 *  this is a plain server-side sort, not client state. `"shareRate"` sorts
 *  by the computed percentage (0 when the row has no denominator), not the
 *  numerator alone — that's the actual "rate-sorted" view the RDM team
 *  asked for, not a raw-count reorder. Undefined `key` returns the input's
 *  existing datasets-desc order unchanged (the report's own default). */
function sortDepartments(
  rows: readonly DepartmentRollup[],
  key: DepartmentSortKey | undefined,
  dir: SortDir,
): DepartmentRollup[] {
  if (!key) return [...rows];
  const rate = (d: DepartmentRollup) =>
    d.shareRateDenominator && d.shareRateDenominator > 0 ? (d.shareRateNumerator ?? 0) / d.shareRateDenominator : 0;
  const value = (d: DepartmentRollup) => (key === "datasets" ? d.datasets : key === "faculty" ? d.faculty : rate(d));
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
    f.shareRateDenominator && f.shareRateDenominator > 0 ? (f.shareRateNumerator ?? 0) / f.shareRateDenominator : 0;
  const value = (f: NamedFacultyRow) =>
    key === "datasets" ? f.datasets : key === "concerning" ? f.concerningDeposits : rate(f);
  const sorted = [...rows].sort((a, b) => value(a) - value(b));
  return dir === "desc" ? sorted.reverse() : sorted;
}

function RepositoriesSection({ report, ui }: { report: DataSharingReport; ui: DataSharingUiParams }) {
  const otherParams = { ...filterQueryParams(ui.filters), facSort: ui.facSort, facDir: ui.facDir, facPage: ui.facPage };
  // Already has `ui` (unlike RollupSection/SubtypesSection/etc below), so
  // derive locally rather than taking a redundant `filtersActive` prop.
  const filtersActive = hasActiveFilters(ui.filters);
  const sortedDepartments = sortDepartments(report.byDepartment, ui.deptSort, ui.deptDir);
  // Synapse-shaped contradiction check (2026-08-16 review): does any
  // repository's tier-implied access model (open/controlled, from
  // TIER_LABELS) disagree with its actually-observed per-deposit Access
  // column? Confirmed via staging probe this is currently true for Synapse
  // (tiered US-hosted/open, all 11 observed deposits controlled) — a
  // platform-level catalog classification, not a per-deposit fact, so the
  // footnote only fires when the data actually shows a disagreement.
  const tierAccessMismatch = report.byRepository.some((r) => {
    const tierImpliesOpen = TIER_LABELS[r.tier]?.includes("open");
    const tierImpliesControlled = TIER_LABELS[r.tier]?.includes("controlled");
    return (tierImpliesOpen && r.accessModel === "controlled") || (tierImpliesControlled && r.accessModel === "open");
  });
  return (
    <section id="repos" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">3 · Repositories &amp; departments</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Audience: library / RDM team — targeting DMS training and repository support.
      </p>

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Repositories by risk tier</h3>
        <DownloadLink href="/edit/data-sharing/export?section=tiers" filtersActive={filtersActive} />
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        The &ldquo;concerning&rdquo; flag elsewhere on this page is tier-based only (country-of-concern
        host or foreign-hosted repository) and does not fold in sensitive-data-type detection —
        §5 &ldquo;Deposits by data sub-type&rdquo; is a separate, not-yet-combined lens; see that
        section for its own coverage.
      </p>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Tier</th>
              <th className={thClass}>Repositories</th>
              <th className={`${thClass} text-right`}>Datasets</th>
            </tr>
          </thead>
          <tbody>
            {report.byRepositoryTier.map((t) => {
              // Per-repo counts inline (mockup's "Zenodo 174 · figshare 67"
              // chips) — derived from byRepository, which is already sorted
              // datasets-desc and is the exact source byRepositoryTier
              // groups from. Each repo name links out via `urlOf` (v3 — the
              // count stays outside the link, it's SPS's number, not the
              // repository's).
              const repos = report.byRepository.filter((r) => r.tier === t.tier);
              // Zero rows arrive from the report on purpose (`paddedTiers`):
              // "Country of concern · 0" is a deliberate compliance statement
              // — render it muted but PRESENT, never filter it out here.
              const isZero = t.datasets === 0;
              return (
                <tr key={t.tier} className="border-apollo-border border-b">
                  <td className={tdClass}>
                    <TierChip tier={t.tier} />
                  </td>
                  <td className={`${tdClass} text-muted-foreground`}>
                    {repos.length === 0
                      ? "none detected"
                      : repos.map((r, i) => {
                          const url = urlOf(r.repository);
                          return (
                            <span key={r.repository} className="whitespace-nowrap">
                              {i > 0 && " · "}
                              {url ? <ExternalA href={url}>{r.repository}</ExternalA> : r.repository}{" "}
                              {r.datasets.toLocaleString()}
                            </span>
                          );
                        })}
                  </td>
                  <td className={`${tdClass} text-right${isZero ? " text-muted-foreground" : ""}`}>
                    {t.datasets.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">By repository</h3>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=repositories" filtersActive={filtersActive} />
          <DownloadLink
            href="/edit/data-sharing/export?section=repositories&grain=items"
            label="Download items CSV"
            filtersActive={filtersActive}
          />
        </span>
      </div>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Repository</th>
              <th className={thClass}>Tier</th>
              <th className={thClass}>Access</th>
              <th className={`${thClass} text-right`}>Datasets</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {report.byRepository.map((r) => {
              const url = urlOf(r.repository);
              return (
                <tr key={r.repository} className="border-apollo-border border-b">
                  <td className={`${tdClass} font-medium`}>
                    {url ? <ExternalA href={url}>{r.repository}</ExternalA> : r.repository}
                  </td>
                  <td className={tdClass}>
                    <TierChip tier={r.tier} />
                  </td>
                  <td className={tdClass}>
                    <AccessChip accessModel={r.accessModel} />
                  </td>
                  <td className={`${tdClass} text-right`}>{r.datasets.toLocaleString()}</td>
                  <td className={tdClass}>
                    <DownloadLink
                      href={`/edit/data-sharing/export?section=repositories&grain=items&repository=${encodeURIComponent(r.repository)}`}
                      label="Items"
                      filtersActive={filtersActive}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tierAccessMismatch && (
        <p className="text-muted-foreground mt-2 text-xs">
          Tier is the shared risk catalog&apos;s platform-level classification (host jurisdiction ×
          typical access model), not a per-deposit fact — a repository&apos;s Access column (the
          actually observed access model on WCM&apos;s deposits there) can disagree with what its
          tier name implies, e.g. Synapse tiers &ldquo;US-hosted, open&rdquo; but every WCM deposit
          observed there today is controlled.
        </p>
      )}

      <div className="mt-6 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">By department</h3>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=departments" filtersActive={filtersActive} />
          <DownloadLink
            href="/edit/data-sharing/export?section=departments&grain=items"
            label="Download items CSV"
            filtersActive={filtersActive}
          />
        </span>
      </div>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Department</th>
              <SortableTh
                label="Datasets"
                sortKey="datasets"
                activeSort={ui.deptSort}
                activeDir={ui.deptDir}
                otherParams={otherParams}
                sortParamName="deptSort"
                dirParamName="deptDir"
              />
              <SortableTh
                label="Depositing faculty"
                sortKey="faculty"
                activeSort={ui.deptSort}
                activeDir={ui.deptDir}
                otherParams={otherParams}
                sortParamName="deptSort"
                dirParamName="deptDir"
              />
              {/* Access-model group — `exposureColClass` bands th + td, see
                  the const's doc comment. */}
              <th className={`${thClass} ${exposureColClass} text-right`}>Open</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>Controlled</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>Registry</th>
              <SortableTh
                label="Share rate"
                sortKey="shareRate"
                activeSort={ui.deptSort}
                activeDir={ui.deptDir}
                otherParams={otherParams}
                sortParamName="deptSort"
                dirParamName="deptDir"
              />
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {sortedDepartments.map((d) => (
              <tr key={d.department} className="border-apollo-border border-b">
                <td className={tdClass}>{displayDepartmentName(d.department)}</td>
                <td className={`${tdClass} text-right`}>{d.datasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.faculty.toLocaleString()}</td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {d.openDatasets.toLocaleString()}
                </td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {d.controlledDatasets.toLocaleString()}
                </td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {d.registryDatasets.toLocaleString()}
                </td>
                <td className={`${tdClass} text-right`}>
                  {formatShareRate(d.shareRateNumerator, d.shareRateDenominator)}
                </td>
                <td className={tdClass}>
                  <DownloadLink
                    href={`/edit/data-sharing/export?section=departments&grain=items&department=${encodeURIComponent(d.department)}`}
                    label="Items"
                    filtersActive={filtersActive}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Department dataset counts don&apos;t sum to the institutional total — a dataset with
        co-authors in two departments counts once in each. Don&apos;t treat this column as a
        partition of the rollup above. Open, Controlled, and Registry don&apos;t sum to Datasets
        either — a deposit with no recorded access model is uncounted in either of the first two.
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Datasets/Depositing-faculty attribute to whichever scholar actually holds the deposit; Share
        rate attributes to whoever confirmed-first/last-authored the underlying publication —
        different scopes on purpose. A publication can show a detected deposit even when the
        depositing scholar is a co-author in a DIFFERENT department (any citing row counts, not just
        the corresponding author&apos;s), so a department can show a nonzero share rate with zero
        datasets of its own, or nonzero datasets with a 0% share rate (a dataset can be linked by any
        co-author, while only first/last-authored publications count toward the rate). Neither is an
        arithmetic error.
      </p>
    </section>
  );
}

/** Fixed caption text for the Concerning/Foreign-hosted columns — matches
 *  the SPEC's "Amended 08-13" caveat framing exactly. Don't soften or drop
 *  this; it's the boundary between the tier-only flag actually shipped here
 *  and the fuller 3-way "concerning" definition the SPEC describes but
 *  defers (open-deposit-of-sensitive-category needs raw MeSH per citing pub,
 *  cut this session). */
const CONCERNING_CAVEAT =
  "Tier-based only — country-of-concern host or foreign-hosted repository; does not include sensitive data-type detection.";

function FacultySection({ report, ui }: { report: DataSharingReport; ui: DataSharingUiParams }) {
  // Already has `ui`, same rationale as `RepositoriesSection`'s local copy.
  const filtersActive = hasActiveFilters(ui.filters);
  const sorted = sortFaculty(report.byFaculty, ui.facSort, ui.facDir);
  const totalPages = Math.max(1, Math.ceil(sorted.length / FACULTY_ROW_CAP));
  // Clamped, not raw `ui.facPage` (2026-08-16 adversarial-review finding): a
  // stale or hand-edited `facPage` past the end (e.g. a filter just shrank
  // the row count) rendered an empty table under a nonsensical "page N of M"
  // label instead of falling back to the last real page.
  const facPage = Math.min(Math.max(ui.facPage, 1), totalPages);
  const start = (facPage - 1) * FACULTY_ROW_CAP;
  const rows = sorted.slice(start, start + FACULTY_ROW_CAP);
  // Includes facSort/facDir too (not just deptSort/deptDir) even though the
  // SortableTh calls below override them via their own sortKey/nextDir —
  // the Prev/Next pagination links (further down) use this SAME object and
  // have no such override, so omitting them here silently reset the sort
  // the moment someone paged a non-default-sorted table (2026-08-16
  // adversarial-review finding).
  const otherParams = {
    ...filterQueryParams(ui.filters),
    deptSort: ui.deptSort,
    deptDir: ui.deptDir,
    facSort: ui.facSort,
    facDir: ui.facDir,
  };
  // Concerning == Foreign-hosted by construction while country-of-concern is
  // 0 institution-wide (2026-08-16 review): two identical columns imply a
  // live distinction that carries no information today. Collapse to one
  // "Concerning" column; the Foreign-hosted split comes back automatically
  // the moment a CONCERN-tier deposit is actually detected anywhere — not a
  // flag someone has to remember to flip.
  const hasCountryOfConcern = report.byRepositoryTier.some((t) => t.tier === "CONCERN" && t.datasets > 0);
  return (
    <section id="faculty" className="mt-10 scroll-mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">4 · Named faculty</h2>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=faculty" filtersActive={filtersActive} />
          <DownloadLink
            href="/edit/data-sharing/export?section=faculty&grain=items"
            label="Download items CSV"
            filtersActive={filtersActive}
          />
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Per-individual counts, page {facPage} of {totalPages} ({sorted.length.toLocaleString()} total) —
        same access as sections 1–3 above, no separate review. No Registry column here (unlike
        §3&apos;s department table): this table stays Open/Controlled-only by design.
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        <strong>Concerning{hasCountryOfConcern ? " / Foreign-hosted" : ""}:</strong> {CONCERNING_CAVEAT}
      </p>

      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
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
              {/* Exposure group — `exposureColClass` bands th + td, see the
                  const's doc comment. The Concerning header carries a
                  `DefinedTerm` hover (glossary definition + the tier-only
                  caveat) — the caveat text itself must survive any future
                  restyle (SPEC "Amended 08-13"). */}
              <th className={`${thClass} ${exposureColClass} text-right`}>Open</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>Controlled</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>
                {/* "Concerning", not "Country of concern": this column counts
                    the union of the three highest-severity tiers, and leading
                    the hover with the narrower COC definition overstated
                    severity for foreign-hosted-only rows (review nit). */}
                <DefinedTerm term="Concerning" caveat={CONCERNING_CAVEAT}>
                  Concerning
                </DefinedTerm>
              </th>
              {hasCountryOfConcern && (
                <th className={`${thClass} ${exposureColClass} text-right`}>
                  {/* Neutral "Foreign-hosted" glossary entry (2026-08-16
                      adversarial-review fix) — this column SUMS both
                      FOREIGN_OPEN and FOREIGN_CTRL deposit instances
                      (`foreignHostedDeposits`), so hovering it with either
                      access-specific entry (the tier chips/spectrum use)
                      would falsely claim the whole column is one access
                      model. */}
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
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.cwid} className="border-apollo-border border-b">
                <td className={tdClass}>
                  <Link href={`/scholar/${f.slug}`} className="hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className={tdClass}>{f.department ? displayDepartmentName(f.department) : "—"}</td>
                <td className={`${tdClass} text-right`}>{f.datasets.toLocaleString()}</td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {f.openDatasets.toLocaleString()}
                </td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {f.controlledDatasets.toLocaleString()}
                </td>
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {f.concerningDeposits.toLocaleString()}
                </td>
                {hasCountryOfConcern && (
                  <td className={`${tdClass} ${exposureColClass} text-right`}>
                    {f.foreignHostedDeposits.toLocaleString()}
                  </td>
                )}
                <td className={`${tdClass} text-right`}>
                  {formatShareRate(f.shareRateNumerator, f.shareRateDenominator)}
                </td>
                <td className={tdClass}>
                  <DownloadLink
                    href={`/edit/data-sharing/export?section=faculty&grain=items&cwid=${encodeURIComponent(f.cwid)}`}
                    label="Items"
                    filtersActive={filtersActive}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="mt-2 flex items-center justify-between text-xs">
          {facPage > 1 ? (
            <a href={buildQuery({ ...otherParams, facPage: facPage - 1 })} className="hover:underline">
              ← Previous
            </a>
          ) : (
            <span />
          )}
          {facPage < totalPages ? (
            <a href={buildQuery({ ...otherParams, facPage: facPage + 1 })} className="hover:underline">
              Next →
            </a>
          ) : (
            <span />
          )}
        </div>
      )}
      {/* The institution-wide concerning-instances footnote that used to sit
          here moved to §7 (Compliance view) in the v3 pass — the per-column
          caveat line above the table stays. */}
    </section>
  );
}

/** Display label per coarse sensitive category — the `sensitiveCats`/
 *  `sensitiveSubtypes` category prefix (`SENS` in `scripts/bulk-data-rule/
 *  attribute.py`, from `taxonomy.py`'s `tag()`). Falls through to the raw
 *  category string for any value not in this map, same pattern as
 *  `TIER_LABELS`. */
const SUBTYPE_CATEGORY_LABELS: Record<string, string> = {
  genomic: "Genomic",
  omic_other: "Other 'omic",
  health: "Health data",
  biometric: "Biometric",
  geolocation: "Geolocation",
};

function SubtypesSection({ report, filtersActive }: { report: DataSharingReport; filtersActive: boolean }) {
  if (report.bySubtype.length === 0) return null;
  return (
    <section id="subtypes" className="scroll-mt-4 mt-10">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">5 · Deposits by data sub-type</h2>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=subtypes" filtersActive={filtersActive} />
          <DownloadLink
            href="/edit/data-sharing/export?section=subtypes&grain=items"
            label="Download items CSV"
            filtersActive={filtersActive}
          />
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Granular sensitive sub-types detected per deposit, grouped by coarse category —
        deposit-INSTANCE counts, same grain as the link counts elsewhere on this page, not
        distinct datasets. A deposit spanning more than one sub-type counts once toward each.
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {formatShareRate(report.overall.subtypeClassifiedInstances, report.overall.links)} of every
        deposit instance carries any sub-type classification at all — read the rows below as a
        floor of a floor, not a census; most §6 Recent-activity rows show &ldquo;—&rdquo; for
        sub-types for the same reason.
      </p>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Category</th>
              <th className={thClass}>Sub-type</th>
              <th className={`${thClass} text-right`}>Deposit instances</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {report.bySubtype.map((s, i) => {
              // Rows arrive pre-sorted by category (aggregateBySubtype's own
              // contract), so a contiguous run shares one category — print
              // the Category cell once per run (rowSpan), on an
              // --apollo-surface-2 band, instead of repeating it down every
              // row in the group (R11).
              const rows = report.bySubtype;
              const isGroupStart = i === 0 || rows[i - 1].category !== s.category;
              const itemsHref = `/edit/data-sharing/export?section=subtypes&grain=items&category=${encodeURIComponent(s.category)}&subtype=${encodeURIComponent(s.subtype)}`;
              if (!isGroupStart) {
                return (
                  <tr key={`${s.category}|${s.subtype}`} className="border-apollo-border border-b">
                    <td className={tdClass}>{s.subtype}</td>
                    <td className={`${tdClass} text-right`}>{s.count.toLocaleString()}</td>
                    <td className={tdClass}>
                      <DownloadLink href={itemsHref} label="Items" filtersActive={filtersActive} />
                    </td>
                  </tr>
                );
              }
              let span = 1;
              while (rows[i + span] && rows[i + span].category === s.category) span++;
              return (
                <tr key={`${s.category}|${s.subtype}`} className="border-apollo-border border-b">
                  <td className={`${tdClass} bg-apollo-surface-2 align-top font-medium`} rowSpan={span}>
                    {SUBTYPE_CATEGORY_LABELS[s.category] ?? s.category}
                  </td>
                  <td className={tdClass}>{s.subtype}</td>
                  <td className={`${tdClass} text-right`}>{s.count.toLocaleString()}</td>
                  <td className={tdClass}>
                    <DownloadLink href={itemsHref} label="Items" filtersActive={filtersActive} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecentActivitySection({
  report,
  filtersActive,
}: {
  report: DataSharingReport;
  /** Not named in the 2026-08-16 filters-feedback ask alongside Rollup/
   *  Subtypes/Compliance, but this section's own export link is the same
   *  always-full-corpus default export as Rollup's, and needs the identical
   *  relabeling. So it gets the same additive `filtersActive` prop. */
  filtersActive: boolean;
}) {
  return (
    <section id="recent" className="mt-10 scroll-mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">6 · Recent activity</h2>
        {/* Item grain — the default (no-section) export IS this table, in full. */}
        <DownloadLink href="/edit/data-sharing/export" filtersActive={filtersActive} />
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Item-level — one row per (person, dataset) link, same grain as the CSV export (a dataset
        with more than one depositing/citing faculty member can appear more than once). Sorted by
        deposit year (repository metadata, or publication year as a fallback) — the only per-item
        recency signal this data has. NOT &ldquo;when SPS detected this&rdquo;: every row in the
        table is stamped with the same sync time on each weekly refresh (see &ldquo;Data as
        of&rdquo; above), so a deposit found this week and one found months ago are
        indistinguishable by that timestamp.
        Ties within a year have no further real ordering.
      </p>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Repository</th>
              <th className={thClass}>Accession</th>
              <th className={thClass}>Title</th>
              <th className={thClass}>Type</th>
              <th className={thClass}>Sub-types</th>
              <th className={thClass}>PMIDs</th>
              <th className={thClass}>Tier</th>
              <th className={thClass}>Access</th>
              <th className={`${thClass} text-right`}>Deposit year</th>
              <th className={thClass}>Faculty</th>
              <th className={thClass}>Department</th>
            </tr>
          </thead>
          <tbody>
            {report.recentItems.map((r) => {
              const url = urlOf(r.repository);
              // Per-accession deep link (v3, the "cryptic rows" complaint —
              // GSE162435 should land on its GEO record, not just name it).
              // Same resolver table as the public profile "Datasets" section;
              // unresolvable → plain text, absent → "—".
              const accessionUrl = r.accessionOrDoi
                ? resolveDatasetUrl({ repository: r.repository, accessionOrDoi: r.accessionOrDoi })
                : null;
              // Same parser as the §5 rollup and the subtypes items export —
              // labels only here, the category prefix is §5's job.
              const subtypeLabels = parseSensitiveSubtypes(r.sensitiveSubtypes).map(
                (s) => s.subtype,
              );
              return (
                // (cwid, datasetId) is PersonDatasetDeposit's own primary key —
                // already unique per row, no index needed.
                <tr key={`${r.datasetId}|${r.cwid}`} className="border-apollo-border border-b">
                  <td className={`${tdClass} font-medium`}>
                    {url ? <ExternalA href={url}>{r.repository}</ExternalA> : r.repository}
                  </td>
                  <td className={tdClass}>
                    {r.accessionOrDoi ? (
                      accessionUrl ? (
                        <ExternalA href={accessionUrl}>{displayAccession(r.repository, r.accessionOrDoi)}</ExternalA>
                      ) : (
                        displayAccession(r.repository, r.accessionOrDoi)
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* No accession fallback here anymore — the accession has
                      its own adjacent column now (v3). Truncated to 2 lines
                      (2026-08-16: long ClinicalTrials.gov titles were
                      blowing row heights to 8+ lines) — native `title=`
                      hover shows the full text instead of a JS expander. */}
                  <td className={`${tdClass} max-w-xs`}>
                    <span className="line-clamp-2" title={r.title ?? undefined}>
                      {r.title || "—"}
                    </span>
                  </td>
                  <td className={tdClass}>{r.dataType ?? r.resourceType ?? "—"}</td>
                  <td className={`${tdClass} text-muted-foreground`}>
                    {subtypeLabels.length > 0 ? subtypeLabels.join(", ") : "—"}
                  </td>
                  {/* Citing pubs for this (person, dataset) link — the only
                      table naming specific publications, so the only PMIDs
                      column (08-16 follow-up). */}
                  <td className={tdClass}>
                    {r.pmids?.length
                      ? r.pmids.map((p, i) => (
                          <span key={p} className="whitespace-nowrap">
                            {i > 0 && ", "}
                            <ExternalA href={`https://pubmed.ncbi.nlm.nih.gov/${p}/`}>{p}</ExternalA>
                          </span>
                        ))
                      : "—"}
                  </td>
                  <td className={tdClass}>
                    <TierChip tier={tierOf(r.repository)} />
                  </td>
                  <td className={tdClass}>
                    <AccessChip accessModel={r.accessModel} />
                  </td>
                  <td className={`${tdClass} text-right`}>{r.depositYear ?? "—"}</td>
                  <td className={tdClass}>
                    <Link href={`/scholar/${r.scholarSlug}`} className="hover:underline">
                      {r.scholarName}
                    </Link>
                  </td>
                  <td className={tdClass}>{r.department ? displayDepartmentName(r.department) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Sublabel for the three §7 placeholder cards — one string so the three
 *  can't drift while they wait on the same missing input. */
const COC_PULL_PENDING = "requires the country-of-concern coauthor pull — not yet ingested";

/** §7 Compliance view (v3, mirrors the v2 mockup's compliance panel). One
 *  real number — `overall.concerningDepositInstances`, moved here from the
 *  old §4 footnote — beside three placeholder cards that render "—" until
 *  the country-of-concern coauthor pull is ingested. The empty cards ship ON
 *  PURPOSE: the stakeholder explicitly wants the section's shape present
 *  before the data exists, so the eventual numbers land in an already-familiar
 *  frame. The closing caveat paragraph is the section's point as much as the
 *  numbers — a flag here locates a QUESTION, it never determines a violation;
 *  don't drop or soften it. */
function ComplianceSection({
  report,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- No
  // `DownloadLink` in this section today, so nothing reads this yet. The
  // three placeholder cards ship before there's anything to export (see
  // `COC_PULL_PENDING`). Accepted anyway so this section matches Rollup/
  // Subtypes' shape and a future §7 export doesn't have to remember to add
  // it (2026-08-16 filters-feedback pass).
  filtersActive,
}: {
  report: DataSharingReport;
  filtersActive: boolean;
}) {
  const { concerningDepositInstances } = report.overall;
  return (
    <section id="compliance" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">7 · Compliance view</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Where the DOJ Bulk Data Rule covered-person-access question could arise — a screening
        lens, not a determination.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">
            {concerningDepositInstances.toLocaleString()}
          </div>
          <div className="text-muted-foreground text-xs">Concerning deposit instances</div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            country-of-concern or foreign-hosted repository — tier-derived only, no
            sensitive-data-type detection
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            deposit-instance count, not distinct datasets or publications — see §1&apos;s tier
            spectrum for the publication-grain view of the same tiers
          </div>
        </div>
        {/* Ghosted/disabled styling (2026-08-16 review: "style them as
            visibly disabled so the section reads pending at a glance rather
            than broken") — opacity + a "Pending" badge, same three cards,
            same COC_PULL_PENDING caption. */}
        <div className={`${sectionClass} p-4 opacity-50`} aria-disabled="true">
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">
            Pubs with a COC-affiliated coauthor{" "}
            <span className="border-apollo-border rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide">
              Pending
            </span>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">{COC_PULL_PENDING}</div>
        </div>
        <div className={`${sectionClass} p-4 opacity-50`} aria-disabled="true">
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">
            Combined exposure{" "}
            <span className="border-apollo-border rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide">
              Pending
            </span>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">{COC_PULL_PENDING}</div>
        </div>
        <div className={`${sectionClass} p-4 opacity-50`} aria-disabled="true">
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">
            Faculty on COC-coauthor pubs{" "}
            <span className="border-apollo-border rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide">
              Pending
            </span>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">{COC_PULL_PENDING}</div>
        </div>
      </div>

      <p className="text-muted-foreground mt-3 text-sm">
        A concerning flag or a COC-affiliated coauthor identifies where the covered-person-access
        question arises; it is NOT a violation determination — much academic collaboration is
        exempt, and each case needs a look at actual access and transaction type.
      </p>
    </section>
  );
}

/** The §1–§7 anchors, in page order — one source list so the sticky nav
 *  (below) and the section headings can't drift apart. */
const SECTION_NAV_ITEMS: { id: string; label: string }[] = [
  { id: "rollup", label: "1 · Rollup" },
  { id: "funding", label: "2 · Funding & access" },
  { id: "repos", label: "3 · Repositories & departments" },
  { id: "faculty", label: "4 · Faculty" },
  { id: "subtypes", label: "5 · Sub-types" },
  { id: "recent", label: "6 · Recent activity" },
  { id: "compliance", label: "7 · Compliance" },
];

/** Sticky section jump-nav (2026-08-16 ask: "the page is ~6 screens tall
 *  with no navigation"). Plain anchor links + `position: sticky` — no JS,
 *  no client island; native in-page anchors already do this. Repeats the
 *  Methods dialog trigger (same `doc` prop `RollupSection` uses) so it's
 *  reachable from anywhere on the page, not just §1's corner. */
function SectionNav({ doc }: { doc: ReturnType<typeof buildMethodsDoc> }) {
  return (
    <nav className="bg-apollo-surface border-apollo-border sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-1 py-2 text-xs">
      {SECTION_NAV_ITEMS.map((item) => (
        <a key={item.id} href={`#${item.id}`} className="hover:underline">
          {item.label}
        </a>
      ))}
      <span className="ml-auto">
        <DataSharingMethodsDialog doc={doc} />
      </span>
    </nav>
  );
}

/** Tier codes offered in the filter form, in the same severity order as
 *  `TIER_LABELS`/`TIER_ORDER` — `UNKNOWN` excluded, same rationale as
 *  `paddedTiers` in the report lib (it's a port-lag bucket, not a real
 *  filterable category). */
const FILTERABLE_TIERS = ["CONCERN", "FOREIGN_OPEN", "FOREIGN_CTRL", "US_OPEN", "US_CTRL", "REGISTRY"] as const;

/** Year-range + tier filter form (2026-08-16 ask). A plain GET `<form>` —
 *  native platform feature, no client state: submitting reloads the page
 *  with the new query string, which `parseDataSharingParams`/
 *  `loadDataSharingReport` already handle. Preserves the current sort choice
 *  via hidden inputs so applying a filter doesn't silently reset it. NIH-
 *  funded filter deliberately NOT offered here — see
 *  `DataSharingReportFilters`'s doc comment for why. */
function FilterBar({
  ui,
  bounds,
}: {
  ui: DataSharingUiParams;
  /** True min/max deposit year across the full corpus (2026-08-16 ask: "you
   *  can type a year below the earliest real deposit and get a silently-
   *  empty table"). Feeds each year input's ghost text (so the effective
   *  range is visible without being a value someone has to keep in sync) and
   *  its native `min`/`max` (the browser enforces the clamp, no JS needed).
   *  `undefined` (rendered as no placeholder/no clamp) only when
   *  `report.depositYearBounds` is null, i.e. no row anywhere carries a
   *  `depositYear`. */
  bounds: DataSharingReport["depositYearBounds"];
}) {
  const active = hasActiveFilters(ui.filters);
  return (
    <form method="get" className={`${sectionClass} mb-4 flex flex-wrap items-end gap-3 p-3 text-xs`}>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Deposit year from</span>
        <input
          type="number"
          name="yearFrom"
          defaultValue={ui.filters.yearFrom}
          placeholder={bounds ? String(bounds.min) : undefined}
          min={bounds?.min}
          max={bounds?.max}
          className="border-apollo-border w-20 rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">to</span>
        <input
          type="number"
          name="yearTo"
          defaultValue={ui.filters.yearTo}
          placeholder={bounds ? String(bounds.max) : undefined}
          min={bounds?.min}
          max={bounds?.max}
          className="border-apollo-border w-20 rounded border px-2 py-1"
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground">Tier</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {FILTERABLE_TIERS.map((tier) => (
            <label key={tier} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                name="tier"
                value={tier}
                defaultChecked={ui.filters.tiers?.includes(tier)}
              />
              {TIER_LABELS[tier]}
            </label>
          ))}
        </div>
      </fieldset>
      {/* Preserve sort choice across a filter change — filters reset page 1
          implicitly (no facPage hidden input), since the row count under a
          new filter makes the old page number meaningless. */}
      {ui.deptSort && <input type="hidden" name="deptSort" value={ui.deptSort} />}
      <input type="hidden" name="deptDir" value={ui.deptDir} />
      {ui.facSort && <input type="hidden" name="facSort" value={ui.facSort} />}
      <input type="hidden" name="facDir" value={ui.facDir} />
      <button type="submit" className="border-apollo-border rounded border px-3 py-1.5 hover:bg-apollo-surface-2">
        Apply filters
      </button>
      {active && (
        <Link href="/edit/data-sharing" className="hover:underline">
          Clear filters
        </Link>
      )}
      {active && (
        <p className="text-muted-foreground basis-full text-xs">
          Narrows the datasets/repositories/faculty/tier tables below. Share rate and PMC coverage on
          §1 stay institution-wide on purpose — they&apos;re a rate over the full corpus, and pairing a
          filtered numerator against that unfiltered denominator would read as sharing collapsing when
          nothing changed. Clear filters to confirm. Every CSV download on this page (aggregate and
          per-row items alike) exports the FULL unfiltered dataset, not this filtered view — there is
          no filtered-export path yet.
        </p>
      )}
    </form>
  );
}

export function DataSharingDashboard({ report, ui }: { report: DataSharingReport; ui: DataSharingUiParams }) {
  // Built once, passed to both the sticky nav and §1 — see `RollupSection`'s
  // doc prop comment for why this can't be built twice.
  const doc = buildMethodsDoc(report, { shareRateYearFloor: SHARE_RATE_YEAR_FLOOR });
  // Computed once here (2026-08-16), not per-section. Every DownloadLink's
  // relabeled caption needs the identical boolean `FilterBar` already
  // computes for its own Clear-filters link, so both read `hasActiveFilters`
  // instead of keeping two copies.
  const filtersActive = hasActiveFilters(ui.filters);
  return (
    <>
      <SectionNav doc={doc} />
      <p className="text-muted-foreground mb-3 text-sm">Data as of {formatDate(report.dataAsOf)}.</p>
      {/* Permanent methodology note (2026-08-16), NOT conditional on filter
          state. Unlike everything else in this component, this is a fixed
          historical marker. The FTE-narrowed share-rate denominator
          (`loadShareRateCorpus`'s doc comment in the report lib) roughly
          halved every corpus size on this page and roughly doubled every
          rate; a reader reconciling an old percentage against a new one
          needs the answer right here, at the source, not buried in the
          Methods dialog. */}
      <p className="text-muted-foreground mb-3 text-xs">
        Aug 2026: share-rate denominator narrowed to full-time faculty; rates roughly doubled vs.
        figures published before this date.
      </p>
      <FilterBar ui={ui} bounds={report.depositYearBounds} />
      <RollupSection report={report} doc={doc} filtersActive={filtersActive} />
      <FundingSection report={report} />
      <RepositoriesSection report={report} ui={ui} />
      <FacultySection report={report} ui={ui} />
      <SubtypesSection report={report} filtersActive={filtersActive} />
      <RecentActivitySection report={report} filtersActive={filtersActive} />
      <ComplianceSection report={report} filtersActive={filtersActive} />
    </>
  );
}
