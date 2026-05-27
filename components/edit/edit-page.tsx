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
import { EditShell } from "@/components/edit/edit-shell";
import { EducationCard } from "@/components/edit/education-card";
import { FundingCard } from "@/components/edit/funding-card";
import { OverviewCard } from "@/components/edit/overview-card";
import { PublicationsCard } from "@/components/edit/publications-card";
import { ReadonlyAttributePanel } from "@/components/edit/readonly-attribute-panel";
import { SlugCard } from "@/components/edit/slug-card";
import { SlugRequestCard, type SlugRequestSummary } from "@/components/edit/slug-request-card";
import { VisibilityCard } from "@/components/edit/visibility-card";
import type { RailItem } from "@/components/edit/attribute-rail";
import type { EditContext } from "@/lib/api/edit-context";

type AttrKey =
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
  { key: "name-title", label: "Name & Title", readonly: true, modes: ["self", "superuser"] },
  { key: "photo", label: "Photo", readonly: true, modes: ["self", "superuser"] },
  { key: "overview", label: "Overview", modes: ["self", "superuser"] },
  { key: "visibility", label: "Visibility", modes: ["self", "superuser"] },
  { key: "publications", label: "Publications", modes: ["self"] },
  { key: "funding", label: "Funding", modes: ["self", "superuser"] },
  { key: "appointments", label: "Appointments", modes: ["self", "superuser"] },
  { key: "education", label: "Education", modes: ["self", "superuser"] },
  // Superuser direct-set is always available; the self request card is flag-gated
  // (`slugRequestEnabled`) — see the rail filter below.
  { key: "profile-url", label: "Profile URL", modes: ["self", "superuser"] },
];

const DEFAULT_ATTR: Record<"self" | "superuser", AttrKey> = {
  self: "overview",
  superuser: "visibility",
};

export type EditPageProps = {
  ctx: EditContext;
  mode?: "self" | "superuser";
  /** The selected attribute from `?attr=`; falls back to the mode's default. */
  attr?: string;
  /** Whether the self "Profile URL" request card is enabled (#497 PR-3,
   *  `SELF_EDIT_SLUG_REQUEST`). Off ⇒ the self rail omits Profile URL. The
   *  superuser direct-set card is unaffected. */
  slugRequestEnabled?: boolean;
  /** The scholar's latest `SlugRequest` (self mode only), seeding the request
   *  card's state machine. `null` when they have never filed one. */
  latestSlugRequest?: SlugRequestSummary | null;
};

export function EditPage({
  ctx,
  mode = "self",
  attr,
  slugRequestEnabled = false,
  latestSlugRequest = null,
}: EditPageProps) {
  const visible = ATTRIBUTES.filter((a) => {
    if (!a.modes.includes(mode)) return false;
    // The self request card is flag-gated; the superuser direct-set card is not.
    if (a.key === "profile-url" && mode === "self" && !slugRequestEnabled) return false;
    return true;
  });
  const active: AttrDef =
    visible.find((a) => a.key === attr) ??
    visible.find((a) => a.key === DEFAULT_ATTR[mode]) ??
    visible[0];

  const railItems: RailItem[] = visible.map((a) => ({
    key: a.key,
    label: a.label,
    readonly: a.readonly,
  }));
  const basePath = mode === "superuser" ? `/edit/scholar/${ctx.scholar.cwid}` : "/edit";
  const scholarName = ctx.scholar.preferredName;

  return (
    <EditShell
      mode={mode}
      scholarName={scholarName}
      railItems={railItems}
      activeAttr={active.key}
      basePath={basePath}
      previewHref={`/scholars/${ctx.scholar.slug}`}
    >
      {renderPanel(active.key, ctx, mode, scholarName, latestSlugRequest)}
    </EditShell>
  );
}

function renderPanel(
  key: AttrKey,
  ctx: EditContext,
  mode: "self" | "superuser",
  scholarName: string,
  latestSlugRequest: SlugRequestSummary | null,
) {
  const cwid = ctx.scholar.cwid;
  switch (key) {
    case "name-title":
      return (
        <ReadonlyAttributePanel
          attribute="name-title"
          cwid={cwid}
          heading="Name & Title"
          description="Name, title, department, email, and ORCID come from the WCM directory and faculty records."
          fields={[{ label: "Name", value: ctx.scholar.fullName }]}
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
        <OverviewCard cwid={cwid} initialHtml={ctx.scholar.overview} readOnly={mode === "superuser"} />
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
      // Superuser sets a slug directly; a scholar requests one for approval.
      return mode === "superuser" ? (
        <SlugCard cwid={cwid} liveSlug={ctx.scholar.slug} initialOverride={ctx.scholar.slugOverride} />
      ) : (
        <SlugRequestCard cwid={cwid} currentSlug={ctx.scholar.slug} latestRequest={latestSlugRequest} />
      );
  }
}
