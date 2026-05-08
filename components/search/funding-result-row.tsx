"use client";

import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { SponsorAbbr } from "@/components/ui/sponsor-abbr";
import { FunderEyebrow } from "@/components/ui/funder-eyebrow";
import { MechanismAbbr } from "@/components/ui/mechanism-abbr";
import { sanitizePubTitle } from "@/lib/utils";
import type { FundingFilters, FundingHit } from "@/lib/api/search-funding";

/**
 * Issue #78 F2 — Funding result row.
 *
 *   Title (wraps to two lines, ellipsis beyond)
 *   People row: avatar + name chips, lead-PI first, with Multi-PI pill
 *               and Type pill (when programType !== "Grant")
 *   Sponsor · year–year · via [direct]
 *   ↳ right column: <MechanismAbbr> serial   (NIH-funded only)
 *                   sponsor's award id        (non-NIH)
 *
 * The "via [direct]" annotation appears only on subawards; the headline
 * funder is always the prime sponsor (issue #78 F6).
 */
const VISIBLE_COI_CAP = 4;

const TYPE_PILL_LABEL: Record<string, string> = {
  "Contract with funding": "Contract",
  Fellowship: "Fellowship",
  Career: "Career",
  Training: "Training",
  "BioPharma Alliance Agreement": "BioPharma Alliance",
  Equipment: "Equipment",
};

function programTypeLabel(programType: string): string | null {
  if (!programType || programType === "Grant") return null;
  return TYPE_PILL_LABEL[programType] ?? programType;
}

function awardSerial(awardNumber: string, mechanism: string): string {
  const re = new RegExp(`^\\s*[1-9]?\\s*${mechanism}\\s*`, "i");
  return awardNumber.replace(re, "").trim();
}

export function FundingResultRow({
  hit,
  q,
  position,
  total,
  filters,
  applId,
}: {
  hit: FundingHit;
  /** Optional analytics context. Issue #80 item 9 — when present, clicks
   *  on a person chip in this row fire a `search_click` beacon mirroring
   *  the People + Publications tabs. */
  q?: string;
  position?: number;
  total?: number;
  filters?: FundingFilters;
  /** NIH RePORTER applId resolved by the parent list — when present, the
   *  award serial in the right column links out to RePORTER. Mirrors the
   *  profile Grants section's NIH-link behavior (issue #80 follow-up). */
  applId?: number;
}) {
  const startYear = hit.startDate.slice(0, 4);
  const endYear = hit.endDate.slice(0, 4);
  const typeLabel = programTypeLabel(hit.programType);
  const visiblePeople = hit.people.slice(0, VISIBLE_COI_CAP);
  const remainder = hit.totalPeople - visiblePeople.length;

  function trackClick(cwid: string) {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    if (q === undefined || position === undefined || total === undefined) return;
    const payload = {
      event: "search_click",
      q,
      position,
      cwid,
      projectId: hit.projectId,
      resultType: "funding",
      resultCount: total,
      filters: filters ?? {},
      ts: Date.now(),
    };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }

  return (
    <article className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-t border-[#e3e2dd] py-5">
      <div className="min-w-0">
        {/* Title — two-line clamp. */}
        <h3
          className="text-[15px] font-medium leading-snug text-[#1a1a1a] line-clamp-2"
          dangerouslySetInnerHTML={{ __html: sanitizePubTitle(hit.title) }}
        />

        {/* People row + inline pills. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {visiblePeople.map((p) => (
            <Link
              key={p.cwid}
              href={`/scholars/${p.slug}`}
              onClick={() => trackClick(p.cwid)}
              className="inline-flex items-center gap-1.5 text-[13px] text-[#2c4f6e] hover:underline"
            >
              <HeadshotAvatar
                cwid={p.cwid}
                identityImageEndpoint={p.identityImageEndpoint}
                preferredName={p.preferredName}
                size="sm"
              />
              <span>{p.preferredName}</span>
            </Link>
          ))}
          {remainder > 0 ? (
            <span className="text-[13px] text-[#757575]">
              +{remainder} more
            </span>
          ) : null}
          {hit.isMultiPi ? (
            <span className="inline-flex h-5 items-center rounded-sm bg-[#f1efe8] px-2 text-[10px] font-semibold uppercase tracking-wide text-[#444441]">
              Multi-PI
            </span>
          ) : null}
          {typeLabel ? (
            <span className="inline-flex h-5 items-center rounded-sm border border-[#d6d4ce] px-2 text-[10px] font-medium uppercase tracking-wide text-[#757575]">
              {typeLabel}
            </span>
          ) : null}
        </div>

        {/* Sponsor · dates · via [direct]. */}
        <div className="mt-1.5 text-[13px] text-[#5a5a5a]">
          <FunderEyebrow short={hit.primeSponsor} />
          {" · "}
          {startYear}
          {"–"}
          {endYear}
          {hit.isSubaward && hit.directSponsor ? (
            <>
              {" · via "}
              <SponsorAbbr short={hit.directSponsor} />
            </>
          ) : null}
        </div>
      </div>

      {/* Right column: award identifier. */}
      <div className="text-right">
        <AwardId hit={hit} applId={applId} />
        {hit.status === "active" ? (
          <div className="mt-1.5 inline-flex items-center rounded-full bg-[#eaf3de] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#27500a]">
            Active
          </div>
        ) : hit.status === "ending_soon" ? (
          <div className="mt-1.5 inline-flex items-center rounded-full bg-[#faeeda] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#854f0b]">
            Ending soon
          </div>
        ) : hit.status === "recently_ended" ? (
          <div className="mt-1.5 inline-flex items-center rounded-full bg-[#f1efe8] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#5a5a5a]">
            Recently ended
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AwardId({ hit, applId }: { hit: FundingHit; applId?: number }) {
  if (!hit.awardNumber) return <span />;
  const reporterUrl = applId
    ? `https://reporter.nih.gov/project-details/${applId}`
    : null;
  if (hit.mechanism) {
    const serial = awardSerial(hit.awardNumber, hit.mechanism);
    return (
      <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-xs text-[#5a5a5a]">
        <MechanismAbbr code={hit.mechanism} className="font-mono" />
        {reporterUrl ? (
          <a
            href={reporterUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="View on NIH RePORTER"
            className="text-[#2c4f6e] underline-offset-4 hover:underline"
          >
            {serial}
          </a>
        ) : (
          <span>{serial}</span>
        )}
      </span>
    );
  }
  return reporterUrl ? (
    <a
      href={reporterUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="View on NIH RePORTER"
      className="whitespace-nowrap font-mono text-xs text-[#2c4f6e] underline-offset-4 hover:underline"
    >
      {hit.awardNumber}
    </a>
  ) : (
    <span className="whitespace-nowrap font-mono text-xs text-[#5a5a5a]">
      {hit.awardNumber}
    </span>
  );
}
