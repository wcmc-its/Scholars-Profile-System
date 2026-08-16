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

import { DataSharingMethodsDialog } from "@/components/edit/data-sharing-methods";
import { DefinedTerm } from "@/components/edit/data-sharing-term";
import { resolveDatasetUrl } from "@/components/profile/datasets-section";
import {
  parseSensitiveSubtypes,
  SHARE_RATE_YEAR_FLOOR,
  type DataSharingReport,
} from "@/lib/api/data-sharing-report";
import { buildMethodsDoc } from "@/lib/edit/data-sharing-methods-doc";
import { tierOf, urlOf } from "@/lib/repository-tier";

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";
const sectionClass =
  "border-apollo-border bg-apollo-surface mt-3 overflow-x-auto rounded-md border";

/** "n/N (x%)" — deliberately never a bare percentage (a past review flagged
 *  that a naked percent on a small denominator implies false precision).
 *  `undefined` (row has no share-rate data merged) or a zero denominator both
 *  render "—" rather than "0/0 (NaN%)" or a misleading "0%". */
function formatShareRate(numerator: number | undefined, denominator: number | undefined): string {
  if (numerator === undefined || denominator === undefined || denominator === 0) return "—";
  const pct = Math.round((numerator / denominator) * 100);
  return `${numerator.toLocaleString()}/${denominator.toLocaleString()} (${pct}%)`;
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

/** Per-table CSV link — a plain <a> because the target is a download route
 *  handler; <Link>'s client nav + prefetch would fetch the file itself.
 *  `label` defaults to the aggregate link's text; the `?grain=items`
 *  drill-down links pass "Download items CSV" (v3 — the stakeholder wants
 *  each table's underlying item rows one click away, not just the rollup). */
function DownloadLink({
  href,
  label = "Download CSV",
  className = "text-xs hover:underline",
  testId,
}: {
  href: string;
  label?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <a href={href} className={className} data-testid={testId}>
      {label}
    </a>
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
 *  `TierChip` labels (v3 term-hover pass). Both FOREIGN_* tiers share the one
 *  "Foreign-hosted" entry. US tiers and UNKNOWN are absent on purpose — the
 *  glossary defines the risk vocabulary, and "US-hosted, open" needs no
 *  definition; an absent key renders the label plain, no hover. */
const TIER_GLOSSARY_TERM: Record<string, string> = {
  CONCERN: "Country of concern",
  FOREIGN_OPEN: "Foreign-hosted",
  FOREIGN_CTRL: "Foreign-hosted",
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

/** The mockup's signature element: a proportional stacked bar over
 *  `pubsByTier` (already severity-sorted by `TIER_ORDER` upstream) with a
 *  legend. Zero-count tiers get no bar segment but keep a legend entry, so
 *  "Country of concern 0" stays visible as a statement rather than vanishing. */
function TierSpectrum({ rows }: { rows: DataSharingReport["pubsByTier"] }) {
  const total = rows.reduce((sum, t) => sum + t.pubs, 0);
  return (
    <>
      {total > 0 && (
        <div className="border-apollo-border mt-3 flex h-5 overflow-hidden rounded border">
          {rows
            .filter((t) => t.pubs > 0)
            .map((t) => (
              <div
                key={t.tier}
                style={{
                  width: `${(t.pubs / total) * 100}%`,
                  backgroundColor: TIER_COLORS[t.tier] ?? TIER_COLORS.UNKNOWN,
                }}
                title={`${TIER_LABELS[t.tier] ?? t.tier} · ${t.pubs.toLocaleString()}`}
              />
            ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rows.map((t) => (
          <span key={t.tier} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: TIER_COLORS[t.tier] ?? TIER_COLORS.UNKNOWN }}
            />
            {/* Same glossary hover as `TierChip` — the legend is where
                "Country of concern 0" is most likely to be read first, so the
                definition has to be reachable right here, not only in §3. */}
            {TIER_GLOSSARY_TERM[t.tier] ? (
              <DefinedTerm term={TIER_GLOSSARY_TERM[t.tier]}>
                <span className="text-muted-foreground">{TIER_LABELS[t.tier] ?? t.tier}</span>
              </DefinedTerm>
            ) : (
              <span className="text-muted-foreground">{TIER_LABELS[t.tier] ?? t.tier}</span>
            )}
            <span className="font-semibold">{t.pubs.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function RollupSection({ report }: { report: DataSharingReport }) {
  const { overall } = report;
  // Built here (server side) and passed down whole — the dialog is a client
  // island and must never import the report lib itself; `buildMethodsDoc` is
  // pure and `DataSharingReport` satisfies its structural param type.
  const doc = buildMethodsDoc(report, { shareRateYearFloor: SHARE_RATE_YEAR_FLOOR });

  return (
    <section id="rollup" className="scroll-mt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">1 · Institutional rollup</h2>
        <span className="inline-flex items-center gap-4">
          <DataSharingMethodsDialog doc={doc} />
          <DownloadLink
            href="/edit/data-sharing/export"
            className="text-sm hover:underline"
            testId="ds-export-link"
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
            Confirmed first/last-author pubs with a detected deposit
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            since {SHARE_RATE_YEAR_FLOOR}, no lock to a sensitive-data subset
          </div>
        </div>
        {/* PMC coverage pair (v3): the full-text arm of the deposit scan can
            only inspect pubs whose full text is in PMC, so (a) how much of
            the corpus that is, and (b) the share rate over just that
            PMC-covered subset — the denominator the scan can actually see.
            See `pmcCoverage`'s doc comment in the report lib. */}
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">
            {formatShareRate(overall.pmcCoveredPubs, overall.shareRateDenominator)}
          </div>
          <div className="text-muted-foreground text-xs">In PMC</div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            corpus publications with PubMed Central full text
          </div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">
            {formatShareRate(overall.pmcDepositedPubs, overall.pmcCoveredPubs)}
          </div>
          <div className="text-muted-foreground text-xs">PMC-covered share rate</div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            PMC-covered pubs with a detected deposit — the denominator the full-text scan can
            actually see
          </div>
        </div>
      </div>

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
  return (
    <section id="funding" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">2 · Funding</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        NIH-funded share of the same non-registry deposited publications the access-model split
        above is built from.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
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
        work.
      </p>
    </section>
  );
}

function RepositoriesSection({ report }: { report: DataSharingReport }) {
  return (
    <section id="repos" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">3 · Repositories &amp; departments</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Audience: library / RDM team — targeting DMS training and repository support.
      </p>

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Repositories by risk tier</h3>
        <DownloadLink href="/edit/data-sharing/export?section=tiers" />
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Tier-based only — country-of-concern host or foreign-hosted repository; does not include
        sensitive data-type detection.
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
          <DownloadLink href="/edit/data-sharing/export?section=repositories" />
          <DownloadLink
            href="/edit/data-sharing/export?section=repositories&grain=items"
            label="Download items CSV"
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">By department</h3>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=departments" />
          <DownloadLink
            href="/edit/data-sharing/export?section=departments&grain=items"
            label="Download items CSV"
          />
        </span>
      </div>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Department</th>
              <th className={`${thClass} text-right`}>Datasets</th>
              <th className={`${thClass} text-right`}>Depositing faculty</th>
              {/* Access-model group — `exposureColClass` bands th + td, see
                  the const's doc comment. */}
              <th className={`${thClass} ${exposureColClass} text-right`}>Open</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>Controlled</th>
              <th className={`${thClass} ${exposureColClass} text-right`}>Registry</th>
              <th className={`${thClass} text-right`}>Share rate</th>
            </tr>
          </thead>
          <tbody>
            {report.byDepartment.map((d) => (
              <tr key={d.department} className="border-apollo-border border-b">
                <td className={tdClass}>{d.department}</td>
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

/** The mockup's "+N more" collapsed-row pattern: the table shows only the
 *  top rows (byFaculty arrives sorted datasets-desc), a full 500+-row wall
 *  was the explicit complaint. The full list stays one click away in the CSV
 *  export. ponytail: static cap; a client-island expander if someone needs
 *  row 26 on-page. */
const FACULTY_ROW_CAP = 25;

function FacultySection({ report }: { report: DataSharingReport }) {
  const rows = report.byFaculty.slice(0, FACULTY_ROW_CAP);
  const more = report.byFaculty.length - rows.length;
  return (
    <section id="faculty" className="mt-10 scroll-mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">4 · Named faculty</h2>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=faculty" />
          <DownloadLink
            href="/edit/data-sharing/export?section=faculty&grain=items"
            label="Download items CSV"
          />
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Per-individual counts, top {FACULTY_ROW_CAP} by dataset count — same access as sections 1–3
        above, no separate review.
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        <strong>Concerning / Foreign-hosted:</strong> {CONCERNING_CAVEAT}
      </p>

      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Faculty</th>
              <th className={thClass}>Department</th>
              <th className={`${thClass} text-right`}>Datasets</th>
              {/* Exposure group — `exposureColClass` bands th + td, see the
                  const's doc comment. The Concerning/Foreign-hosted headers
                  carry `DefinedTerm` hovers (glossary definition + the
                  tier-only caveat) — these replaced bare `title=` attrs in
                  the v3 pass; the caveat text itself must survive any future
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
              <th className={`${thClass} ${exposureColClass} text-right`}>
                <DefinedTerm term="Foreign-hosted" caveat={CONCERNING_CAVEAT}>
                  Foreign-hosted
                </DefinedTerm>
              </th>
              <th className={`${thClass} text-right`}>Share rate</th>
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
                <td className={tdClass}>{f.department ?? "—"}</td>
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
                <td className={`${tdClass} ${exposureColClass} text-right`}>
                  {f.foreignHostedDeposits.toLocaleString()}
                </td>
                <td className={`${tdClass} text-right`}>
                  {formatShareRate(f.shareRateNumerator, f.shareRateDenominator)}
                </td>
              </tr>
            ))}
            {more > 0 && (
              <tr>
                <td className={`${tdClass} text-muted-foreground`} colSpan={8}>
                  {/* Same route-handler <a> as the §1 "Download CSV" link —
                      <Link> would prefetch the file itself. */}
                  + {more.toLocaleString()} more — full list in the{" "}
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                  <a href="/edit/data-sharing/export?section=faculty" className="hover:underline">
                    CSV export
                  </a>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

function SubtypesSection({ report }: { report: DataSharingReport }) {
  if (report.bySubtype.length === 0) return null;
  return (
    <section id="subtypes" className="scroll-mt-4 mt-10">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">5 · Deposits by data sub-type</h2>
        <span className="inline-flex items-center gap-3">
          <DownloadLink href="/edit/data-sharing/export?section=subtypes" />
          <DownloadLink
            href="/edit/data-sharing/export?section=subtypes&grain=items"
            label="Download items CSV"
          />
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Granular sensitive sub-types detected per deposit, grouped by coarse category —
        deposit-INSTANCE counts, same grain as the link counts elsewhere on this page, not
        distinct datasets. A deposit spanning more than one sub-type counts once toward each.
      </p>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Category</th>
              <th className={thClass}>Sub-type</th>
              <th className={`${thClass} text-right`}>Deposit instances</th>
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
              if (!isGroupStart) {
                return (
                  <tr key={`${s.category}|${s.subtype}`} className="border-apollo-border border-b">
                    <td className={tdClass}>{s.subtype}</td>
                    <td className={`${tdClass} text-right`}>{s.count.toLocaleString()}</td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecentActivitySection({ report }: { report: DataSharingReport }) {
  return (
    <section id="recent" className="mt-10 scroll-mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">6 · Recent activity</h2>
        {/* Item grain — the default (no-section) export IS this table, in full. */}
        <DownloadLink href="/edit/data-sharing/export" />
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
                        <ExternalA href={accessionUrl}>{r.accessionOrDoi}</ExternalA>
                      ) : (
                        r.accessionOrDoi
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* No accession fallback here anymore — the accession has
                      its own adjacent column now (v3). */}
                  <td className={tdClass}>{r.title || "—"}</td>
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
                  <td className={tdClass}>{r.department ?? "—"}</td>
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
function ComplianceSection({ report }: { report: DataSharingReport }) {
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
            deposit-instance count, not distinct datasets or publications
          </div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">Pubs with a COC-affiliated coauthor</div>
          <div className="text-muted-foreground mt-0.5 text-xs">{COC_PULL_PENDING}</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">Combined exposure</div>
          <div className="text-muted-foreground mt-0.5 text-xs">{COC_PULL_PENDING}</div>
        </div>
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">—</div>
          <div className="text-muted-foreground text-xs">Faculty on COC-coauthor pubs</div>
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

export function DataSharingDashboard({ report }: { report: DataSharingReport }) {
  return (
    <>
      <p className="text-muted-foreground mb-3 text-sm">Data as of {formatDate(report.dataAsOf)}.</p>
      <RollupSection report={report} />
      <FundingSection report={report} />
      <RepositoriesSection report={report} />
      <FacultySection report={report} />
      <SubtypesSection report={report} />
      <RecentActivitySection report={report} />
      <ComplianceSection report={report} />
    </>
  );
}
