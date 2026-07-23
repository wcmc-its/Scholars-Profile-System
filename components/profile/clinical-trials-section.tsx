"use client";

import { useMemo, useState } from "react";
import type { ProfilePayload } from "@/lib/api/profile";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { SponsorAbbr } from "@/components/ui/sponsor-abbr";

type Trial = ProfilePayload["clinicalTrials"][number];

/** Compact role labels for the 64px badge column (mirrors GrantsSection). */
const ROLE_LABEL: Record<string, string> = {
  "Principal Investigator": "PI",
  Investigator: "Inv",
};
const ROLE_TITLE: Record<string, string> = {
  "Principal Investigator": "Principal Investigator",
  Investigator: "Investigator",
};

/** ClinicalTrials.gov study page for an NCT id (modern /study/ path). */
function ctgovUrl(nct: string): string {
  return `https://clinicaltrials.gov/study/${encodeURIComponent(nct)}`;
}

export function ClinicalTrialsSection({ trials }: { trials: Trial[] }) {
  const activeTrials = useMemo(() => trials.filter((t) => t.isActive), [trials]);
  const completedTrials = useMemo(() => trials.filter((t) => !t.isActive), [trials]);

  return (
    <>
      {activeTrials.length > 0 ? (
        <>
          <div className="mt-2 mb-3 flex items-baseline gap-3">
            <h3 className="text-base font-semibold">Active</h3>
            <span className="text-muted-foreground text-sm">
              {activeTrials.length} {activeTrials.length === 1 ? "study" : "studies"}
            </span>
          </div>
          <ul>
            {activeTrials.map((trial) => (
              <li key={trial.protocolNumber}>
                <TrialRow trial={trial} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {completedTrials.length > 0 ? (
        <details
          className={activeTrials.length > 0 ? "group border-border mt-4 border-t" : "group"}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm font-medium text-[var(--color-accent-slate)] [&::-webkit-details-marker]:hidden">
            <span className="text-muted-foreground inline-block w-3 text-[10px] transition-transform group-open:rotate-90">
              ▶
            </span>
            Completed &amp; closed trials ({completedTrials.length})
          </summary>
          <ul className="pb-3">
            {completedTrials.map((trial) => (
              <li key={trial.protocolNumber}>
                <TrialRow trial={trial} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function TrialRow({ trial }: { trial: Trial }) {
  const [expanded, setExpanded] = useState(false);
  const label = ROLE_LABEL[trial.role] ?? trial.role;
  const title = ROLE_TITLE[trial.role] ?? trial.role;
  const canExpand = !!trial.briefSummary || trial.enrollment != null;
  const statusYear = trial.statusDate ? trial.statusDate.slice(0, 4) : null;

  return (
    <div className="border-border border-t first:border-t-0">
      <div className="grid grid-cols-[64px_1fr_auto] items-baseline gap-3 py-3">
        <HoverTooltip text={title}>
          <span
            className={
              trial.isActive
                ? "inline-flex h-5 items-center justify-center rounded-sm bg-green-50 px-2 text-[10px] font-semibold tracking-wider text-green-700 uppercase dark:bg-green-950 dark:text-green-300"
                : "bg-muted text-muted-foreground inline-flex h-5 items-center justify-center rounded-sm px-2 text-[10px] font-semibold tracking-wider uppercase"
            }
          >
            {label}
          </span>
        </HoverTooltip>
        <div>
          <div className="text-base leading-snug font-medium">{trial.title}</div>
          <div className="text-muted-foreground mt-0.5 text-sm">
            {trial.phase ? <span>{trial.phase}</span> : null}
            {trial.phase && trial.principalSponsor ? " · " : null}
            {trial.principalSponsor ? <SponsorAbbr short={trial.principalSponsor} /> : null}
            {trial.status ? (
              <>
                {(trial.phase || trial.principalSponsor) && " · "}
                <span>{trial.status}</span>
                {statusYear ? (
                  <span className="text-muted-foreground"> (as of {statusYear})</span>
                ) : null}
              </>
            ) : null}
          </div>
          {trial.conditions ? (
            <div className="text-muted-foreground mt-0.5 text-sm">{trial.conditions}</div>
          ) : null}
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="group mt-1.5 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)]"
              aria-expanded={expanded}
            >
              <span
                className={`text-muted-foreground inline-block w-3 text-[10px] transition-transform ${
                  expanded ? "rotate-90" : ""
                }`}
              >
                ▶
              </span>
              <span className="group-hover:underline">
                {expanded ? "Hide details" : "Show details"}
              </span>
            </button>
          ) : null}
        </div>
        {trial.nctNumber ? (
          <a
            href={ctgovUrl(trial.nctNumber)}
            target="_blank"
            rel="noopener noreferrer"
            title="View on ClinicalTrials.gov"
            className="font-mono text-xs whitespace-nowrap text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            {trial.nctNumber}
          </a>
        ) : (
          <span />
        )}
      </div>

      {expanded ? (
        <div className="text-muted-foreground ml-[76px] pb-3 text-sm">
          {trial.enrollment != null ? (
            <div className="mb-1.5">
              Enrollment: {trial.enrollment.toLocaleString()} participants
            </div>
          ) : null}
          {trial.briefSummary ? <p className="leading-relaxed">{trial.briefSummary}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
