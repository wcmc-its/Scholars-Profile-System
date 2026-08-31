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
import { COE_ABBR, COE_EXPANSION } from "@/lib/center-program-roles";
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
}: {
  leader: Leader;
  role: LeaderRole;
  /** #2542 Phase B — interim/acting qualifier. Opt-in: omitted (or false) by
   *  every pre-existing caller, whose `role` already carries any modifier it
   *  wants verbatim. When true, composes `role` through `formatLeadershipTitle`
   *  ("Director" -> "Interim Director") instead of requiring every call site
   *  to pre-format the string. */
  interim?: boolean;
}) {
  const displayRole = role === "COE Liaison" ? role : formatLeadershipTitle(role, interim);
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
              hover/focus. Every other role renders as plain text, unchanged. */}
          {role === "COE Liaison" ? (
            <>
              <AbbrTooltip short={COE_ABBR} expand={COE_EXPANSION} />
              {" Liaison"}
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
