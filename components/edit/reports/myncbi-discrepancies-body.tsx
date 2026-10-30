/**
 * Report 16 — NIH bibliography discrepancies body. One block per scholar, most
 * missing first: the MyNCBI PMIDs naming them that SPS has not confirmed (linked to
 * PubMed, with a Publication Manager link to curate), then — behind disclosures —
 * listed papers by other people (grant-linked, not gaps) and what their profile has
 * that the list does not. Plain GET
 * `AutoSubmitForm` rail: search, what to show, the shared person facets. Loader:
 * `lib/edit/myncbi-discrepancy-report.ts`. Superusers only.
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
import { PubTitle } from "@/components/publication/pub-html";
import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { db } from "@/lib/db";
import {
  MYNCBI_DISCREPANCY_LIST_CAP,
  MYNCBI_DISCREPANCY_SHOW,
  MYNCBI_DISCREPANCY_SHOW_LABEL,
  MYNCBI_EXTRA_TITLE_CAP,
  MYNCBI_SUSPECT_OVERLAP,
  loadMyncbiDiscrepancyReport,
  parseMyncbiDiscrepancyParams,
  type CitationItem,
  type MyncbiDiscrepancyScholar,
  type ReciterState,
} from "@/lib/edit/myncbi-discrepancy-report";
import { pmCurateHref, publicationManagerBaseUrl } from "@/lib/edit/orcid-queue";
import type { ReportRender, SuperuserReportProps } from "@/lib/edit/report-registry";

const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
const RADIO_INPUT = "accent-apollo-maroon size-4";
const SEARCH =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm";
const LINK = "hover:underline";
const FLAG = "bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2 py-0.5 text-[12px]";
/** A missing list this short renders open; longer ones start collapsed. */
const OPEN_MAX = 10;
/** Missing papers grouped by what the curator does in Publication Manager. */
const RECITER_GROUPS: { state: ReciterState; label: string }[] = [
  { state: "pending", label: "Pending in ReCiter: accept" },
  { state: "rejected", label: "Rejected in ReCiter: review" },
  { state: "none", label: "Not a ReCiter candidate: add" },
];
const fmt = (n: number) => n.toLocaleString("en-US");
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/** `curate` (with `cwid`) adds a per-paper link to the PubMed Add tab in Publication Manager. */
function Citations({ items, curate }: { items: CitationItem[]; curate?: { base: string; cwid: string } }) {
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
      {items.map((c) => (
        <li key={c.pmid} className="text-[13px] leading-snug">
          <a href={`https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/`} target="_blank" rel="noreferrer" className={`${LINK} tabular-nums`}>
            PMID {c.pmid}
          </a>{" "}
          <PubTitle value={c.title} />
          {(c.source || c.year) && (
            <span className="text-muted-foreground"> · {[c.source, c.year].filter(Boolean).join(", ")}</span>
          )}
          {curate && (
            <>
              {" "}
              <a
                href={pmCurateHref(curate.base, curate.cwid, { pmid: c.pmid }) ?? undefined}
                target="_blank"
                rel="noreferrer"
                className={`${LINK} text-[12px] whitespace-nowrap`}
              >
                Accept or reject in Publication Manager
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ScholarBlock({ s, curateBase }: { s: MyncbiDiscrepancyScholar; curateBase: string }) {
  const curate = pmCurateHref(curateBase, s.cwid);
  return (
    <section className="border-apollo-border border-t py-4" data-testid="myncbi-discrepancy-scholar">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <ScholarHoverCard cwid={s.cwid}>
          <a href={`/edit/scholar/${s.cwid}`} className="text-[15px] font-semibold hover:underline">
            {s.name}
          </a>
        </ScholarHoverCard>
        {s.department && <span className="text-muted-foreground text-[13px]">{s.department}</span>}
        <a href={s.url} target="_blank" rel="noreferrer" className={`${LINK} text-[13px]`}>
          MyNCBI bibliography
        </a>
        {s.suspect && (
          <span className={FLAG}>
            Only {Math.round((100 * s.matched) / s.listed)}% of this list is on the profile. It may be someone else&apos;s.
          </span>
        )}
        {curate && (
          <a href={curate} target="_blank" rel="noreferrer" className={`${LINK} text-[13px]`}>
            Curate in Publication Manager
          </a>
        )}
      </div>
      <p className="text-muted-foreground m-0 mt-1 text-[13px]">
        {fmt(s.listed)} PubMed citations on the list, {fmt(s.matched)} confirmed on the profile · fetched {day(s.fetchedAt)}
      </p>
      {s.missing.length > 0 && (
        <details className="mt-2" open={!s.suspect && s.missing.length <= OPEN_MAX}>
          <summary className="cursor-pointer text-xs font-semibold tracking-[0.08em] uppercase hover:underline">
            On the list, not confirmed on the profile ({fmt(s.missing.length)})
          </summary>
          {RECITER_GROUPS.map(({ state, label }) => {
            const items = s.missing.filter((c) => c.reciter === state);
            return (
              items.length > 0 && (
                <div key={state} className="mt-2" data-testid={`myncbi-missing-${state}`}>
                  <p className="text-muted-foreground m-0 text-[13px] font-semibold">
                    {label} ({fmt(items.length)})
                  </p>
                  <Citations items={items} curate={curate ? { base: curateBase, cwid: s.cwid } : undefined} />
                </div>
              )
            );
          })}
        </details>
      )}
      {s.notAuthored.length > 0 && (
        <details className="mt-2">
          <summary className="text-muted-foreground cursor-pointer text-[13px] hover:underline">
            On the list, by other authors ({fmt(s.notAuthored.length)})
          </summary>
          <Citations items={s.notAuthored} />
        </details>
      )}
      {s.extraCount > 0 && (
        <details className="mt-2">
          <summary className="text-muted-foreground cursor-pointer text-[13px] hover:underline">
            On the profile, not on the list ({fmt(s.extraCount)})
            {s.extraCount > s.extra.length && ` · newest ${fmt(s.extra.length)}`}
          </summary>
          <Citations items={s.extra} />
        </details>
      )}
    </section>
  );
}

export async function renderMyncbiDiscrepanciesReport({
  searchParams,
  basePath,
}: SuperuserReportProps): Promise<ReportRender> {
  const p = parseMyncbiDiscrepancyParams(searchParams);
  const [r, facets] = await Promise.all([loadMyncbiDiscrepancyReport(db.read, p), loadDataQualityFacets(db.read)]);
  const filtered = p.q !== "" || p.show !== "missing" || p.types.length > 0 || p.unitValues.length > 0;
  const curateBase = publicationManagerBaseUrl();

  const rail = (
    <ReportRail
      resetHref={filtered ? basePath : null}
      help="Filters apply automatically."
      testId="myncbi-discrepancy-rail"
    >
      <AutoSubmitForm action={basePath} className="group" data-testid="myncbi-discrepancy-filters">
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
        <RailSection label="Show" summary={MYNCBI_DISCREPANCY_SHOW_LABEL[p.show]} defaultOpen>
          <div className="flex flex-col gap-2">
            {MYNCBI_DISCREPANCY_SHOW.map((v) => (
              <label key={v} className={RADIO}>
                <input type="radio" name="show" value={v} defaultChecked={p.show === v} className={RADIO_INPUT} />
                {MYNCBI_DISCREPANCY_SHOW_LABEL[v]}
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
            testId="myncbi-discrepancy-person-facets"
            className="flex flex-col gap-3"
          />
        </RailSection>
      </AutoSubmitForm>
    </ReportRail>
  );

  return {
    subtitle: (
      <>
        Public MyNCBI bibliographies linked from scholars&apos; NIH biosketches, refreshed monthly, compared with
        their confirmed publications.
      </>
    ),
    main: (
      <ReportLayout rail={rail}>
        <ReportCard>
          <ReportStats
            stats={[
              { value: fmt(r.totals.scholars), label: "bibliographies" },
              { value: fmt(r.totals.listed), label: "PubMed citations listed" },
              { value: fmt(r.totals.matched), label: "confirmed on profiles" },
              { value: fmt(r.totals.missing), label: "missing from profiles" },
              { value: fmt(r.totals.byReciter.pending), label: "pending in ReCiter (accept)" },
              { value: fmt(r.totals.byReciter.rejected), label: "rejected in ReCiter (review)" },
              { value: fmt(r.totals.byReciter.none), label: "not ReCiter candidates (add)" },
              { value: fmt(r.totals.withMissing), label: "scholars missing any" },
              { value: fmt(r.totals.notAuthored), label: "listed papers by other authors" },
              { value: fmt(r.totals.suspect), label: "lists that may be someone else's" },
            ]}
          />
          <div className="mt-5" data-testid="myncbi-discrepancy-list">
            {r.scholars.length === 0 ? (
              <p className="text-muted-foreground m-0 text-[14px]">No bibliographies match these filters.</p>
            ) : (
              r.scholars.map((s) => <ScholarBlock key={s.cwid} s={s} curateBase={curateBase} />)
            )}
          </div>
          {r.matched > MYNCBI_DISCREPANCY_LIST_CAP && (
            <p className="text-muted-foreground mt-4 text-[13px]" role="note">
              Showing {fmt(MYNCBI_DISCREPANCY_LIST_CAP)} of {fmt(r.matched)} scholars, most missing first. Narrow the
              filters to see the rest.
            </p>
          )}
          <p className="text-muted-foreground mt-4 text-[12px]">
            Citations without a PMID are not compared. Missing papers are grouped by their ReCiter state as of last
            night: pending candidates to accept, papers someone rejected as &ldquo;not mine&rdquo; though the scholar lists
            them with NIH, and papers ReCiter never proposed, to add by PMID. A listed paper whose authors do not include the
            scholar&apos;s surname is shown under &ldquo;by other authors&rdquo; and not counted as missing: PIs link
            trainees&apos; and members&apos; papers to their grants in MyNCBI. A list with under{" "}
            {Math.round(100 * MYNCBI_SUSPECT_OVERLAP)}% of its PubMed citations on the profile is set aside as possibly
            someone else&apos;s and left out of the missing totals. &ldquo;On the profile, not on the list&rdquo; is weaker evidence:
            many people do not keep their MyNCBI list current. Up to {MYNCBI_EXTRA_TITLE_CAP} are titled per scholar.
          </p>
        </ReportCard>
      </ReportLayout>
    ),
  };
}
