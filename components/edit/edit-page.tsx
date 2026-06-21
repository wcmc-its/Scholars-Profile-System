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
import { EmailCard } from "@/components/edit/email-card";
import { FundingCard } from "@/components/edit/funding-card";
import { HighlightsCard } from "@/components/edit/highlights-card";
import { MenteesCard } from "@/components/edit/mentees-card";
import { HomePanel } from "@/components/edit/home-panel";
import { OverviewCard } from "@/components/edit/overview-card";
import {
  ProxyEditorCard,
  type ProxyRow,
  type UnitAdminEditorRow,
} from "@/components/edit/proxy-editor-card";
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
import {
  isOverviewGenerateEnabled,
  resolveEffectiveOverviewModel,
} from "@/lib/edit/overview-generator";
import {
  defaultPromptVersionId,
  listSelectablePromptVersions,
} from "@/lib/edit/overview-prompt-versions";
import { isReciterRejectEnabled } from "@/lib/reciter/client";
import { GrantRecsCard } from "@/components/edit/grant-recs-card";
import { BiosketchTool } from "@/components/edit/biosketch-tool";
import { listSelectableBiosketchPromptVersions } from "@/lib/edit/biosketch-prompt-versions";

/** The model the biosketch route will actually generate on — surfaced to the
 *  privileged cost line in the Services panel. Resolution order matches
 *  `generateBiosketch`. Read once at module load (this is a Server Component). */
const BIOSKETCH_EFFECTIVE_MODEL =
  process.env.BIOSKETCH_GENERATE_MODEL ??
  process.env.OVERVIEW_GENERATE_MODEL ??
  "us.anthropic.claude-opus-4-8";

type AttrKey =
  | "home"
  | "name-title"
  | "email"
  | "photo"
  | "overview"
  | "highlights"
  | "visibility"
  | "publications"
  | "funding"
  | "grant-recs"
  | "biosketch"
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
  // Email + its Web Directory release audience — read-only (email-visibility
  // SPEC § C). The release code is owned by the Web Directory SOR; this panel
  // only shows the imported state and links out, so it carries no write control.
  { key: "email", label: "Email", readonly: true, modes: ["self", "superuser"] },
  { key: "photo", label: "Photo", readonly: true, modes: ["self", "superuser"] },
  { key: "overview", label: "Overview", modes: ["self", "superuser"] },
  // Highlights (#836, SELF_EDIT_MANUAL_HIGHLIGHTS) — the opt-in manual override
  // of the AI-chosen featured publications. Editable by the scholar OR a
  // superuser (a superuser is unrestricted on the edit surface); the rail item
  // appears only when the loader populated `ctx.highlights` (flag on + self or
  // superuser). Not surfaced to a proxy / unit-admin editor.
  { key: "highlights", label: "Highlights", modes: ["self", "superuser"] },
  { key: "visibility", label: "Visibility", modes: ["self", "superuser"] },
  // Publications — the scholar's confirmed authorships with hide/show + the
  // "Not mine" reject. Editable by the scholar, a proxy / unit-admin (via the
  // self surface), OR a superuser on their behalf (a superuser is unrestricted on
  // the edit surface); writes carry the scholar's cwid and the suppress / revoke /
  // reject routes re-authorize the actor.
  { key: "publications", label: "Publications", modes: ["self", "superuser"] },
  { key: "funding", label: "Funding", modes: ["self", "superuser"] },
  // Grants for me (GrantRecs Phase 3, SELF_EDIT_GRANT_RECS) — owner-facing
  // funding-opportunity recommendations. Self OR superuser (on the scholar's
  // behalf); never a proxy / unit-admin. Rail item appears only when the flag is on.
  { key: "grant-recs", label: "Grants for me", modes: ["self", "superuser"] },
  // NIH biosketch generator (#917 v5, EDIT_BIOSKETCH_GENERATE) — tool that drafts
  // the narrative prose of a biosketch (Contributions to Science / Personal
  // Statement) as a copy/export artifact. Visible to every actor the generate
  // route authorizes (self, superuser, comms-steward, a granted proxy, an
  // org-unit owner/curator — the shared `authorizeOverviewWrite`), so a delegate
  // can draft it on the scholar's behalf. Grouped with "Grants for me" under the
  // "Services" rail section. Rail item appears only when the flag is on.
  { key: "biosketch", label: "NIH biosketch", modes: ["self", "superuser"] },
  { key: "appointments", label: "Appointments", modes: ["self", "superuser"] },
  { key: "education", label: "Education", modes: ["self", "superuser"] },
  // Mentees — suppressible (hide/show); corrections route to ITS Support.
  { key: "mentees", label: "Mentees", modes: ["self", "superuser"] },
  // Conflicts of interest — read-only; managed in the Weill Research Gateway.
  { key: "coi", label: "Conflicts of Interest", readonly: true, modes: ["self", "superuser"] },
  // From your publications (#SELF_EDIT_COI_GAP_HINT) — a sensitive advisory:
  // relationships named in the scholar's own PubMed competing-interest statements,
  // never a compliance verdict. Originally self-only; now also visible to a
  // superuser (operator decision — trusted, with a UI nag before any action), but
  // NOT to a proxy / unit-admin (excluded in `attrsForMode`). The rail item
  // appears only when there are candidates AND the flag is on.
  { key: "coi-gap", label: "From your publications", readonly: true, modes: ["self", "superuser"] },
  // Superuser direct-set is always available; the self surface is the request
  // card when `slugRequestEnabled`, else a read-only panel (locked rail item).
  { key: "profile-url", label: "Profile URL", modes: ["self", "superuser"] },
  // Profile editors (#779 + Amendment 4) — the scholar (self) manages their own
  // designees and sees who administers their units; a superuser does so on the
  // scholar's behalf. NOT shown in proxy mode: a proxy can never manage the proxy
  // list (CD-2; excluded in `attrsForMode`).
  { key: "proxy-editors", label: "Profile editors", modes: ["self", "superuser"] },
];

const DEFAULT_ATTR: Record<EditMode, AttrKey> = {
  self: "home",
  superuser: "home",
  proxy: "home",
  "unit-admin": "home",
  comms_steward: "home",
};

/** The actor surfaces. `proxy` (#779) is a scholar-assigned designee, and
 *  `unit-admin` (Amendment 4) is an org-unit administrator of a unit the scholar
 *  belongs to: both reuse the SELF editable surface (overview + publication
 *  hiding) on the scholar's route, minus the self-only Profile URL request and
 *  the "From your publications" advisory, and neither can manage the proxy list.
 *  `comms_steward` (comms-steward-profile-editing-spec.md §3b) edits any scholar
 *  at SUPERUSER parity MINUS slug + proxy delegation. Visual/interaction polish
 *  is a UI-SPEC deliverable. */
type EditMode = "self" | "superuser" | "proxy" | "unit-admin" | "comms_steward";

/** Whether a mode renders with SUPERUSER editability (overview editable,
 *  publications hideable, generate enabled): the superuser surface itself, and
 *  the `comms_steward` profile editor, which is superuser parity minus slug +
 *  proxy-editors. The child cards collapse to this (`childMode` below). */
function isSuperuserLike(mode: EditMode): boolean {
  return mode === "superuser" || mode === "comms_steward";
}

/** The attribute set visible for a mode, before flag/candidate filtering.
 *  `proxy` and `unit-admin` mirror `self` minus `profile-url` (slug is
 *  self/superuser-only — neither can request a slug for the scholar), `coi-gap`
 *  (self-only advisory; the loader returns no candidates for them anyway), and
 *  `proxy-editors` (only the scholar/superuser manages designees — CD-2).
 *  `comms_steward` mirrors `superuser` minus `profile-url` (slug is out of scope,
 *  §3b) and `proxy-editors` (delegation = "adding/removing users", out of scope). */
function attrsForMode(mode: EditMode): AttrDef[] {
  if (mode === "proxy" || mode === "unit-admin") {
    return ATTRIBUTES.filter(
      (a) =>
        a.modes.includes("self") &&
        a.key !== "profile-url" &&
        a.key !== "coi-gap" &&
        a.key !== "proxy-editors", // a proxy / unit admin can never manage the proxy list (CD-2)
    );
  }
  if (mode === "comms_steward") {
    return ATTRIBUTES.filter(
      (a) =>
        a.modes.includes("superuser") &&
        a.key !== "profile-url" && // slug — out of the steward's scope (§3b)
        a.key !== "proxy-editors", // delegation — out of the steward's scope (§3b)
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
  "highlights",
  "visibility",
  "proxy-editors",
  // "From WCM systems" group — ordered per operator request. (Profile URL is
  // owned ⇒ joins "Yours to edit" only when the slug-request flag is on;
  // gated/read-only it leads the WCM group.)
  "profile-url",
  "name-title",
  "email",
  "photo",
  "appointments",
  "education",
  "publications",
  "funding",
  "mentees",
  "coi",
  "coi-gap",
  // "Services" group — owner-facing tools (#917 v5/v6), rendered LAST per operator
  // request (#917 v6 §1). Each item is flag-gated, so the "Services" header renders
  // only when at least one tool is enabled. Group order is first-appearance in this
  // array (`attribute-rail.tsx` `groupItems`), so these two keys position the header.
  "biosketch",
  "grant-recs",
];
const SELF_RAIL_KIND: Record<AttrKey, RailKind> = {
  home: "owned",
  overview: "owned",
  highlights: "owned",
  visibility: "owned",
  "proxy-editors": "owned",
  "profile-url": "owned",
  publications: "sourced",
  funding: "sourced",
  // "Services" group (#917 v5) — owner-facing tools, distinct from sourced data.
  "grant-recs": "service",
  biosketch: "service",
  appointments: "sourced",
  education: "sourced",
  mentees: "sourced",
  "name-title": "readonly",
  email: "readonly",
  photo: "readonly",
  coi: "readonly",
  "coi-gap": "readonly",
};
const SELF_RAIL_GROUP = {
  owned: "Yours to edit",
  service: "Services",
  sourced: "From WCM systems",
  readonly: "From WCM systems",
} as const;

/**
 * Superuser rail order — kept flat (no "Yours to edit" / "From WCM systems"
 * grouping: superuser editability differs from self, so those labels would
 * mislead). Home leads as the completeness landing; Profile URL sits at the top
 * of the attributes per operator request. Publications is present (a superuser
 * manages pubs on the scholar's behalf); the COI-gap advisory remains self-only
 * (a deliberate privacy carve-out — see the dismiss route), so it is absent here.
 */
const SUPERUSER_RAIL_ORDER: ReadonlyArray<AttrKey> = [
  "home",
  "profile-url",
  "name-title",
  "email",
  "photo",
  "overview",
  // Highlights follows Overview (mirrors the self rail); appears only when the
  // loader populated `ctx.highlights` (#836, flag on).
  "highlights",
  "visibility",
  "proxy-editors",
  "funding",
  "grant-recs",
  "biosketch",
  "appointments",
  "education",
  // Publications — now a superuser surface too (#836 follow-on); the scholar's
  // authorships with hide/show + reject, acted on the scholar's behalf.
  "publications",
  "mentees",
  "coi",
  // COI-gap advisory — superuser-visible too (operator decision), with a UI nag.
  // Present only when there are candidates AND the flag is on.
  "coi-gap",
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
  /** Self mode only: a pre-built console tab strip (the shared `AdminSubnav`)
   *  for a superuser / comms_steward, rendered by `EditShell` in place of the
   *  minimal self-edit sub-nav. Built by the `/edit` page (which holds the
   *  session + role verdicts) and forwarded opaquely. */
  consoleNav?: React.ReactNode;
  /** Self mode only: org units the viewer may also curate (#753), surfaced on
   *  the Home panel. Empty for most scholars. */
  manageableUnits?: ManageableUnit[];
  /** The scholar's current proxy-editor grants (#779), for the "Profile editors"
   *  panel in self / superuser mode. `null` ⇒ the panel renders nothing (e.g.
   *  proxy mode, where it is not even in the rail). */
  proxyEditors?: ProxyRow[] | null;
  /** Org-unit administrators who can also edit this scholar (Amendment 4 P3),
   *  shown as the read-only "Org-unit administrators" group inside the Profile
   *  editors panel. `null`/absent ⇒ the group is not rendered (proxy/unit-admin
   *  mode, where the panel is absent from the rail). */
  unitAdminEditors?: UnitAdminEditorRow[] | null;
  /** Unit-admin mode only (Amendment 4): the unit through which the viewer
   *  administers this scholar, for the "via {unit} administrator" banner.
   *  `null`/absent in every other mode. */
  unitAdminBanner?: { unitKind: "department" | "division" | "center"; unitName: string } | null;
  /** Self mode only: whether to mount the live ReCiter pending-articles nudge
   *  (`SELF_EDIT_RECITER_PENDING_HINT`). True only for a genuine, non-impersonating
   *  self viewer with the flag on; when true the Publications card + Home teaser
   *  lazily client-fetch `/api/edit/reciter-pending`. Off (default) ⇒ no fetch. */
  reciterPendingEnabled?: boolean;
  /** GrantRecs Phase 3 (`SELF_EDIT_GRANT_RECS`): whether the "Grants for me"
   *  rail item + panel are surfaced. Computed by the server page (env flag) and
   *  threaded in like the other feature gates; self + superuser only. */
  grantRecsEnabled?: boolean;
  /** #917 v5 (`EDIT_BIOSKETCH_GENERATE`): whether the "NIH biosketch" Services
   *  rail item + panel are surfaced. Computed by the server page (env flag) and
   *  threaded in like grantRecsEnabled. Surfaced to every actor the generate
   *  route authorizes (self, superuser, comms-steward, proxy, unit-admin). */
  biosketchEnabled?: boolean;
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
  hasHighlights = false,
  grantRecsEnabled = false,
  biosketchEnabled = false,
): AttrKey[] {
  void slugRequestEnabled; // Profile URL is always present now (read-only when off).
  return attrsForMode(mode)
    // GrantRecs Phase 3 — "Grants for me" appears only when SELF_EDIT_GRANT_RECS
    // is on, and only on the self / superuser surfaces (never proxy / unit-admin).
    .filter(
      (a) =>
        a.key !== "grant-recs" ||
        (grantRecsEnabled && (mode === "self" || isSuperuserLike(mode))),
    )
    // #917 v5 — "NIH biosketch" appears only when EDIT_BIOSKETCH_GENERATE is on.
    // Visible to EVERY actor the generate route already authorizes (the shared
    // `authorizeOverviewWrite`: self, superuser, comms-steward, a granted proxy,
    // and an org-unit owner/curator). `attrsForMode` already keeps biosketch for
    // all five surfaces, so the flag is the only remaining gate — unlike
    // grant-recs, which stays self / superuser only.
    .filter((a) => a.key !== "biosketch" || biosketchEnabled)
    // The "From your publications" item only exists when there are candidates to
    // show — an empty panel is never surfaced, and an `?attr=coi-gap` with zero
    // candidates canonicalizes away (the page redirects to bare /edit) rather
    // than rendering an empty panel or 404-looping. (proxy drops it outright.)
    .filter((a) => a.key !== "coi-gap" || hasCoiGap)
    // #836 — Highlights appears only when the loader populated `ctx.highlights`
    // (flag on + genuine self). Off ⇒ dropped from both the rail and the valid-
    // attr set, so the feature is fully dark.
    .filter((a) => a.key !== "highlights" || hasHighlights)
    .map((a) => a.key);
}

export function EditPage({
  ctx,
  mode = "self",
  attr,
  slugRequestEnabled = false,
  latestSlugRequest = null,
  canBrowseProfiles = false,
  consoleNav,
  manageableUnits = [],
  proxyEditors = null,
  unitAdminEditors = null,
  unitAdminBanner = null,
  reciterPendingEnabled = false,
  grantRecsEnabled = false,
  biosketchEnabled = false,
}: EditPageProps) {
  // "From your publications" is conditionally present: self OR superuser, and only
  // when the loader returned candidates (the loader per surface enforces who may
  // load them + the flag, so a non-empty array here already implies an allowed
  // actor). Drop it from the visible set otherwise so it appears in neither the
  // rail nor the valid-attr set — an empty panel is never surfaced.
  // The rail item surfaces when there is High-active work OR settled history to
  // revisit (Reviewed). A Medium-only group does NOT surface the item — it lives
  // inside the High panel's lower-confidence expander, never as its own entry.
  const hasCoiGap =
    (mode === "self" || isSuperuserLike(mode)) &&
    (ctx.unmatchedPubmedCoi.length > 0 || ctx.unmatchedPubmedCoiReviewed.length > 0);
  // #836 — Highlights is present only when the loader populated `ctx.highlights`
  // (flag on + self or superuser). The loader (per surface) enforces who may load
  // it — self on `/edit`, self or superuser on `/edit/scholar/[cwid]`, never a
  // proxy / unit-admin — so a non-null value here already implies an allowed actor.
  const hasHighlights =
    (mode === "self" || isSuperuserLike(mode)) && ctx.highlights !== null;
  // GrantRecs Phase 3 — "Grants for me" shows on self / superuser surfaces when
  // SELF_EDIT_GRANT_RECS is on (the server page computes the flag and threads it).
  const showGrantRecs =
    grantRecsEnabled && (mode === "self" || isSuperuserLike(mode));
  // #917 v5 — the "NIH biosketch" Services item shows on every surface the
  // generate route authorizes (self, superuser, comms-steward, proxy, unit-admin
  // — the shared `authorizeOverviewWrite`), gated only by EDIT_BIOSKETCH_GENERATE
  // (the server page computes + threads it). The cost line stays superuser-only
  // and version selection stays superuser / unit-admin (see the panel render).
  const showBiosketch = biosketchEnabled;
  const visible = attrsForMode(mode)
    .filter((a) => a.key !== "coi-gap" || hasCoiGap)
    .filter((a) => a.key !== "highlights" || hasHighlights)
    .filter((a) => a.key !== "grant-recs" || showGrantRecs)
    .filter((a) => a.key !== "biosketch" || showBiosketch);
  // A proxy (#779) and a unit admin (Amendment 4) reuse the SELF rail/cards on
  // the scholar's route (D4). Treated like self for layout; the distinct chrome
  // (banner, breadcrumb, no account menu) is the shell's job.
  const selfLike = mode === "self" || mode === "proxy" || mode === "unit-admin";
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
              // "Yours to edit" is first-person — a proxy / unit-admin edits on
              // the scholar's behalf, so reframe the owned rail group to the
              // third-person "Profile content" the home board uses (#955 #10).
              group:
                mode !== "self" && kind === "owned"
                  ? "Profile content"
                  : SELF_RAIL_GROUP[kind],
              // "From your publications" nests under Conflicts of Interest (it
              // immediately follows "coi" in SELF_RAIL_ORDER) rather than reading
              // as a flat sibling — it is a sub-view of COI, not its own SOR.
              child: a.key === "coi-gap",
              // A quiet count of High-tier relationships still worth reviewing.
              // The badge is the High-active count ONLY — Medium and Reviewed are
              // excluded — and 0 coerces to undefined so the item can appear for a
              // Reviewed-only history without showing a "0" badge.
              count:
                a.key === "coi-gap"
                  ? ctx.unmatchedPubmedCoi.length || undefined
                  : undefined,
            },
          ];
        })
      : SUPERUSER_RAIL_ORDER.flatMap((k) => {
          const a = visible.find((v) => v.key === k);
          if (!a) return [];
          // The COI-gap label is first-person ("From your publications"); reframe
          // it for a superuser viewing another scholar's advisory.
          const label =
            a.key === "coi-gap" ? "From the scholar’s publications" : a.label;
          // Like the self rail, the advisory nests under Conflicts of Interest
          // (it immediately follows "coi" in SUPERUSER_RAIL_ORDER) rather than
          // reading as a flat sibling — it is a sub-view of COI, not its own SOR.
          return [
            {
              key: a.key,
              label,
              readonly: a.readonly,
              child: a.key === "coi-gap",
              // High-active count ONLY (Medium + Reviewed excluded); 0 → undefined
              // so a Reviewed-only history shows the item without a "0" badge.
              count:
                a.key === "coi-gap"
                  ? ctx.unmatchedPubmedCoi.length || undefined
                  : undefined,
            },
          ];
        });
  // Self edits at "/edit"; superuser and proxy edit a named scholar at
  // "/edit/scholar/<cwid>" (a proxy is never on their own /edit).
  const basePath = mode === "self" ? "/edit" : `/edit/scholar/${ctx.scholar.cwid}`;
  const scholarName = ctx.scholar.preferredName;

  return (
    <EditShell
      // The shell chrome (breadcrumb back to Profiles + the "editing … as an
      // administrator" banner) is the same a superuser sees — a comms_steward
      // reaches this editor from the same roster and edits in an administrative
      // capacity, so reuse it rather than add bespoke chrome.
      mode={mode === "comms_steward" ? "superuser" : mode}
      scholarName={scholarName}
      railItems={railItems}
      activeAttr={active.key}
      basePath={basePath}
      previewHref={profilePath(ctx.scholar.slug)}
      // History visibility == edit access, so every mode gets the link; the
      // route is always `/edit/scholar/[cwid]/history` (self resolves via the
      // gate's isSelf branch), never the bare `/edit`. (#955)
      historyHref={`/edit/scholar/${ctx.scholar.cwid}/history`}
      account={mode === "self" ? { slug: ctx.scholar.slug, preferredName: scholarName } : undefined}
      canBrowseProfiles={canBrowseProfiles}
      consoleNav={consoleNav}
      unitAdmin={unitAdminBanner ?? undefined}
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
        unitAdminEditors,
        reciterPendingEnabled,
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
  unitAdminEditors: UnitAdminEditorRow[] | null,
  reciterPendingEnabled: boolean,
) {
  const cwid = ctx.scholar.cwid;
  // Child cards model only self vs superuser. A proxy reuses the SELF cards
  // (overview editable, publications hide); the proxy-specific affordance gates
  // (no generate, no preview link, no slug request) are derived from the REAL
  // `mode` at each call site below, never from `childMode`.
  const childMode: "self" | "superuser" = isSuperuserLike(mode) ? "superuser" : "self";
  // #955 #10 — copy-only child cards take their VOICE via a display mode:
  // third-person whenever the editor is NOT the scholar (superuser,
  // comms_steward, proxy, unit-admin). This is NOT the capability mode — a proxy
  // / unit-admin still reuses the SELF cards' behavior (childMode === "self").
  // The only card that needs the real capability is VisibilityCard (its
  // ownRow/adminRow state machine), which keeps `mode={childMode}` and takes an
  // explicit `thirdPerson` purely for its copy.
  const thirdPerson = mode !== "self";
  const voiceMode: "self" | "superuser" = thirdPerson ? "superuser" : "self";
  const detailBase = mode === "self" ? "/edit" : `/edit/scholar/${cwid}`;
  switch (key) {
    case "grant-recs":
      // GrantRecs Phase 3 — the "Grants for me" panel. Client island fetching the
      // public forward route for the resolved cwid (self or superuser-target).
      return <GrantRecsCard cwid={cwid} />;
    case "biosketch":
      // #917 v5/v6 — the "NIH biosketch" Services panel. The generate tool (client
      // island) POSTs to /api/edit/biosketch/generate for the resolved cwid; the
      // per-draft cost line + the prompt-version selector show to a privileged actor
      // only (superuser / comms / unit-admin curator), matching the route gate.
      return (
        <BiosketchTool
          entityId={cwid}
          canSeeCost={isSuperuserLike(mode)}
          // The "View prompt & payload" debug affordance is STRICTLY superuser (the raw FACTS
          // projection is internal data), narrower than canSeeCost — which also includes a
          // comms-steward. `isSuperuser` here is the self-mode superuser tell (canBrowseProfiles);
          // `mode === "superuser"` is the dedicated superuser surface for another scholar.
          canDebug={mode === "superuser" || (mode === "self" && isSuperuser)}
          model={BIOSKETCH_EFFECTIVE_MODEL}
          versions={listSelectableBiosketchPromptVersions()}
          canSelectVersion={isSuperuserLike(mode) || mode === "unit-admin"}
        />
      );
    case "home": {
      const hiddenPublications = ctx.publications.filter((p) => p.state !== "shown").length;
      const isHidden =
        ctx.scholar.suppression.ownRow !== null || ctx.scholar.suppression.adminRow !== null;
      // A superuser editing another scholar gets the same board reframed as a
      // completeness overview: copy shifts from "you" to the scholar's name, the
      // Overview CTA edits the bio (#844 — admins may now author any overview),
      // the Publications row drops its CTA (no superuser pubs tab), and the "Units
      // you manage" section is omitted — it's the viewer's units, not the
      // target's. (When a superuser edits their OWN profile this is mode='self'.)
      return (
        <HomePanel
          mode={voiceMode}
          basePath={detailBase}
          cwid={cwid}
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
          // ReCiter pending suggestions are surfaced for the scholar themselves OR
          // a superuser viewing the target (parity with the COI-gap hint). The page
          // computes `reciterPendingEnabled` = flag on AND (self OR superuser); the
          // teaser fetches the target `cwid`, which the route re-authorizes. Proxy /
          // unit-admin get false (no nudge).
          reciterPendingEnabled={
            mode === "self" || mode === "superuser" ? reciterPendingEnabled : false
          }
        />
      );
    }
    case "name-title":
      return (
        <ReadonlyAttributePanel
          attribute="name-title"
          cwid={cwid}
          heading="Name & Title"
          description="Name, title, degrees, department, and ORCID come from the WCM directory and faculty records."
          fields={[
            { label: "Name", value: ctx.scholar.fullName },
            { label: "Title", value: ctx.scholar.primaryTitle },
            { label: "Degrees", value: ctx.scholar.postnominal },
            { label: "Department", value: ctx.scholar.primaryDepartment },
            { label: "ORCID", value: ctx.scholar.orcid },
          ]}
        />
      );
    case "email":
      // Read-only Email tab (email-visibility SPEC § C). Email + its release
      // audience are owned by the Web Directory SOR; the panel shows the imported
      // state and links out — no write control. Always shows the email (owner
      // context is internal); the visibility value is informational.
      return (
        <EmailCard
          mode={voiceMode}
          scholarName={scholarName}
          email={ctx.scholar.email}
          emailVisibility={ctx.scholar.emailVisibility}
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
      // #844 — a superuser may now edit any scholar's Overview on the superuser
      // surface (previously read-only). The manual editor renders for every mode
      // that reaches this case (self / proxy / unit-admin / superuser); the
      // server re-authorizes the write per field (overview only for admins). The
      // "View it →" link points at the target scholar's public profile in every
      // mode so the edit → preview → live loop closes for the superuser too.
      return (
        <OverviewCard
          cwid={cwid}
          initialHtml={ctx.scholar.overview}
          previewHref={profilePath(ctx.scholar.slug)}
          // The generator (#742) is offered to the actors who may WRITE the bio
          // here: the scholar (self), a superuser / comms_steward, AND — since
          // prompt versioning (`overview-prompt-versioning-spec.md` §6, D-E:
          // widen-to-curators) — an org-unit curator (unit-admin). The generate
          // route + `authorizeOverviewWrite` already authorize all of these, so the
          // UI surface now agrees. Proxy stays excluded (governance: a proxy still
          // gets the manual editor only). Still gated behind the feature flag.
          generateEnabled={
            (mode === "self" || isSuperuserLike(mode) || mode === "unit-admin") &&
            isOverviewGenerateEnabled()
          }
          // #742 prompt versioning — the version selector is exposed to superuser /
          // comms_steward and to a curator (unit-admin), never to the faculty owner
          // (self) or a proxy. The route re-enforces this server-side. The default
          // version + each version's resolved effective model are server-computed.
          canSelectPromptVersion={isSuperuserLike(mode) || mode === "unit-admin"}
          promptVersions={listSelectablePromptVersions().map((v) => ({
            ...v,
            model: resolveEffectiveOverviewModel(v.id),
          }))}
          defaultPromptVersion={defaultPromptVersionId()}
          // #1077 follow-up — reframe the provenance note's "written by you" copy
          // for any third-person editor (superuser / proxy / unit-admin).
          mode={voiceMode}
        />
      );
    case "highlights":
      // Editable by the scholar (self) or a superuser on their behalf — the
      // loader only populates `ctx.highlights` for an allowed actor (and the rail
      // item is dropped when it is null), and the write route re-authorizes self
      // OR superuser. `childMode` reframes the card's copy from first-person to
      // the scholar's name for a superuser.
      return ctx.highlights ? (
        <HighlightsCard
          cwid={cwid}
          mode={voiceMode}
          scholarName={scholarName}
          highlights={ctx.highlights}
        />
      ) : null;
    case "visibility":
      return (
        <VisibilityCard
          cwid={cwid}
          suppression={ctx.scholar.suppression}
          scholarName={scholarName}
          // VisibilityCard keeps the REAL capability mode (its ownRow/adminRow
          // state machine + reason-required behavior), and takes `thirdPerson`
          // purely to reframe its copy for a proxy / unit-admin (#955 #10).
          mode={childMode}
          thirdPerson={thirdPerson}
        />
      );
    case "publications":
      return (
        <PublicationsCard
          cwid={cwid}
          mode={voiceMode}
          scholarName={scholarName}
          publications={ctx.publications}
          rejectEnabled={isReciterRejectEnabled()}
          // Surfaced for the scholar themselves OR a superuser viewing the target
          // (parity with the COI-gap hint). `childMode` is "self" for a genuine
          // self viewer and "superuser" for a superuser; both mount the loader,
          // which fetches the target `cwid` (route-authorized). A proxy / unit-admin
          // collapses to "self" childMode but the page sets `reciterPendingEnabled`
          // only for self|superuser, so they get false (no nudge).
          reciterPendingEnabled={
            childMode === "self" || childMode === "superuser" ? reciterPendingEnabled : false
          }
        />
      );
    case "funding":
      return <FundingCard cwid={cwid} mode={voiceMode} scholarName={scholarName} grants={ctx.grants} />;
    case "appointments":
      return (
        <AppointmentsCard
          cwid={cwid}
          mode={voiceMode}
          scholarName={scholarName}
          appointments={ctx.appointments}
        />
      );
    case "education":
      return (
        <EducationCard cwid={cwid} mode={voiceMode} scholarName={scholarName} educations={ctx.educations} />
      );
    case "mentees":
      return (
        <MenteesCard cwid={cwid} mode={voiceMode} scholarName={scholarName} mentees={ctx.mentees} />
      );
    case "coi":
      return (
        <CoiCard
          cwid={cwid}
          mode={voiceMode}
          scholarName={scholarName}
          disclosures={ctx.coiDisclosures}
          // The bridge to "From your publications" appears for a self viewer OR a
          // superuser with suggestions (#836 populates `unmatchedPubmedCoi` for a
          // superuser too; a comms_steward is excluded at the loader, so it stays
          // 0 for them). The href targets the ACTIVE surface — `/edit` for self,
          // `/edit/scholar/{cwid}` for a superuser viewing another scholar (#986) —
          // and `childMode` reframes the copy from first-person to the scholar's name.
          suggestionCount={ctx.unmatchedPubmedCoi.length}
          suggestionsHref={`${detailBase}?attr=coi-gap`}
        />
      );
    case "coi-gap":
      // Self or superuser — the loader populates `unmatchedPubmedCoi` only for an
      // allowed actor behind the flag, and the rail item is dropped when the array
      // is empty. `childMode` reframes the advisory copy + the privacy chip and
      // turns on the per-action "nag" confirm for a superuser; the dismiss /
      // restore routes re-authorize genuine-self-or-superuser.
      return (
        <CoiGapCard
          cwid={cwid}
          mode={voiceMode}
          scholarName={scholarName}
          mentions={ctx.unmatchedPubmedCoiMentions}
        />
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
          unitAdmins={unitAdminEditors}
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
          lowercase letters, numbers, and hyphens only. The older{" "}
          <code className="font-mono">/scholars/{slug}</code> address still redirects here.
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
