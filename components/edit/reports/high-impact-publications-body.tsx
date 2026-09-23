/**
 * Report 9 — "High-impact publications" body: a filter rail (years, journal
 * families, the Profiles roster's person-type / unit facets, article type,
 * author position; plain GET params, `AutoSubmitForm` like reports 7 and 8)
 * beside Summary / Publications tabs and the `.xlsx` link
 * (`/api/edit/reports/high-impact-publications`, same query string). Loaders,
 * journal families and defaults live in `lib/edit/high-impact-pubs-report.ts`.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { PersonFilterFacets } from "@/components/edit/reports/article-count-facets";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import {
  ARTICLE_COUNT_CAVEAT,
  articleCountActiveFilters,
  loadArticleCountChoices,
  POSITION_LABEL,
} from "@/lib/edit/article-count-report";
import {
  HIGH_IMPACT_LIST_CAP,
  highImpactQueryString,
  JOURNAL_FAMILIES,
  loadHighImpactList,
  loadJournalCounts,
  parseHighImpactParams,
  type HighImpactParams,
  type HighImpactRow,
  type JournalCount,
} from "@/lib/edit/high-impact-pubs-report";
import type { PersonReportProps, ReportRender } from "@/lib/edit/report-registry";

const RAIL_HEADING = "mb-2 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const RAIL_OPTION = "flex items-start gap-2 py-[3px] text-[13px] leading-[1.4]";
const RAIL_BOX = "mt-[3px] accent-[var(--color-primary-cornell-red)]";
const SELECT = "w-full rounded border border-[#c8c6be] bg-white px-2 py-1 text-[13px]";
const TAB_ACTIVE = "border-apollo-maroon inline-block border-b-2 py-2.5 text-base font-medium";
const TAB_IDLE =
  "text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-2.5 text-base";
const TH = "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";
const TD = "border-apollo-border border-t px-3 py-2 align-top";
const NUM = `${TD} text-right tabular-nums`;

function toSearchParams(sp: PersonReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

type RailProps = {
  basePath: string;
  params: HighImpactParams;
  choices: { facets: DataQualityFacets; atypes: string[] };
  /** Appended to every DOM id: the phone sheet's copy passes "-sheet". */
  idSuffix?: string;
};

function Rail({ basePath, params, choices, idSuffix = "" }: RailProps) {
  const years = Array.from({ length: 30 }, (_, i) => new Date().getFullYear() + 1 - i);
  return (
    <div className="border-apollo-rail-border bg-apollo-rail rounded-xl border p-3">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Filters apply automatically</span>
        <a href={basePath} className="text-muted-foreground ml-auto text-xs hover:underline">
          Reset
        </a>
      </div>
      <AutoSubmitForm
        id={`high-impact-filters${idSuffix}`}
        action={basePath}
        className="group flex flex-col text-sm"
        data-testid="high-impact-filters"
      >
        <input type="hidden" name="view" value={params.view} />
        <div className="mb-5 flex gap-2">
          {(["from", "to"] as const).map((k) => (
            <label key={k} className="flex flex-1 flex-col">
              <span className={RAIL_HEADING}>{k === "from" ? "From" : "To"}</span>
              <select name={k} defaultValue={params[k]} className={SELECT}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <fieldset className="mb-5">
          <legend className={RAIL_HEADING}>Journals</legend>
          {JOURNAL_FAMILIES.map((f) => (
            <label key={f.key} className={RAIL_OPTION}>
              <input
                type="checkbox"
                name="journal"
                value={f.key}
                defaultChecked={params.journals.includes(f.key)}
                className={RAIL_BOX}
              />
              {f.label}
            </label>
          ))}
          <span className="text-muted-foreground mt-1 block text-[11px]">None selected = all.</span>
        </fieldset>
        <PersonFilterFacets
          facets={choices.facets}
          types={params.types}
          units={params.units}
          testId="high-impact-facets"
        />
        <p className="text-muted-foreground -mt-3 mb-5 text-[11px]">Counts are active people, not articles.</p>
        <label className="mb-5 flex flex-col">
          <span className={RAIL_HEADING}>Article type</span>
          <select name="atype" multiple size={6} defaultValue={params.atypes} className={SELECT}>
            {choices.atypes.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground mt-1 text-[11px]">None selected = all.</span>
        </label>
        <fieldset className="mb-5">
          <legend className={RAIL_HEADING}>Author position</legend>
          {(Object.keys(POSITION_LABEL) as (keyof typeof POSITION_LABEL)[]).map((p) => (
            <label key={p} className={RAIL_OPTION}>
              <input type="radio" name="pos" value={p} defaultChecked={params.pos === p} className={RAIL_BOX} />
              {POSITION_LABEL[p]}
            </label>
          ))}
        </fieldset>
        {/* No-JS fallback; the island hides it once hydrated. */}
        <button
          type="submit"
          className="border-foreground/40 hover:bg-apollo-surface-2 mb-2 self-start rounded border px-3 py-1.5 group-data-[hydrated=true]:hidden"
        >
          Apply
        </button>
      </AutoSubmitForm>
    </div>
  );
}

function SummaryTable({ counts, total }: { counts: JournalCount[]; total: number }) {
  return (
    <table className="w-full max-w-2xl text-sm" data-testid="high-impact-summary">
      <thead>
        <tr className="text-left">
          <th className={TH}>Journal family</th>
          <th className={TH}>Journal</th>
          <th className={`${TH} text-right`}>Articles</th>
        </tr>
      </thead>
      <tbody>
        {counts.map((c) => (
          <tr key={c.journal}>
            <td className={TD}>{c.family}</td>
            <td className={TD}>
              <PubJournal as="span" value={c.journal} />
            </td>
            <td className={NUM}>{c.count.toLocaleString()}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td className={TD}>Total</td>
          <td className={TD} />
          <td className={NUM}>{total.toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  );
}

function PublicationsTable({ rows }: { rows: HighImpactRow[] }) {
  return (
    <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-left text-sm" data-testid="high-impact-publications">
        <thead>
          <tr>
            <th className={TH}>Title</th>
            <th className={TH}>Journal</th>
            <th className={`${TH} text-right`}>Impact factor</th>
            <th className={TH}>WCM first / last author</th>
            <th className={TH}>Added to Entrez</th>
            <th className={`${TH} text-right`}>NIH citations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pmid}>
              <td className={TD}>
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.pmid)}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate hover:underline"
                >
                  <PubTitle value={r.title} />
                </a>
              </td>
              <td className={TD}>
                <PubJournal as="span" value={r.journal} />
              </td>
              <td className={NUM}>{r.jif?.toFixed(1) ?? "—"}</td>
              <td className={TD}>{r.authors.join("; ")}</td>
              <td className={`${TD} whitespace-nowrap`}>{r.dateAdded ?? "—"}</td>
              <td className={NUM}>{r.citations ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function renderHighImpactPublicationsReport({
  searchParams,
  basePath,
}: PersonReportProps): Promise<ReportRender> {
  const params = parseHighImpactParams(toSearchParams(searchParams));
  const [choices, counts] = await Promise.all([loadArticleCountChoices(), loadJournalCounts(params)]);
  const total = counts.reduce((s, c) => s + c.count, 0);
  const list =
    params.view === "publications" && total <= HIGH_IMPACT_LIST_CAP ? await loadHighImpactList(params) : null;
  const tab = (view: HighImpactParams["view"], label: string) => (
    <a
      href={`${basePath}?${highImpactQueryString(params, view)}`}
      className={params.view === view ? TAB_ACTIVE : TAB_IDLE}
      aria-current={params.view === view ? "page" : undefined}
      data-testid={`high-impact-view-${view}`}
    >
      {label}
    </a>
  );
  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Articles in top-tier journals by the scholars matching the filters. Opens on original research by
        full-time faculty as first or last author this year.
      </p>
    ),
    main: (
      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="hidden lg:block lg:w-64 lg:shrink-0" data-testid="high-impact-rail">
          <Rail basePath={basePath} params={params} choices={choices} />
        </aside>
        <div className="min-w-0 flex-1">
          <div className="mb-4 lg:hidden">
            <FiltersSheet
              activeCount={articleCountActiveFilters(params) + (params.journals.length < JOURNAL_FAMILIES.length ? 1 : 0)}
              testId="high-impact-filters-sheet-trigger"
            >
              <Rail basePath={basePath} params={params} choices={choices} idSuffix="-sheet" />
            </FiltersSheet>
          </div>
          <nav className="border-apollo-border mb-4 flex gap-6 border-b" aria-label="Report views">
            {tab("summary", "Summary")}
            {tab("publications", `Publications (${total.toLocaleString()})`)}
          </nav>
          {params.view === "summary" ? (
            <SummaryTable counts={counts} total={total} />
          ) : list ? (
            <PublicationsTable rows={list} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {total.toLocaleString()} articles is more than {HIGH_IMPACT_LIST_CAP.toLocaleString()}. Narrow the
              filters to list them.
            </p>
          )}
          <p className="mt-4">
            <a
              href={`/api/edit/reports/high-impact-publications?${highImpactQueryString(params)}`}
              className="text-apollo-maroon text-sm underline-offset-2 hover:underline"
              data-testid="high-impact-download"
            >
              Download .xlsx
            </a>
            <span className="text-muted-foreground text-xs">
              {" "}
              &mdash; publications (title, journal, impact factor, WCM first/last authors, Entrez date, NIH
              citations), a summary and the criteria
            </span>
          </p>
          <p className="text-muted-foreground mt-4 max-w-prose text-xs" role="note">
            {ARTICLE_COUNT_CAVEAT} Only ReCiter-confirmed authorships of active scholars count.
          </p>
        </div>
      </div>
    ),
  };
}
