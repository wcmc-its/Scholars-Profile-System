"use client";

/**
 * TOPIC_FEED_GRANTS_TRIALS — the Activities feed's grant and trial rows, per
 * the Activities Redesign mockup (760 px column). Feed-only: the Search tabs
 * keep `FundingResultRow` / `TrialResultRow`.
 *
 *   Status pill · years | phase                      award | NCT ↗
 *   Title (RePORTER / ClinicalTrials.gov link when there is one)
 *   Name (role), Name (role) · funder · via direct | dates · sponsor · Results posted
 *   ▸ Abstract & N publications | ▸ Intervention & N conditions
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Caret } from "@/components/ui/caret";
import { PubAbstract } from "@/components/publication/pub-html";
import { expandLabel } from "@/components/funding/expanded-grant";
import {
  studyTypeLabel,
  trialDatesLabel,
  TRIAL_STATUS_LABEL,
} from "@/components/search/trial-result-row";
import {
  phaseLabel,
  sponsorTypeLabel,
  type SponsorTypeKey,
} from "@/lib/edit/clinical-trials-report";
import { grantRoleShortLabel } from "@/lib/funding-roles";
import { funderVerbose } from "@/lib/sponsor-lookup";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";
import { sanitizePubTitle } from "@/lib/utils";
import type { TopicGrantActivityHit, TopicTrialActivityHit } from "@/lib/api/topic-activity";

const PEOPLE_LIMIT = 4;

type Tone = "hi" | "warn" | "lo";
const PILL: Record<Tone, string> = {
  hi: "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate font-medium",
  warn: "bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber font-medium",
  lo: "bg-apollo-surface-2 border-apollo-border text-[#4a4540]",
};
const DOT: Record<Tone, string> = {
  hi: "bg-apollo-slate",
  warn: "bg-apollo-amber",
  lo: "bg-[#8a837c]",
};

function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 whitespace-nowrap ${PILL[tone]}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

type Person = { key: string; name: string; slug: string | null; role: string };

/** "Name (role), Name (role)", the first four, then "+N more". */
function PeopleLine({ people, total }: { people: Person[]; total: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, PEOPLE_LIMIT);
  const more = total - shown.length;
  return (
    <span>
      {shown.map((p, i) => (
        <span key={p.key}>
          {p.slug ? (
            <Link href={profilePath(p.slug)} className="text-apollo-slate hover:underline">
              {p.name}
            </Link>
          ) : (
            p.name
          )}
          {p.role ? ` (${p.role})` : ""}
          {i < shown.length - 1 ? ", " : ""}
        </span>
      ))}
      {more > 0 ? (
        <>
          {", "}
          {people.length > shown.length ? (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="text-apollo-slate hover:underline"
            >
              +{more} more
            </button>
          ) : (
            `+${more} more`
          )}
        </>
      ) : null}
    </span>
  );
}

function Disclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="text-apollo-slate flex w-max max-w-full items-center gap-1.5 text-[13px]"
    >
      <Caret open={open} />
      {children}
    </button>
  );
}

const ROW = "border-apollo-border flex flex-col gap-2 border-b py-5";
const TITLE = "text-[16px] leading-[1.4] font-medium text-pretty text-[#1a1a1a]";
const META = "text-muted-foreground flex flex-wrap gap-1.5 text-[13.5px]";
const PANEL = "bg-apollo-page border-apollo-border rounded-lg border px-3 py-2.5 text-[13.5px]";

/** "5R01HL167139-04" with mechanism R01 → "R01 HL167139-04". */
export function grantAwardLabel(awardNumber: string, mechanism: string | null): string {
  if (!mechanism) return awardNumber;
  const serial = awardNumber.replace(new RegExp(`^\\s*[1-9]?\\s*${mechanism}\\s*`, "i"), "").trim();
  return serial === awardNumber.trim() ? awardNumber : `${mechanism} ${serial}`;
}

const GRANT_STATUS: Record<TopicGrantActivityHit["status"], [Tone, string]> = {
  active: ["hi", "Active"],
  ending_soon: ["warn", "Ending soon"],
  recently_ended: ["lo", "Ended"],
  ended: ["lo", "Ended"],
};

export function ActivityGrantRow({ hit, applId }: { hit: TopicGrantActivityHit; applId?: number }) {
  const [open, setOpen] = useState(false);
  const [tone, statusLabel] = GRANT_STATUS[hit.status];
  const reporterId = hit.applId ?? applId ?? null;
  const titleHtml = sanitizePubTitle(hit.title);
  const funder = funderVerbose(hit.primeSponsor);
  const via = hit.isSubaward && hit.directSponsor ? funderVerbose(hit.directSponsor) : null;
  const people: Person[] = hit.people.map((p) => ({
    key: p.cwid,
    name: p.preferredName,
    // #536 — a hidden identity class keeps its name but gets no profile link.
    slug: isPubliclyDisplayed(p.roleCategory) ? p.slug : null,
    role: grantRoleShortLabel(p.role, hit.isMultiPi),
  }));
  return (
    <article className={ROW}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill tone={tone}>{statusLabel}</StatusPill>
          <span className="text-muted-foreground">
            {hit.startDate.slice(0, 4)}–{hit.endDate.slice(0, 4)}
          </span>
        </div>
        {hit.awardNumber ? (
          <span className="font-mono text-[12px] whitespace-nowrap text-[#4a4540]">
            {grantAwardLabel(hit.awardNumber, hit.mechanism)}
          </span>
        ) : null}
      </div>
      <h3 className={TITLE}>
        {reporterId ? (
          <a
            href={`https://reporter.nih.gov/project-details/${reporterId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            dangerouslySetInnerHTML={{ __html: titleHtml }}
          />
        ) : (
          <span dangerouslySetInnerHTML={{ __html: titleHtml }} />
        )}
      </h3>
      <div className={META}>
        {people.length > 0 ? (
          <>
            <PeopleLine people={people} total={hit.totalPeople} />
            <span>·</span>
          </>
        ) : null}
        <span>
          {funder}
          {via ? ` · via ${via}` : ""}
        </span>
      </div>
      {hit.abstract ? (
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          {expandLabel(hit.pubCount, true)}
        </Disclosure>
      ) : null}
      {open && hit.abstract ? (
        <PubAbstract
          as="p"
          value={hit.abstract}
          className={`${PANEL} leading-[1.55] text-pretty text-[#4a4540]`}
        />
      ) : null}
    </article>
  );
}

export function ActivityTrialRow({ hit }: { hit: TopicTrialActivityHit }) {
  const [open, setOpen] = useState(false);
  const statusLabel = TRIAL_STATUS_LABEL[hit.statusKey] ?? hit.statusKey;
  const dates = trialDatesLabel(hit);
  const ctgovHref = hit.nctNumber ? `https://clinicaltrials.gov/study/${hit.nctNumber}` : null;
  const typeLine = [
    hit.studyType ? studyTypeLabel(hit.studyType) : null,
    hit.phase === "nr" ? null : phaseLabel(hit.phase),
  ]
    .filter(Boolean)
    .join(" · ");
  const sponsor =
    hit.principalSponsor ??
    (hit.sponsorClass === "unknown" ? null : sponsorTypeLabel(hit.sponsorClass as SponsorTypeKey));
  const interventions = (hit.interventions ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  const conditions = hit.conditions
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);
  const condLabel = `${conditions.length} ${conditions.length === 1 ? "condition" : "conditions"}`;
  const people: Person[] = hit.pis.map((p) => ({
    key: p.cwid,
    name: p.name,
    slug: p.slug,
    role: "PI",
  }));
  const meta: ReactNode[] = [
    people.length > 0 ? <PeopleLine key="pis" people={people} total={people.length} /> : null,
    dates ? (
      <span key="dates" className="text-[#1a1a1a]">
        {dates}
      </span>
    ) : null,
    sponsor ? <span key="sponsor">{sponsor}</span> : null,
    hit.hasResults && ctgovHref ? (
      <a
        key="results"
        href={`${ctgovHref}?tab=results`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-apollo-slate hover:underline"
      >
        Results posted
      </a>
    ) : null,
  ].filter(Boolean);
  return (
    <article className={ROW}>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill tone={hit.statusKey === "recruiting" ? "hi" : "lo"}>{statusLabel}</StatusPill>
          {typeLine ? <span className="text-muted-foreground">{typeLine}</span> : null}
        </div>
        {ctgovHref ? (
          <a
            href={ctgovHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate whitespace-nowrap hover:underline"
          >
            {hit.nctNumber} ↗
          </a>
        ) : null}
      </div>
      <h3 className={TITLE}>
        {ctgovHref ? (
          <a href={ctgovHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {hit.title /* pub-html-ok: clinical trial title, plain text from CT.gov/OnCore */}
          </a>
        ) : (
          hit.title /* pub-html-ok: clinical trial title, plain text from CT.gov/OnCore */
        )}
      </h3>
      {meta.length > 0 ? (
        <div className={META}>
          {meta.flatMap((m, i) => (i === 0 ? [m] : [<span key={`sep${i}`}>·</span>, m]))}
        </div>
      ) : null}
      {interventions.length > 0 || conditions.length > 0 ? (
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          {interventions.length > 0 && conditions.length > 0
            ? `Intervention & ${condLabel}`
            : interventions.length > 0
              ? "Intervention"
              : condLabel}
        </Disclosure>
      ) : null}
      {open ? (
        <div className={`${PANEL} grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2`}>
          {interventions.length > 0 ? (
            <>
              <span className="text-muted-foreground">Intervention</span>
              <span className="leading-normal">{interventions.join(" · ")}</span>
            </>
          ) : null}
          {conditions.length > 0 ? (
            <>
              <span className="text-muted-foreground">Conditions</span>
              <div className="flex flex-wrap gap-1.5">
                {conditions.map((c) => (
                  <span
                    key={c}
                    className="bg-apollo-surface-2 border-apollo-border rounded-full border px-[9px] py-0.5 text-[12.5px]"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
