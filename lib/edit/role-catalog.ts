/**
 * Every role in Scholars Console, for the Administrators page's "All roles"
 * tab (spec: Projects plans/2026-10-01-administrators-roles-tab-spec.md) and
 * the access-control doc. Descriptive only: no gate reads this. The gates are
 * the `is<Role>` predicates in `lib/auth/` and `lib/edit/authz.ts`; when a
 * role's reach changes there, update its chips here.
 *
 * Pure: safe in a `"use client"` component.
 */

/** Where a role comes from, which also decides whether we can count holders. */
export type RoleSource = "ed_group" | "functional" | "unit_grant" | "scholar";

export type RoleCatalogEntry = {
  key: string;
  label: string;
  description: string;
  source: RoleSource;
  /** The ED group's cn, for `ed_group` roles. */
  groupCn?: string;
  /** A second way in, shown under "Granted by" (e.g. a functional role). */
  alsoGrantedBy?: string;
  can: readonly string[];
  cannot: readonly string[];
};

const ED = (role: string) => `ITS:Library:Scholars/${role}-role`;

export const ROLE_CATALOG: readonly RoleCatalogEntry[] = [
  {
    key: "superuser",
    label: "Superuser",
    description: "Runs the site.",
    source: "ed_group",
    groupCn: ED("superuser"),
    can: ["Everything", "Grant access", "Takedowns", "View as"],
    cannot: [],
  },
  {
    key: "comms_steward",
    label: "Communications steward",
    description: "External Affairs · Communications.",
    source: "ed_group",
    groupCn: ED("comms-steward"),
    alsoGrantedBy: "External Affairs · Communications",
    can: ["Edit any profile", "Edit any unit", "Pin titles", "Method Families", "Role vocabulary", "Queues", "Manage unit access"],
    cannot: ["Takedowns"],
  },
  {
    key: "content_editor",
    label: "Content editor",
    description: "Edits profile and unit content site-wide.",
    source: "ed_group",
    groupCn: ED("content-editor"),
    can: ["Edit any profile", "Hide items and sections", "Edit any unit", "News and media queues", "Method Families", "Read every queue and report", "View as (read-only)"],
    cannot: ["Grant access", "Pin titles", "Takedowns", "Whole-profile hide", "Role vocabulary", "Profile URLs"],
  },
  {
    key: "observer",
    label: "Observer",
    description: "Read-only console access for staff who support users.",
    source: "ed_group",
    groupCn: ED("observer"),
    can: ["Read every profile and unit", "Read every queue and dashboard", "Download CVs", "View as (read-only)"],
    cannot: ["Any edit"],
  },
  {
    key: "development",
    label: "Development",
    description: "External Affairs · Development.",
    source: "ed_group",
    groupCn: ED("development"),
    alsoGrantedBy: "External Affairs · Development",
    can: ["Prospect-research tools"],
    cannot: ["Edit profiles"],
  },
  {
    key: "honors_curator",
    label: "Honors curator",
    description: "Reviews honors matched from award lists.",
    source: "ed_group",
    groupCn: ED("honors-curator"),
    can: ["Honors queue"],
    cannot: ["Edit profiles"],
  },
  {
    key: "cv_generator",
    label: "CV generator",
    description: "Faculty Affairs CV downloads.",
    source: "ed_group",
    groupCn: ED("cv-generator"),
    can: ["Download any CV"],
    cannot: ["Any edit"],
  },
  {
    key: "data_sharing_viewer",
    label: "Data-sharing viewer",
    description: "The data-sharing dashboard.",
    source: "ed_group",
    groupCn: ED("data-sharing-viewer"),
    can: ["Data-sharing dashboard"],
    cannot: ["Any edit"],
  },
  {
    key: "reporting",
    label: "Reporting",
    description: "Reports and dashboards, one scope at a time.",
    source: "functional",
    can: ["Granted reports", "Granted dashboards"],
    cannot: ["Any edit"],
  },
  {
    key: "unit_owner",
    label: "Unit owner",
    description: "Runs one department, division, center or core.",
    source: "unit_grant",
    can: ["Edit the unit", "Edit its scholars' profiles", "Manage its access", "Its reports"],
    cannot: ["Other units"],
  },
  {
    key: "unit_curator",
    label: "Unit curator",
    description: "Edits one department, division, center or core.",
    source: "unit_grant",
    can: ["Edit the unit", "Edit its scholars' profiles", "Its reports"],
    cannot: ["Manage access", "Other units"],
  },
  {
    key: "institution_admin",
    label: "Institution admin",
    description: "An affiliate institution's administrator.",
    source: "unit_grant",
    can: ["Its scholars' profiles", "Its reports"],
    cannot: ["WCM-wide usage"],
  },
  {
    key: "proxy",
    label: "Proxy",
    description: "Someone a scholar authorizes on their own profile.",
    source: "scholar",
    can: ["That scholar's content", "Hide items on that profile"],
    cannot: ["Other profiles"],
  },
];

/** Holder counts by catalog key; absent = not countable (ED groups, proxies). */
export type RoleHolderCounts = Partial<Record<string, number>>;

export const ROLE_SOURCE_LABEL: Record<RoleSource, string> = {
  ed_group: "ED group",
  functional: "Functional role",
  unit_grant: "Unit grant",
  scholar: "The scholar",
};
