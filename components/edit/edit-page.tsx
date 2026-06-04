/**
 * The `/edit/*` detail router inside the Apollo shell (#160 UI follow-up,
 * `self-edit-launch-spec.md` § Layout + § Role parity). Supersedes the v1
 * single-column card stack: the ATTRIBUTES rail selects one attribute and this
 * component renders its detail panel for the active `?attr=`. Server Component
 * composing client-island panels — server-rendered per selection, deep-linkable.
 *
 * Which attributes appear (and whether editable) is the only thing that differs
 * by actor; the data contract and write calls are layout-independent.
 */
import { AppointmentsCard } from "@/components/edit/appointments-card";
import { EditPanel } from "@/components/edit/edit-panel";
import { EditShell } from "@/components/edit/edit-shell";
import { EducationCard } from "@/components/edit/education-card";
import { FundingCard } from "@/components/edit/funding-card";
import { HomePanel } from "@/components/edit/home-panel";
import { OverviewCard } from "@/components/edit/overview-card";
import { PublicationsCard } from "@/components/edit/publications-card";
import { ReadonlyAttributePanel } from "@/components/edit/readonly-attribute-panel";
import { SlugCard } from "@/components/edit/slug-card";
import { SlugRequestCard, type SlugRequestSummary } from "@/components/edit/slug-request-card";
import { VisibilityCard } from "@/components/edit/visibility-card";
import type { RailItem, RailKind } from "@/components/edit/attribute-rail";
import type { EditContext } from "@/lib/api/edit-context";
import { profilePath } from "@/lib/profile-url";

type AttrKey =
  | "home"
  | "name-title"
  | "photo"
  | "overview"
  | "visibility"
  | "publications"
  | "funding"
  | "appointments"
  | "education"
  | "profile-url";

type AttrDef = {
  key: AttrKey;
  label: string;
  readonly?: boolean;
  modes: ReadonlyArray<"self" | "superuser">;
};

/** The full attribute set; the rail filters to the actor's visible subset. */
const ATTRIBUTES: ReadonlyArray<AttrDef> = [
  // Self-only task-first landing (vision-round T3.4).
  { key: "home", label: "Home", modes: ["self"] },
  { key: "name-title", label: "Name & Title", readonly: true, modes: ["self", "superuser"] },
  { key: "photo", label: "Photo", readonly: true, modes: ["self", "superuser"] },
  { key: "overview", label: "Overview", modes: ["self", "superuser"] },
  { key: "visibility", label: "Visibility", modes: ["self", "superuser"] },
  { key: "publications", label: "Publications", modes: ["self"] },
  { key: "funding", label: "Funding", modes: ["self", "superuser"] },
  { key: "appointments", label: "Appointments", modes: ["self", "superuser"] },
  { key: "education", label: "Education", modes: ["self", "superuser"] },
  // Superuser direct-set is always available; the self surface is the request
  // card when `slugRequestEnabled`, else a read-only panel (locked rail item).
  { key: "profile-url", label: "Profile URL", modes: ["self", "superuser"] },
];

const DEFAULT_ATTR: Record<"self" | "superuser", AttrKey> = {
  self: "home",
  superuser: "visibility",
};

/**
 * Self-mode rail grouping + editability tier (vision-round T2.2). Leads with
 * what the scholar can actually change, then groups the rest under their system
 * of record so "what can I edit?" is answerable without clicking all nine items.
 * Superuser mode keeps a flat rail — its editability differs (Overview is
 * read-only, Profile URL is direct-set), so these self labels would mislead.
 */
const SELF_RAIL_ORDER: ReadonlyArray<AttrKey> = [
  "home",
  "overview",
  "visibility",
  "profile-url",
  "publications",
  "funding",
  "appointments",
  "education",
  "name-title",
  "photo",
];
const SELF_RAIL_KIND: Record<AttrKey, "owned" | "sourced" | "readonly"> = {
  home: "owned",
  overview: "owned",
  visibility: "owned",
  "profile-url": "owned",
  publications: "sourced",
  funding: "sourced",
  appointments: "sourced",
  education: "sourced",
  "name-title": "readonly",
  photo: "readonly",
};
const SELF_RAIL_GROUP = {
  owned: "Yours to edit",
  sourced: "From WCM systems",
  readonly: "From WCM systems",
} as const;

export type EditPageProps = {
  ctx: EditContext;
  mode?: "self" | "superuser";
  /** The selected attribute from `?attr=`; falls back to the mode's default. */
  attr?: string;
  /** Whether the self "Profile URL" request card is enabled (#497 PR-3,
   *  `SELF_EDIT_SLUG_REQUEST`). Off ⇒ the self Profile URL panel is read-only
   *  (current URL + "custom URLs aren't available yet", T3.6) and its rail item
   *  is locked; on ⇒ the request form. The superuser direct-set card is
   *  unaffected. */
  slugRequestEnabled?: boolean;
  /** The scholar's latest `SlugRequest` (self mode only), seeding the request
   *  card's state machine. `null` when they have never filed one. */
  latestSlugRequest?: SlugRequestSummary | null;
  /** Self mode only: the viewer is a superuser, so the shell shows a link
   *  across to the Profiles roster. Forwarded to `EditShell`. */
  canBrowseProfiles?: boolean;
};

/**
 * Which attributes the rail shows for an actor + flag state. Self mode keeps
 * Profile URL in the rail even when the slug-request flag is off — it just
 * becomes a read-only panel (current URL + "custom URLs aren't available yet",
 * vision-round T3.6) instead of being dropped. Exported so the server pages can
 * canonicalize an invalid `?attr` without re-deriving this list (T1.13).
 */
export function visibleAttrKeys(
  mode: "self" | "superuser",
  slugRequestEnabled: boolean,
): AttrKey[] {
  void slugRequestEnabled; // Profile URL is always present now (read-only when off).
  return ATTRIBUTES.filter((a) => a.modes.includes(mode)).map((a) => a.key);
}

export function EditPage({
  ctx,
  mode = "self",
  attr,
  slugRequestEnabled = false,
  latestSlugRequest = null,
  canBrowseProfiles = false,
}: EditPageProps) {
  const visible = ATTRIBUTES.filter((a) => a.modes.includes(mode));
  const active: AttrDef =
    visible.find((a) => a.key === attr) ??
    visible.find((a) => a.key === DEFAULT_ATTR[mode]) ??
    visible[0];

  // Profile URL is "owned" when the scholar can request a slug, "readonly" when
  // the flag is off (the panel shows their current URL but no request form).
  const railKindFor = (k: AttrKey): RailKind =>
    k === "profile-url" && mode === "self" && !slugRequestEnabled ? "readonly" : SELF_RAIL_KIND[k];

  const railItems: RailItem[] =
    mode === "self"
      ? SELF_RAIL_ORDER.flatMap((k) => {
          const a = visible.find((v) => v.key === k);
          if (!a) return [];
          const kind = railKindFor(k);
          return [{ key: a.key, label: a.label, readonly: a.readonly, kind, group: SELF_RAIL_GROUP[kind] }];
        })
      : visible.map((a) => ({ key: a.key, label: a.label, readonly: a.readonly }));
  const basePath = mode === "superuser" ? `/edit/scholar/${ctx.scholar.cwid}` : "/edit";
  const scholarName = ctx.scholar.preferredName;

  return (
    <EditShell
      mode={mode}
      scholarName={scholarName}
      railItems={railItems}
      activeAttr={active.key}
      basePath={basePath}
      previewHref={profilePath(ctx.scholar.slug)}
      account={mode === "self" ? { slug: ctx.scholar.slug, preferredName: scholarName } : undefined}
      canBrowseProfiles={canBrowseProfiles}
    >
      {renderPanel(active.key, ctx, mode, scholarName, latestSlugRequest, slugRequestEnabled)}
    </EditShell>
  );
}

function renderPanel(
  key: AttrKey,
  ctx: EditContext,
  mode: "self" | "superuser",
  scholarName: string,
  latestSlugRequest: SlugRequestSummary | null,
  slugRequestEnabled: boolean,
) {
  const cwid = ctx.scholar.cwid;
  switch (key) {
    case "home": {
      const hiddenPublications = ctx.publications.filter((p) => p.state !== "shown").length;
      const isHidden =
        ctx.scholar.suppression.ownRow !== null || ctx.scholar.suppression.adminRow !== null;
      return (
        <HomePanel
          basePath="/edit"
          hasBio={ctx.scholar.overview.trim().length > 0}
          isHidden={isHidden}
          totalPublications={ctx.publications.length}
          hiddenPublications={hiddenPublications}
          previewHref={profilePath(ctx.scholar.slug)}
        />
      );
    }
    case "name-title":
      return (
        <ReadonlyAttributePanel
          attribute="name-title"
          cwid={cwid}
          heading="Name & Title"
          description="Name, degrees, department, email, and ORCID come from the WCM directory and faculty records."
          fields={[
            { label: "Name", value: ctx.scholar.fullName },
            { label: "Degrees", value: ctx.scholar.primaryTitle },
            { label: "Department", value: ctx.scholar.primaryDepartment },
            { label: "Email", value: ctx.scholar.email },
            { label: "ORCID", value: ctx.scholar.orcid },
          ]}
        />
      );
    case "photo":
      return (
        <ReadonlyAttributePanel
          attribute="photo"
          cwid={cwid}
          heading="Photo"
          description="Your profile photo comes from the WCM directory."
        />
      );
    case "overview":
      return (
        <OverviewCard
          cwid={cwid}
          initialHtml={ctx.scholar.overview}
          previewHref={mode === "self" ? profilePath(ctx.scholar.slug) : undefined}
          readOnly={mode === "superuser"}
        />
      );
    case "visibility":
      return (
        <VisibilityCard
          cwid={cwid}
          suppression={ctx.scholar.suppression}
          scholarName={scholarName}
          mode={mode}
        />
      );
    case "publications":
      return <PublicationsCard cwid={cwid} publications={ctx.publications} />;
    case "funding":
      return <FundingCard cwid={cwid} mode={mode} scholarName={scholarName} grants={ctx.grants} />;
    case "appointments":
      return (
        <AppointmentsCard
          cwid={cwid}
          mode={mode}
          scholarName={scholarName}
          appointments={ctx.appointments}
        />
      );
    case "education":
      return (
        <EducationCard cwid={cwid} mode={mode} scholarName={scholarName} educations={ctx.educations} />
      );
    case "profile-url":
      // Superuser sets a slug directly; a scholar requests one for approval —
      // but only when the request flag is on. With it off, the scholar still
      // sees their Profile URL, now read-only (vision-round T3.6) rather than
      // having the rail item disappear.
      if (mode === "superuser") {
        return (
          <SlugCard
            cwid={cwid}
            liveSlug={ctx.scholar.slug}
            initialOverride={ctx.scholar.slugOverride}
          />
        );
      }
      if (!slugRequestEnabled) {
        return <ProfileUrlReadonlyPanel slug={ctx.scholar.slug} />;
      }
      return (
        <SlugRequestCard cwid={cwid} currentSlug={ctx.scholar.slug} latestRequest={latestSlugRequest} />
      );
  }
}

/** The read-only Profile URL panel shown to scholars while `SELF_EDIT_SLUG_REQUEST`
 *  is off (T3.6): their live URL, plus an honest note that custom URLs aren't
 *  self-serve yet. No input, no request form, no unsaved-changes guard. */
function ProfileUrlReadonlyPanel({ slug }: { slug: string }) {
  return (
    <EditPanel
      slot="profile-url-readonly"
      heading="Profile URL"
      description="The web address for your public profile. Custom URLs aren't available yet — your old address keeps working if it ever changes."
    >
      <p className="text-sm">
        <span className="text-muted-foreground">Your current URL: </span>
        <code
          className="rounded bg-muted px-1.5 py-0.5 text-xs"
          data-testid="profile-url-readonly-value"
        >
          {publicProfileHost()}/{slug}
        </code>
      </p>
    </EditPanel>
  );
}

/** The public host the personalized URL hangs off (root-alias form). Mirrors the
 *  request card's `SITE_HOST` so both surfaces show the same address. */
function publicProfileHost(): string {
  return "scholars.weill.cornell.edu";
}
