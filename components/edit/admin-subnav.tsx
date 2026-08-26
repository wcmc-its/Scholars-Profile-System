/**
 * The shared admin sub-nav across ALL `/edit` console surfaces (#497 PR-3c,
 * `slug-personalization-ui-spec.md` § 3.1; unified onto the self-edit surface in
 * `role-aware-navigation-entry-points-spec.md`). The maroon-underlined tab strip
 * under the black Apollo bar, linking the Profiles roster (`/edit/scholars`), the
 * Profile-URL request queue (`/edit/slug-requests`), the URL registry,
 * Administrators, Method Families, and the matcher tools
 * (`/edit/matcha`, `/edit/grant-matcha`). A pending-count pill sits on the "URL requests"
 * tab; the account chip/dropdown anchors the right end (account-dropdown-nav
 * handoff, Workstream A — its `ACCOUNT_CONSOLE_NAV_RESTRUCTURE` flag was
 * retired in #1440).
 *
 * Originally only the superuser list pages rendered this. It now also renders on
 * the `/edit` self-edit surface for a superuser or comms_steward (via
 * `active="self"`), so the full role-gated option set is visible from anywhere in
 * the console — not just after drilling into the roster. A plain scholar's
 * self-edit page keeps its minimal "My Profile" strip and never mounts this.
 *
 * `pendingSlugRequests === null` hides the URL-requests tab entirely — the
 * slug-request feature is flag-gated (`SELF_EDIT_SLUG_REQUEST`), so a surface
 * that doesn't exist isn't advertised.
 */
import Link from "next/link";

import { AccountMenu } from "@/components/site/account-menu";
import { AdminGroupMenu } from "@/components/edit/admin-group-menu";
import { MatchaTab } from "@/components/edit/matcha-tab";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isGrantMatchaEnabled } from "@/lib/edit/grant-recs";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";

export type AdminSubnavActive =
  | "profiles"
  | "units"
  | "slug-requests"
  | "honors-queue"
  | "news-queue"
  | "slugs"
  | "administrators"
  | "methods"
  | "coi"
  | "data-sharing"
  | "activity"
  | "usage"
  | "etl-status"
  | "reports"
  | "cores"
  | "matcha"
  | "grant-matcha"
  /** The viewer's own self-edit surface (`/edit`) — no list tab is active;
   *  profile actions live in the right-end account menu. */
  | "self";

/**
 * Two-tier grouping (`docs/2026-07-20-console-subnav-two-tier-spec.md`), behind
 * `CONSOLE_SUBNAV_GROUPED`. The 14 role-gated tabs are not peers: four groups
 * collapse twelve of them, leaving Profiles / Org units top-level (the daily
 * drivers, and "Web Directory" would collide with the Enterprise Directory
 * source system).
 *
 * Routes, callers and `AdminSubnavProps` are all untouched — the group is
 * DERIVED from `active` via this map, so nothing new threads through the 14
 * console pages. `Record<AdminSubnavActive, …>` is the point: a new id fails to
 * compile until it is placed, rather than silently landing ungrouped.
 */
type GroupId = "queues" | "registries" | "reports" | "insights" | "tools";

const GROUP_LABEL: Record<GroupId, string> = {
  queues: "Queues",
  registries: "Registries",
  reports: "Reports",
  insights: "Insights",
  tools: "Tools",
};

/** Tier-1 order after the top-level tabs. `reports` is always a single-member
 *  "group" (see `TAB_GROUP.reports` below) — the single-member promotion
 *  further down renders it as a plain tab, not a dropdown, so this array
 *  entry is really just "where in the strip does Reports sit": left of
 *  Insights, per direct feedback overturning the 2026-08-12 exclusivity
 *  decision (Reports IA redesign, 2026-08-14). */
const GROUP_ORDER: GroupId[] = ["queues", "registries", "reports", "insights", "tools"];

const TAB_GROUP: Record<AdminSubnavActive, GroupId | null> = {
  profiles: null,
  units: null,
  /** Pending work — something is waiting on a human. All four are approve/reject
   *  review surfaces; `cores` moves here from its old bar position (its own code
   *  comment calls it the "Cores review-queue index"). */
  "slug-requests": "queues",
  "honors-queue": "queues",
  "news-queue": "queues",
  cores: "queues",
  /** Reference/config data you look up; rarely mutated. */
  slugs: "registries",
  administrators: "registries",
  methods: "registries",
  /** Read-only dashboards; no writes. */
  coi: "insights",
  "data-sharing": "insights",
  activity: "insights",
  usage: "insights",
  "etl-status": "insights",
  // Its own single-member group (Reports IA redesign, 2026-08-14) — a
  // dedicated top-level tab, not an Insights peer. Reverses the 2026-08-12
  // "reached exclusively via /edit/units" decision; per direct feedback,
  // Reports keeps a SECOND entry point too (the center editor's header link,
  // `EditShell`'s `reportsHref` — Phase 1 of this redesign).
  reports: "reports",
  /** Paste an input, get a ranked result. */
  matcha: "tools",
  "grant-matcha": "tools",
  /** The viewer's own `/edit` — no group is active, so tier 2 does not render. */
  self: null,
};

/** One console tab, with its visibility resolved. */
type TabSpec = {
  show: boolean;
  id: AdminSubnavActive;
  href: string;
  label: string;
  count?: number;
  activeIsLink?: boolean;
};

export function AdminSubnav({
  active,
  pendingSlugRequests,
  pendingHonors,
  administratorsTab,
  methodsTab,
  dataSharingTab,
  superuserSurfaces = true,
  profilesTab = false,
  unitsTab = false,
  usageTab = false,
  reportsTab = false,
  newsTab = false,
  coresTab = false,
  viewerIsDeveloper = false,
}: {
  active: AdminSubnavActive;
  pendingSlugRequests: number | null;
  /**
   * #1762 — count of honors awaiting approval. `null` hides the tab: the flag is
   * off, or this viewer is neither a superuser nor an `honors_curator`.
   *
   * 🔴 REQUIRED, and deliberately NOT optional-with-a-default, mirroring
   * `pendingSlugRequests`. An optional prop compiles clean at all 12 callers and
   * silently defaults to `null` — so the tab renders on the honors page alone and
   * nowhere else, i.e. only for someone who already knows the URL. That is
   * exactly #1767's bug ("an honors surface nobody could find"), and exactly
   * #1760's rail-order bug: the compiler-enforced maps were right, the
   * unenforced arrays typechecked clean and never rendered. Required is what
   * makes the compiler the test.
   */
  pendingHonors: number | null;
  /** `null` hides the "Administrators" tab — the feature is flag-gated
   *  (`SELF_EDIT_ADMINISTRATORS_TAB`), mirroring the `pendingSlugRequests`
   *  hide pattern. A number shows the tab (Phase B passes `0` — no badge). */
  administratorsTab?: number | null;
  /** `null`/omitted hides the "Method Families" tab — the comms_steward surface
   *  is flag-gated + role-gated (`isMethodsTabVisible`). A number shows it
   *  (passed `0` — no badge), mirroring `administratorsTab`. */
  methodsTab?: number | null;
  /** `null`/omitted hides the "Data sharing" tab — the S-Index Phase 1 dashboard
   *  is flag- + role-gated (`isDataSharingDashboardTabVisible`; superuser,
   *  comms_steward, or data_sharing_viewer, no unit-scoped variant — unlike
   *  Data Quality, there is no natural per-unit cut here). A number shows it
   *  (passed `0` — no badge). */
  dataSharingTab?: number | null;
  /** Whether to show the superuser list surfaces (URL requests / Slug registry /
   *  Administrators — and Profiles, unless `profilesTab` separately enables it).
   *  Default `true`. A comms_steward who is NOT a superuser passes `false` so
   *  those superuser-only surfaces stay hidden. */
  superuserSurfaces?: boolean;
  /** Show the "Profiles" tab independently of `superuserSurfaces`. A
   *  comms_steward is a global profile editor (comms-steward-profile-editing-
   *  spec.md §4d), so they get Profiles (+ Method Families) without the other
   *  superuser surfaces. A superuser already gets Profiles via `superuserSurfaces`. */
  profilesTab?: boolean;
  /** Show the "Units" tab (the `/edit/units` finder). A comms_steward edits any
   *  existing org unit's content (§3b), and a superuser jumps to any unit too. */
  unitsTab?: boolean;
  /** Show the "Usage" tab (`/edit/usage`, the global usage dashboard) to a
   *  non-superuser unit admin (owner/curator). Superusers already get it via
   *  `superuserSurfaces`; this is the escape hatch so a unit admin who can view
   *  usage (`canViewUsage`) sees the tab too. Default `false`. */
  usageTab?: boolean;
  /** Show the "Reports" tab (`/edit/reports`, the Cancer Center reports console)
   *  to a non-superuser unit admin (owner/curator) with at least one reportable
   *  unit. Superusers already get it via `superuserSurfaces`; this is the
   *  escape hatch, mirroring `usageTab`. Default `false` (Reports IA redesign,
   *  2026-08-14). */
  reportsTab?: boolean;
  /** Show the "News" tab (`/edit/news-queue`) to a non-superuser comms_steward.
   *  Superusers already get it via `superuserSurfaces`; this is the escape
   *  hatch, mirroring `reportsTab`. Gap 2 fix (2026-08-14) — previously
   *  piggybacked on `profilesTab`, which a unit Owner/Curator can also earn
   *  (`/edit/scholars`'s `unitScope !== null` override), showing a News link
   *  that 404s on `isNewsQueueTabVisible`'s actual gate. Default `false`. */
  newsTab?: boolean;
  /** Show the "Cores" tab (`/edit/core`) to a non-superuser comms_steward.
   *  Superusers already get it via `superuserSurfaces`; this is the escape
   *  hatch, mirroring `newsTab`/`reportsTab` — 2026-08-26 policy widening
   *  (decision #6, full curator-parity on cores) matches `TAB_PREDICATES.cores`
   *  in `lib/edit/console-tabs.server.ts`. Without this, the tab was ANDed
   *  with `superuserSurfaces` alone — the same Gap-3 shape already fixed for
   *  Administrators above — which would hide it from every steward even
   *  though `/edit/core` itself now admits them. Default `false`. */
  coresTab?: boolean;
  /** Show the Matcha / Grant Matcha tabs to a pure development-role viewer who
   *  is NOT a superuser. Superusers already get them via `superuserSurfaces`;
   *  this is the dev-role escape hatch on `/edit/grant-matcha` (their console
   *  landing since the find-researchers sunset). Default `false`. */
  viewerIsDeveloper?: boolean;
}) {
  /**
   * Visibility is computed BEFORE grouping. A group may render only if at least
   * one of its members is visible, which an inline JSX guard per tab cannot
   * answer — so every condition below is lifted VERBATIM out of the old strip
   * into one list. No gate changed; this half is a pure refactor and the
   * flag-off render below reproduces the previous DOM exactly.
   *
   * `isNewsQueueEnabled()` / `isCorePagesEnabled()` / `isMatchaEnabled()` are
   * server env reads and stay in this server component — threading them into a
   * client child is the #1783 failure mode.
   */
  const tabs: TabSpec[] = (
    [
      { show: superuserSurfaces || profilesTab, id: "profiles", href: "/edit/scholars", label: "Profiles" },
      { show: unitsTab, id: "units", href: "/edit/units", label: "Org units" },
      {
        show: superuserSurfaces && pendingSlugRequests !== null,
        id: "slug-requests",
        href: "/edit/slug-requests",
        label: "URL requests",
        count: pendingSlugRequests ?? undefined,
      },
      // Gated on `pendingHonors !== null` ALONE — deliberately without
      // `superuserSurfaces`, unlike the slug tab above. This queue has a
      // non-superuser tier (`honors_curator`, the Research Dean's office) for whom
      // `superuserSurfaces` is false, so ANDing it would hide the tab from the very
      // people the role exists to serve (#1767: "an honors surface nobody could
      // find"). The caller already resolved the gate into a count-vs-null.
      // #1762 round 4: no count badge — the curator asked for it to be dropped.
      { show: pendingHonors !== null, id: "honors-queue", href: "/edit/honors-queue", label: "Honors" },
      {
        // Gap 2 fix — was `superuserSurfaces || profilesTab`, piggybacking on a
        // prop a unit Owner/Curator can also earn; `newsTab` is the dedicated
        // signal (mirrors `reportsTab`), matching `isNewsQueueTabVisible`'s
        // actual isSuperuser-or-isCommsSteward gate.
        show: (superuserSurfaces || newsTab) && isNewsQueueEnabled(),
        id: "news-queue",
        href: "/edit/news-queue",
        label: "News",
      },
      // Always visible to superusers — the slug namespace exists regardless of the
      // slug-request flag.
      { show: superuserSurfaces, id: "slugs", href: "/edit/slugs", label: "URL registry" },
      // Gap 3 fix — was `superuserSurfaces && administratorsTab !== null && ...`,
      // ANDing a role check its siblings (methods/dataQuality/dataSharing below)
      // don't. `administratorsTab` is now `0`-or-`null` FOR THE VIEWER already
      // (superuser OR unit Owner, D5 — see `loadConsoleTabs`'s `administrators`
      // predicate), so the count-vs-null check alone is the correct gate; the
      // extra AND was hiding the tab from exactly the Owner it exists to serve,
      // mirroring the #1767 shape already fixed for Honors above.
      {
        show: administratorsTab !== null && administratorsTab !== undefined,
        id: "administrators",
        href: "/edit/administrators",
        label: "Administrators",
      },
      {
        show: methodsTab !== null && methodsTab !== undefined,
        id: "methods",
        href: "/edit/methods",
        label: "Method families",
      },
      // A dedicated tab, not an Insights peer (Reports IA redesign, 2026-08-14 —
      // reverses the 2026-08-12 "/edit/units only" decision). Declared here, right
      // before the Insights group's own members, so it also lands immediately to
      // their left when `CONSOLE_SUBNAV_GROUPED` is off and `tabs` renders verbatim.
      {
        show: superuserSurfaces || reportsTab,
        id: "reports",
        href: "/edit/reports",
        label: "Reports",
        activeIsLink: true,
      },
      // Superuser + flag only, no grant escape hatch — the one tab a unit
      // admin can never earn (`lib/edit/console-tabs.server.ts`'s `coi`
      // predicate mirrors this exactly).
      { show: superuserSurfaces && isDataQualityDashboardEnabled(), id: "coi", href: "/edit/coi", label: "COI" },
      {
        show: dataSharingTab !== null && dataSharingTab !== undefined,
        id: "data-sharing",
        href: "/edit/data-sharing",
        label: "Data sharing",
      },
      // Fleet-wide edit-activity oversight. Superuser-only; no separate flag — the
      // superuser gate on the page IS the control.
      { show: superuserSurfaces, id: "activity", href: "/edit/activity", label: "Activity" },
      // Wider audience than the other superuser tabs: a superuser OR any unit admin
      // (via `usageTab`, set when `canViewUsage` passes).
      { show: superuserSurfaces || usageTab, id: "usage", href: "/edit/usage", label: "Usage" },
      // Read-only ETL health board. Superuser-only; no separate flag — same
      // rationale as Activity above, the superuser gate on the page IS the control.
      { show: superuserSurfaces, id: "etl-status", href: "/edit/etl-status", label: "ETL status" },
      // Gated on the same `CORE_PAGES` flag as the public core surfaces, so it stays
      // dark in any env where cores aren't live yet (staging-on / prod-off).
      // `coresTab` is the comms_steward escape hatch (2026-08-26, decision #6).
      {
        show: (superuserSurfaces || coresTab) && isCorePagesEnabled(),
        id: "cores",
        href: "/edit/core",
        label: "Cores",
      },
      // CTL sponsor match — `viewerIsDeveloper` is the escape hatch for a pure
      // development-role viewer; dark while SPONSOR_MATCH is off.
      {
        show: (superuserSurfaces || viewerIsDeveloper) && isMatchaEnabled(),
        id: "matcha",
        href: "/edit/matcha",
        label: "Matcha",
      },
      // Grant Matcha — Matcha seeded from a funding opportunity. Same audience
      // as Matcha, additionally dark while GRANT_MATCHA is off (both flags read
      // here in the server component; mirrors the `grantMatcha` predicate in
      // `lib/edit/console-tabs.server.ts`). Unlike Matcha this renders through
      // the plain `AdminTab` link — no Radix hover content (#1783).
      {
        show: (superuserSurfaces || viewerIsDeveloper) && isMatchaEnabled() && isGrantMatchaEnabled(),
        id: "grant-matcha",
        href: "/edit/grant-matcha",
        label: "Grant Matcha",
      },
    ] satisfies TabSpec[]
  ).filter((t) => t.show);

  const renderTab = (t: TabSpec) =>
    // Matcha alone renders through the CLIENT `MatchaTab`, because it carries a
    // Radix HoverCard: composing Radix in this server component silently DROPPED
    // the tab once (#1783 — a 200 with no error, which jsdom cannot catch). Group
    // entries take the same care via the client `AdminGroupMenu` below.
    t.id === "matcha" ? (
      <MatchaTab key="matcha" active={active === "matcha"} />
    ) : (
      <AdminTab
        key={t.id}
        href={t.href}
        testId={`admin-tab-${t.id}`}
        label={t.label}
        active={active === t.id}
        count={t.count}
        activeIsLink={t.activeIsLink}
      />
    );

  // Ships dark. Flipping it in a deployed env needs the var set "on" in BOTH
  // `.env.local` AND the per-env `environment:` block in cdk/lib/app-stack.ts,
  // then `cdk deploy Sps-App-<env>` — env vars live in the task def, so a merged
  // flag is inert until that deploy (the flag-parity rule).
  const grouped = process.env.CONSOLE_SUBNAV_GROUPED === "on";
  const activeGroup = grouped ? TAB_GROUP[active] : null;
  const groups = grouped
    ? GROUP_ORDER.map((id) => ({ id, members: tabs.filter((t) => TAB_GROUP[t.id] === id) })).filter(
        // A group with zero visible members is omitted entirely.
        (g) => g.members.length > 0,
      )
    : [];

  const tier1 = grouped
    ? [
        ...tabs.filter((t) => TAB_GROUP[t.id] === null).map(renderTab),
        ...groups.map((g) =>
          // Single-member promotion. Not a nicety: narrow roles are common here
          // (`honors_curator` → Queues={Honors}; a comms_steward → Registries={Method
          // families}), and
          // wrapping one tab in a group turns their entire console into a pointless
          // extra hop.
          g.members.length === 1 ? (
            renderTab(g.members[0])
          ) : (
            // A multi-member group reveals its members in a hover/focus menu
            // (`AdminGroupMenu`, client — #1783). The label is still a LINK to the
            // first visible member, so a click/tap reaches that surface directly and
            // every other member is one hover-or-focus away.
            <AdminGroupMenu
              key={g.id}
              groupId={g.id}
              label={GROUP_LABEL[g.id]}
              href={g.members[0].href}
              active={activeGroup === g.id}
              members={g.members.map((m) => ({
                id: m.id,
                href: m.href,
                label: m.label,
                active: active === m.id,
                count: m.count,
              }))}
            />
          ),
        ),
      ]
    : tabs.map(renderTab);

  return (
    <div className="border-border border-b" data-slot="admin-subnav">
      <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-6 px-6">
        {/* The role-gated tab set now runs to ~14 items and no longer fits the
            bar on a laptop. Scroll the tab strip horizontally instead of letting
            it overflow / shove the account chip off-screen. `min-w-0` lets this
            flex child shrink below its content width so `overflow-x-auto` can
            engage. That is only HALF the fix: flex items default to
            `flex-shrink: 1`, so without `shrink-0 whitespace-nowrap` on each tab
            (see `AdminTab` below and the hand-mirrored `matcha-tab.tsx`) the tabs
            squeeze and their labels wrap to two lines instead — the content never
            exceeds the container, so the scrollbar never appears. That was the
            #1803 bug. Radix popovers/menus inside a tab portal to the body, so
            they are NOT clipped by this scroller. Account chip pinned outside. */}
        <div
          className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto"
          data-testid="admin-subnav-tier1"
        >
          {tier1}
        </div>
        {/* The account chip/dropdown anchors the right end — profile actions live
            entirely in the menu, which derives its scholar + rows from the
            `/api/auth/session` probe, so no scholar object needs threading
            through every console page that renders this strip. */}
        <AccountMenu context="console" />
      </div>
    </div>
  );
}

function AdminTab({
  href,
  testId,
  label,
  active,
  count,
  activeIsLink = false,
}: {
  href: string;
  /** e.g. `admin-tab-profiles`, or `admin-group-queues` for a tier-1 group entry. */
  testId: string;
  label: string;
  active: boolean;
  count?: number;
  /** When `active`, render as a clickable `Link` instead of an inert `span` —
   *  for a tab whose "active" state spans multiple distinct routes (Reports:
   *  index + 6 report detail pages), so a click always returns to the tab's
   *  home page instead of being a no-op. Default `false` preserves the
   *  existing "you are already here" convention for every other tab. */
  activeIsLink?: boolean;
}) {
  const inner = (
    <span className="inline-flex items-center gap-2">
      {label}
      {count !== undefined && count > 0 && (
        <span
          className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border inline-flex min-w-5 items-center justify-center rounded-full border px-1.5 py-0.5 text-xs font-semibold"
          data-testid="admin-subnav-pending-count"
        >
          {count}
        </span>
      )}
    </span>
  );
  const activeClass =
    "border-apollo-maroon inline-block shrink-0 border-b-2 py-3 text-sm font-medium whitespace-nowrap";
  const inactiveClass =
    "text-muted-foreground hover:text-foreground inline-block shrink-0 border-b-2 border-transparent py-3 text-sm whitespace-nowrap";
  const tab =
    active && !activeIsLink ? (
      <span className={activeClass} aria-current="page" data-testid={testId}>
        {inner}
      </span>
    ) : (
      <Link
        href={href}
        className={active ? activeClass : inactiveClass}
        aria-current={active ? "page" : undefined}
        data-testid={testId}
      >
        {inner}
      </Link>
    );
  return tab;
}
