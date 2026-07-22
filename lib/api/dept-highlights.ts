/**
 * Department card shapes shared by the Recent publications and Active grants
 * list surfaces on /departments/[slug] (and the center/division equivalents).
 *
 * The highlight loaders (getDeptHighlights / getDeptRecentPublications /
 * getDeptActiveGrants) were removed in the #1440 dead-code sweep — the
 * paginated list surfaces in `lib/api/dept-lists.ts` own all data assembly now.
 * Only the card TYPE contracts remain here, imported type-only by those
 * surfaces and by the shared card components (publication-card / grant-card).
 */
import type { AuthorChip } from "@/components/publication/author-chip-row";

export type DeptPublicationCard = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  citationCount: number;
  doi: string | null;
  pubmedUrl: string | null;
  authors: AuthorChip[];
};

export type DeptGrantCard = {
  externalId: string | null;
  awardNumber: string | null;
  funder: string | null;
  title: string;
  startDate: Date | null;
  endDate: Date | null;
  isRecentlyCompleted: boolean;
  pis: AuthorChip[];
  /** True when ≥2 PIs across the same externalId (multi-PI grant). */
  isMultiPi: boolean;
  /** NIH RePORTER applId from ETL, when present. Optional: only the Grants-tab
   *  loader (dept-lists.ts) fills it, to link the title to RePORTER like the
   *  profile does; other card producers omit it. Usually null for InfoEd rows,
   *  so the client resolver in DeptGrantsList backfills it (see grant-card). */
  applId?: number | null;
};
