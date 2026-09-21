/**
 * Report 8 — "Article counts" body: a filter rail (person type, primary
 * department, primary institution, article type, minimum JIF, author
 * position, year basis and
 * range — plain GET params, `AutoSubmitForm` like report 7) beside the
 * total, the per-year table and the `.xlsx` link
 * (`/api/edit/reports/article-count`, same query string). The loader,
 * counting rule and caveat live in `lib/edit/article-count-report.ts`.
 */
import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { JifSlider } from "@/components/edit/reports/jif-slider";
import {
  ARTICLE_COUNT_CAVEAT,
  ARTICLE_LIST_CAP,
  articleCountQueryString,
  BASIS_LABEL,
  JIF_MAX,
  loadArticleCountChoices,
  loadArticleCounts,
  parseArticleCountParams,
  POSITION_LABEL,
  type ArticleCountParams,
} from "@/lib/edit/article-count-report";
import { institutionDisplayName } from "@/lib/institutions";
import { roleCategoryLabel } from "@/lib/match-display";
import type { AdminReportProps, ReportRender } from "@/lib/edit/report-registry";

const RAIL_HEADING = "mb-2 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const RAIL_OPTION = "flex items-start gap-2 py-[3px] text-[13px] leading-[1.4]";
const RAIL_BOX = "mt-[3px] accent-[var(--color-primary-cornell-red)]";
const SELECT = "w-full rounded border border-[#c8c6be] bg-white px-2 py-1 text-[13px]";

function toSearchParams(sp: AdminReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

function FilterForm({
  basePath,
  params,
  choices,
}: {
  basePath: string;
  params: ArticleCountParams;
  choices: { types: string[]; depts: string[]; insts: string[]; atypes: string[] };
}) {
  const years = Array.from({ length: 30 }, (_, i) => new Date().getFullYear() + 1 - i);
  return (
    <AutoSubmitForm
      id="article-count-filters"
      action={basePath}
      className="group flex flex-col text-sm"
      data-testid="article-count-filters"
    >
      <fieldset className="mb-5">
        <legend className={RAIL_HEADING}>Year basis</legend>
        {(Object.keys(BASIS_LABEL) as (keyof typeof BASIS_LABEL)[]).map((b) => (
          <label key={b} className={RAIL_OPTION}>
            <input type="radio" name="basis" value={b} defaultChecked={params.basis === b} className={RAIL_BOX} />
            {BASIS_LABEL[b]}
          </label>
        ))}
      </fieldset>
      <div className="mb-5 flex gap-2">
        <label className="flex flex-1 flex-col">
          <span className={RAIL_HEADING}>From</span>
          <select name="from" defaultValue={params.from} className={SELECT}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col">
          <span className={RAIL_HEADING}>To</span>
          <select name="to" defaultValue={params.to} className={SELECT}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="mb-5">
        <legend className={RAIL_HEADING}>Person type</legend>
        {choices.types.map((t) => (
          <label key={t} className={RAIL_OPTION}>
            <input type="checkbox" name="types" value={t} defaultChecked={params.types.includes(t)} className={RAIL_BOX} />
            {roleCategoryLabel(t)}
          </label>
        ))}
        <p className="text-muted-foreground mt-1 text-[11px]">None checked = all.</p>
      </fieldset>
      <label className="mb-5 flex flex-col">
        <span className={RAIL_HEADING}>Primary department</span>
        <select name="dept" multiple size={8} defaultValue={params.depts} className={SELECT}>
          {choices.depts.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground mt-1 text-[11px]">None selected = all. Ctrl/Cmd-click for several.</span>
      </label>
      <label className="mb-5 flex flex-col">
        <span className={RAIL_HEADING}>Primary institution</span>
        <select name="inst" multiple size={4} defaultValue={params.insts} className={SELECT}>
          {choices.insts.map((i) => (
            <option key={i} value={i}>
              {institutionDisplayName(i)}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground mt-1 text-[11px]">None selected = all.</span>
      </label>
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
      <div className="mb-5">
        <span className={RAIL_HEADING}>Minimum Journal Impact Factor</span>
        <JifSlider name="jif" defaultValue={params.jif} max={JIF_MAX} />
      </div>
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
  );
}

export async function renderArticleCountReport({ searchParams, basePath }: AdminReportProps): Promise<ReportRender> {
  const params = parseArticleCountParams(toSearchParams(searchParams));
  const [choices, { rows, total }] = await Promise.all([loadArticleCountChoices(), loadArticleCounts(params)]);
  const qs = articleCountQueryString(params);
  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Distinct articles per year for the scholars matching the filters. Each article counts once,
        however many matching authors it has.
      </p>
    ),
    main: (
      <div className="mt-4 md:flex md:items-start md:gap-6">
        <div className="border-apollo-rail-border bg-apollo-rail rounded-xl border p-3 md:w-64 md:shrink-0">
          <FilterForm basePath={basePath} params={params} choices={choices} />
        </div>
        <div className="mt-4 flex-1 md:mt-0">
          <p className="text-3xl font-bold tabular-nums" data-testid="article-count-total">
            {total.toLocaleString()}
          </p>
          <p className="text-muted-foreground text-sm">
            articles, {params.basis === "fy" ? "FY" : ""}
            {params.from}
            {params.to !== params.from && `–${params.basis === "fy" ? "FY" : ""}${params.to}`}
            {params.basis === "cy" && " (calendar years)"}
          </p>
          <table className="mt-4 w-full max-w-sm text-sm" data-testid="article-count-table">
            <thead>
              <tr className="text-muted-foreground text-left text-xs uppercase tracking-wide">
                <th className="py-1 pr-4 font-semibold">{params.basis === "fy" ? "Fiscal year" : "Year"}</th>
                <th className="py-1 text-right font-semibold">Articles</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.year} className="border-apollo-border border-t">
                  <td className="py-1 pr-4">{params.basis === "fy" ? `FY${r.year}` : r.year}</td>
                  <td className="py-1 text-right tabular-nums">{r.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4">
            <a
              href={`/api/edit/reports/article-count?${qs}`}
              className="text-apollo-maroon text-sm underline-offset-2 hover:underline"
              data-testid="article-count-download"
            >
              Download .xlsx
            </a>
            <span className="text-muted-foreground text-xs">
              {" "}
              &mdash; counts, a Criteria sheet, and the article list with matching scholars
              {total > ARTICLE_LIST_CAP &&
                ` (omitted above ${ARTICLE_LIST_CAP.toLocaleString()} articles — narrow the filters)`}
            </span>
          </p>
          <p className="text-muted-foreground mt-4 max-w-prose text-xs" role="note">
            {ARTICLE_COUNT_CAVEAT}
            {params.basis === "fy" &&
              " Fiscal years run July 1 – June 30, named by the ending year, and are assigned by the date the article was added to PubMed."}
            {params.jif > 0 && " Articles in journals with no impact factor on file are excluded."}
          </p>
        </div>
      </div>
    ),
  };
}
