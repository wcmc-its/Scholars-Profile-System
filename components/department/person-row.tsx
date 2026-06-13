import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import { htmlToPlainText } from "@/lib/utils";
import { formatRoleCategory } from "@/lib/role-display";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";

/**
 * Per neurology_dept_body_per_spec.html: 11px uppercase role tag with 0.06em
 * letter-spacing on a muted-secondary background, 0.5px border, 3px radius.
 */
function RoleTag({ role }: { role: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[3px] border border-border bg-muted px-[6px] text-[11px] font-medium leading-[1.4] uppercase tracking-[0.06em] text-muted-foreground"
    >
      {role}
    </span>
  );
}

export function PersonRow({
  hit,
  trailingBadge,
  methodChips,
}: {
  hit: DepartmentFacultyHit;
  /** Optional badge rendered after the role tag — e.g. the center roster's
   *  Research/Clinical membership-type chip. Omitted everywhere else. */
  trailingBadge?: ReactNode;
  /** #962 — top 2–3 PUBLIC method families (center roster only). Each chip shows
   *  the `familyLabel` (aligns 1:1 with the facet value) with the methods/wrench
   *  icon; `exemplarTools` become the title tooltip. Renders nothing when empty
   *  (a member with no public families passes `undefined`). A structural subset
   *  of `CenterMemberFamily`, so `topMethods` satisfies it directly. */
  methodChips?: Array<{ value: string; familyLabel: string; exemplarTools: string[] }>;
}) {
  const deptLine = hit.divisionName
    ? `${hit.divisionName} · Department of ${hit.departmentName}`
    : `Department of ${hit.departmentName}`;
  const snippet = hit.overview ? htmlToPlainText(hit.overview) : null;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";

  return (
    <div className="grid grid-cols-[48px_1fr_auto] items-start gap-[13px] py-4 border-b border-border last:border-b-0">
      <div>
        <HeadshotAvatar
          size="md"
          cwid={hit.cwid}
          preferredName={hit.preferredName}
          identityImageEndpoint={hit.identityImageEndpoint}
        />
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="mb-[3px] flex flex-wrap items-center gap-2 text-[15px] font-medium leading-[1.3]">
          {isPubliclyDisplayed(hit.roleCategory) ? (
            <PersonPopover cwid={hit.cwid} surface="facet">
              <a
                href={profilePath(hit.slug)}
                className="hover:underline"
                style={{ textDecoration: "none", color: "var(--color-text-primary)" }}
              >
                {hit.preferredName}
              </a>
            </PersonPopover>
          ) : (
            // #536 — hidden identity class: name + role tag stay, but no
            // profile link (the route 404s) and no navigating popover.
            <span style={{ color: "var(--color-text-primary)" }}>{hit.preferredName}</span>
          )}
          {hit.roleCategory && (() => {
            const label = formatRoleCategory(hit.roleCategory);
            return label ? <RoleTag role={label} /> : null;
          })()}
          {trailingBadge}
        </div>
        {hit.primaryTitle && (
          <div className="mb-[2px] text-[13px] text-muted-foreground">
            {hit.primaryTitle}
          </div>
        )}
        <div className="mb-[5px] text-[12.5px] text-[var(--color-text-tertiary)]">
          {deptLine}
        </div>
        {snippet && (
          <div className="text-[13px] leading-[1.5] text-muted-foreground">
            {snippet}
          </div>
        )}
        {methodChips && methodChips.length > 0 && (
          <div className="mt-[6px] flex flex-wrap items-center gap-[6px]">
            {methodChips.map((c) => (
              <span
                key={c.value}
                title={c.exemplarTools.length > 0 ? c.exemplarTools.join(", ") : undefined}
                className="inline-flex items-center gap-1 rounded-[3px] border border-border bg-muted px-[6px] py-[1px] text-[11px] font-medium leading-[1.4] text-muted-foreground"
              >
                <Wrench aria-hidden className="h-3 w-3" strokeWidth={2} />
                {c.familyLabel}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 self-start pt-1 text-[12px] text-[var(--color-text-tertiary)]">
        {hit.pubCount > 0 && (
          <span>
            <b className="text-[14px] font-medium text-foreground">
              {hit.pubCount.toLocaleString()}
            </b>{" "}
            {pubLabel}
          </span>
        )}
        {hit.grantCount > 0 && (
          <span>
            <b className="text-[14px] font-medium text-foreground">
              {hit.grantCount.toLocaleString()}
            </b>{" "}
            {grantLabel}
          </span>
        )}
      </div>
    </div>
  );
}
