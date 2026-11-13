/**
 * Report 22 — Cross-campus duplicates body. One block per suggested pair (a WCM
 * scholar and a Cornell Ithaca NetID), strongest evidence first. Plain GET
 * `AutoSubmitForm` rail: search and band. Loader: `lib/edit/identity-links-report.ts`.
 * Superusers only; view-only, no download.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import {
  RailSection,
  ReportCard,
  ReportLayout,
  ReportRail,
  ReportStats,
} from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { db } from "@/lib/db";
import {
  IDENTITY_LINK_BANDS,
  IDENTITY_LINK_BAND_LABEL,
  IDENTITY_LINK_LIST_CAP,
  loadIdentityLinkReport,
  parseIdentityLinkParams,
  type IdentityLinkRow,
} from "@/lib/edit/identity-links-report";
import type { ReportRender, SuperuserReportProps } from "@/lib/edit/report-registry";

const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const SEARCH =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm";
const FLAG =
  "bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2 py-0.5 text-[12px]";
const BAND_SHORT = { known: "Known", strong: "Strong", possible: "Possible" } as const;
const fmt = (n: number) => n.toLocaleString("en-US");
const day = (d: Date) =>
  d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

function Evidence({ r }: { r: IdentityLinkRow }) {
  const items: React.ReactNode[] = [];
  if (r.signals.ed) items.push("The WCM directory lists this NetID for them");
  if (r.signals.orcid)
    items.push(
      <>
        Both carry ORCID iD{" "}
        <a
          href={`https://orcid.org/${r.signals.orcid}`}
          target="_blank"
          rel="noreferrer"
          className="tabular-nums hover:underline"
        >
          {r.signals.orcid}
        </a>
      </>,
    );
  if (r.signals.email) items.push(`The Cornell record lists ${r.signals.email}`);
  if (r.signals.name) items.push("Same name, held by one person on each campus");
  return (
    <ul className="text-muted-foreground m-0 mt-1.5 list-disc pl-5 text-[13px]">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function PairBlock({ r }: { r: IdentityLinkRow }) {
  return (
    <section className="border-apollo-border border-t py-3" data-testid="identity-link-pair">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={FLAG}>{BAND_SHORT[r.band]}</span>
        <ScholarHoverCard cwid={r.cwid}>
          <a href={`/edit/scholar/${r.cwid}`} className="text-[15px] font-semibold hover:underline">
            {r.wcmName}
          </a>
        </ScholarHoverCard>
        <span className="text-muted-foreground text-[13px] tabular-nums">{r.cwid}</span>
        {r.wcmDepartment && (
          <span className="text-muted-foreground text-[13px]">{r.wcmDepartment}</span>
        )}
        {r.leftWcm && <span className={FLAG}>No longer at WCM</span>}
      </div>
      <p className="m-0 mt-1 text-[13px]">
        Cornell Ithaca: <span className="font-semibold">{r.cornellName ?? "Unknown name"}</span>{" "}
        <span className="text-muted-foreground tabular-nums">{r.netid}</span>
        {(r.cornellTitle || r.cornellDepartment) && (
          <span className="text-muted-foreground">
            {" "}
            · {[r.cornellTitle, r.cornellDepartment].filter(Boolean).join(", ")}
          </span>
        )}
      </p>
      <Evidence r={r} />
    </section>
  );
}

export async function renderIdentityLinksReport({
  searchParams,
  basePath,
}: SuperuserReportProps): Promise<ReportRender> {
  const p = parseIdentityLinkParams(searchParams);
  const r = await loadIdentityLinkReport(db.read, p);
  const filtered = p.q !== "" || p.band !== "all";
  const bandSummary = p.band === "all" ? "All pairs" : IDENTITY_LINK_BAND_LABEL[p.band];

  const rail = (
    <ReportRail
      resetHref={filtered ? basePath : null}
      help="Filters apply automatically."
      testId="identity-link-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="identity-link-filters">
        <RailSection label="Search" summary={p.q || "Anyone"} defaultOpen>
          <input
            type="search"
            name="q"
            defaultValue={p.q}
            placeholder="Name, CWID or NetID"
            aria-label="Search name, CWID or NetID"
            className={SEARCH}
          />
        </RailSection>
        <RailSection label="Evidence" summary={bandSummary} defaultOpen>
          <div className="flex flex-col gap-2">
            {(["all", ...IDENTITY_LINK_BANDS] as const).map((v) => (
              <label key={v} className={RADIO}>
                <input
                  type="radio"
                  name="band"
                  value={v}
                  defaultChecked={p.band === v}
                  className={RADIO_INPUT}
                />
                {v === "all" ? "All pairs" : IDENTITY_LINK_BAND_LABEL[v]}
              </label>
            ))}
          </div>
        </RailSection>
      </AutoSubmitForm>
    </ReportRail>
  );

  return {
    subtitle: (
      <>
        WCM scholars who probably also hold a Cornell Ithaca NetID, refreshed weekly
        {r.computedAt ? `, last on ${day(r.computedAt)}` : ""}.
      </>
    ),
    main: (
      <ReportLayout rail={rail}>
        <ReportCard>
          <ReportStats
            stats={[
              { value: fmt(r.total), label: "suggested pairs" },
              { value: fmt(r.byBand.known), label: "known (in the directory)" },
              { value: fmt(r.byBand.strong), label: "strong (shared ORCID or email)" },
              { value: fmt(r.byBand.possible), label: "possible (same name only)" },
            ]}
          />
          <div className="mt-5" data-testid="identity-link-list">
            {r.rows.length === 0 ? (
              <p className="text-muted-foreground m-0 text-[14px]">
                {r.total === 0
                  ? "No pairs yet. The weekly job has not run."
                  : "No pairs match these filters."}
              </p>
            ) : (
              r.rows.map((row) => <PairBlock key={`${row.cwid}-${row.netid}`} r={row} />)
            )}
          </div>
          {r.matched > IDENTITY_LINK_LIST_CAP && (
            <p className="text-muted-foreground mt-4 text-[13px]" role="note">
              Showing {fmt(IDENTITY_LINK_LIST_CAP)} of {fmt(r.matched)} pairs, strongest first.
              Narrow the filters to see the rest.
            </p>
          )}
          <p className="text-muted-foreground mt-4 text-[12px]">
            Known pairs are ones the WCM directory already records. Strong pairs share an ORCID iD,
            or the Cornell record carries the scholar&apos;s WCM email. Possible pairs only share a
            name, and only names held by exactly one person on each campus are suggested, so check
            them before acting. A scholar or NetID in a known pair is not suggested with anyone
            else. The Cornell side is the whole Ithaca roster, staff and students included.
          </p>
        </ReportCard>
      </ReportLayout>
    ),
  };
}
