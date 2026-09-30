/**
 * The /edit landing board: what still needs the editor first, then what is
 * already settled. The editor used to open on a nine-item data dictionary; this
 * opens on the actual job — the few things that make a profile feel finished —
 * with live status read from the loaded context.
 *
 * Five essentials — overview, headshot, ORCID iD, publications, visibility. The
 * heading counts the rows that need the editor ("Two items need you", never a
 * percentage); those sit first as boxed rows with an amber marker, and the rest
 * (settled, or informational like a hidden profile or an empty feed) fold away
 * under a "<N> completed items" disclosure (collapsed by default) as flat rows
 * with a grey check.
 *
 * Rows fed from WCM systems — the headshot, publications, and the ORCID iD (see
 * `orcidRow`) — carry an inline "WCM records" tag, the same name the rail gives
 * that group. The headshot is a live pointer to the WCM Web Directory (a scholar
 * fixes it there and it shows here right away — no sync lag); publications flow
 * from PubMed/ReCiter. Identity (avatar, name, title) is the shell's, not this
 * panel's.
 *
 * Client component: the headshot's presence is only knowable by probing the
 * external directory image (the same approach as `HeadshotAvatar`), and the
 * count and headshot row depend on it; the disclosure is local state.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PUBLICATION_MANAGER_URL, WEB_DIRECTORY_URL } from "@/lib/edit/request-a-change";
import { unitKindLabel, type ManageableUnit } from "@/lib/edit/manageable-units";
import { firstName, type OrcidEvidence } from "@/lib/edit/orcid";
import { cn } from "@/lib/utils";
import { useReciterPendingSuggestions } from "@/components/edit/reciter-pending-card";
import type { ReciterSuggestion } from "@/lib/reciter/client";

// Must match EditShell's `<main aria-labelledby="panel-heading">` and
// EditPanel's EDIT_PANEL_HEADING_ID — this panel forgoes EditPanel for the
// needs-you header, so it owns the labelled heading itself.
const PANEL_HEADING_ID = "panel-heading";
const COMPLETED_LIST_ID = "home-completed-items";

export type HomePanelProps = {
  /** Whose board this is. `"self"` (default) is the scholar's own task board;
   *  `"superuser"` reframes it as a completeness overview of another scholar —
   *  first-name copy and an editable Overview CTA (#844 — admins may now edit
   *  any bio). */
  mode?: "self" | "superuser";
  basePath: string;
  /** The target scholar's CWID — threaded to the ReCiter pending teaser so a
   *  superuser reads the target scholar's suggestions (self omits it / reads
   *  the signed-in identity). */
  cwid?: string;
  preferredName: string;
  /** The WCM directory headshot URL for this scholar (404s when none exists). */
  identityImageEndpoint: string;
  hasBio: boolean;
  isHidden: boolean;
  totalPublications: number;
  hiddenPublications: number;
  /** Org units this scholar may also curate (#753); empty for most scholars,
   *  in which case the section is omitted entirely. */
  manageableUnits?: ManageableUnit[];
  /** Whether the viewer is a superuser (#753). A superuser can edit every unit
   *  yet usually holds no `unit_admin` grant, so the section still shows them a
   *  way through to the `/edit/units` finder even when `manageableUnits` is empty. */
  isSuperuser?: boolean;
  /** Whether to mount the live ReCiter pending-articles teaser on the Publications
   *  row (`SELF_EDIT_RECITER_PENDING_HINT`). Only a genuine self viewer with the flag
   *  on passes `true`; when `true` a client loader lazily fetches
   *  `/api/edit/reciter-pending` and shows a compact teaser only if a high-confidence
   *  (≥70) hero suggestion comes back. Off (default) ⇒ ZERO fetch, nothing renders. */
  reciterPendingEnabled?: boolean;
  /** The ORCID row (`SELF_EDIT_ORCID_SUGGESTION`): `onFile` = the asserted iD
   *  (`scholar.orcid`, or the RPM-admin iD when the flag is on); `suggested` = the
   *  sole strong-inferred iD from `orcid_candidate` with its accepted-article count,
   *  null when the flag is off or nothing grades strong. */
  orcid?: OrcidRowState;
};

export type OrcidRowState = {
  onFile: string | null;
  /** Per-source evidence for the on-file iD — what the mirror knows about it —
   *  shown under it on the Identifiers & Profiles card so the "why" persists
   *  after confirming. Empty/absent when nothing in `orcid_candidate` carries it. */
  onFileEvidence?: OrcidEvidence[];
  /** The sole strong-inferred iD (if it differs from `onFile`), its RPM accepted
   *  count, and its per-source evidence. */
  suggested: { orcid: string; accepted: number; evidence?: OrcidEvidence[] } | null;
  /** Where the CTA goes: the Identifiers & Profiles tab (in-app) or, with the
   *  flag off, ReCiter Manage Profile (external, campus-only). */
  editHref?: string;
};

type HeadshotState = "loading" | "present" | "missing";

const NEEDS_YOU = ["Nothing needs you", "One item needs you", "Two items need you", "Three items need you", "Four items need you"];

export function HomePanel({
  mode = "self",
  basePath,
  cwid,
  preferredName,
  identityImageEndpoint,
  hasBio,
  isHidden,
  totalPublications,
  hiddenPublications,
  manageableUnits = [],
  isSuperuser = false,
  reciterPendingEnabled = false,
  orcid = { onFile: null, suggested: null },
}: HomePanelProps) {
  const headshot = useHeadshotProbe(identityImageEndpoint);
  const isAdmin = mode === "superuser";
  // Live ReCiter pending suggestions, fetched client-side (zero fetch when the
  // feature is off — the `enabled` gate). Unreviewed suggestions are an
  // outstanding action on Publications, so they flip that row to "to-do".
  const pendingSuggestions = useReciterPendingSuggestions(cwid, reciterPendingEnabled);
  const [showCompleted, setShowCompleted] = React.useState(false);

  // ponytail: "N items need you" IS the number of open rows below it — one
  // source of truth, so the heading can never claim more than the board shows.
  // (The old "N of 5 done" also counted a still-probing headshot and an empty
  // publications feed against the scholar; neither is theirs to act on here.)
  const rows = [
    overviewRow({ basePath, hasBio, isAdmin, name: preferredName }),
    orcidRow({ state: orcid, basePath, isAdmin, name: preferredName }),
    visibilityRow({ basePath, isHidden, isAdmin }),
    headshotRow({ state: headshot, isAdmin, name: preferredName }),
    publicationsRow({
      basePath,
      total: totalPublications,
      hidden: hiddenPublications,
      pending: pendingSuggestions,
    }),
  ];
  const open = rows.filter((row) => row.marker === "todo");
  const completed = rows.filter((row) => row.marker !== "todo");
  const needsYou = open.length;
  const completedLabel = `${completed.length} completed ${completed.length === 1 ? "item" : "items"}`;

  return (
    <section data-slot="home-panel" className="flex flex-col gap-5">
      <header>
        <h2 id={PANEL_HEADING_ID} className="text-[17px] font-[600] tracking-[-0.015em]">
          {NEEDS_YOU[needsYou]}
        </h2>
        <p className="text-muted-foreground mt-1.5 text-[13px]">
          {needsYou === 0
            ? "Everything on this profile is either complete or maintained from WCM records."
            : "Everything else on this profile is either complete or maintained from WCM records."}
        </p>
      </header>

      {open.length > 0 && (
        <ul className="flex flex-col gap-2">
          {open.map((row) => (
            <ChecklistRow key={row.testId} boxed {...row} />
          ))}
        </ul>
      )}

      {completed.length > 0 && (
        <div className="border-apollo-border border-t pt-3.5">
          <button
            type="button"
            aria-expanded={showCompleted}
            aria-controls={COMPLETED_LIST_ID}
            onClick={() => setShowCompleted((v) => !v)}
            data-testid="home-completed-toggle"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]"
          >
            {showCompleted ? `Hide ${completedLabel}` : completedLabel}
            <ChevronDown
              className={cn("size-4 transition-transform", showCompleted && "rotate-180")}
              aria-hidden
            />
          </button>
          <ul
            id={COMPLETED_LIST_ID}
            hidden={!showCompleted}
            className="divide-apollo-border mt-2 divide-y"
          >
            {completed.map((row) => (
              <ChecklistRow key={row.testId} {...row} />
            ))}
          </ul>
        </div>
      )}

      {(manageableUnits.length > 0 || isSuperuser) && (
        <ManageableUnitsSection units={manageableUnits} />
      )}
    </section>
  );
}

/**
 * "Units you manage" — shown to scholars who hold a unit-admin grant, and to
 * superusers regardless (#753). A compact list (capped) into each unit's
 * editor, with a link through to the full `/edit/units` index. A superuser with
 * no explicit grants still gets the link (they can edit any unit via the index
 * finder). Reuses the checklist row styling so it reads as another board
 * section, not a bolt-on.
 */
const UNITS_CARD_CAP = 6;

function ManageableUnitsSection({ units }: { units: ManageableUnit[] }) {
  const shown = units.slice(0, UNITS_CARD_CAP);
  const remaining = units.length - shown.length;
  const hasUnits = units.length > 0;
  return (
    <div className="flex flex-col gap-2" data-testid="home-units">
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Org units you manage
      </p>
      {hasUnits ? (
        <ul className="divide-apollo-border divide-y">
          {shown.map((unit) => (
            <ChecklistRow
              key={`${unit.kind}:${unit.code}`}
              testId={`home-unit-${unit.kind}-${unit.code}`}
              marker="info"
              title={unit.name}
              subtitle={unitKindLabel(unit.kind)}
              action={
                <RowButton href={unit.href} testId={`home-unit-edit-${unit.kind}-${unit.code}`}>
                  Edit
                </RowButton>
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="home-units-superuser-hint">
          As a superuser you can edit any department, division, or center.
        </p>
      )}
      <Link
        href="/edit/units"
        data-testid="home-units-manage"
        className="text-apollo-slate inline-flex items-center gap-1 self-start text-sm font-medium"
      >
        {hasUnits && remaining > 0 ? `View all ${units.length} units` : "Manage units"}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

/**
 * Probe the external directory headshot once on mount. Mirrors `HeadshotAvatar`'s
 * client-side load detection — the directory 404s (`returnGenericOn404=false`)
 * when a scholar has no photo, so a failed load means "missing".
 */
function useHeadshotProbe(src: string): HeadshotState {
  const [state, setState] = React.useState<HeadshotState>("loading");
  React.useEffect(() => {
    if (!src) {
      setState("missing");
      return;
    }
    let active = true;
    const img = new window.Image();
    img.onload = () => active && setState("present");
    img.onerror = () => active && setState("missing");
    img.src = src;
    return () => {
      active = false;
    };
  }, [src]);
  return state;
}

// ---------------------------------------------------------------------------
// Checklist rows
// ---------------------------------------------------------------------------

type Marker = "todo" | "done" | "info";

type Row = {
  marker: Marker;
  title: string;
  /** Rows fed from WCM systems carry the inline "WCM records" tag. */
  fromWcm?: boolean;
  subtitle: React.ReactNode;
  action: React.ReactNode;
  testId: string;
  /** Optional secondary content rendered beneath the subtitle (e.g. the ReCiter
   *  pending-suggestion teaser). */
  teaser?: React.ReactNode;
};

/** One row: boxed (surface-2, strong border) for an open item, flat for a settled one. */
function ChecklistRow({
  marker,
  title,
  fromWcm,
  subtitle,
  action,
  testId,
  teaser,
  boxed = false,
}: Row & { boxed?: boolean }) {
  return (
    <li
      data-testid={testId}
      className={cn(
        "flex items-center gap-3 px-4 py-3.5",
        boxed && "bg-apollo-surface-2 border-apollo-border-strong rounded-[9px] border",
      )}
    >
      <RowMarker marker={marker} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[14.5px] font-[600]">
          {title}
          {fromWcm && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-normal">
              <Lock className="size-3" aria-hidden />
              WCM records
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-[12.5px] leading-snug">{subtitle}</div>
        {teaser}
      </div>
      <div className="flex-none">{action}</div>
    </li>
  );
}

function RowMarker({ marker }: { marker: Marker }) {
  if (marker === "done") {
    return (
      <span
        aria-hidden
        className="flex size-[22px] flex-none items-center justify-center rounded-full border border-apollo-done text-apollo-done"
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (marker === "todo") {
    return (
      <span
        aria-hidden
        className="border-apollo-amber flex size-[22px] flex-none items-center justify-center rounded-full border-2"
      >
        <span className="bg-apollo-amber size-[7px] rounded-full" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate flex size-[22px] flex-none items-center justify-center rounded-full border"
    >
      <span className="bg-apollo-slate size-[7px] rounded-full" />
    </span>
  );
}

/** Row action button: an in-app Link, or (http href) an external hand-off in a new tab with ↗. */
function RowButton({
  href,
  testId,
  variant = "outline",
  children,
}: {
  href: string;
  testId?: string;
  variant?: "outline" | "apollo";
  children: React.ReactNode;
}) {
  return (
    <Button asChild variant={variant} size="sm">
      {href.startsWith("http") ? (
        <a href={href} target="_blank" rel="noreferrer" data-testid={testId}>
          {children}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      ) : (
        <Link href={href} data-testid={testId}>
          {children}
        </Link>
      )}
    </Button>
  );
}

function overviewRow({
  basePath,
  hasBio,
  isAdmin,
  name,
}: {
  basePath: string;
  hasBio: boolean;
  isAdmin: boolean;
  name: string;
}): Row {
  const href = `${basePath}?attr=overview`;
  if (hasBio) {
    return {
      testId: "home-item-overview",
      marker: "done",
      title: "Overview written",
      subtitle: isAdmin
        ? `Showing at the top of ${name}'s public profile.`
        : "Showing at the top of your public profile.",
      // #844 — a superuser can now edit any scholar's overview, so the CTA is
      // "Edit" for them too (no longer a read-only "View").
      action: (
        <RowButton href={href} testId="home-card-overview">
          Edit
        </RowButton>
      ),
    };
  }
  // #844 lets a superuser write it on the scholar's behalf, so the CTA writes it
  // like the self surface; only the voice changes.
  return {
    testId: "home-item-overview",
    marker: "todo",
    title: "No overview yet",
    subtitle: `Two or three sentences on ${isAdmin ? `${firstName(name)}'s` : "your"} research focus. Shown at the top of the public profile.`,
    action: (
      <RowButton href={href} testId="home-card-overview" variant="apollo">
        Write
      </RowButton>
    ),
  };
}

function visibilityRow({
  basePath,
  isHidden,
  isAdmin,
}: {
  basePath: string;
  isHidden: boolean;
  isAdmin: boolean;
}): Row {
  return {
    testId: "home-item-visibility",
    // Hidden is a settled choice, not a gap — an info row in the completed group.
    marker: isHidden ? "info" : "done",
    title: isHidden ? "Profile hidden" : "Visible in Scholars",
    subtitle: isHidden
      ? isAdmin
        ? "Hidden from public search and the public profile. Change it anytime."
        : "Hidden from public search — visible only to you. Change it anytime."
      : "Listed in public Scholars search.",
    action: (
      <RowButton href={`${basePath}?attr=visibility`} testId="home-card-visibility">
        Change
      </RowButton>
    ),
  };
}

/**
 * The ORCID iD row. On file → done, the iD linked to its orcid.org record. A strong
 * inference (`SELF_EDIT_ORCID_SUGGESTION`) → "Is this your ORCID iD?" with the iD
 * and the accepted-publication count behind it, "Review" linking into the
 * Identifiers & Profiles tab where "Yes, this is mine" writes it (`scholar.orcid`,
 * stamped confirmed). Otherwise → not on file with the one-line
 * reason and the same link.
 */
function orcidRow({
  state,
  basePath,
  isAdmin,
  name,
}: {
  state: OrcidRowState;
  basePath: string;
  isAdmin: boolean;
  name: string;
}): Row {
  const orcidLink = (id: string) => (
    <a
      href={`https://orcid.org/${id}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono font-[600] hover:underline"
    >
      {id}
    </a>
  );
  const base = { testId: "home-item-orcid", fromWcm: true } as const;
  if (state.onFile) {
    return {
      ...base,
      marker: "done",
      title: "ORCID iD on file",
      subtitle: orcidLink(state.onFile),
      action: null,
    };
  }
  // Into the Identifiers & Profiles tab, where the confirm / enter controls live;
  // with the flag off, the pre-tab hand-off to ReCiter Manage Profile (external,
  // campus-only) so the row never dead-ends.
  const href = state.editHref ?? `${basePath}?attr=identifiers-profiles`;
  const action = (
    <RowButton href={href} testId="home-card-orcid">
      {href.startsWith("http")
        ? `${state.suggested ? "Confirm" : "Add"} in ReCiter`
        : state.suggested
          ? "Review"
          : "Add"}
    </RowButton>
  );
  // Second person is the EDITOR: an administrator reads the scholar's first name.
  const whose = isAdmin ? `${firstName(name)}'s` : "your";
  // One short reason: the NIH requirement first, the matching payoff second.
  const why = `Needed for NIH SciENcv biosketches; also makes ${whose} publication matching more reliable.`;
  if (state.suggested) {
    const { orcid, accepted } = state.suggested;
    return {
      ...base,
      marker: "todo",
      title: isAdmin ? `Is this ${firstName(name)}'s ORCID iD?` : "Is this your ORCID iD?",
      subtitle: (
        <>
          {orcidLink(orcid)} ·{" "}
          {accepted > 0 ? (
            <>
              on {accepted} of {whose} accepted publications in{" "}
              <a
                href={PUBLICATION_MANAGER_URL}
                target="_blank"
                rel="noreferrer"
                className="text-apollo-slate underline underline-offset-2"
              >
                ReCiter
              </a>
            </>
          ) : (
            `matches ${whose} record in the ORCID registry`
          )}
        </>
      ),
      teaser: (
        <p
          className="text-muted-foreground mt-1 text-xs leading-snug"
          data-testid="home-item-orcid-why"
        >
          {why}
        </p>
      ),
      action,
    };
  }
  return { ...base, marker: "todo", title: "ORCID iD not on file", subtitle: why, action };
}

function headshotRow({
  state,
  isAdmin,
  name,
}: {
  state: HeadshotState;
  isAdmin: boolean;
  name: string;
}): Row {
  const base = { testId: "home-item-headshot", fromWcm: true } as const;
  const action = (
    <RowButton href={WEB_DIRECTORY_URL} testId="home-card-headshot">
      {state === "present" ? "Replace" : "Update in Web Directory"}
    </RowButton>
  );
  if (state === "present") {
    return {
      ...base,
      marker: "done",
      title: "Headshot added",
      subtitle: isAdmin
        ? `Showing on ${firstName(name)}'s public profile.`
        : "Showing on the public profile.",
      action,
    };
  }
  if (state === "loading") {
    return {
      ...base,
      marker: "info",
      title: "Headshot",
      subtitle: "Checking the Web Directory…",
      action,
    };
  }
  return {
    ...base,
    marker: "todo",
    title: "Add a headshot",
    subtitle: "Pulled from the Web Directory — add one there and it appears here right away.",
    action,
  };
}

function publicationsRow({
  basePath,
  total,
  hidden,
  pending,
}: {
  basePath: string;
  total: number;
  hidden: number;
  /** Live ReCiter pending suggestions (already fetched by HomePanel; `[]` when
   *  the feature is off or none are pending). */
  pending: ReciterSuggestion[];
}): Row {
  const hero = pending.length > 0 && pending[0].score >= 70 ? pending[0] : null;
  return {
    testId: "home-item-publications",
    fromWcm: true,
    // Unreviewed suggestions are an outstanding action ⇒ the "to-do" marker (amber
    // ring), even though publications are already shown. No pending ⇒ done when
    // pubs exist, else info (nothing shown yet).
    marker: pending.length > 0 ? "todo" : total > 0 ? "done" : "info",
    title: "Publications",
    subtitle:
      total === 0
        ? "None shown yet."
        : hidden > 0
          ? `${total} shown · ${hidden} hidden`
          : `${total} shown on this profile.`,
    teaser:
      pending.length > 0 ? (
        <PublicationsSuggestionTeaser hero={hero} count={pending.length} />
      ) : null,
    // Both self and superuser have a per-scholar Publications tab to deep-link
    // into (a superuser manages pubs on the scholar's behalf).
    action: (
      <RowButton href={`${basePath}?attr=publications`} testId="home-card-publications">
        Review
      </RowButton>
    ),
  };
}

/**
 * The compact "pending in ReCiter" teaser shown beneath the Publications row's
 * subtitle whenever suggestions are pending: a link into Publication Manager,
 * preceded by a green score chip + truncated title when a high-confidence (≥70)
 * `hero` exists. `hero` is null when the top suggestion scores 40–69 — the count
 * line still shows so the row's "to-do" marker always has an explanation.
 */
function PublicationsSuggestionTeaser({
  hero,
  count,
}: {
  hero: ReciterSuggestion | null;
  count: number;
}) {
  return (
    <div data-testid="home-reciter-pending-teaser" className="mt-1.5 flex flex-col gap-1">
      {hero ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[0.8rem]">
          <span className="bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green inline-flex flex-none items-center rounded-full border px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums">
            {hero.score}
          </span>
          <span className="text-foreground truncate font-medium">{hero.articleTitle}</span>
        </p>
      ) : null}
      <a
        href={PUBLICATION_MANAGER_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="home-reciter-pending-link"
        className="text-apollo-slate inline-flex items-center gap-1 self-start text-[0.8rem] font-medium"
      >
        {count === 1 ? "1 suggested article" : `${count} suggested articles`} — review in ReCiter
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}
