/**
 * Embedded leader card used by Department, Division, and Center pages.
 *
 * Generalizes the original ChairCard with a parameterized role label
 * ("Chair" | "Chief" | "Director"). Visual treatment is unchanged from
 * the dept-page hero spec: 52px avatar, tight padding, uppercase eyebrow,
 * underline-on-hover name link to the scholar profile.
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { AbbrTooltip } from "@/components/ui/abbr-tooltip";
import { formatLeadershipTitle } from "@/lib/org-unit-roles";
import { profilePath } from "@/lib/profile-url";

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
}) {
  const displayRole = expansion ? role : formatLeadershipTitle(role, interim);
  const abbrWord = expansion ? (role.split(" ")[0] ?? role) : "";
  const abbrRest = expansion ? role.slice(abbrWord.length) : "";
  return (
    <div className="mt-6 flex max-w-[460px] items-center gap-[14px] rounded-md border border-border bg-background px-4 py-[14px]">
      <HeadshotAvatar
        size="md"
        cwid={leader.cwid}
        preferredName={leader.preferredName}
        identityImageEndpoint={leader.identityImageEndpoint}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-[3px] text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
        </div>
        {leader.slug ? (
          <a
            href={profilePath(leader.slug)}
            className="text-[16px] font-medium leading-[1.2] hover:underline"
            style={{ textDecoration: "none" }}
          >
            {leader.preferredName}
          </a>
        ) : (
          // External leader (not a WCM scholar) — no profile to link to.
          <span className="text-[16px] font-medium leading-[1.2]">
            {leader.preferredName}
          </span>
        )}
        {leader.primaryTitle && (
          <div className="text-[13px] leading-[1.4] text-muted-foreground">
            {leader.primaryTitle}
          </div>
        )}
      </div>
    </div>
  );
}
