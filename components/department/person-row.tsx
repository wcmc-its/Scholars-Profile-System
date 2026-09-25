import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import { formatRoleCategory } from "@/lib/role-display";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";
import { visibleInstitutionName } from "@/lib/institutions";
import { ROSTER_ROW_TAGS, type RosterMeshChip, type RosterRowTags } from "@/lib/roster-row-tags";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] focus-visible:ring-offset-1";
// Unit Page v2 TOPICS chip — slate outline pill (mock: 26px, 12.5px, radius 999).
// `max-w-full min-w-0` + a truncating label keep a long descriptor (e.g.
// "Antineoplastic Combined Chemotherapy Protocols") inside the 1fr column at
// 390px instead of spilling over the pubs/grants column.
const MESH_CHIP_CLASS =
  "inline-flex h-[26px] min-w-0 max-w-full items-center whitespace-nowrap rounded-full border border-apollo-slate bg-background px-[10px] text-[12.5px] leading-none text-apollo-slate";

/**
 * One roster row — Unit Page v2 layout: grid 40px | 1fr | 72px, 18px vertical
 * padding, a hairline under every row. Name (16px, slate + underline on hover)
 * with only the membership badge beside it; then title, a meta line (division /
 * department), an appointment line ("{role} at {institution}"), ONE tag row
 * (TOPICS MeSH chips by default, or method chips — see `ROSTER_ROW_TAGS`), and a
 * fixed pubs / grants column (a zero count is omitted, not dashed).
 */
export function PersonRow({
  hit,
  trailingBadge,
  methodChips,
  meshChips,
  rowTags = ROSTER_ROW_TAGS,
  activeAppointment = "All",
  departmentContext = false,
}: {
  hit: DepartmentFacultyHit;
  /** Optional badge rendered after the name — e.g. the center roster's
   *  Research/Clinical membership-type chip. Omitted everywhere else. */
  trailingBadge?: ReactNode;
  /** #962 — top 2–3 PUBLIC method families (center roster only). Each chip shows
   *  the `familyLabel` (aligns 1:1 with the facet value) with the methods/wrench
   *  icon; `exemplarTools` become the title tooltip. Renders nothing when empty
   *  (a member with no public families passes `undefined`). A structural subset
   *  of `CenterMemberFamily`, so `topMethods` satisfies it directly. */
  methodChips?: Array<{ value: string; familyLabel: string; exemplarTools: string[] }>;
  /** Unit Page v2 — the member's top ≤3 MeSH terms (`hit.topMesh`), shown as
   *  the TOPICS chip row, each deep-linking to the profile's `?mesh=` filter. */
  meshChips?: RosterMeshChip[];
  /** Which single tag row renders (mock `rowTags`). No cross-fallback: in
   *  "mesh" mode a member without MeSH terms shows no tag row. */
  rowTags?: RosterRowTags;
  /** The roster's active Appointment chip. The role label on the appointment
   *  line only shows under "All" — any narrower chip already says it. */
  activeAppointment?: string;
  /** Rendered on the row's OWN department roster: the meta line drops the
   *  redundant "Department of X" and shows just the division (or nothing). */
  departmentContext?: boolean;
}) {
  // #2519 — a Cornell (Ithaca) external member's `departmentName` is a raw
  // Cornell dept string (e.g. "CIO - IT Security Office"), not a WCM
  // department to prefix, and has no division segment; it's also `""` when
  // the person has no dept, in which case no department line renders at all.
  const deptLine = hit.isExternal
    ? hit.departmentName || null
    : departmentContext
      ? hit.divisionName || null
      : hit.divisionName
        ? `${hit.divisionName} · Department of ${hit.departmentName}`
        : `Department of ${hit.departmentName}`;
  // Appointment line (Unit Page v2 — replaces the uppercase role tag and the
  // institution pill beside the name). The institution is a non-WCMC primary
  // institution (absence-as-default) or, for an external member (#2519 Cornell
  // / CTSC feed), the feed institution — an external hit has no
  // `primaryOrgCode`, so the two never stack. The role label shows only under
  // the "All" chip and never for full-time faculty (the default appointment).
  const institution = hit.isExternal
    ? hit.externalInstitution || null
    : visibleInstitutionName(hit.primaryOrgCode);
  const roleLabel = hit.roleCategory ? formatRoleCategory(hit.roleCategory) : null;
  const apptLabel =
    activeAppointment === "All" && roleLabel && roleLabel !== "Full-time faculty"
      ? roleLabel
      : null;
  const apptLine =
    apptLabel && institution ? `${apptLabel} at ${institution}` : apptLabel || institution;

  const pubLabel = hit.pubCount === 1 ? "pub" : "pubs";
  const grantLabel = hit.grantCount === 1 ? "grant" : "grants";
  // TOPICS chips link to the WCM profile, so only rows whose name links there.
  const profileLinked =
    !hit.isExternal && isPubliclyDisplayed(hit.roleCategoryRaw ?? hit.roleCategory);
  const meshRow = rowTags === "mesh" && profileLinked ? (meshChips ?? []) : [];
  const methodRow = rowTags === "methods" ? (methodChips ?? []) : [];
  const nameClass =
    "text-foreground no-underline underline-offset-[3px] transition-colors duration-[120ms] ease-out hover:text-apollo-slate hover:underline";

  return (
    <div className="grid grid-cols-[40px_minmax(0,1fr)_72px] items-start gap-[14px] border-b border-apollo-border py-[18px]">
      <div>
        <HeadshotAvatar
          size="roster"
          cwid={hit.cwid}
          preferredName={hit.preferredName}
          identityImageEndpoint={hit.identityImageEndpoint}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[16px] leading-[22px]">
          {/* #2202 — `hit.roleCategory` is a display LABEL ("Doctoral student"),
              which is not a value isPubliclyDisplayed knows; it must see the raw
              enum. The fallback keeps older payloads working — and now that the
              predicate fails closed, an unrecognized label de-links rather than
              leaks. */}
          {hit.isExternal && !hit.externalProfileUrl ? (
            // A CTSC feed person with no SPS profile: plain name, no link.
            <span className="text-foreground">{hit.preferredName}</span>
          ) : hit.isExternal ? (
            // #2519 — a Cornell (Ithaca) external member has no WCM profile
            // (no slug, no Scholar row): link out to the Cornell directory
            // instead, and skip `PersonPopover` (it has no WCM data to show).
            <a
              href={hit.externalProfileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={nameClass}
            >
              {hit.preferredName}
            </a>
          ) : isPubliclyDisplayed(hit.roleCategoryRaw ?? hit.roleCategory) ? (
            <PersonPopover cwid={hit.cwid} surface="facet">
              <a href={profilePath(hit.slug)} className={nameClass}>
                {hit.preferredName}
              </a>
            </PersonPopover>
          ) : (
            // #536 — hidden identity class: name stays, but no profile link
            // (the route 404s) and no navigating popover.
            <span className="text-foreground">{hit.preferredName}</span>
          )}
          {trailingBadge}
        </div>
        {hit.primaryTitle && (
          <div className="text-[14px] leading-[20px] text-muted-foreground">
            {hit.primaryTitle}
          </div>
        )}
        {deptLine && (
          <div className="text-[13px] leading-[19px] text-foreground">{deptLine}</div>
        )}
        {apptLine && (
          <div className="text-[13px] leading-[19px] text-muted-foreground">{apptLine}</div>
        )}
        {meshRow.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-[6px]">
            <span
              aria-hidden
              className="mr-[2px] text-[10.5px] tracking-[0.12em] text-muted-foreground"
            >
              TOPICS
            </span>
            <ul
              aria-label="Research topics"
              className="m-0 flex min-w-0 max-w-full list-none flex-wrap gap-[6px] p-0"
            >
              {meshRow.map((c) => (
                <li key={c.ui ?? c.label} className="min-w-0 max-w-full">
                  {c.ui ? (
                    <a
                      href={`${profilePath(hit.slug)}?mesh=${encodeURIComponent(c.ui)}#publications`}
                      title={`${c.label} — see this topic on the scholar's profile`}
                      className={`${MESH_CHIP_CLASS} ${FOCUS_RING} no-underline transition-colors hover:bg-apollo-slate-tint hover:no-underline`}
                    >
                      <span className="truncate">{c.label}</span>
                    </a>
                  ) : (
                    <span className={MESH_CHIP_CLASS} title={c.label}>
                      <span className="truncate">{c.label}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {methodRow.length > 0 && (
          <div className="mt-[5px] flex flex-wrap items-center gap-[6px]">
            {methodRow.map((c) => (
              <span
                key={c.value}
                title={c.exemplarTools.length > 0 ? c.exemplarTools.join(", ") : undefined}
                className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap border border-apollo-border-strong bg-apollo-page px-[7px] text-[11.5px] text-muted-foreground"
              >
                <Wrench aria-hidden className="size-[11px]" strokeWidth={2} />
                {c.familyLabel}
              </span>
            ))}
          </div>
        )}
      </div>
      <dl className="m-0 flex flex-col gap-1 text-right text-[12px] leading-[20px] text-muted-foreground">
        {hit.pubCount > 0 && (
          <div>
            <dt className="inline text-[14px] text-foreground">
              {hit.pubCount.toLocaleString()}
            </dt>{" "}
            <dd className="m-0 inline">{pubLabel}</dd>
          </div>
        )}
        {hit.grantCount > 0 && (
          <div>
            <dt className="inline text-[14px] text-foreground">
              {hit.grantCount.toLocaleString()}
            </dt>{" "}
            <dd className="m-0 inline">{grantLabel}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
