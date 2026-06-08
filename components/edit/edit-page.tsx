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
import { CoiCard } from "@/components/edit/coi-card";
import { CoiGapCard } from "@/components/edit/coi-gap-card";
import { EditPanel } from "@/components/edit/edit-panel";
import { EditShell } from "@/components/edit/edit-shell";
import { EducationCard } from "@/components/edit/education-card";
import { FundingCard } from "@/components/edit/funding-card";
import { MenteesCard } from "@/components/edit/mentees-card";
import { HomePanel } from "@/components/edit/home-panel";
import { OverviewCard } from "@/components/edit/overview-card";
import { ProxyEditorCard, type ProxyRow } from "@/components/edit/proxy-editor-card";
import { PublicationsCard } from "@/components/edit/publications-card";
import { ReadonlyAttributePanel } from "@/components/edit/readonly-attribute-panel";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { SlugCard } from "@/components/edit/slug-card";
import { SlugRequestCard, type SlugRequestSummary } from "@/components/edit/slug-request-card";
import { VisibilityCard } from "@/components/edit/visibility-card";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import type { RailItem, RailKind } from "@/components/edit/attribute-rail";
import type { EditContext } from "@/lib/api/edit-context";
import type { ManageableUnit } from "@/lib/edit/manageable-units";
import { identityImageEndpoint } from "@/lib/headshot";
import { profilePath } from "@/lib/profile-url";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import { isReciterRejectEnabled } from "@/lib/reciter/client";

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
  | "coi"
  | "coi-gap"
  | "mentees"
  | "profile-url"
  | "proxy-editors";

type AttrDef = {
  key: AttrKey;
  label: string;
  readonly?: boolean;
  modes: ReadonlyArray<"self" | "superuser">;
};

/** The full attribute set; the rail filters to the actor's visible subset. */
const ATTRIBUTES: ReadonlyArray<AttrDef> = [
  // Task-first landing (vision-round T3.4). Shared with superusers, where it
  // reads as a read-only profile-completeness overview of the target scholar.
  { key: "home", label: "Home", modes: ["self", "superuser"] },
  { key: "name-title", label: "Name & Title", readonly: true, modes: ["self", "superuser"] },
  { key: "photo", label: "Photo", readonly: true, modes: ["self", "superuser"] },
  { key: "overview", label: "Overview", modes: ["self", "superuser"] },
  { key: "visibility", label: "Visibility", modes: ["self", "superuser"] },
  { key: "publications", label: "Publications", modes: ["self"] },
  { key: "funding", label: "Funding", modes: ["self", "superuser"] },
  { key: "appointments", label: "Appointments", modes: ["self", "superuser"] },
  { key: "education", label: "Education", modes: ["self", "superuser"] },
  // Mentees — suppressible (hide/show); corrections route to ITS Support.
  { key: "mentees", label: "Mentees", modes: ["self", "superuser"] },
  // Conflicts of interest — read-only; managed in the Weill Research Gateway.
  { key: "coi", label: "Conflicts of Interest", readonly: true, modes: ["self", "superuser"] },
  // From your publications (#SELF_EDIT_COI_GAP_HINT) — self-only, read-only.
  // A suggestion surface: relationships named in the scholar's own PubMed
  // competing-interest statements, shown only to them, never a compliance
  // verdict. The rail item appears only when there are candidates AND the flag
  // is on (the loader returns an empty array otherwise).
  { key: "coi-gap", label: "From your publications", readonly: true, modes: ["self"] },
  // Superuser direct-set is always available; the self surface is the request
  // card when `slugRequestEnabled`, else a read-only panel (locked rail item).
  { key: "profile-url", label: "Profile URL", modes: ["self", "superuser"] },
  // Proxy editors (#779) — the scholar (self) manages their own designees; a
  // superuser manages them on the scholar's behalf. NOT shown in proxy mode: a
  // proxy can never manage the proxy list (CD-2; excluded in `attrsForMode`).
  { key: "proxy-editors", label: "Proxy editors", modes: ["self", "superuser"] },
];

const DEFAULT_ATTR: Record<EditMode, AttrKey> = {
  self: "home",
  superuser: "home",
  proxy: "home",
};

/** The actor surfaces. `proxy` (#779) is a scholar-assigned designee: it reuses
 *  the SELF editable surface (overview + publication hiding) on the scholar's
 *  route, minus the self-only Profile URL request and the "From your
 *  publications" advisory. Visual/interaction polish is a UI-SPEC deliverable. */
type EditMode = "self" | "superuser" | "proxy";

/** The attribute set visible for a mode, before flag/candidate filtering.
 *  `proxy` mirrors `self` minus `profile-url` (slug is self/superuser-only — a
 *  proxy cannot request a slug for the scholar) and `coi-gap` (self-only
 *  advisory; the loader returns no candidates for a proxy anyway). */
function attrsForMode(mode: EditMode): AttrDef[] {
  if (mode === "proxy") {
    return ATTRIBUTES.filter(
      (a) =>
        a.modes.includes("self") &&
        a.key !== "profile-url" &&
        a.key !== "coi-gap" &&
        a.key !== "proxy-editors", // a proxy can never manage the proxy list (CD-2)
    );
  }
  return ATTRIBUTES.filter((a) => a.modes.includes(mode));
}

/**
 * Self-mode rail grouping + editability tier (vision-round T2.2). Leads with
 * what the scholar can actually change, then groups the rest under their system
 * of record so "what can I edit?" is answerable without clicking all nine items.
 * Superuser mode keeps a flat rail — its editability differs (Overview is
 * read-only, Profile URL is direct-set), so these self labels would mislead.
 */
const SELF_RAIL_ORDER: ReadonlyArray<AttrKey> = [
  // "Yours to edit" group (owned).
  "home",
  "overview",
  "visibility",
  "proxy-editors",
  // "From WCM systems" group — ordered per operator request. (Profile URL is
  // owned ⇒ joins "Yours to edit" only when the slug-request flag is on;
  // gated/read-only it leads the WCM group.)
  "profile-url",
  "name-title",
  "photo",
  "appointments",
  "education",
  "publications",
  "funding",
  "mentees",
  "coi",
  "coi-gap",
];
const SELF_RAIL_KIND: Record<AttrKey, "owned" | "sourced" | "readonly"> = {
  home: "owned",
  overview: "owned",
  visibility: "owned",
  "proxy-editors": "owned",
  "profile-url": "owned",
  publications: "sourced",
  funding: "sourced",
  appointments: "sourced",
  education: "sourced",
  mentees: "sourced",
  "name-title": "readonly",
  photo: "readonly",
  coi: "readonly",
  "coi-gap": "readonly",
};
const SELF_RAIL_GROUP = {
  owned: "Yours to edit",
  sourced: "From WCM systems",
  readonly: "From WCM systems",
} as const;

/**
 * Superuser rail order — kept flat (no "Yours to edit" / "From WCM systems"
 * grouping: superuser editability differs from self, so those labels would
 * mislead). Home leads as the completeness landing; Profile URL sits at the top
 * of the attributes per operator request. Publications and the COI-gap surface
 * are self-only, so they are absent here.
 */
const SUPERUSER_RAIL_ORDER: ReadonlyArray<AttrKey> = [
  "home",
  "profile-url",
  "name-title",
  "photo",
  "overview",
  "visibility",
  "proxy-editors",
  "funding",
  "appointments",
  "education",
  "mentees",
  "coi",
];

export type EditPageProps = {
  ctx: EditContext;
  mode?: EditMode;
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
  /** Self mode only: org units the viewer may also curate (#753), surfaced on
   *  the Home panel. Empty for most scholars. */
  manageableUnits?: ManageableUnit[];
  /** The scholar's current proxy-editor grants (#779), for the "Proxy editors"
   *  panel in self / superuser mode. `null` ⇒ the panel renders nothing (e.g.
   *  proxy mode, where it is not even in the rail). */
  proxyEditors?: ProxyRow[] | null;
};

/**
 * Which attributes the rail shows for an actor + flag state. Self mode keeps
 * Profile URL in the rail even when the slug-request flag is off — it just
 * becomes a read-only panel (current URL + "custom URLs aren't available yet",
 * vision-round T3.6) instead of being dropped. Exported so the server pages can
 * canonicalize an invalid `?attr` without re-deriving this list (T1.13).
 */
export function visibleAttrKeys(
  mode: EditMode,
  slugRequestEnabled: boolean,
  hasCoiGap = false,
): AttrKey[] {
  void slugRequestEnabled; // Profile URL is always present now (read-only when off).
  return attrsForMode(mode)
    // The "From your publications" item only exists when there are candidates to
    // show — an empty panel is never surfaced, and an `?attr=coi-gap` with zero
    // candidates canonicalizes away (the page redirects to bare /edit) rather
    // than rendering an empty panel or 404-looping. (proxy drops it outright.)
    .filter((a) => a.key !== "coi-gap" || hasCoiGap)
    .map((a) => a.key);
}

export function EditPage({
  ctx,
  mode = "self",
  attr,
  slugRequestEnabled = false,
  latestSlugRequest = null,
  canBrowseProfiles = false,
  manageableUnits = [],
  proxyEditors = null,
}: EditPageProps) {
  // "From your publications" is conditionally present: only in self mode and
  // only when the loader returned candidates (the loader itself enforces the
  // self-only + flag gate, so a non-empty array here already implies both). Drop
  // it from the visible set otherwise so it appears in neither the rail nor the
  // valid-attr set — an empty panel is never surfaced.
  const hasCoiGap = mode === "self" && ctx.unmatchedPubmedCoi.length > 0;
  const visible = attrsForMode(mode).filter((a) => a.key !== "coi-gap" || hasCoiGap);
  // A proxy reuses the SELF rail/cards on the scholar's route (D4). Treated like
  // self for layout; the distinct chrome (banner, breadcrumb, no account menu)
  // is the shell's job.
  const selfLike = mode === "self" || mode === "proxy";
  const active: AttrDef =
    visible.find((a) => a.key === attr) ??
    visible.find((a) => a.key === DEFAULT_ATTR[mode]) ??
    visible[0];

  // Profile URL is "owned" when the scholar can request a slug, "readonly" when
  // the flag is off (the panel shows their current URL but no request form).
  const railKindFor = (k: AttrKey): RailKind =>
    k === "profile-url" && mode === "self" && !slugRequestEnabled ? "readonly" : SELF_RAIL_KIND[k];

  const railItems: RailItem[] =
    selfLike
      ? SELF_RAIL_ORDER.flatMap((k) => {
          const a = visible.find((v) => v.key === k);
          if (!a) return [];
          const kind = railKindFor(k);
          return [
            {
              key: a.key,
              label: a.label,
              readonly: a.readonly,
              kind,
              group: SELF_RAIL_GROUP[kind],
              // "From your publications" nests under Conflicts of Interest (it
              // immediately follows "coi" in SELF_RAIL_ORDER) rather than reading
              // as a flat sibling — it is a sub-view of COI, not its own SOR.
              child: a.key === "coi-gap",
            },
          ];
        })
      : SUPERUSER_RAIL_ORDER.flatMap((k) => {
          const a = visible.find((v) => v.key === k);
          return a ? [{ key: a.key, label: a.label, readonly: a.readonly }] : [];
        });
  // Self edits at "/edit"; superuser and proxy edit a named scholar at
  // "/edit/scholar/<cwid>" (a proxy is never on their own /edit).
  const basePath = mode === "self" ? "/edit" : `/edit/scholar/${ctx.scholar.cwid}`;
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
      {renderPanel(
        active.key,
        ctx,
        mode,
        scholarName,
        latestSlugRequest,
        slugRequestEnabled,
        manageableUnits,
        canBrowseProfiles,
        proxyEditors,
      )}
    </EditShell>
  );
}

function renderPanel(
  key: AttrKey,
  ctx: EditContext,
  mode: EditMode,
  scholarName: string,
  latestSlugRequest: SlugRequestSummary | null,
  slugRequestEnabled: boolean,
  manageableUnits: ManageableUnit[],
  isSuperuser: boolean,
  proxyEditors: ProxyRow[] | null,
) {
  const cwid = ctx.scholar.cwid;
  // Child cards model only self vs superuser. A proxy reuses the SELF cards
  // (overview editable, publications hide); the proxy-specific affordance gates
  // (no generate, no preview link, no slug request) are derived from the REAL
  // `mode` at each call site below, never from `childMode`.
  const childMode: "self" | "superuser" = mode === "superuser" ? "superuser" : "self";
  const detailBase = mode === "self" ? "/edit" : `/edit/scholar/${cwid}`;
  switch (key) {
    case "home": {
      const hiddenPublications = ctx.publications.filter((p) => p.state !== "shown").length;
      const isHidden =
        ctx.scholar.suppression.ownRow !== null || ctx.scholar.suppression.adminRow !== null;
      // A superuser editing another scholar gets the same board reframed as a
      // read-only completeness overview: copy shifts from "you" to the scholar's
      // name, the Overview CTA is View-only (read-only for them), the
      // Publications row drops its CTA (no superuser pubs tab), and the "Units
      // you manage" section is omitted — it's the viewer's units, not the
      // target's. (When a superuser edits their OWN profile this is mode='self'.)
      return (
        <HomePanel
          mode={childMode}
          basePath={detailBase}
          preferredName={scholarName}
          identityImageEndpoint={identityImageEndpoint(cwid)}
          hasBio={ctx.scholar.overview.trim().length > 0}
          isHidden={isHidden}
          totalPublications={ctx.publications.length}
          hiddenPublications={hiddenPublications}
          // "Units you manage" + the cross-link are the viewer's own affordances —
          // shown only to a genuine self viewer, never a superuser or a proxy.
          manageableUnits={mode === "self" ? manageableUnits : []}
          isSuperuser={mode === "self" ? isSuperuser : false}
        />
      );
    }
    case "name-title":
      return (
        <ReadonlyAttributePanel
          attribute="name-title"
          cwid={cwid}
          heading="Name & Title"
          description="Name, title, degrees, department, email, and ORCID come from the WCM directory and faculty records."
          fields={[
            { label: "Name", value: ctx.scholar.fullName },
            { label: "Title", value: ctx.scholar.primaryTitle },
            { label: "Degrees", value: ctx.scholar.postnominal },
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
          media={
            <HeadshotAvatar
              cwid={cwid}
              preferredName={scholarName}
              identityImageEndpoint={identityImageEndpoint(cwid)}
              size="lg"
            />
          }
        />
      );
    case "overview":
      return (
        <OverviewCard
          cwid={cwid}
          initialHtml={ctx.scholar.overview}
          previewHref={mode === "self" ? profilePath(ctx.scholar.slug) : undefined}
          readOnly={mode === "superuser"}
          // The generator is an owner-self affordance only — a superuser viewing
          // another scholar's bio gets the read-only arm with no Generate button
          // (#742, spec § Authorization resolution A: admins stage, not edit here).
          generateEnabled={mode === "self" && isOverviewGenerateEnabled()}
        />
      );
    case "visibility":
      return (
        <VisibilityCard
          cwid={cwid}
          suppression={ctx.scholar.suppression}
          scholarName={scholarName}
          mode={childMode}
        />
      );
    case "publications":
      return (
        <PublicationsCard
          cwid={cwid}
          publications={ctx.publications}
          rejectEnabled={isReciterRejectEnabled()}
        />
      );
    case "funding":
      return <FundingCard cwid={cwid} mode={childMode} scholarName={scholarName} grants={ctx.grants} />;
    case "appointments":
      return (
        <AppointmentsCard
          cwid={cwid}
          mode={childMode}
          scholarName={scholarName}
          appointments={ctx.appointments}
        />
      );
    case "education":
      return (
        <EducationCard cwid={cwid} mode={childMode} scholarName={scholarName} educations={ctx.educations} />
      );
    case "mentees":
      return (
        <MenteesCard cwid={cwid} mode={childMode} scholarName={scholarName} mentees={ctx.mentees} />
      );
    case "coi":
      return (
        <CoiCard
          cwid={cwid}
          mode={childMode}
          scholarName={scholarName}
          disclosures={ctx.coiDisclosures}
          // The bridge to "From your publications" only appears for a genuine
          // self viewer with suggestions — `unmatchedPubmedCoi` is [] for the
          // superuser/impersonation paths, so the count is naturally 0 there.
          suggestionCount={ctx.unmatchedPubmedCoi.length}
          suggestionsHref="/edit?attr=coi-gap"
        />
      );
    case "coi-gap":
      // Self-only by construction — the loader only populates
      // `unmatchedPubmedCoi` for a genuine self viewer behind the flag, and the
      // rail item is dropped when the array is empty. No `mode` prop: there is
      // no superuser variant of this surface.
      return <CoiGapCard cwid={cwid} candidates={ctx.unmatchedPubmedCoi} />;
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
        return <ProfileUrlReadonlyPanel slug={ctx.scholar.slug} cwid={cwid} />;
      }
      return (
        <SlugRequestCard cwid={cwid} currentSlug={ctx.scholar.slug} latestRequest={latestSlugRequest} />
      );
    case "proxy-editors":
      // Self (the scholar) or superuser (on the scholar's behalf) manages the
      // scholar's designees. Never reached in proxy mode (excluded from the rail
      // — a proxy can't manage the proxy list, CD-2).
      return (
        <ProxyEditorCard
          scholarCwid={cwid}
          scholarName={scholarName}
          mode={childMode}
          proxies={proxyEditors}
        />
      );
  }
}

/** The read-only Profile URL panel shown to scholars while `SELF_EDIT_SLUG_REQUEST`
 *  is off (T3.6): their live URL, plus an honest note that custom URLs aren't
 *  self-serve yet. No input, no request form, no unsaved-changes guard. */
function ProfileUrlReadonlyPanel({ slug, cwid }: { slug: string; cwid: string }) {
  const currentUrl = `${publicProfileHost()}/${slug}`;
  return (
    <EditPanel
      slot="profile-url-readonly"
      heading="Profile URL"
      description="The web address for your public profile."
    >
      <p className="flex flex-wrap items-center gap-2.5 text-sm">
        <span className="text-muted-foreground">Your current URL: </span>
        <code
          className="bg-apollo-surface-2 border-apollo-border rounded border px-2.5 py-1 font-mono text-xs"
          data-testid="profile-url-readonly-value"
        >
          {currentUrl}
        </code>
      </p>
      <div className="text-muted-foreground flex flex-col gap-2 text-sm">
        <p>
          Personalized URLs aren&rsquo;t self-service, but you can request one &mdash; a Scholars
          administrator reviews every request.
        </p>
        <p>
          A personalized URL must be a variation of your own first and last name &mdash; optionally
          with a middle initial or fuller form &mdash; not a research area or other handle, using
          lowercase letters, numbers, and hyphens only. Your current address (
          <code className="font-mono">/scholars/{slug}</code>) keeps working either way.
        </p>
      </div>
      <RequestAChangeDialog
        attribute="profile-url"
        cwid={cwid}
        triggerTestId="profile-url-request-change"
      />
    </EditPanel>
  );
}

/** The public host the personalized URL hangs off (root-alias form). Mirrors the
 *  request card's `SITE_HOST` so both surfaces show the same address. */
function publicProfileHost(): string {
  return "scholars.weill.cornell.edu";
}
