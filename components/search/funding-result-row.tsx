"use client";

import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { SponsorAbbr } from "@/components/ui/sponsor-abbr";
import { MechanismAbbr } from "@/components/ui/mechanism-abbr";
import { sanitizePubTitle } from "@/lib/utils";
import type { FundingHit } from "@/lib/api/search-funding";

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

export function FundingResultRow({ hit }: { hit: FundingHit }) {
  const startYear = hit.startDate.slice(0, 4);
  const endYear = hit.endDate.slice(0, 4);
  const typeLabel = programTypeLabel(hit.programType);
  const visiblePeople = hit.people.slice(0, VISIBLE_COI_CAP);
  const remainder = hit.totalPeople - visiblePeople.length;

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
          <SponsorAbbr short={hit.primeSponsor} />
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
        <AwardId hit={hit} />
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

function AwardId({ hit }: { hit: FundingHit }) {
  if (!hit.awardNumber) return <span />;
  if (hit.mechanism) {
    const serial = awardSerial(hit.awardNumber, hit.mechanism);
    return (
      <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-xs text-[#5a5a5a]">
        <MechanismAbbr code={hit.mechanism} className="font-mono" />
        <span>{serial}</span>
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap font-mono text-xs text-[#5a5a5a]">
      {hit.awardNumber}
    </span>
  );
}
