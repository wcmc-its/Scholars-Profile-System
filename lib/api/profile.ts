/**
 * Profile-page data assembly. Reads scholar + relations + publications and
 * computes the ranking formulas from `lib/ranking.ts`.
 *
 * Pure-function handler (production-extractable per Q1' refinement). The
 * profile page server component imports this directly for ISR; the equivalent
 * external API endpoint would call the same function.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { sanitizeVIVOHtml } from "@/lib/utils";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { coreProjectNum } from "@/lib/award-number";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import {
  rankForSelectedHighlights,
  type ScoredPublication,
} from "@/lib/ranking";

/** Funding "Active" definition (issue #78, decision Q6).
 *  A grant is considered active through its end date plus a 12-month
 *  no-cost-extension grace window. NCE status isn't reliably present in
 *  InfoEd, so we use the most common NIH NCE window as a proxy. */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;
export function isFundingActive(endDate: Date, now: Date): boolean {
  return endDate.getTime() + NCE_GRACE_MS > now.getTime();
}

export type CoauthorChip = {
  cwid: string;
  slug: string;
  preferredName: string;
};

/** Issue #73 — back-end naming. UI maps these to "Topics" at the component
 *  boundary (heading, banner copy, help text). Source: MeSH keywords on the
 *  scholar's accepted publications, aggregated across `Publication.meshTerms`.
 *  `descriptorUi` is null for the rare label that didn't resolve to a
 *  `mesh.DescriptorUI` in reciterdb.
 */
export type ScholarKeyword = {
  descriptorUi: string | null;
  displayLabel: string;
  pubCount: number;
};

export type ProfileKeywords = {
  totalAcceptedPubs: number;
  keywords: ScholarKeyword[];
};

/** Publication types excluded from the Topics section's per-keyword counts.
 *  Issue #63 — same set is now also the read-path filter on the authorships
 *  query, so the keyword-count guard is belt-and-braces. */
const TOPIC_EXCLUDED_PUBLICATION_TYPES = new Set<string>(NEVER_DISPLAY_TYPES);

type RawMeshTerm = { ui?: string | null; label?: string | null };

/** @internal Exported for unit tests. */
export function normalizeMeshTerms(raw: unknown): Array<{ ui: string | null; label: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ ui: string | null; label: string }> = [];
  for (const term of raw as RawMeshTerm[]) {
    if (!term || typeof term !== "object") continue;
    const label = typeof term.label === "string" ? term.label : null;
    if (!label) continue;
    const ui = typeof term.ui === "string" && term.ui.length > 0 ? term.ui : null;
    out.push({ ui, label });
  }
  return out;
}

/** @internal Exported for unit tests. */
export function aggregateKeywords(
  publications: ReadonlyArray<{
    publicationType: string | null;
    publication: { meshTerms: unknown };
  }>,
): ProfileKeywords {
  type Bucket = { descriptorUi: string | null; displayLabel: string; pubCount: number };
  const byKey = new Map<string, Bucket>();
  let totalAcceptedPubs = 0;

  for (const p of publications) {
    if (p.publicationType && TOPIC_EXCLUDED_PUBLICATION_TYPES.has(p.publicationType)) continue;
    totalAcceptedPubs += 1;
    const raw = p.publication.meshTerms;
    if (!Array.isArray(raw)) continue;
    // Dedupe terms within a single pub so a malformed double-entry doesn't
    // double-count toward pubCount.
    const seenKeysOnThisPub = new Set<string>();
    for (const term of raw as RawMeshTerm[]) {
      if (!term || typeof term !== "object") continue;
      const ui = typeof term.ui === "string" && term.ui.length > 0 ? term.ui : null;
      const label = typeof term.label === "string" ? term.label : null;
      if (!label) continue;
      const key = ui ?? `__nolabel:${label}`;
      if (seenKeysOnThisPub.has(key)) continue;
      seenKeysOnThisPub.add(key);
      const bucket = byKey.get(key);
      if (bucket) {
        bucket.pubCount += 1;
      } else {
        byKey.set(key, { descriptorUi: ui, displayLabel: label, pubCount: 1 });
      }
    }
  }

  const keywords = Array.from(byKey.values()).sort((a, b) => {
    if (b.pubCount !== a.pubCount) return b.pubCount - a.pubCount;
    return a.displayLabel.localeCompare(b.displayLabel);
  });
  return { totalAcceptedPubs, keywords };
}

export type ProfilePublication = ScoredPublication<{
  pmid: string;
  title: string;
  /** Full PubMed-style author list including externals (from analysis_summary_article). */
  authorsString: string | null;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  /** Display-only — Variant B ranking does not consume citation count. */
  citationCount: number;
  /** ReCiterAI per-scholar publication score (D-08); 0 for pre-2020 papers (D-15). */
  reciteraiImpact: number;
  dateAddedToEntrez: Date | null;
  doi: string | null;
  pmcid: string | null;
  pubmedUrl: string | null;
  authorship: { isFirst: boolean; isLast: boolean; isPenultimate: boolean };
  isConfirmed: boolean;
  /** MeSH keywords on this publication, used by the profile Topics filter
   *  (#73). Same `{ui, label}` shape as `Publication.meshTerms`; empty when
   *  the row had no keywords in reciterdb. `ui` is null for the rare
   *  unresolved label. */
  meshTerms: Array<{ ui: string | null; label: string }>;
  /** Plain-text article abstract from `Publication.abstract` (#288 PR-A).
   *  Null when the publication has no abstract — common for older papers
   *  and non-research types. Rendered inline via `<AbstractDisclosure>`. */
  abstract: string | null;
  /** Active WCM scholars (incl. the profile owner) who are confirmed authors
   *  on this publication. Chip-row shape matching the topic/search surfaces. */
  wcmAuthors: Array<{
    name: string;
    cwid: string;
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
    position: number;
  }>;
}>;

export type ProfilePayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  /** Postnominal degree string from LDAP `weillCornellEduDegree`, e.g. "MD".
   *  Null when absent. Combine with preferredName via `publishedName` for
   *  display surfaces. */
  postnominal: string | null;
  /** preferredName with postnominal appended ("Curtis Cole, MD") when present.
   *  Single source of truth for any UI that renders a scholar's published
   *  name (profile H1, author chips, search results, etc.). */
  publishedName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  /** Issue #167 — division name when the scholar has a populated divCode
   *  AND the joined division name is not "Administration" (an admin-style
   *  level2 unit that should not be surfaced as a research/clinical
   *  division). Used by the sidebar to render "<Division> (<Department>)"
   *  when present, falling back to department-only when null. */
  division: string | null;
  email: string | null;
  identityImageEndpoint: string;
  /** Derived in ED ETL — true when LDAP carries a clinical or NYP-credentialed
   *  signal. Drives whether the "Clinical profile →" link renders in the
   *  Contact card (absence-as-default per design spec v1.7.1). */
  hasClinicalProfile: boolean;
  /** Issue #165 — canonical per-scholar weillcornell.org URL from the ED
   *  `labeledURI;pops` attribute (e.g. "https://weillcornell.org/matthewfink").
   *  When present, the sidebar links here directly; when null and
   *  `hasClinicalProfile` is true, falls back to a surname-search URL. */
  clinicalProfileUrl: string | null;
  /** Issue #171 — bare 19-char ORCID iD (e.g. "0000-0002-1825-0097"), or
   *  null when the scholar has no Identity record or the Identity record's
   *  orcid is null. Sourced by etl/identity. Used by lib/seo/jsonld to
   *  append an https://orcid.org/<id> URL to Person.sameAs. */
  orcid: string | null;
  overview: string | null;
  appointments: Array<{
    title: string;
    organization: string;
    startDate: string | null;
    endDate: string | null;
    isPrimary: boolean;
    isInterim: boolean;
    isActive: boolean;
  }>;
  educations: Array<{
    degree: string;
    institution: string;
    year: number | null;
    field: string | null;
  }>;
  grants: Array<{
    title: string;
    role: string;
    funder: string;
    startDate: string;
    endDate: string;
    isActive: boolean;
    /** Sponsor-issued award number (e.g. "R01 AG067497"); null when not provided. */
    awardNumber: string | null;
    /** Issue #78 — InfoEd `program_type` (Grant, Contract with funding,
     *  Fellowship, Career, Training, BioPharma Alliance Agreement, Equipment). */
    programType: string;
    /** Issue #78 F6 — original source of funds. Canonical short name when
     *  the raw sponsor maps to lib/sponsor-lookup; raw form populated on
     *  primeSponsorRaw. */
    primeSponsor: string | null;
    primeSponsorRaw: string | null;
    /** Issue #78 F6 — institution that issued the subaward to WCM. */
    directSponsor: string | null;
    directSponsorRaw: string | null;
    /** Issue #78 F2 — derived from award number (NIH only; null otherwise). */
    mechanism: string | null;
    nihIc: string | null;
    /** Issue #78 F6 — true when direct sponsor differs from prime. */
    isSubaward: boolean;
    /** Issue #85/#86 — RePORTER core_project_num parsed from awardNumber.
     *  Used by the UI to group renewal-year rows of the same core grant
     *  into a single displayed entry. Null for non-NIH grants. */
    coreProjectNum: string | null;
    /** Issue #85/#86 — RePORTER application ID (most recent FY's award).
     *  Drives outbound RePORTER deep links. Null for non-NIH or unmatched. */
    applId: number | null;
    /** Issue #85/#86 — RePORTER project abstract. Null for non-NIH or
     *  unmatched grants. */
    abstract: string | null;
    /** Issue #92 — origin of the abstract: 'reporter' | 'nsf' | 'pcori'
     *  | 'cdmrp' | 'gates'. Null when no abstract is populated. */
    abstractSource: string | null;
    /** Issue #85/#86 — pub-grant linkages for this grant from
     *  reciterdb.grant_provenance via the grant_publication bridge.
     *  Sorted by year desc → citation count desc. */
    publications: Array<{
      pmid: string;
      title: string;
      journal: string | null;
      year: number | null;
      citationCount: number;
      /** True when RePORTER confirmed this linkage. */
      sourceReporter: boolean;
      /** True when reciterdb (PubMed grant indexing) had this linkage. */
      sourceReciterdb: boolean;
      /** True when reciterdb-only AND reciterdbFirstSeen is older than 12
       *  months — the UI shows a "Lower confidence" badge in this case. */
      isLowerConfidence: boolean;
    }>;
  }>;
  keywords: ProfileKeywords;
  disclosures: Array<{
    entity: string | null;
    activityType: string | null;
    value: string | null;
    activityRelatesTo: string | null;
    activityGroup: string | null;
    description: string | null;
  }>;
  highlights: ProfilePublication[]; // top-3 first/senior, ranked by selected_highlights curve
  publications: ProfilePublication[]; // every confirmed authorship, year desc → dateAddedToEntrez desc
  /** Issue #5 — postdoctoral mentor, populated only for scholars whose
   *  roleCategory is 'postdoc' AND whose mentor resolves to an active
   *  scholar. Drives the sidebar "Postdoctoral Mentor" card. */
  postdoctoralMentor: {
    cwid: string;
    slug: string;
    publishedName: string;
    primaryTitle: string | null;
    identityImageEndpoint: string;
  } | null;
  /** Issue #90 — preferred NIH RePORTER PI profile_id, when the scholar
   *  has appeared on at least one NIH grant we could resolve. Drives the
   *  outbound "View NIH portfolio on RePORTER ↗" link in the Funding
   *  section header. Null when no mapping exists. */
  nihReporterProfileId: number | null;
};

/**
 * Apply spec line 43 appointment filtering:
 *   - Primary first (drives ordering — but DB also orders by isPrimary desc)
 *   - Active only by default for the public list (callers can show past via expander)
 *   - Interim excluded if any non-interim exists
 *
 * This function returns ALL appointments with `isActive` annotated; the UI
 * decides how to present them.
 */
function annotateAppointments<
  T extends { startDate: Date | null; endDate: Date | null; isInterim: boolean },
>(appts: T[], now: Date) {
  const annotated = appts.map((a) => ({
    ...a,
    isActive: a.endDate === null || a.endDate.getTime() > now.getTime(),
  }));
  // Spec line 46: interim excluded if any non-interim exists.
  const hasNonInterimActive = annotated.some((a) => a.isActive && !a.isInterim);
  if (hasNonInterimActive) {
    return annotated.filter((a) => !(a.isActive && a.isInterim));
  }
  return annotated;
}

/**
 * Collapse multiple SOR-flagged primary appointments down to a single visible
 * "Primary" designation. The WOOFA SOR can mark a scholar as primary in more
 * than one department (joint chairs, dual-affiliation chairs); rendering two
 * "Primary" badges is confusing for the reader.
 *
 * Tie-break order, applied only across rows where DB `isPrimary === true`:
 *   1. Title starts with "Chair" / "Chairman" / "Chairperson" / "Chairwoman".
 *   2. Title starts with "Director".
 *   3. Earliest startDate (longest-tenured).
 *
 * Rows that lose the tie-break get `isPrimary: false`. DB rows are NOT
 * modified — the underlying SOR truth is preserved on the Appointment table.
 */
function collapseToSingleVisiblePrimary<
  T extends { title: string; isPrimary: boolean; startDate: Date | null },
>(appts: T[]): T[] {
  const primaries = appts.filter((a) => a.isPrimary);
  if (primaries.length <= 1) return appts;
  const isChair = (t: string) => /^Chair(man|person|woman)?\b/i.test(t);
  const isDirector = (t: string) => /^Director\b/i.test(t);
  const ranked = primaries
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => {
      const xc = isChair(x.a.title);
      const yc = isChair(y.a.title);
      if (xc !== yc) return xc ? -1 : 1;
      const xd = isDirector(x.a.title);
      const yd = isDirector(y.a.title);
      if (xd !== yd) return xd ? -1 : 1;
      const xs = x.a.startDate?.getTime() ?? Infinity;
      const ys = y.a.startDate?.getTime() ?? Infinity;
      return xs - ys;
    });
  const winner = ranked[0].a;
  return appts.map((a) =>
    a.isPrimary && a !== winner ? { ...a, isPrimary: false } : a,
  );
}

/**
 * Issue #169 — guarantee the profile owner appears in `AuthorChipRow`'s
 * visible window. The component slices the list to the first
 * CHIP_CAP_VISIBLE entries; when upstream author-position data is sparse
 * (e.g. PMID 34741892, where 8 of 9 confirmed WCM authors carry
 * position=0), Prisma's `orderBy: { position: "asc" }` lands a real
 * position-N author at the end of the list and CHIP_CAP_VISIBLE drops
 * them.
 *
 * If the owner is already in the visible window we leave the order
 * untouched. Otherwise we move them into the last visible slot,
 * preserving their first/last role styling. This is a rendering guard,
 * not a fix for the upstream data issue — the underlying position rows
 * still need to be corrected during the ETL.
 */
const CHIP_CAP_VISIBLE = 5;
function ensureOwnerInChipWindow<T extends { cwid: string }>(
  authors: T[],
  ownerCwid: string,
): T[] {
  const idx = authors.findIndex((a) => a.cwid === ownerCwid);
  if (idx < 0 || idx < CHIP_CAP_VISIBLE) return authors;
  const owner = authors[idx];
  const next = authors.slice();
  next.splice(idx, 1);
  next.splice(CHIP_CAP_VISIBLE - 1, 0, owner);
  return next;
}

export async function getScholarFullProfileBySlug(
  slug: string,
  now: Date = new Date(),
): Promise<ProfilePayload | null> {
  const scholar = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    include: {
      appointments: {
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
      },
      educations: {
        orderBy: [{ year: "desc" }],
      },
      grants: {
        orderBy: [{ endDate: "desc" }, { startDate: "desc" }],
        include: {
          publications: {
            include: {
              publication: {
                select: {
                  pmid: true,
                  title: true,
                  journal: true,
                  year: true,
                  citationCount: true,
                },
              },
            },
          },
        },
      },
      coiActivities: {
        orderBy: [{ activityGroup: "asc" }, { entity: "asc" }],
      },
      // Issue #167 — surface the division name so the sidebar can render
      // "<Division> (<Department>)". Department display still comes from
      // the existing `primaryDepartment` text column.
      division: { select: { name: true } },
      // Issue #5 — surface the postdoctoral mentor on the sidebar. Hide
      // soft-deleted / suppressed mentors at the API layer so the card
      // never points at a hidden profile.
      postdoctoralMentor: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          postnominal: true,
          primaryTitle: true,
          deletedAt: true,
          status: true,
        },
      },
    },
  });
  if (!scholar) return null;

  // Authorships for this scholar — drives the publications list. Pull author rows
  // for every publication so coauthor chips can be rendered. Issue #63: drop
  // Retraction / Erratum rows at fetch time so the list, header counts, and
  // keyword aggregation all see the same filtered set.
  const authorships = await prisma.publicationAuthor.findMany({
    where: {
      cwid: scholar.cwid,
      isConfirmed: true,
      publication: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
    },
    include: {
      publication: {
        include: {
          authors: {
            orderBy: { position: "asc" },
            include: {
              scholar: {
                select: {
                  cwid: true,
                  slug: true,
                  preferredName: true,
                  deletedAt: true,
                  status: true,
                },
              },
            },
          },
          // ReCiterAI per-scholar publication score (D-08). Filtered to this
          // scholar's row only; PublicationScore is keyed by (cwid, pmid)
          // unique pair so this returns at most one row per publication.
          publicationScores: { where: { cwid: scholar.cwid } },
        },
      },
    },
  });

  const rankablePubs = authorships.map((a) => {
    // ReCiterAI publication score for this scholar+pmid pair (D-08). Source
    // chain after issue #316 PR-A: prefer the per-scholar PublicationScore
    // (currently empty in prototype — populated by a future per-(cwid, pmid)
    // projection), then fall back to the per-pmid global `Publication.impactScore`
    // landed by the IMPACT# DynamoDB ETL block. Pre-2020 papers and papers
    // ReCiterAI didn't score yield 0, which legitimately excludes them from
    // Selected highlights per D-15.
    //
    // The previous fallback ran a MAX-collapse over `publication_topic.impact_score`
    // because the global score had no home column; that workaround was retired in
    // PR-B of #316 once `Publication.impactScore` came online.
    const pubImpact =
      a.publication.impactScore !== null && a.publication.impactScore !== undefined
        ? Number(a.publication.impactScore)
        : 0;
    return {
    pmid: a.publication.pmid,
    title: a.publication.title,
    authorsString: a.publication.authorsString,
    journal: a.publication.journal,
    year: a.publication.year,
    publicationType: a.publication.publicationType,
    citationCount: a.publication.citationCount, // display-only — NOT used by Variant B ranking
    reciteraiImpact:
      a.publication.publicationScores[0]?.score ?? pubImpact,
    dateAddedToEntrez: a.publication.dateAddedToEntrez,
    doi: a.publication.doi,
    pmcid: a.publication.pmcid,
    pubmedUrl: a.publication.pubmedUrl,
    authorship: {
      isFirst: a.isFirst,
      isLast: a.isLast,
      isPenultimate: a.isPenultimate,
    },
    isConfirmed: a.isConfirmed,
    meshTerms: normalizeMeshTerms(a.publication.meshTerms),
    abstract: a.publication.abstract ?? null,
    // All confirmed WCM authors on this publication, including the profile
    // owner. Same chip-row shape as topic/search; the page renders chips and
    // omits the plain authorsString to avoid duplicating WCM author names.
    wcmAuthors: ensureOwnerInChipWindow(
      a.publication.authors
        .filter(
          (au) =>
            au.scholar &&
            !au.scholar.deletedAt &&
            au.scholar.status === "active",
        )
        .map((au) => ({
          name: au.scholar!.preferredName,
          cwid: au.scholar!.cwid,
          slug: au.scholar!.slug,
          identityImageEndpoint: identityImageEndpoint(au.scholar!.cwid),
          isFirst: au.isFirst,
          isLast: au.isLast,
          position: au.position,
        })),
      scholar.cwid,
    ),
    };
  });

  const highlights = rankForSelectedHighlights(rankablePubs, now).slice(0, 3);

  // Issue #73 — aggregate keywords from this scholar's accepted publications.
  // Operates over `authorships` (which includes `publication.meshTerms` via the
  // earlier include) so we don't re-query. Excludes Retraction/Erratum types
  // from per-keyword counts unconditionally, ahead of issue #63 fully landing
  // the same exclusion in the publications list.
  const keywords: ProfileKeywords = aggregateKeywords(
    authorships.map((a) => ({
      publicationType: a.publication.publicationType,
      publication: { meshTerms: a.publication.meshTerms },
    })),
  );

  // Full publications record: every confirmed authorship, no scholar-centric
  // filter. The year-grouped Publications list is the canonical "papers by
  // this person" record — middle-author and penultimate papers belong here
  // even though they don't surface as Selected highlights (D-13 first/senior
  // filter applies to the highlight surface only).
  //
  // Sort key is `dateAddedToEntrez` for ALL chronological ordering, not the
  // PubMed PubDate `year` — `year` is the journal-issue label (used for
  // bucketing) but `dateAddedToEntrez` is the canonical signal for "when this
  // paper became known" and is the more reliable per-paper sort across edge
  // cases (e-pub-ahead-of-print, missing year, retroactive indexing).
  const publications: ProfilePublication[] = rankablePubs
    .map((p) => ({ ...p, score: 0 } satisfies ProfilePublication))
    .sort((a, b) => {
      const ad = a.dateAddedToEntrez?.getTime() ?? 0;
      const bd = b.dateAddedToEntrez?.getTime() ?? 0;
      return bd - ad;
    });

  // Issue #162, #193 — three-tier active-appointments order. The Prisma
  // query orders by isPrimary/startDate within each source; a stable
  // secondary pass groups by source tier. Unknown sources sort to the end
  // (?? 99) — defensive when new sources are added without updating this
  // map. To add a tier, insert one entry; nothing else here needs to change.
  const APPOINTMENT_TIER_ORDER: Record<string, number> = {
    ED: 0, // WCM College faculty (LDAP ou=faculty)
    "JENZABAR-GSFACULTY": 1, // Weill Cornell Graduate School (#193)
    "ED-NYP": 2, // NYP affiliates (#162)
  };
  const tier = (s: string) => APPOINTMENT_TIER_ORDER[s] ?? 99;
  const sortedAppointments = [...scholar.appointments].sort(
    (a, b) => tier(a.source) - tier(b.source),
  );
  const annotatedAppointments = annotateAppointments(sortedAppointments, now);

  // Issue #90 — preferred NIH RePORTER profile_id for this scholar, used
  // to render the outbound "View NIH portfolio on RePORTER" link in the
  // Funding section header. Null when no mapping was found by the
  // etl:nih-profile resolver.
  const nihProfileRow = await prisma.personNihProfile.findFirst({
    where: { cwid: scholar.cwid, isPreferred: true },
    select: { nihProfileId: true },
  });

  return {
    cwid: scholar.cwid,
    slug: scholar.slug,
    preferredName: scholar.preferredName,
    postnominal: scholar.postnominal,
    publishedName: scholar.postnominal
      ? `${scholar.preferredName}, ${scholar.postnominal}`
      : scholar.preferredName,
    fullName: scholar.fullName,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    // Issue #167 — belt-and-suspenders filter for the "Administration"
    // division label. The ED ETL drops Administration at the divCode level
    // (EXCLUDED_DIV_NAMES), so this typically only matters when divCode
    // exists but the joined Division row's name is "Administration" (e.g.
    // a row that pre-dates the ETL filter).
    division:
      scholar.division && scholar.division.name !== "Administration"
        ? scholar.division.name
        : null,
    email: scholar.email,
    identityImageEndpoint: identityImageEndpoint(scholar.cwid),
    hasClinicalProfile: scholar.hasClinicalProfile,
    clinicalProfileUrl: scholar.clinicalProfileUrl,
    orcid: scholar.orcid,
    overview: scholar.overview ? sanitizeVIVOHtml(scholar.overview) : null,
    appointments: collapseToSingleVisiblePrimary(annotatedAppointments).map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isPrimary: a.isPrimary,
      isInterim: a.isInterim,
      isActive: a.isActive,
    })),
    educations: scholar.educations.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      year: e.year,
      field: e.field,
    })),
    // Issue #78 — runtime canonicalization fallback. When the stored
    // canonical short is null but the raw matches the current sponsor
    // lookup (e.g. due to alias / normalization additions made after the
    // last ETL run), promote it on the fly. Lets the profile section
    // reflect canonical-lookup updates without re-ingesting.
    grants: scholar.grants.map((g) => {
      const lowerConfidenceCutoff = new Date(now);
      lowerConfidenceCutoff.setMonth(lowerConfidenceCutoff.getMonth() - 12);
      const pubs = g.publications
        .map((gp) => ({
          pmid: gp.publication.pmid,
          title: gp.publication.title,
          journal: gp.publication.journal,
          year: gp.publication.year,
          citationCount: gp.publication.citationCount,
          sourceReporter: gp.sourceReporter,
          sourceReciterdb: gp.sourceReciterdb,
          // "Lower confidence" trigger per #85/#86: reciterdb has had this
          // linkage for 12+ months but RePORTER still hasn't confirmed it.
          isLowerConfidence:
            gp.sourceReciterdb &&
            !gp.sourceReporter &&
            gp.reciterdbFirstSeen !== null &&
            gp.reciterdbFirstSeen < lowerConfidenceCutoff,
        }))
        .sort((a, b) => {
          // Year desc, then citation count desc, then pmid asc for stability.
          if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
          if (b.citationCount !== a.citationCount) return b.citationCount - a.citationCount;
          return a.pmid.localeCompare(b.pmid);
        });
      return {
        title: g.title,
        role: g.role,
        funder: g.funder,
        startDate: g.startDate.toISOString().slice(0, 10),
        endDate: g.endDate.toISOString().slice(0, 10),
        isActive: isFundingActive(g.endDate, now),
        awardNumber: g.awardNumber ?? null,
        programType: g.programType,
        primeSponsor: g.primeSponsor ?? canonicalizeSponsor(g.primeSponsorRaw),
        primeSponsorRaw: g.primeSponsorRaw ?? null,
        directSponsor: g.directSponsor ?? canonicalizeSponsor(g.directSponsorRaw),
        directSponsorRaw: g.directSponsorRaw ?? null,
        mechanism: g.mechanism ?? null,
        nihIc: g.nihIc ?? null,
        isSubaward: g.isSubaward,
        coreProjectNum: coreProjectNum(g.awardNumber),
        applId: g.applId ?? null,
        abstract: g.abstract ?? null,
        abstractSource: g.abstractSource ?? null,
        publications: pubs,
      };
    }),
    keywords,
    disclosures: scholar.coiActivities.map((c) => ({
      entity: c.entity,
      activityType: c.activityType,
      value: c.value,
      activityRelatesTo: c.activityRelatesTo,
      activityGroup: c.activityGroup,
      description: c.description,
    })),
    highlights,
    publications,
    postdoctoralMentor:
      scholar.postdoctoralMentor &&
      scholar.postdoctoralMentor.deletedAt === null &&
      scholar.postdoctoralMentor.status === "active"
        ? {
            cwid: scholar.postdoctoralMentor.cwid,
            slug: scholar.postdoctoralMentor.slug,
            publishedName: scholar.postdoctoralMentor.postnominal
              ? `${scholar.postdoctoralMentor.preferredName}, ${scholar.postdoctoralMentor.postnominal}`
              : scholar.postdoctoralMentor.preferredName,
            primaryTitle: scholar.postdoctoralMentor.primaryTitle ?? null,
            identityImageEndpoint: identityImageEndpoint(
              scholar.postdoctoralMentor.cwid,
            ),
          }
        : null,
    nihReporterProfileId: nihProfileRow?.nihProfileId ?? null,
  };
}

/**
 * Slugs of all active, non-deleted, non-suppressed scholars — used by Next.js
 * `generateStaticParams` to enumerate the profile pages for ISR.
 */
export async function getActiveScholarSlugs(): Promise<string[]> {
  const rows = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { slug: true },
  });
  return rows.map((r) => r.slug);
}

/**
 * Slim projection for OG image route (Phase 5 / SEO-03).
 * Returns null for deleted or inactive scholars (404 from OG route).
 * Used by app/og/scholars/[slug]/route.tsx — keep query minimal because
 * route runs per social-share request.
 */
export async function getScholarOgData(slug: string): Promise<{
  preferredName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  slug: string;
} | null> {
  const row = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: {
      slug: true,
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
    },
  });
  return row ?? null;
}

/**
 * Spec line 134-136 sparse-profile threshold:
 *   no overview AND fewer than 3 publications AND no active grants
 * Returns true when the "This profile is being populated" affordance should display.
 */
export function isSparseProfile(p: ProfilePayload): boolean {
  const noOverview = !p.overview || p.overview.trim().length === 0;
  const fewPubs = p.publications.length < 3;
  const noActiveGrants = !p.grants.some((g) => g.isActive);
  return noOverview && fewPubs && noActiveGrants;
}
