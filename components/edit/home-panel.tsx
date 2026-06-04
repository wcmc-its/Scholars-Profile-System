/**
 * The self-edit landing board (vision-round T3.4 / Direction B headline),
 * reframed as a "Complete your profile" checklist. The editor used to open on a
 * nine-item data dictionary; this opens on the actual job — the few things that
 * make a profile feel finished — with live status read from the loaded context.
 *
 * Completeness is a real count over four essentials, never a percentage: the
 * scholar's overview and headshot are the two they act on; publications and
 * visibility are configured-for-them states shown as reassurance. Each item is
 * a checklist row — amber "to-do" when it needs the scholar, green check when
 * done — so a gap reads as a gap, not as just another settled status.
 *
 * Two of the four are owned by the scholar (overview here; visibility here) and
 * sit under "Yours to edit" — matching the rail's owned/sourced split. The other
 * two come "From WCM systems": the headshot is a live pointer to the WCM Web
 * Directory (a scholar fixes it there and it shows here right away — no sync
 * lag), and publications flow from PubMed/ReCiter.
 *
 * Client component: the headshot's presence is only knowable by probing the
 * external directory image (the same approach as `HeadshotAvatar`), and the
 * count/avatar/headshot-row all depend on it.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Plus } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { WEB_DIRECTORY_URL } from "@/lib/edit/request-a-change";
import { unitKindLabel, type ManageableUnit } from "@/lib/edit/manageable-units";
import { cn, initials } from "@/lib/utils";

// Must match EditShell's `<main aria-labelledby="panel-heading">` and
// EditPanel's EDIT_PANEL_HEADING_ID — this panel forgoes EditPanel for the
// avatar + progress header, so it owns the labelled heading itself.
const PANEL_HEADING_ID = "panel-heading";

export type HomePanelProps = {
  basePath: string;
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
};

type HeadshotState = "loading" | "present" | "missing";

export function HomePanel({
  basePath,
  preferredName,
  identityImageEndpoint,
  hasBio,
  isHidden,
  totalPublications,
  hiddenPublications,
  manageableUnits = [],
  isSuperuser = false,
}: HomePanelProps) {
  const headshot = useHeadshotProbe(identityImageEndpoint);

  // A real count over four essentials — not a percentage. An item counts only
  // when it is genuinely satisfied; while the headshot is still probing it does
  // not count (so the number only ever ticks up, never down).
  const total = 4;
  const done =
    (hasBio ? 1 : 0) +
    (headshot === "present" ? 1 : 0) +
    (totalPublications > 0 ? 1 : 0) +
    1; // visibility — a choice is always set

  return (
    <section data-slot="home-panel" className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <ProfileAvatar state={headshot} preferredName={preferredName} src={identityImageEndpoint} />
        <div className="min-w-0 flex-1">
          <h2 id={PANEL_HEADING_ID} className="text-lg font-semibold">
            Complete your profile
          </h2>
          <ProgressMeter done={done} total={total} />
        </div>
      </header>

      <ChecklistGroup label="Yours to edit">
        <OverviewItem basePath={basePath} hasBio={hasBio} />
        <VisibilityItem basePath={basePath} isHidden={isHidden} />
      </ChecklistGroup>

      <ChecklistGroup label="From WCM systems">
        <HeadshotItem state={headshot} />
        <PublicationsItem basePath={basePath} total={totalPublications} hidden={hiddenPublications} />
      </ChecklistGroup>

      {(manageableUnits.length > 0 || isSuperuser) && (
        <ManageableUnitsSection units={manageableUnits} isSuperuser={isSuperuser} />
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

function ManageableUnitsSection({
  units,
  isSuperuser,
}: {
  units: ManageableUnit[];
  isSuperuser: boolean;
}) {
  const shown = units.slice(0, UNITS_CARD_CAP);
  const remaining = units.length - shown.length;
  const hasUnits = units.length > 0;
  return (
    <div className="flex flex-col gap-2" data-testid="home-units">
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Units you manage
      </p>
      {hasUnits ? (
        <ul className="flex flex-col gap-2">
          {shown.map((unit) => (
            <ChecklistRow
              key={`${unit.kind}:${unit.code}`}
              testId={`home-unit-${unit.kind}-${unit.code}`}
              marker="info"
              title={unit.name}
              subtitle={unitKindLabel(unit.kind)}
              action={
                <RowLink href={unit.href} testId={`home-unit-edit-${unit.kind}-${unit.code}`}>
                  Edit
                </RowLink>
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
// Header
// ---------------------------------------------------------------------------

function ProfileAvatar({
  state,
  preferredName,
  src,
}: {
  state: HeadshotState;
  preferredName: string;
  src: string;
}) {
  return (
    <div className="relative size-14 flex-none">
      <Avatar className={cn("size-14", state === "present" && "border-apollo-green-tint-border border-2")}>
        {state === "present" && <AvatarImage src={src} alt="" className="object-cover object-top" />}
        <AvatarFallback
          className={cn(
            "bg-apollo-slate-tint text-apollo-slate text-lg font-semibold",
            state === "missing"
              ? "border-apollo-border-strong border-2 border-dashed"
              : "border-apollo-slate-tint-border border",
          )}
        >
          {initials(preferredName)}
        </AvatarFallback>
      </Avatar>
      {state === "missing" && (
        <AvatarBadge className="bg-apollo-amber">
          <Plus className="size-3" strokeWidth={2.6} aria-hidden />
        </AvatarBadge>
      )}
      {state === "present" && (
        <AvatarBadge className="bg-apollo-green">
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </AvatarBadge>
      )}
    </div>
  );
}

function AvatarBadge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "border-apollo-surface absolute -right-0.5 -bottom-0.5 flex size-[22px] items-center justify-center rounded-full border-2 text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A done/total bar (honest fraction, decorative) + the count in words. */
function ProgressMeter({ done, total }: { done: number; total: number }) {
  const complete = done >= total;
  const width = `${Math.round((done / total) * 100)}%`;
  return (
    <div className="mt-1.5">
      <div className="bg-apollo-border h-[7px] overflow-hidden rounded-full" aria-hidden>
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            complete ? "bg-apollo-green" : "bg-apollo-amber",
          )}
          style={{ width }}
        />
      </div>
      <p className="text-muted-foreground mt-1.5 text-sm">
        {done} of {total} done
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklist rows
// ---------------------------------------------------------------------------

function ChecklistGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{label}</p>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}

type Marker = "todo" | "done" | "info";

function ChecklistRow({
  marker,
  title,
  subtitle,
  action,
  testId,
}: {
  marker: Marker;
  title: string;
  subtitle: string;
  action: React.ReactNode;
  testId: string;
}) {
  return (
    <li
      data-testid={testId}
      className="border-apollo-border bg-apollo-surface flex items-center gap-3 rounded-xl border px-4 py-3.5"
    >
      <RowMarker marker={marker} />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="text-muted-foreground text-sm leading-snug">{subtitle}</div>
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
        className="bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green flex size-[22px] flex-none items-center justify-center rounded-full border"
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

/** Quiet slate text link used for the "done" / informational row actions. */
function RowLink({
  href,
  testId,
  children,
}: {
  href: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="text-apollo-slate text-sm font-medium whitespace-nowrap"
    >
      {children}
    </Link>
  );
}

function OverviewItem({ basePath, hasBio }: { basePath: string; hasBio: boolean }) {
  const href = `${basePath}?attr=overview`;
  if (hasBio) {
    return (
      <ChecklistRow
        testId="home-item-overview"
        marker="done"
        title="Overview written"
        subtitle="Showing at the top of your public profile."
        action={
          <RowLink href={href} testId="home-card-overview">
            Edit
          </RowLink>
        }
      />
    );
  }
  return (
    <ChecklistRow
      testId="home-item-overview"
      marker="todo"
      title="Write your overview"
      subtitle="The one section only you can write · about 2 min"
      action={
        <Button asChild variant="apollo" size="sm">
          <Link href={href} data-testid="home-card-overview">
            Write
          </Link>
        </Button>
      }
    />
  );
}

function VisibilityItem({ basePath, isHidden }: { basePath: string; isHidden: boolean }) {
  return (
    <ChecklistRow
      testId="home-item-visibility"
      marker={isHidden ? "info" : "done"}
      title={isHidden ? "Profile hidden" : "Visible in Scholars"}
      subtitle={
        isHidden
          ? "Hidden from public search — visible only to you. Change it anytime."
          : "Listed in public Scholars search."
      }
      action={
        <RowLink href={`${basePath}?attr=visibility`} testId="home-card-visibility">
          Change
        </RowLink>
      }
    />
  );
}

function HeadshotItem({ state }: { state: HeadshotState }) {
  const action = (
    <a
      href={WEB_DIRECTORY_URL}
      target="_blank"
      rel="noreferrer"
      data-testid="home-card-headshot"
      className="text-apollo-slate inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap"
    >
      {state === "present" ? "Replace" : "Update in Web Directory"}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </a>
  );
  if (state === "present") {
    return (
      <ChecklistRow
        testId="home-item-headshot"
        marker="done"
        title="Headshot added"
        subtitle="Showing on your public profile."
        action={action}
      />
    );
  }
  if (state === "loading") {
    return (
      <ChecklistRow
        testId="home-item-headshot"
        marker="info"
        title="Headshot"
        subtitle="Checking the Web Directory…"
        action={action}
      />
    );
  }
  return (
    <ChecklistRow
      testId="home-item-headshot"
      marker="todo"
      title="Add a headshot"
      subtitle="Pulled from the Web Directory — add one there and it appears here right away."
      action={action}
    />
  );
}

function PublicationsItem({
  basePath,
  total,
  hidden,
}: {
  basePath: string;
  total: number;
  hidden: number;
}) {
  const subtitle =
    total === 0
      ? "None shown yet."
      : hidden > 0
        ? `${total} shown · ${hidden} hidden`
        : `${total} shown on your profile`;
  return (
    <ChecklistRow
      testId="home-item-publications"
      marker={total > 0 ? "done" : "info"}
      title="Publications"
      subtitle={subtitle}
      action={
        <RowLink href={`${basePath}?attr=publications`} testId="home-card-publications">
          Review
        </RowLink>
      }
    />
  );
}
