/**
 * UnitEditSections — the single-scroll unit editor (Edit Center mockup,
 * 2026-09-25). Replaces the one-attribute-at-a-time `?attr=` rail for a center:
 * every section — Basics, Leadership, Members, Programs, Access, Retire — is a
 * card on ONE page, indexed by a sticky in-page nav (`UnitSectionNav`) whose
 * rows carry a count or an amber "needs filling in" stat.
 *
 * The page owns its own header rather than borrowing `EditShell`'s (which the
 * scholar editor shares): an `<h1>` naming the unit with a kind chip, a one-line
 * "Editing as administrator (Owner)…" note in place of the tinted banner, and
 * the "View reports" / "Preview profile" actions on the right. The breadcrumb
 * reads "Org units / Centers" — the unit's name moved into the `<h1>`.
 *
 * What stays the same: every section is the SAME card with the same endpoint,
 * authz and visibility gate as before (`unit-edit-page.tsx` builds the section
 * list from the same predicates the rail used). The rich Members table still
 * gets the whole width on its own `?attr=roster` page — the Members section
 * here summarises it and links there.
 *
 * Retired read-through (edge 11): a retired unit shows only the notice + the
 * Retire section (where a Superuser restores it).
 */
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronLeftIcon } from "lucide-react";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { UnitSectionNav, type UnitSectionNavItem } from "@/components/edit/unit-section-nav";
import { Button } from "@/components/ui/button";
import type { UnitActorRole } from "@/lib/api/unit-edit-context";

export type UnitEditSection = UnitSectionNavItem & {
  /** Section body — a card with its own `<h2 id={`${id}-heading`}>`. */
  content: React.ReactNode;
  /** The retire strip gets the red-tint edge. */
  tone?: "danger";
  /** Overrides the `${id}-heading` the section is labelled by (a card that
   *  can't take a heading id of its own). */
  headingId?: string;
};

const ROLE_LABEL: Record<UnitActorRole, string> = {
  superuser: "Superuser",
  owner: "Owner",
  curator: "Curator",
};

export function UnitEditSections({
  name,
  kindLabel,
  crumbLabel,
  orgUnitsNavVisible,
  actorRole,
  previewHref,
  reportsHref,
  sections,
  initialSection,
  notice,
}: {
  name: string;
  /** The chip beside the `<h1>` ("Center"). */
  kindLabel: string;
  /** The breadcrumb's second segment ("Centers"). */
  crumbLabel: string;
  /** Whether "Org units" links back to `/edit/units` (the units-tab predicate). */
  orgUnitsNavVisible: boolean;
  actorRole: UnitActorRole;
  previewHref?: string;
  reportsHref?: string;
  sections: ReadonlyArray<UnitEditSection>;
  /** A legacy `?attr=` deep link, mapped to its section id. */
  initialSection?: string;
  /** Rendered above the sections (the retired notice). */
  notice?: React.ReactNode;
}) {
  return (
    <div className="bg-apollo-page min-h-screen" data-slot="unit-edit-sections">
      <a
        href="#edit-detail"
        className="bg-apollo-maroon text-apollo-maroon-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to editor
      </a>
      <ConsoleTopBar variant="console" showAccountMenu />

      <div className="mx-auto flex max-w-[var(--max-content)] flex-col gap-5 px-4 pt-5 pb-28 sm:px-6">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
          {orgUnitsNavVisible ? (
            <Link
              href="/edit/units"
              className="text-apollo-slate inline-flex items-center gap-1 hover:underline"
              data-testid="edit-subnav-units"
            >
              <ChevronLeftIcon className="size-3.5" aria-hidden />
              Org units
            </Link>
          ) : (
            <span className="text-muted-foreground">Org units</span>
          )}
          <span className="text-muted-foreground" aria-hidden>
            /
          </span>
          <span className="text-muted-foreground" data-testid="unit-edit-crumb">
            {crumbLabel}
          </span>
        </nav>

        <header className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1
                className="text-[24px] leading-tight font-[600] tracking-[-0.01em] sm:text-[28px]"
                data-testid="unit-edit-title"
              >
                {name}
              </h1>
              <span
                className="bg-apollo-surface-2 border-apollo-border-strong rounded-full border px-2.5 py-0.5 text-xs"
                data-testid="unit-edit-kind"
              >
                {kindLabel}
              </span>
            </div>
            <p className="text-muted-foreground text-[13px]" data-testid="unit-edit-actor-note">
              Editing as administrator ({ROLE_LABEL[actorRole]}). Changes are logged against your
              account.
            </p>
          </div>
          {(reportsHref || previewHref) && (
            <div className="flex shrink-0 items-center gap-2">
              {reportsHref && (
                <Button asChild variant="ghost" size="sm" className="text-apollo-slate">
                  <Link href={reportsHref} data-testid="edit-reports-link">
                    View reports
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              )}
              {previewHref && (
                <Button asChild variant="outline" size="sm">
                  <Link href={previewHref} target="_blank" rel="noreferrer" data-testid="edit-preview-link">
                    Preview profile
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              )}
            </div>
          )}
        </header>

        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[210px_minmax(0,1fr)] md:gap-6">
          <div className="min-w-0 md:sticky md:top-[76px]">
            <UnitSectionNav
              items={sections.map(({ id, label, stat, warn }) => ({ id, label, stat, warn }))}
              initialSection={initialSection}
            />
          </div>

          <main id="edit-detail" tabIndex={-1} className="flex min-w-0 flex-col gap-[18px]">
            {notice}
            {sections.map((s) => (
              <section
                key={s.id}
                id={s.id}
                aria-labelledby={s.headingId ?? `${s.id}-heading`}
                className="apollo-card scroll-mt-[76px]"
                style={s.tone === "danger" ? { borderColor: "var(--apollo-red-tint-border)" } : undefined}
                data-testid={`unit-section-${s.id}`}
              >
                {s.content}
              </section>
            ))}
          </main>
        </div>
      </div>
    </div>
  );
}
