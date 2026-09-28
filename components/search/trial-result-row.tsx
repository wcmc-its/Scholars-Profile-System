import Link from "next/link";
import { profilePath } from "@/lib/profile-url";
import { phaseLabel, sponsorTypeLabel, type SponsorTypeKey } from "@/lib/edit/clinical-trials-report";
import type { TrialHit, TrialMatchField } from "@/lib/api/search-trials";

const PI_LIMIT = 3;
const CONDITION_LIMIT = 3;
const FIELD_NOUN: Record<TrialMatchField, string> = {
  title: "title",
  conditions: "conditions",
  meshTerms: "conditions",
  piNames: "investigators",
  briefSummary: "summary",
};

/** "INTERVENTIONAL" / "Expanded Access" → "Interventional" / "Expanded access". */
export function studyTypeLabel(raw: string): string {
  const s = raw.trim().replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The row's "why it matched" line: the MeSH concept first, else the text field that hit. */
export function trialMatchLine(
  hit: Pick<TrialHit, "matchedConcept" | "matchedFields">,
  q: string,
  conceptLabel: string | null,
): { kind: string; text: string } | null {
  const fields = [...new Set(hit.matchedFields.map((f) => FIELD_NOUN[f]))];
  if (hit.matchedConcept && conceptLabel) {
    const where = ["conditions", ...(fields.includes("title") ? ["title"] : [])];
    return { kind: "Concept", text: `${conceptLabel} in ${joinAnd(where)}` };
  }
  const first = fields[0];
  if (!first || !q.trim()) return null;
  return { kind: first.charAt(0).toUpperCase() + first.slice(1), text: `contains “${q.trim()}”` };
}

/**
 * Clinical research tab result row (mockup: Clinical Research Tab.dc.html):
 *   Status pill · type · phase                       NCT ↗ | WCM protocol …
 *   Title
 *   PI names, each with a PI pill (+N more)
 *   Sponsor
 *   Condition chips (+N more), query-matching chips tinted
 *   Match line
 */
export function TrialResultRow({
  hit,
  q,
  conceptLabel,
}: {
  hit: TrialHit;
  q: string;
  conceptLabel: string | null;
}) {
  const active = hit.statusBucket === "active";
  const typeLine = [
    hit.studyType ? studyTypeLabel(hit.studyType) : null,
    hit.phase === "nr" ? null : phaseLabel(hit.phase),
  ]
    .filter(Boolean)
    .join(" · ");
  const sponsor =
    hit.principalSponsor ??
    (hit.sponsorClass === "unknown" ? null : sponsorTypeLabel(hit.sponsorClass as SponsorTypeKey));
  const conditions = hit.conditions.split(";").map((c) => c.trim()).filter(Boolean);
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const match = trialMatchLine(hit, q, conceptLabel);
  const ctgovHref = hit.nctNumber ? `https://clinicaltrials.gov/study/${hit.nctNumber}` : null;
  const piLink = (p: TrialHit["pis"][number]) => (
    <span key={p.cwid} className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Link href={profilePath(p.slug)} className="text-[#2c4f6e] hover:underline">
        {p.name}
      </Link>
      <span className="inline-flex h-[18px] items-center rounded-sm bg-[#f1efe8] px-1.5 text-[10px] font-semibold tracking-wide text-[#444441] uppercase">
        PI
      </span>
    </span>
  );

  return (
    <article className="flex flex-col gap-2 border-t border-[#e3e2dd] py-5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]">
        <span
          className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-medium whitespace-nowrap ${
            active ? "bg-[#eaf0f5] text-[var(--color-accent-slate)]" : "bg-[#f4f1ed] text-muted-foreground"
          }`}
        >
          <span aria-hidden="true" className="size-[7px] rounded-full bg-current" />
          {active ? "Active" : "Completed"}
        </span>
        {typeLine ? <span className="whitespace-nowrap text-muted-foreground">{typeLine}</span> : null}
        <span className="ml-auto">
          {ctgovHref ? (
            <a
              href={ctgovHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] whitespace-nowrap text-[var(--color-accent-slate)] tabular-nums hover:underline"
            >
              {hit.nctNumber} ↗
            </a>
          ) : (
            <span className="whitespace-nowrap text-muted-foreground">WCM protocol {hit.trialId}</span>
          )}
        </span>
      </div>
      <h3 className="text-[16px] leading-snug font-medium text-[#1a1a1a]">
        {ctgovHref ? (
          <a href={ctgovHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {hit.title /* pub-html-ok: clinical trial title, plain text from CT.gov/OnCore */}
          </a>
        ) : (
          hit.title /* pub-html-ok: clinical trial title, plain text from CT.gov/OnCore */
        )}
      </h3>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[13.5px]">
        {hit.pis.slice(0, PI_LIMIT).map(piLink)}
        {hit.pis.length > PI_LIMIT ? (
          // Native disclosure: no client JS for "+N more".
          <details className="inline-flex flex-wrap items-center gap-x-3.5 gap-y-1.5 [&[open]>summary]:hidden">
            <summary className="cursor-pointer list-none text-[13px] text-muted-foreground hover:underline">
              +{hit.pis.length - PI_LIMIT} more
            </summary>
            {hit.pis.slice(PI_LIMIT).map(piLink)}
          </details>
        ) : null}
      </div>
      {sponsor ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 text-[13px] leading-snug">
          <span className="text-muted-foreground">Sponsor</span>
          <span className="text-[#1a1a1a]">{sponsor}</span>
        </div>
      ) : null}
      {conditions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {conditions.slice(0, CONDITION_LIMIT).map((c) => {
            const hitWord = words.some((w) => c.toLowerCase().includes(w));
            return (
              <span
                key={c}
                className={`rounded-xl border px-2 py-0.5 text-[12.5px] text-[#1a1a1a] ${
                  hitWord ? "border-amber-200 bg-amber-50" : "border-[#e9e3df] bg-[#f4f1ed]"
                }`}
              >
                {c}
              </span>
            );
          })}
          {conditions.length > CONDITION_LIMIT ? (
            <span className="px-1 py-0.5 text-[12.5px] text-muted-foreground">
              +{conditions.length - CONDITION_LIMIT} more
            </span>
          ) : null}
        </div>
      ) : null}
      {match ? (
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-[var(--color-accent-slate)]">{match.kind}</span>
          {match.text}
        </div>
      ) : null}
    </article>
  );
}
