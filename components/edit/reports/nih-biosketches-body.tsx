/**
 * Report 15 — NIH biosketches body. One block per scholar (newest biosketch first),
 * each biosketch a row; the statement text sits in a disclosure so the list stays
 * scannable. Plain GET `AutoSubmitForm` rail: search, what to show, the shared
 * person facets. Loader: `lib/edit/nih-biosketch-report.ts`. Superusers only.
 *
 * The text is internal: never published, never shown outside this report.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { PersonFilterFacets } from "@/components/edit/reports/article-count-facets";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
import {
  NIH_BIOSKETCH_LIST_CAP,
  NIH_BIOSKETCH_SHOW,
  NIH_BIOSKETCH_SHOW_LABEL,
  loadNihBiosketchReport,
  parseNihBiosketchParams,
  type NihBiosketchRow,
  type NihBiosketchScholar,
} from "@/lib/edit/nih-biosketch-report";
import type { ReportRender, SuperuserReportProps } from "@/lib/edit/report-registry";

const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const SEARCH =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm";
const TH = "text-muted-foreground px-3 py-2 text-xs font-medium tracking-[0.05em] uppercase";
const TD = "px-3 py-2 align-top text-[13px]";
const FLAG = "bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2 py-0.5 text-[12px]";
const fmt = (n: number) => n.toLocaleString("en-US");
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

const OrcidLink = ({ id }: { id: string }) => (
  <a href={`https://orcid.org/${id}`} target="_blank" rel="noreferrer" className="hover:underline">
    {id}
  </a>
);

function Sections({ b }: { b: NihBiosketchRow }) {
  const parts = [
    ["Personal statement", b.personalStatement],
    ["Contributions to science", b.contributions],
    ["Honors", b.honors],
  ].filter((x): x is [string, string] => !!x[1]);
  if (parts.length === 0) return <span className="text-muted-foreground">None found</span>;
  return (
    <details>
      <summary className="cursor-pointer hover:underline">{parts.map((p) => p[0]).join(" · ")}</summary>
      <div className="mt-2 flex max-w-[760px] flex-col gap-3">
        {parts.map(([label, text]) => (
          <div key={label}>
            <div className="text-muted-foreground text-xs font-semibold tracking-[0.08em] uppercase">{label}</div>
            <p className="m-0 mt-1 text-[13px] leading-relaxed whitespace-pre-line">{text}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function ScholarBlock({ s }: { s: NihBiosketchScholar }) {
  return (
    <section className="border-apollo-border border-t py-4" data-testid="nih-biosketch-scholar">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <ScholarHoverCard cwid={s.cwid}>
          <a href={`/edit/scholar/${s.cwid}`} className="text-[15px] font-semibold hover:underline">
            {s.name}
          </a>
        </ScholarHoverCard>
        {s.department && <span className="text-muted-foreground text-[13px]">{s.department}</span>}
        {s.orcidConflict && <span className={FLAG}>Different iDs across biosketches</span>}
        {s.orcidDiffers && <span className={FLAG}>Differs from the iD on file ({s.orcidOnFile})</span>}
      </div>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="text-left">
            <th className={TH}>Uploaded</th>
            <th className={TH}>Proposal</th>
            <th className={TH}>Form</th>
            <th className={TH}>Matched by</th>
            <th className={TH}>ORCID iD</th>
            <th className={TH}>MyNCBI</th>
            <th className={TH}>Text</th>
          </tr>
        </thead>
        <tbody>
          {s.biosketches.map((b) => (
            <tr key={b.docVersionId} className="border-apollo-border border-t">
              <td className={`${TD} whitespace-nowrap tabular-nums`}>{day(b.uploadedAt)}</td>
              <td className={`${TD} tabular-nums`}>{b.propNo}</td>
              <td className={TD}>{b.format === "common" ? "Common Form" : "Pre-2026"}</td>
              <td className={TD}>{b.attributedBy === "email" ? "Email" : "Name"}</td>
              <td className={`${TD} tabular-nums`}>{b.orcid ? <OrcidLink id={b.orcid} /> : "—"}</td>
              <td className={TD}>
                {b.myncbiUrl ? (
                  <a href={b.myncbiUrl} target="_blank" rel="noreferrer" className="hover:underline">
                    Bibliography
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className={TD}>
                <Sections b={b} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export async function renderNihBiosketchesReport({
  searchParams,
  basePath,
}: SuperuserReportProps): Promise<ReportRender> {
  const p = parseNihBiosketchParams(searchParams);
  const [r, facets] = await Promise.all([loadNihBiosketchReport(db.read, p), loadDataQualityFacets(db.read)]);
  const filtered = p.q !== "" || p.show !== "all" || p.types.length > 0 || p.unitValues.length > 0;

  const rail = (
    <ReportRail
      resetHref={filtered ? basePath : null}
      help="Filters apply automatically."
      testId="nih-biosketch-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="nih-biosketch-filters">
        <RailSection label="Search" summary={p.q || "Any scholar"} defaultOpen>
          <input
            type="search"
            name="q"
            defaultValue={p.q}
            placeholder="Name or CWID"
            aria-label="Search name or CWID"
            className={SEARCH}
          />
        </RailSection>
        <RailSection label="Show" summary={NIH_BIOSKETCH_SHOW_LABEL[p.show]} defaultOpen>
          <div className="flex flex-col gap-2">
            {NIH_BIOSKETCH_SHOW.map((v) => (
              <label key={v} className={RADIO}>
                <input type="radio" name="show" value={v} defaultChecked={p.show === v} className={RADIO_INPUT} />
                {NIH_BIOSKETCH_SHOW_LABEL[v]}
              </label>
            ))}
          </div>
        </RailSection>
        <RailSection
          label="People"
          summary={p.types.length + p.unitValues.length > 0 ? "Filtered" : "Everyone"}
          defaultOpen={p.types.length + p.unitValues.length > 0}
        >
          <PersonFilterFacets
            facets={facets}
            types={p.types}
            units={p.unitValues}
            testId="nih-biosketch-person-facets"
            className="flex flex-col gap-3"
          />
        </RailSection>
      </AutoSubmitForm>
    </ReportRail>
  );

  return {
    subtitle: <>From WCM grant applications in InfoEd, refreshed weekly. Confidential proposals are left out.</>,
    main: (
      <ReportLayout rail={rail}>
        <ReportCard>
          <ReportStats
            stats={[
              { value: fmt(r.totals.scholars), label: "scholars" },
              { value: fmt(r.totals.biosketches), label: "biosketches" },
              { value: fmt(r.totals.withOrcid), label: "with an ORCID iD" },
              { value: fmt(r.totals.withMyncbi), label: "with a MyNCBI bibliography" },
              { value: fmt(r.totals.flagged), label: "ORCID flagged" },
            ]}
          />
          <div className="mt-5" data-testid="nih-biosketch-list">
            {r.scholars.length === 0 ? (
              <p className="text-muted-foreground m-0 text-[14px]">No biosketches match these filters.</p>
            ) : (
              r.scholars.map((s) => <ScholarBlock key={s.cwid} s={s} />)
            )}
          </div>
          {r.matched > NIH_BIOSKETCH_LIST_CAP && (
            <p className="text-muted-foreground mt-4 text-[13px]" role="note">
              Showing {fmt(NIH_BIOSKETCH_LIST_CAP)} of {fmt(r.matched)} scholars, A–Z. Narrow the filters to see the rest.
            </p>
          )}
        </ReportCard>
      </ReportLayout>
    ),
  };
}
