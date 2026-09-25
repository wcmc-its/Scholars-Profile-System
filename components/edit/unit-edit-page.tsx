/**
 * The `/edit/{department,division,center}/[code]` detail router inside the
 * Apollo shell (#540 Phase 7, `unit-curation-edit-ui-spec.md` § Layout +
 * § The attribute set). Parallel to `components/edit/edit-page.tsx` — the
 * scholar router is scholar-shaped (name/photo/publications); unit attributes
 * (Members, Access, Center type) don't fit it, so the two stay separate and
 * share only `EditShell` + the rail primitives.
 *
 * The rail is filtered to the actor's capability BEFORE render — visibility =
 * capability (no greyed-out rows a user can hover but never click). The active
 * attribute comes from `?attr=`, defaulting to `description`.
 *
 * PR-7a wired `description`, `leader`, and `access`. PR-7b adds the center
 * route and wires `slug`, `center-type`, and `retire`. The center `roster`
 * (the rich #552 Member/Type/Program/Start/End/Status table + its history view)
 * lands in a follow-up that depends on #552 Phase 1 (schema) + Phase 2
 * (`/api/edit/roster` `set` action); until then `roster` keeps a placeholder —
 * deliberate, so the PR boundary is visible to reviewers.
 *
 * Edit Center mockup (2026-09-25): a CENTER no longer uses the one-panel rail —
 * it renders `UnitEditSections`, every visible attribute as a section of one
 * scrolling page (the five Basics fields merged into one form). Visibility still
 * comes from `ATTRIBUTES` below; `?attr=roster` keeps the full-width Members
 * page; any other `?attr=` scrolls to the section that now holds it.
 * Departments and divisions are unchanged here.
 *
 * Retired read-through (edge 11): a Superuser may open a retired unit (to
 * restore it). The `retire` panel renders normally so they can Restore; every
 * other panel shows a "Retired — restore to edit" notice instead of its editor.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { CenterBasicsSection } from "@/components/edit/center-basics-section";
import { CenterLeadershipCard } from "@/components/edit/center-leadership-card";
import { CenterProgramCard } from "@/components/edit/center-program-card";
import { CenterRosterCard } from "@/components/edit/center-roster-card";
import { CenterTypeCard } from "@/components/edit/center-type-card";
import { EditShell } from "@/components/edit/edit-shell";
import { SiblingDivisionsRail } from "@/components/edit/sibling-divisions-rail";
import { UnitAccessCard } from "@/components/edit/unit-access-card";
import { UnitDescriptionCard } from "@/components/edit/unit-description-card";
import { UnitUrlCard } from "@/components/edit/unit-url-card";
import { UnitLeaderCard } from "@/components/edit/unit-leader-card";
import { UnitRetireCard } from "@/components/edit/unit-retire-card";
import { UnitFacultyExportCard } from "@/components/edit/unit-faculty-export-card";
import { UnitRosterCard } from "@/components/edit/unit-roster-card";
import { UnitNameCard } from "@/components/edit/unit-name-card";
import { UnitSlugCard } from "@/components/edit/unit-slug-card";
import { CtscFeedIssuesPanel } from "@/components/edit/ctsc-feed-issues-panel";
import { UnitEditSections, type UnitEditSection } from "@/components/edit/unit-edit-sections";
import { Button } from "@/components/ui/button";
import { CTSC_CENTER_SLUG } from "@/lib/edit/external-member-sources";
import { INVITED_ROLE_KEY } from "@/lib/org-unit-roles";
import type { RailItem } from "@/components/edit/attribute-rail";
import type { UnitActorRole, UnitEditContext } from "@/lib/api/unit-edit-context";
import { isUnitRosterExportEnabled } from "@/lib/edit/unit-roster-export";
import { isCornellDirectoryMembersEnabled } from "@/lib/edit/cornell-directory-flag";

type AttrKey =
  | "description"
  | "url"
  | "leader"
  | "roster"
  | "programs"
  | "access"
  | "name"
  | "slug"
  | "center-type"
  | "retire"
  | "feed-issues";

type AttrDef = {
  key: AttrKey;
  label: string;
  /** Returns true when this attribute is visible for the given context. */
  visible: (ctx: UnitEditContext) => boolean;
};

const isSuperuser = (role: UnitActorRole) => role === "superuser";

/** Whether SPS — not the enterprise directory — owns this unit's data.
 *
 *  A center is always manually owned; a division only when `source='manual'`.
 *  A department, and an ED-sourced division, carry directory-derived values that
 *  the next `etl/ed` run would overwrite, so SPS may not edit them in-row.
 *  This is the boundary for BOTH the curated roster and the name — the same
 *  predicate `/api/edit/unit` and `/api/edit/roster` enforce server-side. */
const isManuallyOwned = (ctx: UnitEditContext) =>
  ctx.unit.unitType === "center" ||
  (ctx.unit.unitType === "division" && ctx.unit.source === "manual");

const hasRoster = isManuallyOwned;

// A department / division has no curated roster, but when the roster-export flag
// is on they get a read-only "Members" tab carrying the faculty CSV export.
const hasFacultyExportTab = (ctx: UnitEditContext) =>
  isUnitRosterExportEnabled() &&
  (ctx.unit.unitType === "department" || ctx.unit.unitType === "division");

// A center keeps the same data-driven "has a program taxonomy" gate
// Programs/NCI-Table-2A/Reports have always shared — a center with a program
// taxonomy is exactly the population the Cancer Center reports cover.
// Department/division have no such taxonomy to gate on — reports 3
// (Publications) and 6 (NIH-funded pubs) are kind-generic and degrade to an
// empty state rather than erroring (org-unit publications reports plan,
// 2026-08-16; same ungated posture `loadReportableUnitsForActor` already
// applies to these two kinds), so any department/division this actor can
// edit is reportable. Reports moved off the in-page attribute set to the
// top-level `/edit/reports` console (cancer-center-reports-consolidation);
// this predicate now decides whether `EditShell`'s header "View reports"
// link (`reportsHref`) renders — it used to gate a rail-mounted link instead
// (`CenterReportsRailLink`, retired Reports IA redesign 2026-08-14, so the
// link survives the roster/Members page, which hides the rail).
const hasUnitReports = (ctx: UnitEditContext) =>
  ctx.unit.unitType === "center"
    ? (ctx.programs?.length ?? 0) > 0
    : ctx.unit.unitType === "department" || ctx.unit.unitType === "division";

/** The full attribute set; `visible` encodes the SPEC § attribute table. */
const ATTRIBUTES: ReadonlyArray<AttrDef> = [
  // Only for units SPS owns — a department's name is the directory's, and an
  // edit here would be silently reverted by the next nightly ETL.
  { key: "name", label: "Name", visible: isManuallyOwned },
  { key: "description", label: "Description", visible: () => true },
  // #1021 — same visibility as Description (curators / owners / superuser).
  { key: "url", label: "Website", visible: () => true },
  { key: "leader", label: "Leadership", visible: () => true },
  {
    key: "roster",
    label: "Members",
    visible: (ctx) => hasRoster(ctx) || hasFacultyExportTab(ctx),
  },
  // #1117 — per-program leaders + description; only for a center with a program
  // taxonomy (the Cancer-Center-only gate is data-driven, like the roster fields).
  {
    key: "programs",
    label: "Programs",
    visible: (ctx) => ctx.unit.unitType === "center" && (ctx.programs?.length ?? 0) > 0,
  },
  // Visibility is driven directly by whether the context populated the access
  // array — `loadUnitEditContext`'s `canManageAccess` local already resolves
  // Owner/Superuser/comms_steward (2026-08-26 policy widening, decision #3),
  // so gating on `ctx.actorRole` here would re-derive a narrower answer: a
  // grant-less steward's `actorRole` floors at "curator" for content-editing
  // purposes even though `access` is non-null for them.
  { key: "access", label: "Access", visible: (ctx) => ctx.access !== null },
  { key: "slug", label: "Profile URL", visible: (ctx) => isSuperuser(ctx.actorRole) },
  {
    key: "center-type",
    label: "Center type",
    visible: (ctx) => ctx.unit.unitType === "center" && isSuperuser(ctx.actorRole),
  },
  { key: "retire", label: "Retire unit", visible: (ctx) => isSuperuser(ctx.actorRole) },
  // CTSC only: records in the CTSC feed whose CWID CTSC should fix (etl/ctsc-roster).
  {
    key: "feed-issues",
    label: "Feed CWID issues",
    visible: (ctx) => ctx.unit.unitType === "center" && ctx.unit.slug === CTSC_CENTER_SLUG,
  },
];

const DEFAULT_ATTR: AttrKey = "description";

export type UnitEditPageProps = {
  ctx: UnitEditContext;
  /** The selected attribute from `?attr=`; falls back to `description`. */
  attr?: string;
  /** Whether the viewer satisfies the units-tab predicate
   *  (`TAB_PREDICATES.units`, `lib/edit/console-tabs.server.ts`) — forwarded
   *  verbatim to `EditShell`'s `orgUnitsNavVisible`, which gates the
   *  navigable "Org units / {name}" breadcrumb (dwd2001 bug #7). The caller
   *  page computes this server-side (`loadConsoleTabs(session, db.read)`);
   *  default `false` keeps the flat label for a caller that hasn't. */
  orgUnitsNavVisible?: boolean;
};

export function UnitEditPage({ ctx, attr, orgUnitsNavVisible = false }: UnitEditPageProps) {
  const visible = ATTRIBUTES.filter((a) => a.visible(ctx));
  const active: AttrDef =
    visible.find((a) => a.key === attr) ??
    visible.find((a) => a.key === DEFAULT_ATTR) ??
    visible[0];

  const railItems: RailItem[] = visible.map((a) => ({ key: a.key, label: a.label }));
  const basePath = `/edit/${ctx.unit.unitType}/${ctx.unit.code}`;
  const previewHref =
    ctx.unit.unitType === "department"
      ? `/departments/${ctx.unit.slug}`
      : ctx.unit.unitType === "center"
        ? `/centers/${ctx.unit.slug}`
        : ctx.unit.deptSlug
          ? `/departments/${ctx.unit.deptSlug}/divisions/${ctx.unit.slug}`
          : undefined; // a division with no resolvable parent slug has no preview

  // A department gets its sibling-divisions cross-nav; other unit types have
  // nothing to put here (a center's Reports link moved to `reportsHref` below).
  const subRail =
    ctx.unit.unitType === "department" && ctx.siblingDivisions ? (
      <SiblingDivisionsRail divisions={ctx.siblingDivisions} />
    ) : undefined;

  const reportsHref = hasUnitReports(ctx)
    ? ctx.unit.unitType === "center"
      ? `/edit/reports?center=${encodeURIComponent(ctx.unit.code)}`
      : `/edit/reports?center=${encodeURIComponent(ctx.unit.code)}&kind=${ctx.unit.unitType}`
    : undefined;

  // A center renders the single-scroll editor (Edit Center mockup, 2026-09-25)
  // — every section on one page. The rich Members table keeps its own
  // full-width `?attr=roster` page below (EditShell with `hideRail`).
  if (ctx.unit.unitType === "center" && active.key !== "roster") {
    return (
      <UnitEditSections
        name={ctx.unit.name}
        kindLabel={ctx.unit.centerType === "institute" ? "Institute" : "Center"}
        crumbLabel="Centers"
        orgUnitsNavVisible={orgUnitsNavVisible}
        actorRole={ctx.actorRole}
        previewHref={previewHref}
        reportsHref={reportsHref}
        sections={centerSections(ctx, visible, basePath)}
        initialSection={attr ? LEGACY_ATTR_SECTION[attr as AttrKey] : undefined}
        notice={ctx.unit.suppression !== null ? <RetiredNotice /> : undefined}
      />
    );
  }

  return (
    <EditShell
      mode="superuser"
      scholarName={ctx.unit.name}
      // A unit, not a scholar profile — "Profiles" never has anywhere useful
      // to go from a unit editor. Its OWN structural crumb ("Org units") is
      // `orgUnitsNavVisible`, gated on the caller's units-tab predicate.
      isProfileEntity={false}
      orgUnitsNavVisible={orgUnitsNavVisible}
      railItems={railItems}
      activeAttr={active.key}
      basePath={basePath}
      previewHref={previewHref}
      reportsHref={reportsHref}
      subRail={subRail}
      // Members gets the whole width for its own filter bar + (on a center)
      // disease grid, not a shared column with a rail it has no room to use —
      // "← Back" (to basePath, the default attr, rail restored) replaces it.
      hideRail={active.key === "roster"}
      backHref={basePath}
    >
      {renderPanel(active.key, ctx)}
    </EditShell>
  );
}

/** Old `?attr=` bookmarks → the section of the single-scroll page they now
 *  live in (the five Basics fields collapsed into one section). */
const LEGACY_ATTR_SECTION: Partial<Record<AttrKey, string>> = {
  name: "basics",
  description: "basics",
  url: "basics",
  slug: "basics",
  "center-type": "basics",
  leader: "leadership",
  programs: "programs",
  access: "access",
  "feed-issues": "feed-issues",
  retire: "retire",
};

/** Mirrors `CenterProgramCard`'s EXCLUDED_PROGRAM_CODES (no public page). */
const CENTER_PROGRAMS_WITHOUT_PAGE = new Set(["ZY"]);

/** The center's sections, gated by the SAME visibility predicates the rail
 *  used (`visible` is `ATTRIBUTES` already filtered for this ctx). */
function centerSections(
  ctx: UnitEditContext,
  visible: ReadonlyArray<AttrDef>,
  basePath: string,
): UnitEditSection[] {
  const has = (key: AttrKey) => visible.some((a) => a.key === key);
  const retired = ctx.unit.suppression !== null;
  const retireSection: UnitEditSection | null = has("retire")
    ? {
        id: "retire",
        label: "Retire",
        tone: "danger",
        content: (
          <UnitRetireCard
            entityType="center"
            entityId={ctx.unit.code}
            unitName={ctx.unit.name}
            headingId="retire-heading"
            suppression={
              ctx.unit.suppression
                ? { id: ctx.unit.suppression.id, suppressedAt: ctx.unit.suppression.suppressedAt }
                : null
            }
          />
        ),
      }
    : null;
  // Retired read-through (edge 11): only the Retire section stays editable.
  if (retired) return retireSection ? [retireSection] : [];

  const sections: UnitEditSection[] = [];
  const description = ctx.unit.description?.trim() ?? "";
  sections.push({
    id: "basics",
    label: "Basics",
    stat: description ? undefined : "No description",
    warn: !description,
    content: (
      <CenterBasicsSection
        code={ctx.unit.code}
        name={ctx.unit.name}
        description={ctx.unit.description}
        url={ctx.unit.url}
        slug={ctx.unit.slug}
        centerType={ctx.unit.centerType ?? "center"}
        canEditSuperuserFields={isSuperuser(ctx.actorRole)}
        headingId="basics-heading"
      />
    ),
  });

  const leadership = ctx.centerLeadership ?? [];
  const holderCount = leadership.reduce((n, r) => n + r.holders.length, 0);
  sections.push({
    id: "leadership",
    label: "Leadership",
    stat: String(holderCount),
    content: (
      <CenterLeadershipCard
        centerCode={ctx.unit.code}
        roles={leadership}
        headingId="leadership-heading"
      />
    ),
  });

  if (has("roster")) {
    const active = activeCenterMemberCount(ctx.roster ?? []);
    sections.push({
      id: "members",
      label: "Members",
      stat: active.toLocaleString("en-US"),
      content: (
        <CenterMembersSummary
          count={active}
          rosterHref={`${basePath}?attr=roster`}
          exportHref={
            isUnitRosterExportEnabled()
              ? `/edit/center/${encodeURIComponent(ctx.unit.code)}/export`
              : undefined
          }
        />
      ),
    });
  }

  if (has("programs")) {
    const programs = ctx.programs ?? [];
    sections.push({
      id: "programs",
      label: "Programs",
      stat: String(programs.filter((p) => !CENTER_PROGRAMS_WITHOUT_PAGE.has(p.code)).length),
      content: (
        <CenterProgramCard
          centerCode={ctx.unit.code}
          programs={programs}
          headingId="programs-heading"
        />
      ),
    });
  }

  if (has("access")) {
    sections.push({
      id: "access",
      label: "Access",
      stat: String(ctx.access?.length ?? 0),
      content: (
        <UnitAccessCard
          entityType="center"
          entityId={ctx.unit.code}
          access={ctx.access}
          actorCwid={ctx.actorCwid}
          headingId="access-heading"
        />
      ),
    });
  }

  if (has("feed-issues")) {
    sections.push({
      id: "feed-issues",
      label: "Feed CWID issues",
      headingId: "panel-heading",
      content: <CtscFeedIssuesPanel />,
    });
  }

  if (retireSection) sections.push(retireSection);
  return sections;
}

/** Active members, by the same #552 §3.3 predicate the roster table's default
 *  view uses (invitees never count; inclusive dates; null = open). */
function activeCenterMemberCount(
  roster: NonNullable<UnitEditContext["roster"]>,
  today: string = new Date().toISOString().slice(0, 10),
): number {
  return roster.filter(
    (m) =>
      m.membershipRoleKey !== INVITED_ROLE_KEY &&
      !(m.startDate && m.startDate > today) &&
      !(m.endDate && m.endDate < today),
  ).length;
}

/** The Members section: a count + the way into the full roster table (which
 *  keeps its own full-width page — filters, disease review, xlsx). */
function CenterMembersSummary({
  count,
  rosterHref,
  exportHref,
}: {
  count: number;
  rosterHref: string;
  exportHref?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4" data-testid="center-members-summary">
      <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
        <h2 id="members-heading" className="text-[17px] font-[600] tracking-[-0.015em]">
          Members
        </h2>
        <p className="text-muted-foreground text-[13px]">
          Faculty on the center roster, as shown on its public page.
        </p>
      </div>
      <p className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums" data-testid="center-members-count">
          {count.toLocaleString("en-US")}
        </span>
        <span className="text-muted-foreground text-[13px]">active</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {exportHref && (
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} data-testid="center-members-export">
              Export CSV
            </a>
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className="border-apollo-slate text-apollo-slate">
          <Link href={rosterHref} data-testid="center-members-manage">
            Manage members
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function renderPanel(key: AttrKey, ctx: UnitEditContext) {
  // Retired read-through (edge 11): every panel except `retire` is read-only
  // while the unit is retired — the Superuser restores via the retire panel.
  if (ctx.unit.suppression !== null && key !== "retire") {
    return <RetiredNotice />;
  }
  switch (key) {
    case "description":
      return (
        <UnitDescriptionCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          description={ctx.unit.description}
          // Centers edit in-row (no field_override), so there is nothing to clear.
          canClear={ctx.unit.unitType !== "center"}
          hasOverride={ctx.unit.overriddenFields.includes("description")}
        />
      );
    case "url":
      return (
        <UnitUrlCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          url={ctx.unit.url}
          // Centers edit in-row (no field_override), so there is nothing to clear.
          canClear={ctx.unit.unitType !== "center"}
          hasOverride={ctx.unit.overriddenFields.includes("url")}
        />
      );
    case "leader":
      // #2542 Phase C — a center's leadership is manually-owned and
      // vocabulary-driven (three roles, not one), so it gets the generic
      // picker instead of the dept/div override card.
      if (ctx.unit.unitType === "center") {
        return (
          <CenterLeadershipCard centerCode={ctx.unit.code} roles={ctx.centerLeadership ?? []} />
        );
      }
      return (
        <UnitLeaderCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          leader={ctx.unit.leader}
          canClear
          hasOverride={
            ctx.unit.overriddenFields.includes("leaderCwid") ||
            ctx.unit.overriddenFields.includes("leaderInterim")
          }
        />
      );
    case "access":
      return (
        <UnitAccessCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          access={ctx.access}
          actorCwid={ctx.actorCwid}
        />
      );
    case "feed-issues":
      return <CtscFeedIssuesPanel />;
    case "roster":
      // A center gets the rich #552 §6.1 table (Member/Type/Program/Diseases/
      // Status); a manual division gets the simple add/remove list (PR-7c).
      if (ctx.unit.unitType === "center") {
        return (
          <CenterRosterCard
            unitCode={ctx.unit.code}
            members={ctx.roster ?? []}
            programs={ctx.programs ?? []}
            membershipRoles={ctx.centerMembershipRoles ?? []}
            exportEnabled={isUnitRosterExportEnabled()}
            // The canonical disease-code list for "+ Add a disease" — was
            // already computed by `loadUnitEditContext` for the API route's
            // own server-side validation but never reached this component.
            diseaseOptions={ctx.diseaseOptions ?? []}
            cornellDirectoryEnabled={isCornellDirectoryMembersEnabled()}
          />
        );
      }
      if (ctx.unit.unitType === "division") {
        return (
          <div className="flex flex-col gap-6">
            {/* A manual division keeps its editable add/remove roster (PR-7c);
                an ED division has none, so only the faculty export shows. */}
            {hasRoster(ctx) && (
              <UnitRosterCard
                entityType="division"
                unitCode={ctx.unit.code}
                members={ctx.roster ?? []}
                cornellDirectoryEnabled={isCornellDirectoryMembersEnabled()}
              />
            )}
            {/* Faculty CSV export (count + link) — extends #1102 to divisions. */}
            {hasFacultyExportTab(ctx) && (
              <UnitFacultyExportCard
                unitType="division"
                code={ctx.unit.code}
                source={ctx.unit.source}
              />
            )}
          </div>
        );
      }
      // A department has no curated roster — its Members tab is the read-only
      // faculty CSV export (extends #1102 to departments).
      if (ctx.unit.unitType === "department" && hasFacultyExportTab(ctx)) {
        return (
          <UnitFacultyExportCard
            unitType="department"
            code={ctx.unit.code}
            source={ctx.unit.source}
          />
        );
      }
      return null;
    case "programs":
      // #1117 — only surfaced for a center with a program taxonomy.
      return (
        <CenterProgramCard centerCode={ctx.unit.code} programs={ctx.programs ?? []} />
      );
    case "name":
      // The rail only surfaces this row for a manually-owned unit, so the
      // unitType is center | division here (never department).
      return (
        <UnitNameCard
          entityType={ctx.unit.unitType === "division" ? "division" : "center"}
          entityId={ctx.unit.code}
          name={ctx.unit.name}
        />
      );
    case "slug":
      return (
        <UnitSlugCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          liveSlug={ctx.unit.slug}
          initialOverride={ctx.unit.slugOverride}
        />
      );
    case "center-type":
      // The rail only surfaces this row for a center; centerType is non-null there.
      return (
        <CenterTypeCard
          entityId={ctx.unit.code}
          centerType={ctx.unit.centerType ?? "center"}
        />
      );
    case "retire":
      return (
        <UnitRetireCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          unitName={ctx.unit.name}
          suppression={
            ctx.unit.suppression
              ? { id: ctx.unit.suppression.id, suppressedAt: ctx.unit.suppression.suppressedAt }
              : null
          }
        />
      );
  }
}

/** Edge 11: shown on non-retire panels while the unit is retired. */
function RetiredNotice() {
  return (
    <section data-slot="retired-notice" data-testid="retired-notice" className="flex flex-col gap-4">
      <div className="bg-apollo-surface-2 border-apollo-border-strong rounded-md border p-4">
        <p className="text-foreground text-sm">
          This unit is retired. Restore it (under <span className="font-medium">Retire unit</span>)
          to edit its other attributes.
        </p>
      </div>
    </section>
  );
}
