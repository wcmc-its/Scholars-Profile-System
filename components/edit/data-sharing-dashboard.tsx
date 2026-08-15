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
 */
import Link from "next/link";

import { CopyButton } from "@/components/publication/copy-button";
import { Badge } from "@/components/ui/badge";
import { SHARE_RATE_YEAR_FLOOR, type DataSharingReport } from "@/lib/api/data-sharing-report";
import { urlOf } from "@/lib/repository-tier";

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

function AccessChip({ accessModel }: { accessModel: string | null }) {
  if (accessModel === null) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={accessModel === "open" ? "default" : "secondary"}>
      {accessModel === "open" ? "Open" : "Controlled"}
    </Badge>
  );
}

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

/** `variant` mirrors severity: `destructive` for CONCERN, `secondary` for
 *  the foreign-hosted tiers, `outline` otherwise — same visual language as
 *  `AccessChip`, no new color system introduced. */
function TierChip({ tier }: { tier: string }) {
  const variant =
    tier === "CONCERN"
      ? "destructive"
      : tier === "FOREIGN_OPEN" || tier === "FOREIGN_CTRL"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{TIER_LABELS[tier] ?? tier}</Badge>;
}

function RollupSection({ report }: { report: DataSharingReport }) {
  const { overall } = report;
  const paragraph =
    `WCM researchers deposited at least ${overall.datasets.toLocaleString()} distinct datasets ` +
    `in public repositories, with ${overall.faculty.toLocaleString()} distinct depositing faculty ` +
    `across ${report.byDepartment.length} departments.`;

  return (
    <section id="rollup" className="scroll-mt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">1 · Institutional rollup</h2>
        {/* A plain <a>: /export is a CSV download route (route.ts), not a page,
            so <Link>'s client nav + prefetch would fetch the file itself. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/edit/data-sharing/export"
          className="text-sm hover:underline"
          data-testid="ds-export-link"
        >
          Download CSV
        </a>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Aggregate headline numbers for research leadership and compliance/grant reporting.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className={`${sectionClass} p-4`}>
          <div className="text-2xl font-semibold">{overall.datasets.toLocaleString()}</div>
          <div className="text-muted-foreground text-xs">Distinct datasets (strict floor)</div>
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
      </div>

      <div className={`${sectionClass} mt-4 p-4`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">One paragraph for reporting</span>
          <span className="inline-flex items-center gap-1 text-xs">
            <CopyButton value={paragraph} label="Copy paragraph text" />
            Copy paragraph
          </span>
        </div>
        <p className="mt-2 text-sm">{paragraph}</p>
        <p className="text-muted-foreground mt-2 text-xs">
          Methodology travels with the number: extracted from PubMed DataBankList and full-text Data
          Availability statements, attributed via ReCiter disambiguation, deposit-vs-use classified.
          Counts are a floor, not a census — confirmed deposits only, not an estimate of the
          ceiling.
        </p>
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        <strong>Coverage skew:</strong> the full-text scan only sees full text that is actually
        retrievable. A department publishing more in low-PMC-coverage venues will look like it
        shares less than it does — state this on any cross-department comparison.
      </p>

      <p className="text-muted-foreground mt-2 text-xs">
        <strong>Share rate caveats:</strong> the denominator only counts publications from{" "}
        {SHARE_RATE_YEAR_FLOOR} onward — the extraction pipeline never scanned earlier pubs, so
        including them would manufacture &quot;no detected deposit&quot; for papers that were simply
        never checked. Deposit detection today also only covers full-time faculty, an
        extraction-pipeline scope rather than an SPS filter — a non-full-time scholar&apos;s rate
        will read 0/0, or a low denominator with a zero numerator, by construction, not as a finding
        about their sharing behavior.
      </p>

      <div className={`${sectionClass} mt-4 p-4`}>
        <div className="text-sm font-medium">Publications by repository risk tier</div>
        <p className="text-muted-foreground mt-1 text-xs">
          Distinct publications with a detected deposit in a repository of each tier — tier-based
          only (host jurisdiction × access model); a publication with deposits in repositories of
          different tiers is counted in each.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
          {report.pubsByTier.map((t) => (
            <div key={t.tier} className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold">{t.pubs.toLocaleString()}</span>
              <span className="text-muted-foreground text-xs">{TIER_LABELS[t.tier] ?? t.tier}</span>
            </div>
          ))}
        </div>
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

      <h3 className="text-sm font-semibold">Repositories by risk tier</h3>
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
            {report.byRepositoryTier.map((t) => (
              <tr key={t.tier} className="border-apollo-border border-b">
                <td className={tdClass}>
                  <TierChip tier={t.tier} />
                </td>
                <td className={tdClass}>{t.repositories.join(", ")}</td>
                <td className={`${tdClass} text-right`}>{t.datasets.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-sm font-semibold">By repository</h3>
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
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {r.repository}
                      </a>
                    ) : (
                      r.repository
                    )}
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

      <h3 className="mt-6 text-sm font-semibold">By department</h3>
      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Department</th>
              <th className={`${thClass} text-right`}>Datasets</th>
              <th className={`${thClass} text-right`}>Depositing faculty</th>
              <th className={`${thClass} text-right`}>Open</th>
              <th className={`${thClass} text-right`}>Controlled</th>
              <th className={`${thClass} text-right`}>Registry</th>
              <th className={`${thClass} text-right`}>Share rate</th>
            </tr>
          </thead>
          <tbody>
            {report.byDepartment.map((d) => (
              <tr key={d.department} className="border-apollo-border border-b">
                <td className={tdClass}>{d.department}</td>
                <td className={`${tdClass} text-right`}>{d.datasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.faculty.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.openDatasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.controlledDatasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.registryDatasets.toLocaleString()}</td>
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

function FacultySection({ report }: { report: DataSharingReport }) {
  return (
    <section id="faculty" className="mt-10 scroll-mt-4">
      <h2 className="text-base font-semibold">4 · Named faculty</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Per-individual counts — same access as sections 1–3 above, no separate review.
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
              <th className={`${thClass} text-right`}>Open</th>
              <th className={`${thClass} text-right`}>Controlled</th>
              <th className={`${thClass} text-right`} title={CONCERNING_CAVEAT}>
                Concerning
              </th>
              <th className={`${thClass} text-right`} title={CONCERNING_CAVEAT}>
                Foreign-hosted
              </th>
              <th className={`${thClass} text-right`}>Share rate</th>
            </tr>
          </thead>
          <tbody>
            {report.byFaculty.map((f) => (
              <tr key={f.cwid} className="border-apollo-border border-b">
                <td className={tdClass}>
                  <Link href={`/scholar/${f.slug}`} className="hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className={tdClass}>{f.department ?? "—"}</td>
                <td className={`${tdClass} text-right`}>{f.datasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{f.openDatasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{f.controlledDatasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{f.concerningDeposits.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>
                  {f.foreignHostedDeposits.toLocaleString()}
                </td>
                <td className={`${tdClass} text-right`}>
                  {formatShareRate(f.shareRateNumerator, f.shareRateDenominator)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground mt-2 text-xs">
        <strong>{report.overall.concerningDepositInstances.toLocaleString()}</strong> deposit
        instance{report.overall.concerningDepositInstances === 1 ? "" : "s"} institution-wide
        flagged concerning by tier (same tier-only definition as the columns above) — not a
        distinct-dataset or distinct-publication count.
      </p>
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
      <h2 className="text-base font-semibold">5 · Deposits by data sub-type</h2>
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

export function DataSharingDashboard({ report }: { report: DataSharingReport }) {
  return (
    <>
      <p className="text-muted-foreground mb-3 text-sm">Data as of {formatDate(report.dataAsOf)}.</p>
      <RollupSection report={report} />
      <FundingSection report={report} />
      <RepositoriesSection report={report} />
      <FacultySection report={report} />
      <SubtypesSection report={report} />
    </>
  );
}
