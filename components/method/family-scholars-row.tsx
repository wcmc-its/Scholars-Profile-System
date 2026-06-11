"use client";

/**
 * Top scholars for the supercategory page's selected-family panel (the
 * `subtopic-scholars-row` analog, #172). Renders the family's ranked researchers
 * as the SAME avatar-chip row the page-level "Top scholars" row uses, each chip
 * wrapped in the context-aware `<PersonPopover>` so the hover-card matches the
 * Topics surface verbatim (UX feedback A4 + A5). Replaces the older inline
 * middot-name list, which was easy to miss next to the publication feed.
 *
 * Fetches `/api/methods/[supercategory]/families/[familyId]/scholars`. The data
 * shape (`SubtopicScholarRowData`, re-exported from `lib/api/methods.ts`) is a
 * superset of the chip's `TopScholarChipData`, so the chips render with no new
 * endpoint. The loader caps the roster (FT-faculty carve, ≤10); a "View all
 * scholars →" link to the family page's scholar browse is shown when the cap is
 * reached.
 */
import { useEffect, useState } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import { profilePath } from "@/lib/profile-url";
import { familySegmentFor } from "@/lib/method-url";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import type { SubtopicScholarRowData } from "@/lib/api/methods";

// The loader returns at most this many rows (FAMILY_SCHOLARS_TARGET); when the
// fetched roster hits the cap there are likely more behind the family page.
const ROSTER_CAP = 10;

export function FamilyScholarsRow({
  supercategorySlug,
  familyId,
  familyLabel,
}: {
  supercategorySlug: string;
  familyId: string;
  familyLabel: string | null;
}) {
  const [scholars, setScholars] = useState<SubtopicScholarRowData[] | null>(null);
  const [includesNonFaculty, setIncludesNonFaculty] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setScholars(null);
    fetch(
      `/api/methods/${encodeURIComponent(supercategorySlug)}/families/${encodeURIComponent(
        familyId,
      )}/scholars`,
    )
      .then((r) => (r.ok ? r.json() : { scholars: [] }))
      .then((data: { scholars: SubtopicScholarRowData[]; includesNonFaculty?: boolean }) => {
        if (!cancelled) {
          setScholars(data.scholars ?? []);
          setIncludesNonFaculty(Boolean(data.includesNonFaculty));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScholars([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [supercategorySlug, familyId]);

  if (loading || !scholars || scholars.length === 0) return null;

  const seeAllHref = familyLabel
    ? `/methods/${encodeURIComponent(supercategorySlug)}/${familySegmentFor(
        familyLabel,
        familyId,
      )}/scholars`
    : null;

  return (
    <div className="mb-8">
      <div className="mb-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {familyLabel ? `Top scholars in ${familyLabel}` : "Top scholars in this method"}
          <SectionInfoButton label="Top scholars in this method" anchor="topScholars">
            {includesNonFaculty ? (
              <>
                Researchers ranked by ReCiterAI on their first- or senior-author
                publications using this method, with full-time faculty listed first.
                Curators do not handpick this list; the order updates weekly as new
                work appears.
              </>
            ) : (
              <>
                Full-time faculty ranked by ReCiterAI on their first- or senior-author
                publications using this method. Curators do not handpick this list; the
                order updates weekly as new work appears.
              </>
            )}
          </SectionInfoButton>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 py-1">
        {scholars.map((s) => (
          <FamilyScholarChip key={s.cwid} scholar={s} />
        ))}
        {scholars.length >= ROSTER_CAP && seeAllHref && (
          <a
            href={seeAllHref}
            className="flex shrink-0 items-center rounded-full border border-border bg-background px-3 py-1 text-sm text-[var(--color-accent-slate)] transition-colors hover:border-[var(--color-accent-slate)]"
          >
            View all scholars →
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * One researcher chip — avatar + name + title, the same anchor markup the topic
 * Top-scholar chip uses, wrapped in the shared context-aware hover-card. Uses the
 * generic `top-scholar` surface with NO topic context (a methods surface), with
 * `contextMethods` so the card adds the scholar's "Prominent method families"
 * section (#853) alongside their totals + "View profile".
 */
function FamilyScholarChip({ scholar }: { scholar: SubtopicScholarRowData }) {
  return (
    <PersonPopover cwid={scholar.cwid} surface="top-scholar" contextMethods>
      <a
        href={profilePath(scholar.slug)}
        className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-1 transition-colors hover:border-[var(--color-accent-slate)]"
      >
        <HeadshotAvatar
          size="sm"
          cwid={scholar.cwid}
          preferredName={scholar.preferredName}
          identityImageEndpoint={scholar.identityImageEndpoint}
        />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">{scholar.preferredName}</span>
          {scholar.primaryTitle ? (
            <span className="text-sm text-muted-foreground">{scholar.primaryTitle}</span>
          ) : null}
        </div>
      </a>
    </PersonPopover>
  );
}
