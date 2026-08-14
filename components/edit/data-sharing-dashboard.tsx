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
 */
import Link from "next/link";

import { CopyButton } from "@/components/publication/copy-button";
import { Badge } from "@/components/ui/badge";
import { SHARE_RATE_YEAR_FLOOR, type DataSharingReport } from "@/lib/api/data-sharing-report";

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";
const sectionClass = "border-apollo-border bg-apollo-surface mt-3 overflow-x-auto rounded-md border";

/** "n/N (x%)" — deliberately never a bare percentage (a past review flagged
 *  that a naked percent on a small denominator implies false precision).
 *  `undefined` (row has no share-rate data merged) or a zero denominator both
 *  render "—" rather than "0/0 (NaN%)" or a misleading "0%". */
function formatShareRate(numerator: number | undefined, denominator: number | undefined): string {
  if (numerator === undefined || denominator === undefined || denominator === 0) return "—";
  const pct = Math.round((numerator / denominator) * 100);
  return `${numerator.toLocaleString()}/${denominator.toLocaleString()} (${pct}%)`;
}

function AccessChip({ accessModel }: { accessModel: string | null }) {
  if (accessModel === null) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={accessModel === "open" ? "default" : "secondary"}>
      {accessModel === "open" ? "Open" : "Controlled"}
    </Badge>
  );
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
        <a href="/edit/data-sharing/export" className="text-sm hover:underline" data-testid="ds-export-link">
          Download CSV
        </a>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Aggregate headline numbers for CTSA renewal writers and research deans.
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
          <span className="text-sm font-medium">One paragraph for the renewal</span>
          <span className="inline-flex items-center gap-1 text-xs">
            <CopyButton value={paragraph} label="Copy paragraph text" />
            Copy paragraph
          </span>
        </div>
        <p className="mt-2 text-sm">{paragraph}</p>
        <p className="text-muted-foreground mt-2 text-xs">
          Methodology travels with the number: extracted from PubMed DataBankList and full-text
          Data Availability statements, attributed via ReCiter disambiguation, deposit-vs-use
          classified. Counts are a floor, not a census — confirmed deposits only, not an estimate
          of the ceiling.
        </p>
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        <strong>Coverage skew:</strong> the full-text scan only sees full text that is actually
        retrievable. A department publishing more in low-PMC-coverage venues will look like it
        shares less than it does — state this on any cross-department comparison.
      </p>

      <p className="text-muted-foreground mt-2 text-xs">
        <strong>Share rate caveats:</strong> the denominator only counts publications from{" "}
        {SHARE_RATE_YEAR_FLOOR} onward — the extraction pipeline never scanned earlier pubs, so including them would
        manufacture &quot;no detected deposit&quot; for papers that were simply never checked.
        Deposit detection today also only covers full-time faculty, an extraction-pipeline scope
        rather than an SPS filter — a non-full-time scholar&apos;s rate will read 0/0, or a low
        denominator with a zero numerator, by construction, not as a finding about their sharing
        behavior.
      </p>
    </section>
  );
}

function FundingSection({ report }: { report: DataSharingReport }) {
  const { overall } = report;
  return (
    <section id="funding" className="scroll-mt-4 mt-10">
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
        separately tracked here and are counted as not NIH-funded alongside genuinely
        non-federal work.
      </p>
    </section>
  );
}

function RepositoriesSection({ report }: { report: DataSharingReport }) {
  return (
    <section id="repos" className="scroll-mt-4 mt-10">
      <h2 className="text-base font-semibold">3 · Repositories &amp; departments</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Audience: library / RDM team — targeting DMS training and repository support.
      </p>

      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Repository</th>
              <th className={thClass}>Access</th>
              <th className={`${thClass} text-right`}>Datasets</th>
            </tr>
          </thead>
          <tbody>
            {report.byRepository.map((r) => (
              <tr key={r.repository} className="border-apollo-border border-b">
                <td className={`${tdClass} font-medium`}>{r.repository}</td>
                <td className={tdClass}>
                  <AccessChip accessModel={r.accessModel} />
                </td>
                <td className={`${tdClass} text-right`}>{r.datasets.toLocaleString()}</td>
              </tr>
            ))}
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

function FacultySection({ report }: { report: DataSharingReport }) {
  return (
    <section id="faculty" className="scroll-mt-4 mt-10">
      <h2 className="text-base font-semibold">4 · Named faculty</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Per-individual counts — same access as sections 1–3 above, no separate review.
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
                <td className={`${tdClass} text-right`}>
                  {formatShareRate(f.shareRateNumerator, f.shareRateDenominator)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DataSharingDashboard({ report }: { report: DataSharingReport }) {
  return (
    <>
      <RollupSection report={report} />
      <FundingSection report={report} />
      <RepositoriesSection report={report} />
      <FacultySection report={report} />
    </>
  );
}
