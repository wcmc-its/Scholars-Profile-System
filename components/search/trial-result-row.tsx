import Link from "next/link";
import { profilePath } from "@/lib/profile-url";
import { phaseLabel, sponsorTypeLabel, type SponsorTypeKey } from "@/lib/edit/clinical-trials-report";
import type { TrialHit } from "@/lib/api/search-trials";

/**
 * Clinical trials tab result row, modeled on the Funding row:
 *   Title (two-line clamp)
 *   PI name links
 *   Status · phase · sponsor type · sponsor
 *   Conditions (one line)
 *   ↳ right column: NCT number linking to ClinicalTrials.gov
 */
export function TrialResultRow({ hit }: { hit: TrialHit }) {
  const phase = hit.phase === "nr" ? null : phaseLabel(hit.phase);
  const sponsorType = hit.sponsorClass === "unknown" ? null : sponsorTypeLabel(hit.sponsorClass as SponsorTypeKey);
  return (
    <article className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-t border-[#e3e2dd] py-5">
      <div className="min-w-0">
        <h3 className="line-clamp-2 text-[15px] leading-snug font-medium text-[#1a1a1a]">{hit.title /* pub-html-ok: clinical trial title, plain text from CT.gov/OnCore */}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {hit.pis.map((p) => (
            <Link
              key={p.cwid}
              href={profilePath(p.slug)}
              className="text-[13px] text-[#2c4f6e] hover:underline"
            >
              {p.name}
            </Link>
          ))}
          <span className="inline-flex h-5 items-center rounded-sm bg-[#f1efe8] px-2 text-[10px] font-semibold tracking-wide text-[#444441] uppercase">
            PI
          </span>
        </div>
        <div className="mt-1.5 text-[13px] text-[#5a5a5a]">
          {[hit.statusBucket === "active" ? "Active" : "Completed", phase, sponsorType, hit.principalSponsor]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {hit.conditions ? (
          <div className="mt-1 line-clamp-1 text-[13px] text-muted-foreground">{hit.conditions}</div>
        ) : null}
      </div>
      {hit.nctNumber ? (
        <a
          href={`https://clinicaltrials.gov/study/${hit.nctNumber}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] whitespace-nowrap text-[var(--color-accent-slate)] hover:underline"
        >
          {hit.nctNumber} ↗
        </a>
      ) : (
        <span />
      )}
    </article>
  );
}
