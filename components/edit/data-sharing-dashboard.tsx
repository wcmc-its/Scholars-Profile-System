/**
 * `/edit/data-sharing` — S-Index Phase 1 admin/CTSA reporting dashboard.
 * Three sections as in-page anchors (`#rollup` / `#repos` / `#faculty`),
 * mirroring `~/Downloads/s-index-ui-proposal.html`'s IA — not its markup, this
 * reuses the existing table/`Badge` primitives the other Insights dashboards
 * use (`etl-status`, `usage`). Server component; the only interactive bit is
 * the "Copy paragraph" clipboard button, an existing client island.
 *
 * v1 scope: COUNTS ONLY (distinct datasets, depositing faculty, link volume).
 * No share rate, no full-text coverage — see `lib/api/data-sharing-report.ts`'s
 * header for why those are a fast-follow, not this pass. Strict-only: every
 * count here is the confirmed-deposit floor (`DatasetDeposit.confidence`
 * is only ever `'high'` in what's persisted today — see the 2026-08-12 plan's
 * "Strict/generous band" section). Named faculty (§3) ships identically to
 * §1–2 — one flag, no lock, no redaction (decided 2026-08-12).
 */
import Link from "next/link";

import { CopyButton } from "@/components/publication/copy-button";
import { Badge } from "@/components/ui/badge";
import type { DataSharingReport } from "@/lib/api/data-sharing-report";

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";
const sectionClass = "border-apollo-border bg-apollo-surface mt-3 overflow-x-auto rounded-md border";

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

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
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
    </section>
  );
}

function RepositoriesSection({ report }: { report: DataSharingReport }) {
  return (
    <section id="repos" className="scroll-mt-4 mt-10">
      <h2 className="text-base font-semibold">2 · Repositories &amp; departments</h2>
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
            </tr>
          </thead>
          <tbody>
            {report.byDepartment.map((d) => (
              <tr key={d.department} className="border-apollo-border border-b">
                <td className={tdClass}>{d.department}</td>
                <td className={`${tdClass} text-right`}>{d.datasets.toLocaleString()}</td>
                <td className={`${tdClass} text-right`}>{d.faculty.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Department dataset counts don&apos;t sum to the institutional total — a dataset with
        co-authors in two departments counts once in each. Don&apos;t treat this column as a
        partition of the rollup above.
      </p>
    </section>
  );
}

function FacultySection({ report }: { report: DataSharingReport }) {
  return (
    <section id="faculty" className="scroll-mt-4 mt-10">
      <h2 className="text-base font-semibold">3 · Named faculty</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Per-individual counts — same access as sections 1–2 above, no separate review.
      </p>

      <div className={sectionClass}>
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Faculty</th>
              <th className={thClass}>Department</th>
              <th className={`${thClass} text-right`}>Datasets</th>
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
      <RepositoriesSection report={report} />
      <FacultySection report={report} />
    </>
  );
}
