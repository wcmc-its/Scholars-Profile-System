/**
 * Report 27's Connections view (`lib/edit/downstream-reach-connections.ts`):
 * its two lists, and the pairs list one row's count opens. Report 27's own
 * parts, nothing new drawn: `PersonCell` (the scholar hover card, the CWID in
 * monospace), `TH` / `TD`, `Pager`, the neutral `StageBadge` and the public
 * publication modal.
 *
 * THE RULE: every number opens its list.
 *   - A row's count is the number of distinct citing papers, and links to the
 *     pairs list (`with`, `dir`), which has one row per citing paper.
 *   - Each stage-mix count links to report 27's Publications view for that
 *     colleague and stage (`connectionLinks.stageMix`); a stage with none is
 *     not shown.
 *   - No heading or tab carries a count.
 */
import Link from "next/link";

import {
  LINK,
  Pager,
  PersonCell,
  PubMeta,
  TD,
  TH,
  type PersonFooter,
} from "@/components/edit/reports/citation-report-parts";
import { PaperTitle } from "@/components/edit/reports/downstream-reach-client";
import { PubTitle } from "@/components/publication/pub-html";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import { StageBadge } from "@/components/publication/stage-badge";
import {
  connectionLinks,
  connectionsListLabel,
  connectionsScholar,
  CONNECTIONS_FILTER_NOTE,
  CONNECTIONS_RULE,
  loadConnectionPapers,
  loadConnectionStageMix,
  loadReachConnections,
  MIN_CONNECTION_PAPERS,
  type ConnectionPair,
  type ConnectionPaper,
  type ConnectionRow,
  type ReachConnections,
  type StageMix,
} from "@/lib/edit/downstream-reach-connections";
import { NO_STAGE_LABEL } from "@/lib/edit/article-count-report";
import {
  loadModalHidden,
  reachQueryString,
  stageKeyLabel,
  type ConnectionDir,
  type ReachParams,
} from "@/lib/edit/downstream-reach-report";
import { TRANSLATIONAL_STAGES, type TranslationalStage } from "@/lib/translational-stage";
import { cn } from "@/lib/utils";

const TEST = "downstream-reach-connections";

type Ok = Extract<ReachConnections, { status: "ok" }>;

export type ConnectionsPage =
  | { status: "pick"; many: boolean }
  | { status: "unavailable" }
  | {
      status: "lists";
      /** Every row (the export takes these). */
      all: Ok;
      /** This page's rows of each list. */
      cited: ConnectionRow[];
      cites: ConnectionRow[];
      /** What the pager runs over: the longer list. */
      total: number;
      mix: Map<string, StageMix>;
    }
  | {
      status: "pairs";
      all: Ok;
      dir: ConnectionDir;
      /** The colleague's row in that list; null when they are not in it. */
      other: ConnectionRow | null;
      /** This page's pairs. */
      pairs: ConnectionPair[];
      total: number;
      papers: Map<string, { title: string; journal: string | null }>;
      hidden: Set<string>;
    };

/** Everything one page of the view shows, for the rows on that page only. */
export async function loadConnectionsPage(
  p: ReachParams,
  offset: number,
  limit: number,
): Promise<ConnectionsPage> {
  if (connectionsScholar(p) === null) return { status: "pick", many: p.people.length > 1 };
  const all = await loadReachConnections(p);
  if (all.status === "pick") return { status: "pick", many: false };
  if (all.status === "unavailable") return { status: "unavailable" };
  if (p.with === null) {
    const cited = all.cited.slice(offset, offset + limit);
    const cites = all.cites.slice(offset, offset + limit);
    const mix = await loadConnectionStageMix(p, [
      ...new Set([...cited, ...cites].map((r) => r.cwid)),
    ]);
    return {
      status: "lists",
      all,
      cited,
      cites,
      total: Math.max(all.cited.length, all.cites.length),
      mix,
    };
  }
  const other = all[p.dir].find((r) => r.cwid === p.with) ?? null;
  const pairs = (other?.pairs ?? []).slice(offset, offset + limit);
  const pmids = [...new Set(pairs.flatMap((x) => [x.citing.pmid, ...x.cited.map((c) => c.pmid)]))];
  const [papers, hidden] = await Promise.all([loadConnectionPapers(pmids), loadModalHidden(pmids)]);
  return {
    status: "pairs",
    all,
    dir: p.dir,
    other,
    pairs,
    total: other?.pairs.length ?? 0,
    papers,
    hidden,
  };
}

/** The colleagues named on the page (for the Bibliometrics links). */
export const connectionsPageCwids = (c: ConnectionsPage | null): string[] =>
  c?.status === "lists" ? [...new Set([...c.cited, ...c.cites].map((r) => r.cwid))] : [];

const NOTE = "text-muted-foreground px-4 py-3 text-[13px]";

function Mix({
  cwid,
  name,
  mix,
  href,
}: {
  cwid: string;
  name: string;
  mix: StageMix | undefined;
  /** Report 27's Publications view for this colleague at one stage. */
  href: (stage: TranslationalStage) => string;
}) {
  const shown = TRANSLATIONAL_STAGES.filter((s) => (mix?.[s] ?? 0) > 0);
  if (shown.length === 0) return <span className="text-muted-foreground text-xs">–</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
      {shown.map((s) => (
        <Link
          key={s}
          href={href(s)}
          aria-label={`${mix![s]!.toLocaleString()} first- or senior-author papers by ${name} at ${stageKeyLabel(s)}`}
          className={LINK}
          data-testid={`${TEST}-mix-${cwid}-${s}`}
        >
          {s.replace("-", "–")}: {mix![s]!.toLocaleString()}
        </Link>
      ))}
    </span>
  );
}

function ListTable({
  dir,
  scholar,
  rows,
  mix,
  href,
  p,
  footer,
  bibliometrics,
}: {
  dir: ConnectionDir;
  scholar: string;
  rows: ConnectionRow[];
  mix: Map<string, StageMix>;
  href: (q: string) => string;
  p: ReachParams;
  footer: PersonFooter;
  bibliometrics: (cwid: string) => string | null;
}) {
  const links = connectionLinks(p);
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[820px] border-collapse text-sm tabular-nums"
        data-testid={`${TEST}-${dir}`}
      >
        <thead>
          <tr className="bg-apollo-surface-2 text-left">
            <th className={TH}>Person</th>
            <th className={TH}>Org unit</th>
            <th className={TH}>Person type</th>
            <th className={cn(TH, "whitespace-normal")}>
              Their first- or senior-author papers by stage
            </th>
            <th className={cn(TH, "whitespace-normal")}>Citing papers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const phrase =
              dir === "cited"
                ? `of their papers cite ${scholar}'s work`
                : `of ${scholar}'s papers cite their work`;
            const label =
              dir === "cited"
                ? `${r.papers.toLocaleString()} of ${r.name}'s papers cite ${scholar}'s work: the pairs of papers`
                : `${r.papers.toLocaleString()} of ${scholar}'s papers cite ${r.name}'s work: the pairs of papers`;
            return (
              <tr
                key={r.cwid}
                className="border-apollo-border border-b"
                data-testid={`${TEST}-row`}
              >
                <PersonCell
                  cwid={r.cwid}
                  name={r.name}
                  footer={footer}
                  bibliometrics={bibliometrics(r.cwid)}
                />
                <td className={TD}>{r.orgUnit}</td>
                <td className={TD}>{r.personType}</td>
                <td className={TD}>
                  <Mix
                    cwid={r.cwid}
                    name={r.name}
                    mix={mix.get(r.cwid)}
                    href={(s) => href(links.stageMix(r.cwid, s))}
                  />
                </td>
                <td className={TD}>
                  <Link
                    href={href(links.pairs(r.cwid, dir))}
                    aria-label={label}
                    className={LINK}
                    data-testid={`${TEST}-count`}
                  >
                    {r.papers.toLocaleString()}
                  </Link>{" "}
                  <span className="text-muted-foreground">{phrase}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Paper({
  paper,
  facts,
  hidden,
}: {
  paper: ConnectionPaper;
  facts: { title: string; journal: string | null } | undefined;
  hidden: boolean;
}) {
  const title = facts?.title ?? "";
  return (
    <div className="flex flex-col gap-0.5">
      {hidden ? (
        <span className="font-medium">
          <PubTitle value={title} />
        </span>
      ) : (
        <PaperTitle pmid={paper.pmid} title={title} />
      )}
      <div className="text-muted-foreground leading-normal">
        <PubMeta pub={{ pmid: paper.pmid, journal: facts?.journal ?? null, year: paper.year }} />
      </div>
      <div>
        {paper.stage ? (
          <StageBadge stage={paper.stage} />
        ) : (
          <span className="text-muted-foreground text-xs">{NO_STAGE_LABEL}</span>
        )}
      </div>
    </div>
  );
}

export function ConnectionsPanel({
  page,
  params,
  pageSize,
  href,
  footer,
  bibliometrics,
  peopleHref,
}: {
  page: ConnectionsPage;
  params: ReachParams;
  pageSize: number;
  href: (q: string) => string;
  footer: PersonFooter;
  bibliometrics: (cwid: string) => string | null;
  /** The People tab, where a scholar is picked. */
  peopleHref: string;
}) {
  const pager = (total: number) => (
    <Pager
      page={params.page}
      total={total}
      pageSize={pageSize}
      href={(n) => href(reachQueryString(params, { page: n }))}
      testId={`${TEST}-pager`}
    />
  );
  if (page.status === "pick") {
    return (
      <p className={NOTE} data-testid={`${TEST}-pick`}>
        {page.many
          ? "Connections are shown for one scholar at a time. Remove all but one person from the filters."
          : "Pick one scholar to see their connections: colleagues who cite their work, or whose work they cite, and who have never co-authored with them."}{" "}
        <Link href={peopleHref} className={LINK}>
          Choose a person in the People view
        </Link>
        , or from an author&rsquo;s card on a paper.
      </p>
    );
  }
  if (page.status === "unavailable") {
    return (
      <p className={NOTE} data-testid={`${TEST}-unavailable`}>
        Connections are not available for this person: they are not an active scholar in the units
        you can see.
      </p>
    );
  }
  const name = page.all.scholar.name;
  const note = (
    <p className={NOTE} role="note" data-testid={`${TEST}-note`}>
      {CONNECTIONS_RULE} {CONNECTIONS_FILTER_NOTE}
    </p>
  );
  if (page.status === "pairs") {
    const other = page.other;
    return (
      <PublicationModalProvider>
        <p className={NOTE}>
          <Link
            href={href(connectionLinks(params).lists())}
            className={LINK}
            data-testid={`${TEST}-back`}
          >
            Back to all of {name}&rsquo;s connections
          </Link>
        </p>
        {other === null ? (
          <p className={NOTE} data-testid={`${TEST}-not-connection`}>
            This colleague is not in the list &ldquo;{connectionsListLabel(page.dir, name)}&rdquo;
            under these filters.
          </p>
        ) : (
          <>
            <h3
              className="px-4 pt-1 text-[15px] font-semibold"
              data-testid={`${TEST}-pairs-heading`}
            >
              {page.dir === "cited"
                ? `Papers by ${other.name} that cite ${name}'s work`
                : `Papers by ${name} that cite ${other.name}'s work`}
            </h3>
            <p className="text-muted-foreground px-4 pb-2 text-[13px]">
              One row per citing paper, newest first, with the papers it cites beside it.
            </p>
            <div className="overflow-x-auto">
              <table
                className="w-full min-w-[820px] border-collapse text-sm tabular-nums"
                data-testid={`${TEST}-pairs`}
              >
                <thead>
                  <tr className="bg-apollo-surface-2 text-left">
                    <th className={cn(TH, "w-1/2")}>
                      Citing paper ({page.dir === "cited" ? other.name : name})
                    </th>
                    <th className={cn(TH, "w-1/2")}>
                      Cited {page.dir === "cited" ? `${name}'s` : `${other.name}'s`} paper
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.pairs.map((x) => (
                    <tr
                      key={x.citing.pmid}
                      className="border-apollo-border border-b align-top"
                      data-testid={`${TEST}-pair`}
                    >
                      <td className={TD}>
                        <Paper
                          paper={x.citing}
                          facts={page.papers.get(x.citing.pmid)}
                          hidden={page.hidden.has(x.citing.pmid)}
                        />
                      </td>
                      <td className={cn(TD, "flex flex-col gap-3")}>
                        {x.cited.map((c) => (
                          <Paper
                            key={c.pmid}
                            paper={c}
                            facts={page.papers.get(c.pmid)}
                            hidden={page.hidden.has(c.pmid)}
                          />
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pager(page.total)}
          </>
        )}
        {note}
      </PublicationModalProvider>
    );
  }
  const section = (dir: ConnectionDir, rows: ConnectionRow[], all: number) => (
    <section className="flex flex-col" data-testid={`${TEST}-section-${dir}`}>
      <h3 className="px-4 pt-3 pb-2 text-[15px] font-semibold">
        {connectionsListLabel(dir, name)}
      </h3>
      {all === 0 ? (
        <p className="text-muted-foreground px-4 pb-3 text-[13px]">
          {dir === "cited"
            ? `No colleague who has never co-authored with ${name} cites their work in ${MIN_CONNECTION_PAPERS} or more papers under these filters.`
            : `${name}'s papers cite no colleague they have never co-authored with in ${MIN_CONNECTION_PAPERS} or more papers under these filters.`}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground px-4 pb-3 text-[13px]">
          This list ends on an earlier page.
        </p>
      ) : (
        <ListTable
          dir={dir}
          scholar={name}
          rows={rows}
          mix={page.mix}
          href={href}
          p={params}
          footer={footer}
          bibliometrics={bibliometrics}
        />
      )}
    </section>
  );
  return (
    <>
      {note}
      {section("cited", page.cited, page.all.cited.length)}
      {section("cites", page.cites, page.all.cites.length)}
      {pager(page.total)}
    </>
  );
}
