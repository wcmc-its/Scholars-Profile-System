/**
 * Embedded leader card used by Department, Division, and Center pages.
 *
 * Generalizes the original ChairCard with a parameterized role label
 * ("Chair" | "Chief" | "Director"). Unit Page v2 treatment: the whole card
 * links to the scholar profile (40px headshot, warm page fill, surface-2 hover),
 * except for an external leader or an abbreviation-expanded role (see below).
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { AbbrTooltip } from "@/components/ui/abbr-tooltip";
import { formatLeadershipTitle } from "@/lib/org-unit-roles";
import { profilePath } from "@/lib/profile-url";
import { cn } from "@/lib/utils";

export type LeaderRole =
  | "Chair"
  | "Chief"
  | "Director"
  // #1105 — center program leader (and its interim qualifier). The card renders
  // the role string verbatim in the eyebrow.
  | "Leader"
  | "Interim Leader"
  // #1570 — Community Outreach & Engagement liaison for a Meyer Cancer Center
  // program (rendered as a separate card after the Leaders).
  | "COE Liaison"
  // #2542 Phase B — center-vocabulary labels ("Co-Director", "Associate
  // Director", …) are curator-editable data, not a closed set. The literals
  // above stay for autocomplete/docs; any string is accepted.
  | (string & {});

export type Leader = {
  cwid: string;
  preferredName: string;
  /** Profile slug, or null for an external leader (not a WCM scholar) — the
   *  name then renders as plain text with no profile link. */
  slug: string | null;
  primaryTitle: string | null;
  identityImageEndpoint: string;
};

export function LeaderCard({
  leader,
  role,
  interim = false,
  expansion = null,
  className,
}: {
  leader: Leader;
  role: LeaderRole;
  /** #2542 Phase B — interim/acting qualifier. Opt-in: omitted (or false) by
   *  every pre-existing caller, whose `role` already carries any modifier it
   *  wants verbatim. When true, composes `role` through `formatLeadershipTitle`
   *  ("Director" -> "Interim Director") instead of requiring every call site
   *  to pre-format the string. Ignored when `expansion` is set — see below. */
  interim?: boolean;
  /** #2558 — long form for `role`'s abbreviated leading word (e.g. "Community
   *  Outreach & Engagement" for "COE Liaison"), sourced from the vocabulary's
   *  `OrgUnitRole.expansion` column rather than a hardcoded constant (#1570's
   *  original "COE" affordance). When present, the leading word of `role`
   *  renders as an `<abbr>` tooltip and `interim` is ignored — a role that
   *  needs its abbreviation spelled out has never carried an Interim qualifier
   *  (the caller bakes it into `role` instead, if it should apply). */
  expansion?: string | null;
  /** Optional override for the wrapper's top margin / max width, so a
   *  caller (e.g. a 2-column leadership grid) can replace `mt-[22px]` and
   *  `max-w-[460px]` without affecting other callers. */
  className?: string;
}) {
  const displayRole = expansion ? role : formatLeadershipTitle(role, interim);
  const abbrWord = expansion ? (role.split(" ")[0] ?? role) : "";
  const abbrRest = expansion ? role.slice(abbrWord.length) : "";
  // Unit Page v2 — the WHOLE card is the profile link. Two carve-outs keep the
  // card a plain <div> with only the name linked (the pre-v2 treatment):
  //   - an external leader (slug null) has no profile to link to;
  //   - a role with an `expansion` renders a focusable <abbr> tooltip in the
  //     eyebrow, which must not nest inside an <a> (interactive-in-interactive).
  const cardLinked = !!leader.slug && !expansion;
  const shellClass = cn(
    "mt-[22px] flex w-full max-w-[460px] items-center gap-[14px] rounded-[8px] border border-apollo-border bg-apollo-page p-4 text-foreground",
    cardLinked &&
      "no-underline transition-colors duration-[120ms] ease-out hover:border-apollo-border-strong hover:bg-apollo-surface-2 hover:no-underline",
    className,
  );
  const body = (
    <>
      <HeadshotAvatar
        size="roster"
        cwid={leader.cwid}
        preferredName={leader.preferredName}
        identityImageEndpoint={leader.identityImageEndpoint}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {/* #1570 — "COE" is the one eyebrow that isn't self-evident; expand it on
              hover/focus (#2558 — sourced from `expansion`, not a hardcoded
              constant). Every other role renders as plain text, unchanged. */}
          {expansion ? (
            <>
              <AbbrTooltip short={abbrWord} expand={expansion} />
              {abbrRest}
            </>
          ) : (
            displayRole
          )}
        </span>
        {leader.slug && !cardLinked ? (
          <a
            href={profilePath(leader.slug)}
            className="text-[16px] leading-[22px] text-foreground no-underline hover:text-apollo-slate hover:underline"
          >
            {leader.preferredName}
          </a>
        ) : (
          // Card-linked leader (the card is the link), or an external leader
          // (not a WCM scholar) — no profile to link to.
          <span className="text-[16px] leading-[22px]">{leader.preferredName}</span>
        )}
        {leader.primaryTitle && (
          <span className="text-[13px] leading-[1.4] text-muted-foreground">
            {leader.primaryTitle}
          </span>
        )}
      </span>
    </>
  );
  return cardLinked ? (
    <a href={profilePath(leader.slug!)} className={shellClass}>
      {body}
    </a>
  ) : (
    <div className={shellClass}>{body}</div>
  );
}
