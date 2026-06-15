/**
 * Embedded leader card used by Department, Division, and Center pages.
 *
 * Generalizes the original ChairCard with a parameterized role label
 * ("Chair" | "Chief" | "Director"). Visual treatment is unchanged from
 * the dept-page hero spec: 52px avatar, tight padding, uppercase eyebrow,
 * underline-on-hover name link to the scholar profile.
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { profilePath } from "@/lib/profile-url";

export type LeaderRole = "Chair" | "Chief" | "Director";

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
}: {
  leader: Leader;
  role: LeaderRole;
}) {
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
          {role}
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
