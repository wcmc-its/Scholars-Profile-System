import type { ProfilePayload } from "@/lib/api/profile";

type Technology = ProfilePayload["technologies"][number];

/** CTL's shared licensing inbox. Named officers live on each technology's own
 *  page — we link there rather than mirroring a person's contact details, which
 *  would go stale the moment CTL reassigns the docket. */
const CTL_INQUIRIES = "enterpriseinnovation@med.cornell.edu";
const CTL_PORTFOLIO = "https://innovation.weill.cornell.edu/technology-portfolio";

function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

/**
 * Licensable inventions from the WCM Center for Technology Licensing portfolio.
 *
 * The audience is an external commercial partner arriving from CTL's site, so
 * each row carries the two things that let them judge an invention: how far the
 * patent has progressed, and the paper that backs it.
 *
 * ponytail: no client state — every row is a link out. Deliberately a compact
 * row rather than a card, to match the Funding and Clinical trials sections
 * directly above it. Deliberately no per-row contact block: 112 of 129 scholars
 * have a single licensing officer across all their technologies, so repeating it
 * per row is noise, and caching a named person's email here would rot.
 */
export function TechnologiesSection({ technologies }: { technologies: Technology[] }) {
  return (
    <>
      <ul>
        {technologies.map((tech) => (
          <li key={tech.url} className="border-border border-t first:border-t-0">
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
                {tech.patentStatus || tech.pmids.length > 0 ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {tech.patentStatus ? (
                      <span className="bg-muted text-muted-foreground inline-flex h-5 items-center rounded-sm px-2 text-[10px] font-semibold tracking-wider uppercase">
                        {tech.patentStatus}
                      </span>
                    ) : null}
                    {tech.pmids.map((pmid) => (
                      <a
                        key={pmid}
                        href={pubmedUrl(pmid)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="View the related paper on PubMed"
                        className="text-muted-foreground font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {/* One interpolation, not `PMID {pmid}` — SSR would split that
                            into two text nodes and break copy-paste and text search. */}
                        {`PMID ${pmid}`}
                      </a>
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
        ))}
      </ul>

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
