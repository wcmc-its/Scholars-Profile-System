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
 * Retired read-through (edge 11): a Superuser may open a retired unit (to
 * restore it). The `retire` panel renders normally so they can Restore; every
 * other panel shows a "Retired — restore to edit" notice instead of its editor.
 */
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
import { UnitRosterCard } from "@/components/edit/unit-roster-card";
import { UnitSlugCard } from "@/components/edit/unit-slug-card";
import type { RailItem } from "@/components/edit/attribute-rail";
import type { UnitActorRole, UnitEditContext } from "@/lib/api/unit-edit-context";
import { isUnitRosterExportEnabled } from "@/lib/edit/unit-roster-export";

type AttrKey =
  | "description"
  | "url"
  | "leader"
  | "roster"
  | "programs"
  | "access"
  | "slug"
  | "center-type"
  | "retire";

type AttrDef = {
  key: AttrKey;
  label: string;
  /** Returns true when this attribute is visible for the given context. */
  visible: (ctx: UnitEditContext) => boolean;
};

const isOwnerPlus = (role: UnitActorRole) => role === "owner" || role === "superuser";
const isSuperuser = (role: UnitActorRole) => role === "superuser";
const hasRoster = (ctx: UnitEditContext) =>
  ctx.unit.unitType === "center" ||
  (ctx.unit.unitType === "division" && ctx.unit.source === "manual");

/** The full attribute set; `visible` encodes the SPEC § attribute table. */
const ATTRIBUTES: ReadonlyArray<AttrDef> = [
  { key: "description", label: "Description", visible: () => true },
  // #1021 — same visibility as Description (curators / owners / superuser).
  { key: "url", label: "Website", visible: () => true },
  { key: "leader", label: "Leadership", visible: () => true },
  { key: "roster", label: "Members", visible: (ctx) => hasRoster(ctx) },
  // #1117 — per-program leaders + description; only for a center with a program
  // taxonomy (the Cancer-Center-only gate is data-driven, like the roster fields).
  {
    key: "programs",
    label: "Programs",
    visible: (ctx) => ctx.unit.unitType === "center" && (ctx.programs?.length ?? 0) > 0,
  },
  { key: "access", label: "Access", visible: (ctx) => isOwnerPlus(ctx.actorRole) },
  { key: "slug", label: "Profile URL", visible: (ctx) => isSuperuser(ctx.actorRole) },
  {
    key: "center-type",
    label: "Center type",
    visible: (ctx) => ctx.unit.unitType === "center" && isSuperuser(ctx.actorRole),
  },
  { key: "retire", label: "Retire unit", visible: (ctx) => isSuperuser(ctx.actorRole) },
];

const DEFAULT_ATTR: AttrKey = "description";

export type UnitEditPageProps = {
  ctx: UnitEditContext;
  /** The selected attribute from `?attr=`; falls back to `description`. */
  attr?: string;
};

export function UnitEditPage({ ctx, attr }: UnitEditPageProps) {
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

  const subRail =
    ctx.unit.unitType === "department" && ctx.siblingDivisions ? (
      <SiblingDivisionsRail divisions={ctx.siblingDivisions} />
    ) : undefined;

  return (
    <EditShell
      mode="superuser"
      scholarName={ctx.unit.name}
      railItems={railItems}
      activeAttr={active.key}
      basePath={basePath}
      previewHref={previewHref}
      subRail={subRail}
    >
      {renderPanel(active.key, ctx)}
    </EditShell>
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
      return (
        <UnitLeaderCard
          entityType={ctx.unit.unitType}
          entityId={ctx.unit.code}
          leader={ctx.unit.leader}
          canClear={ctx.unit.unitType !== "center"}
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
    case "roster":
      // A center gets the rich #552 §6.1 table (Member/Type/Program/Start/End/
      // Status); a manual division gets the simple add/remove list (PR-7c).
      if (ctx.unit.unitType === "center") {
        return (
          <CenterRosterCard
            unitCode={ctx.unit.code}
            members={ctx.roster ?? []}
            programs={ctx.programs ?? []}
            exportEnabled={isUnitRosterExportEnabled()}
          />
        );
      }
      if (ctx.unit.unitType === "division") {
        return (
          <UnitRosterCard
            entityType="division"
            unitCode={ctx.unit.code}
            members={ctx.roster ?? []}
          />
        );
      }
      // A department has no roster row in its rail — unreachable.
      return null;
    case "programs":
      // #1117 — only surfaced for a center with a program taxonomy.
      return (
        <CenterProgramCard centerCode={ctx.unit.code} programs={ctx.programs ?? []} />
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
      <div className="bg-apollo-surface-2 border-apollo-border rounded-md border p-4">
        <p className="text-muted-foreground text-sm">
          This unit is retired. Restore it (under <span className="font-medium">Retire unit</span>)
          to edit its other attributes.
        </p>
      </div>
    </section>
  );
}
