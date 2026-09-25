"use client";

/**
 * Report 5's results (reports redesign, `Clinical Trials Redesign.dc.html`):
 * the headline numbers with the `.xlsx` button, the Trials / By member tabs,
 * the inline search / status / phase bar, and the tab's table.
 *
 * Every trial for the center arrives once from the server; the filters narrow
 * it here, with no server trip, and are mirrored into the URL (`view`, `q`,
 * `status`, `phase`, via `history.replaceState`) so a shared link or a reload
 * reopens the same view, and the download link carries the same filters to
 * the route, which parses them with the same `parseClinicalTrialsParams`.
 * Inline selects rather than `ReportRail`: two small facets and a search box
 * (plan D4: the rail is for four or more facets).
 *
 * Mobile: the filter bar wraps, and each table scrolls inside its own box,
 * never the page. Type-only imports from server code; the value imports are
 * the pure `lib/edit/clinical-trials-report.ts`.
 */
import { Download } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ReportStats } from "@/components/edit/reports/report-ui";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import {
  clinicalTrialsDownloadNote,
  clinicalTrialsQueryString,
  clinicalTrialsTotals,
  filterTrials,
  PHASE_OPTIONS,
  phaseLabel,
  STATUS_OPTIONS,
  summarizeMembers,
  trialStatusLabel,
  type ClinicalTrialsParams,
  type ClinicalTrialsView,
  type MemberSummary,
  type TrialGroup,
  type TrialStatusKey,
} from "@/lib/edit/clinical-trials-report";
import { cn } from "@/lib/utils";

const TH =
  "text-muted-foreground px-3 py-2.5 text-left text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
const TD = "px-3 py-3 align-top";

const STATUS_PILL: Record<TrialStatusKey, string> = {
  open: "text-apollo-slate bg-apollo-slate-tint border-apollo-slate-tint-border",
  closed: "text-foreground bg-apollo-surface-2 border-apollo-border-strong",
  irb: "text-foreground bg-apollo-surface-2 border-apollo-border-strong",
  suspended: "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border",
  other: "text-muted-foreground bg-apollo-surface-2 border-apollo-border",
};

const ctgovUrl = (nct: string) => `https://clinicaltrials.gov/study/${encodeURIComponent(nct)}`;

function StatusPill({ trial }: { trial: TrialGroup }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-px text-xs font-medium whitespace-nowrap",
        STATUS_PILL[trial.statusKey],
      )}
    >
      {trialStatusLabel(trial.status)}
    </span>
  );
}

/** The NCT link, or the "Local only · no NCT" tag for an unregistered trial. */
function NctTag({ nct }: { nct: string | null }) {
  if (nct) {
    return (
      <a
        href={ctgovUrl(nct)}
        target="_blank"
        rel="noopener noreferrer"
        title="View on ClinicalTrials.gov"
        className="text-apollo-slate font-mono text-xs whitespace-nowrap hover:underline"
      >
        {nct} ↗
      </a>
    );
  }
  return (
    <span
      title="Not registered on ClinicalTrials.gov"
      className="bg-apollo-surface-2 border-apollo-border-strong rounded border px-1.5 text-xs whitespace-nowrap"
      data-testid="ct-local-only"
    >
      Local only · no NCT
    </span>
  );
}

const roleText = (role: string) =>
  role.toLowerCase() === "principal investigator" ? "Principal investigator" : role;

type MemberSort = "name" | "pi" | "open";

const lastName = (name: string) => name.trim().split(/\s+/).pop() ?? name;

export function sortMembers(
  rows: ReadonlyArray<MemberSummary>,
  key: MemberSort,
  dir: 1 | -1,
): MemberSummary[] {
  const val = {
    name: (r: MemberSummary) => lastName(r.name),
    pi: (r: MemberSummary) => r.asPi,
    open: (r: MemberSummary) => r.open,
  }[key];
  return [...rows].sort((x, y) => {
    const a = val(x);
    const b = val(y);
    const c = typeof a === "string" ? a.localeCompare(b as string) : a - (b as number);
    return c * dir || lastName(x.name).localeCompare(lastName(y.name));
  });
}

export function ClinicalTrialsResults({
  trials,
  initial,
  basePath,
  centerCode,
  keepQuery,
  cap,
}: {
  /** Every trial for the center, unfiltered. */
  trials: TrialGroup[];
  initial: ClinicalTrialsParams;
  basePath: string;
  centerCode: string;
  /** Page params that aren't filters (`center=…`), kept on the URL as given. */
  keepQuery: string;
  /** SCHOLAR_EXPORT_CAP, from the server. */
  cap: number;
}) {
  const [params, setParams] = useState<ClinicalTrialsParams>(initial);
  const set = (patch: Partial<ClinicalTrialsParams>) => setParams((p) => ({ ...p, ...patch }));

  const filtered = useMemo(() => filterTrials(trials, params), [trials, params]);
  const members = useMemo(() => summarizeMembers(filtered), [filtered]);
  const totals = clinicalTrialsTotals(filtered);
  const note = clinicalTrialsDownloadNote(totals.members, cap);

  const href = (p: ClinicalTrialsParams) => {
    const qs = [keepQuery, clinicalTrialsQueryString(p)].filter(Boolean).join("&");
    return qs ? `${basePath}?${qs}` : basePath;
  };
  useEffect(() => {
    window.history.replaceState(window.history.state, "", href(params));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- href is derived from params
  }, [params]);

  const downloadQs = [
    `center=${encodeURIComponent(centerCode)}`,
    clinicalTrialsQueryString(params, false),
  ]
    .filter(Boolean)
    .join("&");
  const anyFilter = Boolean(params.q || params.status || params.phase);

  const tab = (v: ClinicalTrialsView, label: string) => (
    <a
      href={href({ ...params, view: v })}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        set({ view: v });
      }}
      aria-current={params.view === v ? "page" : undefined}
      data-testid={`ct-view-${v}`}
      className={cn(
        "-mb-px border-b-2 py-2.5 text-base whitespace-nowrap tabular-nums",
        params.view === v
          ? "border-apollo-maroon text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </a>
  );
  const selectClass = (on: boolean) =>
    cn(
      "h-[34px] min-w-0 rounded-md border px-2 text-sm",
      on
        ? "border-apollo-slate bg-apollo-slate-tint"
        : "border-apollo-border-strong bg-apollo-surface",
    );

  return (
    <div data-testid="clinical-trials-results">
      <ReportStats
        testId="ct-stats"
        stats={[
          { value: totals.trials.toLocaleString(), label: "trials" },
          {
            value: totals.members.toLocaleString(),
            label: `members on trials · ${totals.links.toLocaleString()} links`,
          },
          { value: totals.open.toLocaleString(), label: "open to accrual" },
          { value: totals.registered.toLocaleString(), label: "registered on ClinicalTrials.gov" },
        ]}
        aside={
          <div className="flex flex-col items-start gap-2">
            <Button asChild variant="apollo">
              <a href={`/api/edit/reports/clinical-trials?${downloadQs}`} data-testid="ct-download">
                <Download className="size-4" aria-hidden />
                Download .xlsx
              </a>
            </Button>
            <p
              className={cn(
                "text-[13px]",
                note.withheld ? "text-apollo-amber" : "text-muted-foreground",
              )}
              data-testid="ct-download-note"
            >
              {note.text}
            </p>
          </div>
        }
      />

      <div className="border-apollo-border mt-6 border-b">
        <nav className="flex flex-wrap gap-x-7" aria-label="Report views">
          {tab("trials", `Trials (${totals.trials.toLocaleString()})`)}
          {tab("members", `By member (${totals.members.toLocaleString()})`)}
        </nav>
      </div>

      <form
        method="get"
        action={basePath}
        onSubmit={(e: FormEvent) => e.preventDefault()}
        className="border-apollo-border flex flex-wrap items-center gap-2.5 border-b py-4"
        data-testid="ct-filters"
      >
        <input
          type="search"
          name="q"
          value={params.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search title, NCT, sponsor or person"
          aria-label="Search title, NCT, sponsor or person"
          className="border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2.5 text-sm sm:w-72"
          data-testid="ct-search"
        />
        <select
          name="status"
          value={params.status}
          onChange={(e) => set({ status: e.target.value as ClinicalTrialsParams["status"] })}
          aria-label="Status"
          className={selectClass(Boolean(params.status))}
          data-testid="ct-status"
        >
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          name="phase"
          value={params.phase}
          onChange={(e) => set({ phase: e.target.value })}
          aria-label="Phase"
          className={selectClass(Boolean(params.phase))}
          data-testid="ct-phase"
        >
          <option value="">Any phase</option>
          {PHASE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {anyFilter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => set({ q: "", status: "", phase: "" })}
            data-testid="ct-clear"
          >
            Clear filters
          </Button>
        )}
      </form>

      {params.view === "trials" ? (
        <TrialsTable trials={filtered} />
      ) : (
        <MembersTable members={members} />
      )}
    </div>
  );
}

function Footer({
  rangeLabel,
  noun,
  hasMore,
  showMore,
}: {
  rangeLabel: string;
  noun: string;
  hasMore: boolean;
  showMore: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3.5">
      <span className="text-muted-foreground text-[13px]">
        {rangeLabel} {noun}
      </span>
      {hasMore && (
        <Button type="button" variant="outline" size="sm" onClick={showMore}>
          Show 25 more
        </Button>
      )}
    </div>
  );
}

function TrialsTable({ trials }: { trials: TrialGroup[] }) {
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(trials);
  if (trials.length === 0) return <Empty />;
  return (
    <>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[760px] border-collapse text-sm"
          data-testid="ct-trials-table"
        >
          <thead>
            <tr className="bg-apollo-surface-2">
              <th className={TH}>Trial</th>
              <th className={cn(TH, "w-[160px]")}>Sponsor</th>
              <th className={cn(TH, "w-[170px]")}>Phase · Status</th>
              <th className={cn(TH, "w-[190px]")}>Members on trial</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr
                key={t.protocolNumber}
                className="border-apollo-border border-b"
                data-testid="ct-trial-row"
              >
                <td className={TD}>
                  <div title={t.title} className="line-clamp-3 leading-[1.4] font-semibold">
                    {t.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <NctTag nct={t.nctNumber} />
                    <span className="text-muted-foreground font-mono text-xs">
                      Protocol {t.protocolNumber}
                    </span>
                  </div>
                </td>
                <td className={cn(TD, "leading-[1.4]")}>
                  {t.sponsor ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className={TD}>
                  <div
                    className={cn(
                      "text-[13px] font-semibold",
                      t.phaseKey === "nr" && "text-muted-foreground",
                    )}
                  >
                    {phaseLabel(t.phaseKey)}
                  </div>
                  <div className="mt-1.5">
                    <StatusPill trial={t} />
                  </div>
                </td>
                <td className={TD}>
                  <ul className="flex flex-col gap-1">
                    {t.members.map((m) => (
                      <li key={m.cwid} className="leading-[1.3]">
                        <ScholarHoverCard cwid={m.cwid}>
                          <span className="hover:text-apollo-maroon font-semibold">{m.name}</span>
                        </ScholarHoverCard>
                        <div className="text-muted-foreground text-xs whitespace-nowrap">
                          {roleText(m.role)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Footer rangeLabel={rangeLabel} noun="trials" hasMore={hasMore} showMore={showMore} />
    </>
  );
}

function MembersTable({ members }: { members: MemberSummary[] }) {
  const [sort, setSort] = useState<{ key: MemberSort; dir: 1 | -1 }>({ key: "pi", dir: -1 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(() => sortMembers(members, sort.key, sort.dir), [members, sort]);
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(rows);
  if (members.length === 0) return <Empty />;

  const header = (key: MemberSort, label: string, align: "left" | "right") => (
    <th
      className={cn(TH, align === "right" && "text-right")}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1,
          }))
        }
        className="hover:text-foreground inline-flex items-center gap-1 uppercase"
        data-testid={`ct-sort-${key}`}
      >
        {label}
        <span aria-hidden>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );

  return (
    <>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[520px] border-collapse text-sm tabular-nums"
          data-testid="ct-members-table"
        >
          <thead>
            <tr className="bg-apollo-surface-2">
              {header("name", "Member", "left")}
              {header("pi", "Trials as PI", "right")}
              {header("open", "Open to accrual", "right")}
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => {
              const open = expanded === m.cwid;
              const toggle = () => setExpanded(open ? null : m.cwid);
              return [
                <tr
                  key={m.cwid}
                  onClick={toggle}
                  className={cn(
                    "border-apollo-border hover:bg-apollo-page cursor-pointer border-b",
                    open && "bg-apollo-page",
                  )}
                  data-testid="ct-member-row"
                >
                  <td className={TD}>
                    <ScholarHoverCard cwid={m.cwid}>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                        className="hover:text-apollo-maroon text-left font-semibold"
                      >
                        {m.name}
                      </button>
                    </ScholarHoverCard>
                    {m.department && (
                      <div className="text-muted-foreground mt-0.5 text-[13px]">{m.department}</div>
                    )}
                  </td>
                  <td className={cn(TD, "text-right font-semibold")}>{m.asPi}</td>
                  <td className={cn(TD, "text-right")}>{m.open}</td>
                </tr>,
                open && (
                  <tr
                    key={`${m.cwid}-trials`}
                    className="bg-apollo-page border-apollo-border border-b"
                  >
                    <td colSpan={3} className="pt-1 pr-5 pb-3 pl-5 sm:pl-9">
                      <ul data-testid="ct-member-trials">
                        {m.trials.map((t) => {
                          const role = t.members.find((x) => x.cwid === m.cwid)?.role ?? "";
                          return (
                            <li
                              key={t.protocolNumber}
                              className="border-apollo-border grid gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_150px_170px]"
                            >
                              <div className="min-w-0">
                                <div className="leading-[1.4]">{t.title}</div>
                                <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
                                  <span>{phaseLabel(t.phaseKey)}</span>
                                  {t.sponsor && <span>· {t.sponsor}</span>}
                                  <span>·</span>
                                  <NctTag nct={t.nctNumber} />
                                </div>
                              </div>
                              <div className="text-[13px]">{roleText(role)}</div>
                              <div>
                                <StatusPill trial={t} />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      <Footer rangeLabel={rangeLabel} noun="members" hasMore={hasMore} showMore={showMore} />
    </>
  );
}

function Empty() {
  return (
    <p className="text-muted-foreground py-8 text-sm" data-testid="ct-empty">
      No trials match these filters.
    </p>
  );
}
