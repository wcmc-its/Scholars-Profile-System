/**
 * Compact grant card used in the dept "Active grants" highlights row and the
 * Grants tab full list. Server Component. PI chips reuse AuthorChipRow with
 * isFirst=true to render the slate first-author variant; tooltip text is
 * overridden via a wrapper so single-PI vs multi-PI tooltips differ.
 *
 * Phase A: no dollar amount displayed (column missing from upstream).
 */
import type { DeptGrantCard } from "@/lib/api/dept-highlights";
import { parseFunderEyebrow } from "@/lib/grant-meta";
import { sanitizePubTitle } from "@/lib/utils";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { HoverTooltip } from "@/components/ui/hover-tooltip";

export function GrantCard({ grant }: { grant: DeptGrantCard }) {
  const eyebrow = parseFunderEyebrow(grant.funder, grant.awardNumber);
  // Grant titles carry the same inline markup as PubMed pub titles
  // (chemical formulae like [<sup>68</sup>Ga]-DOTATATE, gene names, etc.)
  // Reuse the same allowlist sanitizer.
  const titleHtml = sanitizePubTitle(grant.title);
  const startYear = grant.startDate?.getFullYear();
  const endYear = grant.endDate?.getFullYear();
  const period =
    startYear && endYear ? `${startYear}–${endYear}` : (endYear ? String(endYear) : "");

  return (
    <article
      className={`flex flex-col ${grant.isRecentlyCompleted ? "opacity-70" : ""}`}
      style={
        grant.isRecentlyCompleted
          ? { borderLeft: "2px dotted var(--color-border-strong)", paddingLeft: 8 }
          : undefined
      }
    >
      {eyebrow && (
        <div className="text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--color-accent-slate)]">
          {eyebrow}
        </div>
      )}
      <div
        className="mt-1 text-[13px] font-medium leading-[1.4] text-[var(--color-text-primary)]"
        dangerouslySetInnerHTML={{ __html: titleHtml }}
      />
      {grant.pis.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {grant.pis.map((p) => (
            <HoverTooltip
              key={p.cwid ?? p.name}
              text={grant.isMultiPi ? "Multi-PI" : "Principal investigator"}
            >
              <a
                href={p.slug ? `/scholars/${p.slug}` : undefined}
                className="chip chip-first flex items-center gap-1.5 rounded-full bg-background px-2.5 py-0.5 text-xs text-foreground"
                style={{ textDecoration: "none" }}
              >
                {p.identityImageEndpoint && p.cwid ? (
                  <HeadshotAvatar
                    size="sm"
                    cwid={p.cwid}
                    preferredName={p.name}
                    identityImageEndpoint={p.identityImageEndpoint}
                  />
                ) : null}
                {p.name}
              </a>
            </HoverTooltip>
          ))}
        </div>
      )}
      {period && (
        <div className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          <span>{period}</span>
          {grant.isRecentlyCompleted && (
            <span className="ml-2 italic">Recently completed</span>
          )}
        </div>
      )}
    </article>
  );
}
