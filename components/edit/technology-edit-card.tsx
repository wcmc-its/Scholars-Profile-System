/**
 * The "Available technologies" attribute panel — a read-only mirror of the
 * public profile's CTL technologies section (`technologies-section.tsx`).
 *
 * These inventions are the Center for Technology Licensing's system-of-record
 * data; Scholars only displays them. So this panel is NOT editable — there is no
 * Hide control and no write path (unlike Publications/Funding). It renders each
 * technology exactly as the profile does (title link, patent-status + PoC chips,
 * PMID links, reference number, and the expandable Overview via the shared
 * `TechnologyOverview` island), with the standard "not editable" treatment and a
 * note routing corrections to CTL's licensing inbox.
 *
 * Surfaced only when the loader populated `ctx.technologies` — i.e.
 * `AVAILABLE_TECHNOLOGIES_SECTION` is on AND the scholar has ≥1 invention — so
 * an empty panel is never reached (the rail item is dropped otherwise).
 */
"use client";

import { Fragment, type ReactNode } from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { TechnologyOverview } from "@/components/profile/technology-overview";
import type { EditContextTechnology } from "@/lib/api/edit-context";

/** CTL's shared licensing inbox — where corrections are actually made. */
const CTL_INQUIRIES = "enterpriseinnovation@med.cornell.edu";

/** patentStatus + PoC chip styling — copied verbatim from the profile section
 *  (`technologies-section.tsx`) so the two surfaces read identically. */
const CHIP =
  "bg-muted text-muted-foreground inline-flex h-5 items-center rounded-sm px-2 text-[10px] font-semibold tracking-wider uppercase";

function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

export type TechnologyEditCardProps = {
  /** Accepted for call-site parity with the other read-only cards (coi/email);
   *  CTL is the SOR, so there is no per-scholar write path to key off it. */
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  technologies: ReadonlyArray<EditContextTechnology>;
};

/** One technology row — the same badge row the profile shows
 *  (`[PATENT STATUS] [POC DATA] · PMID … · Overview`), middots collapsing so a
 *  row missing a group never shows `· ·`. */
function TechnologyRow({ tech }: { tech: EditContextTechnology }) {
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
    <li className="border-apollo-border border-t first:border-t-0">
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

export function TechnologyEditCard({ mode, scholarName, technologies }: TechnologyEditCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";

  return (
    <EditPanel
      slot="technologies-panel"
      heading="Available technologies"
      description={`Inventions of ${possessive} that the Center for Technology Licensing lists as available to license. These are shown on the public profile and aren't editable here.`}
    >
      <LockedBadge />

      <ul
        className="border-apollo-border rounded-md border px-4 py-1"
        data-slot="technologies-panel-list"
      >
        {technologies.map((tech) => (
          <TechnologyRow key={tech.url} tech={tech} />
        ))}
      </ul>

      <div className="border-apollo-border flex flex-col items-start gap-2 border-t pt-3">
        <p className="text-sm font-medium">This section is not editable.</p>
        <p className="text-muted-foreground text-sm">
          Managed by the Center for Technology Licensing. To add{" "}
          {mode === "superuser" ? "an invention" : "one of yours"} or correct a listing, contact{" "}
          <a
            href={`mailto:${CTL_INQUIRIES}`}
            className="text-[var(--color-accent-slate)] underline underline-offset-4"
          >
            {CTL_INQUIRIES}
          </a>
          .
        </p>
      </div>
    </EditPanel>
  );
}
