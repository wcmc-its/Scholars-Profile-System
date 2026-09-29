/**
 * CoreEditSections — the core facility's single-scroll editor (Edit Org Unit
 * mockup, Core variant, 2026-09-28). The same `UnitEditSections` shell and
 * sticky stats rail the department/division/center editors use (#2827, #2822),
 * with the core's own sections: Basics, Leadership, Staff, and (Owner /
 * Superuser / comms_steward) Access. A core has NO Members, Profile URL or
 * Retire.
 *
 * Kept separate from `unit-edit-page.tsx` on purpose: that router and its
 * `UnitEditContext` are typed department | division | center throughout, and
 * three shipped unit types depend on them. This component takes plain data
 * (the page does every read), so it never pulls `@/lib/db` into a render test.
 *
 * Above the sections sits the core owner's primary task, the review queue
 * banner (open candidates + the high-confidence split, same cut as the
 * `/edit/core` index).
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { CoreBasicsSection } from "@/components/edit/core-basics-section";
import { CoreLeaderCard, type CoreLeaderState } from "@/components/edit/core-leader-card";
import { UnitAccessCard, type UnitAccessCardProps } from "@/components/edit/unit-access-card";
import { SectionHeader } from "@/components/edit/unit-basics-section";
import { UnitEditSections, type UnitEditSection } from "@/components/edit/unit-edit-sections";
import type { UnitActorRole } from "@/lib/api/unit-edit-context";
import { cn } from "@/lib/utils";

/** Old one-panel `?attr=` bookmarks → the section that now holds them. */
const LEGACY_ATTR_SECTION: Record<string, string> = {
  details: "basics",
  leadership: "leadership",
  access: "access",
};

export type CoreEditSectionsProps = {
  core: {
    id: string;
    name: string;
    description: string | null;
    url: string | null;
    visible: boolean;
    /** Staff the facility dictionary lists; null = no staff feed yet (NOT 0). */
    staffCount: number | null;
    /** Of those, staff the co-author signal can match; same null rule. */
    staffTrackedCount: number | null;
  };
  leaders: ReadonlyArray<CoreLeaderState>;
  roleLabels: Record<string, string>;
  /** Null when the viewer can't manage access — the section is omitted. */
  access: UnitAccessCardProps["access"];
  actorCwid: string;
  actorRole: UnitActorRole;
  pending: { total: number; strong: number };
  /** `/cores/[id]`, only when the public page would actually render. */
  previewHref?: string;
  /** Whether "Cores" links back to `/edit/core` (the cores-tab predicate). */
  coresNavVisible: boolean;
  /** The legacy `?attr=` value, if any. */
  attr?: string;
};

export function CoreEditSections({
  core,
  leaders,
  roleLabels,
  access,
  actorCwid,
  actorRole,
  pending,
  previewHref,
  coresNavVisible,
  attr,
}: CoreEditSectionsProps) {
  const basePath = `/edit/core/${encodeURIComponent(core.id)}`;
  const description = core.description?.trim() ?? "";
  const staff = staffStatus(core.staffCount, core.staffTrackedCount);

  const sections: UnitEditSection[] = [
    {
      id: "basics",
      label: "Basics",
      stat: description ? undefined : "No description",
      warn: !description,
      content: (
        <CoreBasicsSection
          coreId={core.id}
          name={core.name}
          description={core.description}
          url={core.url}
          visible={core.visible}
          headingId="basics-heading"
        />
      ),
    },
    {
      id: "leadership",
      label: "Leadership",
      stat: leaders.length ? String(leaders.length) : "None",
      warn: leaders.length === 0,
      headingId: "core-leadership-heading",
      content: <CoreLeaderCard coreId={core.id} leaders={leaders} roleLabels={roleLabels} />,
    },
    {
      id: "staff",
      label: "Staff",
      stat: staff.stat,
      warn: staff.warn,
      content: <CoreStaffSummary {...staff} />,
    },
  ];
  if (access !== null) {
    sections.push({
      id: "access",
      label: "Access",
      stat: String(access.length),
      content: (
        <UnitAccessCard
          entityType="core"
          entityId={core.id}
          access={access}
          actorCwid={actorCwid}
          headingId="access-heading"
        />
      ),
    });
  }

  return (
    <UnitEditSections
      name={core.name}
      kindLabel="Core"
      titleBadge={
        core.visible ? undefined : (
          <span
            className="bg-apollo-slate-tint text-apollo-slate rounded-full px-2.5 py-0.5 text-xs"
            data-testid="core-hidden-pill"
          >
            Hidden from public pages
          </span>
        )
      }
      rootCrumb={{ label: "Cores", href: "/edit/core" }}
      orgUnitsNavVisible={coresNavVisible}
      actorRole={actorRole}
      previewHref={previewHref}
      sections={sections}
      initialSection={attr ? LEGACY_ATTR_SECTION[attr] : undefined}
      notice={<CoreReviewBanner href={`${basePath}/review`} {...pending} />}
    />
  );
}

/** The review-queue call to action. Amber dot = awaiting human judgment (R13). */
function CoreReviewBanner({
  href,
  total,
  strong,
}: {
  href: string;
  total: number;
  strong: number;
}) {
  return (
    <Link
      href={href}
      className="border-apollo-border-strong bg-apollo-surface-2 hover:border-apollo-slate flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[13px] border px-5 py-4 transition-colors hover:no-underline"
      data-testid="core-review-link"
    >
      <div className="flex min-w-[220px] flex-1 items-start gap-3">
        {total > 0 && (
          <span className="bg-apollo-amber mt-2 size-2.5 flex-none rounded-full" aria-hidden />
        )}
        <div className="flex flex-col gap-0.5">
          <span className="text-[15.5px] font-semibold">Review pending publications</span>
          <span className="text-muted-foreground text-[13px]">
            {total > 0
              ? "Publications that may acknowledge this core. Strong-confidence matches are the quickest to clear."
              : "No publications pending review."}
          </span>
        </div>
      </div>
      {total > 0 && (
        <div className="flex items-end gap-6">
          <BannerCount value={strong} label="strong confidence" slate testId="core-review-strong" />
          <BannerCount value={total} label="pending in total" testId="core-review-total" />
        </div>
      )}
      <ArrowRight className="text-apollo-slate size-4 flex-none" aria-hidden />
    </Link>
  );
}

function BannerCount({
  value,
  label,
  slate = false,
  testId,
}: {
  value: number;
  label: string;
  slate?: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={cn("text-2xl font-semibold tabular-nums", slate && "text-apollo-slate")}
        data-testid={testId}
      >
        {value.toLocaleString("en-US")}
      </span>
      <span className="text-muted-foreground text-[12.5px] whitespace-nowrap">{label}</span>
    </div>
  );
}

type StaffStatus = { stat: string; warn: boolean; summary: string; note: string | null };

/** The rail stat + summary for the staff counts, with the same states the
 *  `/edit/core` index's Staff cell uses (`staffCell`, core-facilities-index.tsx
 *  — a client module, so it can't be called from here). SPS stores counts
 *  only, never a roster (`Core.staffCount`). */
function staffStatus(listed: number | null, tracked: number | null): StaffStatus {
  if (listed === null) {
    return {
      stat: "Not listed",
      warn: true,
      summary: "Not listed",
      note: "No staff feed. The facility dictionary hasn’t published a staff list for this core yet.",
    };
  }
  const t = tracked ?? 0;
  if (listed === 0) {
    return {
      stat: "None listed",
      warn: true,
      summary: "None listed",
      note: "The facility dictionary lists no staff for this core.",
    };
  }
  if (t === 0) {
    return {
      stat: String(listed),
      warn: true,
      summary: `${listed} listed · 0 tracked`,
      note: "Co-author signal can’t fire: none of the listed staff can be matched to a person.",
    };
  }
  return {
    stat: String(listed),
    warn: false,
    summary: `${listed} listed · ${t} tracked`,
    note:
      t < listed
        ? `${listed - t} untracked. Add their CWIDs to the dictionary so the co-author signal can match them.`
        : null,
  };
}

function CoreStaffSummary({ summary, note, warn }: StaffStatus) {
  return (
    <div className="flex flex-col gap-3" data-testid="core-staff-summary">
      <SectionHeader
        id="staff-heading"
        title="Staff"
        description="People who run the core’s services. They’re used as likely co-authors when matching publications to this core. Not shown publicly."
      />
      <p
        className={cn("text-sm font-medium tabular-nums", warn && "text-apollo-amber")}
        data-testid="core-staff-counts"
      >
        {summary}
      </p>
      {note && (
        <p
          className={cn("text-[13px]", warn ? "text-apollo-amber" : "text-muted-foreground")}
          data-testid="core-staff-note"
        >
          {note}
        </p>
      )}
    </div>
  );
}
