import { Fragment, type ReactNode } from "react";
import type { ProfilePayload } from "@/lib/api/profile";
import { TechnologyOverview } from "@/components/profile/technology-overview";

type Technology = ProfilePayload["technologies"][number];

/** CTL's shared licensing inbox. Named officers live on each technology's own
 *  page — we link there rather than mirroring a person's contact details, which
 *  would go stale the moment CTL reassigns the docket. */
const CTL_INQUIRIES = "enterpriseinnovation@med.cornell.edu";
const CTL_PORTFOLIO = "https://innovation.weill.cornell.edu/technology-portfolio";

/** Most rows fit above the fold; the rest collapse into a native <details>. 96%
 *  of scholars hold ≤5 technologies, so the expander appears on a handful. */
const ROW_CAP = 5;

/** patentStatus + PoC chip styling — a small uppercase pill. */
const CHIP =
  "bg-muted text-muted-foreground inline-flex h-5 items-center rounded-sm px-2 text-[10px] font-semibold tracking-wider uppercase";

function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

/** One technology row. The badge row reads
 *  `[PATENT STATUS] [POC DATA] · PMID … · Overview`, middots collapsing so a row
 *  missing a group never shows `· ·`. The Overview trigger is the only client
 *  island; everything else is server-rendered. */
function TechnologyRow({ tech }: { tech: Technology }) {
  // Grouped so the middot separators fall between groups, not between every chip.
  const groups: ReactNode[] = [];

  if (tech.patentStatus || tech.hasPocData) {
    groups.push(
      <span key="chips" className="inline-flex items-center gap-x-1.5">
        {tech.patentStatus ? <span className={CHIP}>{tech.patentStatus}</span> : null}
        {tech.hasPocData ? <span className={CHIP}>PoC Data</span> : null}
      </span>,
    );
  }

  if (tech.pmids.length > 0) {
    groups.push(
      <span key="pmids" className="inline-flex flex-wrap items-center gap-x-3">
        {tech.pmids.map((pmid) => (
          <a
            key={pmid}
            href={pubmedUrl(pmid)}
            target="_blank"
            rel="noopener noreferrer"
            title="View the related paper on PubMed"
            className="text-muted-foreground font-mono text-xs underline-offset-4 hover:underline"
          >
            {/* One interpolation, not `PMID {pmid}` — SSR would split that into two
                text nodes and break copy-paste and text search. */}
            {`PMID ${pmid}`}
          </a>
        ))}
      </span>,
    );
  }

  if (tech.overview) {
    groups.push(<TechnologyOverview key="overview" overview={tech.overview} />);
  }

  return (
    <li className="border-border border-t first:border-t-0">
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-3 py-3">
        <div>
          <a
            href={tech.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-base leading-snug font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            {tech.title}
          </a>
          {groups.length > 0 ? (
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {/* No wrapper element: the Overview reveal is `basis-full`, so it
                  must be a direct flex child to wrap onto its own line. */}
              {groups.map((g, i) => (
                <Fragment key={i}>
                  {i > 0 ? (
                    <span aria-hidden="true" className="text-muted-foreground/60">
                      ·
                    </span>
                  ) : null}
                  {g}
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
        {tech.reference ? (
          <span
            title="Cornell Reference number"
            className="text-muted-foreground font-mono text-xs whitespace-nowrap"
          >
            {tech.reference}
          </span>
        ) : (
          <span />
        )}
      </div>
    </li>
  );
}

/**
 * Licensable inventions from the WCM Center for Technology Licensing portfolio.
 *
 * The audience is an external commercial partner arriving from CTL's site, so
 * each row carries the two things that let them judge an invention: how far the
 * patent has progressed, and the paper that backs it. An expandable "Overview"
 * and a "PoC Data" chip surface CTL's own summary and proof-of-concept signal
 * without spending vertical space — the overview stays collapsed by default.
 *
 * ponytail: the only client state is the per-row Overview toggle (its own
 * island); the section, the PMID/reference links, and the "show more rows"
 * expander are all zero-JS. Deliberately a compact row rather than a card, to
 * match the Funding and Clinical trials sections directly above it. Deliberately
 * no per-row contact block: 112 of 129 scholars have a single licensing officer
 * across all their technologies, so repeating it per row is noise, and caching a
 * named person's email here would rot.
 */
export function TechnologiesSection({ technologies }: { technologies: Technology[] }) {
  const head = technologies.slice(0, ROW_CAP);
  const rest = technologies.slice(ROW_CAP);

  return (
    <>
      <ul>
        {head.map((tech) => (
          <TechnologyRow key={tech.url} tech={tech} />
        ))}
      </ul>

      {rest.length > 0 ? (
        // Native <details> so "show more" needs no client state — the section
        // stays server-rendered. Only the handful of scholars with >5 land here.
        <details className="border-border border-t">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer py-3 text-sm">
            Show {rest.length} more {rest.length === 1 ? "technology" : "technologies"}
          </summary>
          <ul>
            {rest.map((tech) => (
              <TechnologyRow key={tech.url} tech={tech} />
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-sm">
        Technologies available for licensing, listed by the{" "}
        <a
          href={CTL_PORTFOLIO}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent-slate)] underline underline-offset-4"
        >
          Center for Technology Licensing
        </a>
        . Licensing inquiries:{" "}
        <a
          href={`mailto:${CTL_INQUIRIES}`}
          className="text-[var(--color-accent-slate)] underline underline-offset-4"
        >
          {CTL_INQUIRIES}
        </a>
        .
      </p>
    </>
  );
}
