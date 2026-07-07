/**
 * Profile-page data assembly. Reads scholar + relations + publications and
 * computes the ranking formulas from `lib/ranking.ts`.
 *
 * Pure-function handler (production-extractable per Q1' refinement). The
 * profile page server component imports this directly for ISR; the equivalent
 * external API endpoint would call the same function.
 */
import { cache } from "react";
import { prisma } from "@/lib/db";
import { buildPersonJsonLd } from "@/lib/seo/jsonld";
import {
  getEffectiveOverview,
  getSelectedHighlightPmids,
  isAuthorHidden,
  loadEntitySuppressions,
  loadPublicationSuppressions,
  pickManualHighlights,
} from "@/lib/api/manual-layer";
import { isManualHighlightsEnabled } from "@/lib/edit/manual-highlights";
import { isEmailReleaseGateEnabled } from "@/lib/profile/email-visibility-flags";
import { gateEmailForViewer } from "@/lib/profile/email-display-gate";
import { MAX_SELECTED_HIGHLIGHTS } from "@/lib/edit/validators";
import { identityImageEndpoint } from "@/lib/headshot";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { coreProjectNum } from "@/lib/award-number";
import { isFundingActive } from "@/lib/funding-active";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import {
  isMethodsLensEnabled,
  isMethodsLensSensitiveGateOn,
  isMethodsFamilyDefinitionsOn,
  isMethodsLensToolContextOn,
} from "@/lib/profile/methods-lens-flags";
import { familyOverlayKey } from "@/lib/api/methods-overlay";
import {
  getScholarCenterAffiliations,
  type ScholarCenterAffiliation,
} from "@/lib/api/centers";
import { isProfileCenterAffiliationEnabled } from "@/lib/profile/center-affiliation-flag";
import {
  rankForSelectedHighlights,
  scorePublication,
  type ScoredPublication,
} from "@/lib/ranking";

// `isFundingActive` (issue #78, decision Q6) moved to the Prisma-free
// `@/lib/funding-active` so the profile, the funding search index, and the
// self-edit Funding panel share one definition. Re-exported here for the
// existing callers that import it from this module.
export { isFundingActive };

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

/** One row of the family-primary Methods lens (#799). Sourced from the
 *  `scholar_family` rollup; `exemplarTools` are resolved member-tool display
 *  names. `pubCount` is the per-scholar, C-tier-reconciled publication count. */
export type ScholarFamilyView = {
  familyId: string;
  familyLabel: string;
  supercategory: string;
  pubCount: number;
  exemplarTools: string[];
  /** #1119 — best per-exemplar-tool usage snippet, keyed by the SAME display name
   *  as `exemplarTools`. `{}` until the tools-a2-v3 rollup populates the column AND
   *  the METHODS_LENS_TOOL_CONTEXT flag is on (kept out of the cached payload until
   *  then, like `definition`). Plain extracted publication text; render as text. */
  exemplarContexts: Record<string, string>;
  /** #1158 — parallel per-exemplar-tool source PMID (digit string), keyed by the
   *  SAME display name as `exemplarContexts`. Lets the Methods provenance rail link
   *  a usage snippet to the publication it was extracted from. `{}` until the
   *  rollup populates the `exemplar_context_pmids` column AND the
   *  METHODS_LENS_TOOL_CONTEXT flag is on (kept out of the cached payload until
   *  then, exactly like `exemplarContexts`). A missing key = "no source link".
   *  Optional on the type for back-compat: a pre-#1158 client payload (and the
   *  reveal route, if it predates this) may omit it — `toScholarFamilyView` ALWAYS
   *  emits a concrete map (`{}` or the coerced pmids), so it is never `undefined`
   *  at runtime from this loader; consumers should still defend with `?? {}`. */
  exemplarContextPmids?: Record<string, string>;
  /** #819 — distinct member PMIDs (digit strings) backing the click-to-filter.
   *  `len === pubCount` upstream (ReciterAI#175); `[]` on a pre-#175 rollup. */
  pmids: string[];
  /** #879 — generated capability gloss for the family (passthrough, render-only).
   *  `null` until the tools-a2-v3 rollup populates it. NEVER fed back into any
   *  LLM/embedding/retrieval — the overview generator reads its own projection. */
  definition: string | null;
  /** #879 — "generated" | null; gates the "AI-generated" disclaimer in the UI. */
  definitionSource: string | null;
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

// The stable composite overlay key (`${supercategory}::${familyLabel}`) now lives
// in `lib/api/methods-overlay.ts`, shared with the cross-scholar Method pages so
// the per-profile lens and the standalone pages apply ONE suppression/sensitivity
// implementation. Imported above; behavior here is unchanged.

/** Coerce a nullable Json column into a plain `Record<string, string>`, dropping
 *  non-string values and own-prototype keys. #1119 `exemplar_contexts` shape. */
function coerceStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

function toScholarFamilyView(
  r: {
    familyId: string;
    familyLabel: string;
    supercategory: string;
    pmidCount: number;
    exemplarTools: unknown;
    exemplarContexts: unknown;
    exemplarContextPmids: unknown;
    pmids: unknown;
    definition: string | null;
    definitionSource: string | null;
  },
  // #879 — when the flag is off, drop the definition from the view ENTIRELY. The
  // public profile payload is CloudFront-cached, so a client-side render gate would
  // still bake the copy into the cache; nulling it here keeps it out of the payload
  // until the flag flips (mirrors getFamily reading it only under the same gate).
  includeDefinition: boolean,
  // #1119 — same reasoning for the tool-usage snippets: drop them from the cached
  // payload entirely unless METHODS_LENS_TOOL_CONTEXT is on.
  includeToolContext: boolean,
): ScholarFamilyView {
  return {
    familyId: r.familyId,
    familyLabel: r.familyLabel,
    supercategory: r.supercategory,
    pubCount: r.pmidCount,
    exemplarTools: Array.isArray(r.exemplarTools) ? (r.exemplarTools as string[]) : [],
    // #1119 — keyed by display name; coerce defensively (nullable Json column).
    exemplarContexts: includeToolContext ? coerceStringRecord(r.exemplarContexts) : {},
    // #1158 — parallel pmid map (same key, same gate). NULL/non-object → {}.
    exemplarContextPmids: includeToolContext ? coerceStringRecord(r.exemplarContextPmids) : {},
    // Coerce defensively: the column is nullable (pre-#175 rollup) and Json.
    pmids: Array.isArray(r.pmids) ? (r.pmids as unknown[]).map(String) : [],
    // #879 — render-only passthrough; null until the tools-a2-v3 rollup lands AND
    // the METHODS_LENS_FAMILY_DEFINITIONS flag is on.
    definition: includeDefinition ? r.definition : null,
    definitionSource: includeDefinition ? r.definitionSource : null,
  };
}

/**
 * Partition a scholar's method families (#799) into the PUBLIC set — what the
 * CloudFront-cached profile payload may carry — and the #801 SENSITIVE set,
 * which only the scholar + admins may see (via the cookie-forwarding reveal
 * route, never the cached payload). Both newest-first by publication count.
 *
 *   - #800 suppression is applied ALWAYS, to BOTH sets (generic families are
 *     never shown to anyone).
 *   - #801 sensitivity partitions only when `METHODS_LENS_SENSITIVE_GATE=on`;
 *     with the gate off every (non-suppressed) family is public and sensitive
 *     is []. Both overlays key on the stable (supercategory, family_label).
 *   - Returns empty sets when the lens is disabled (the master render gate).
 */
async function partitionScholarFamilies(
  cwid: string,
): Promise<{ publicFamilies: ScholarFamilyView[]; sensitiveFamilies: ScholarFamilyView[] }> {
  if (!isMethodsLensEnabled()) return { publicFamilies: [], sensitiveFamilies: [] };

  // #879 — gate the generated definition out of the (cached) payload unless on.
  const defsOn = isMethodsFamilyDefinitionsOn();
  // #1119 — gate the tool-usage snippets out of the (cached) payload unless on.
  const ctxOn = isMethodsLensToolContextOn();

  const rows = await prisma.scholarFamily.findMany({
    where: { cwid },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    select: {
      familyId: true,
      familyLabel: true,
      supercategory: true,
      pmidCount: true,
      exemplarTools: true,
      exemplarContexts: true,
      exemplarContextPmids: true,
      pmids: true,
      definition: true,
      definitionSource: true,
    },
  });
  if (rows.length === 0) return { publicFamilies: [], sensitiveFamilies: [] };

  const suppression = await prisma.familySuppressionOverlay.findMany({
    select: { supercategory: true, familyLabel: true },
  });
  const suppressed = new Set(
    suppression.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );
  const visible = rows.filter(
    (r) => !suppressed.has(familyOverlayKey(r.supercategory, r.familyLabel)),
  );

  if (!isMethodsLensSensitiveGateOn()) {
    return {
      publicFamilies: visible.map((r) => toScholarFamilyView(r, defsOn, ctxOn)),
      sensitiveFamilies: [],
    };
  }

  const sensitivity = await prisma.familySensitivityOverlay.findMany({
    select: { supercategory: true, familyLabel: true },
  });
  const sensitiveKeys = new Set(
    sensitivity.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );
  const publicFamilies: ScholarFamilyView[] = [];
  const sensitiveFamilies: ScholarFamilyView[] = [];
  for (const r of visible) {
    (sensitiveKeys.has(familyOverlayKey(r.supercategory, r.familyLabel))
      ? sensitiveFamilies
      : publicFamilies
    ).push(toScholarFamilyView(r, defsOn, ctxOn));
  }
  return { publicFamilies, sensitiveFamilies };
}

/** PUBLIC method families for the (CloudFront-cached) profile payload (#799).
 *  #800-suppressed and #801-gated families are excluded; [] when the lens flag
 *  is off (the master render gate), so no SEO/JSON side channel can leak.
 *  @internal Exported for the #879 definition flag-gate unit test. */
export async function loadScholarFamilies(cwid: string): Promise<ScholarFamilyView[]> {
  return (await partitionScholarFamilies(cwid)).publicFamilies;
}

/** #801 — the AUDIENCE-GATED method families a scholar/admin may see but the
 *  public may not. Served ONLY by the cookie-forwarding reveal route
 *  (/api/edit/methods-sensitive/[cwid]) after an owner/superuser authorization
 *  check; [] unless `METHODS_LENS_SENSITIVE_GATE=on`. */
export async function loadSensitiveScholarFamilies(cwid: string): Promise<ScholarFamilyView[]> {
  return (await partitionScholarFamilies(cwid)).sensitiveFamilies;
}

/**
 * email-visibility-spec § Cache-safety — the cache-unsafe reveal of a scholar's
 * email for the /api/profile/[cwid]/contact-email endpoint. Returns the raw email
 * + release audience (the endpoint applies table A against the resolved
 * internal-viewer signal); `null` for an unknown or soft-deleted scholar.
 */
export async function loadScholarContactEmail(
  cwid: string,
): Promise<{ email: string | null; emailVisibility: string | null } | null> {
  const scholar = await prisma.scholar.findUnique({
    where: { cwid },
    select: { email: true, emailVisibility: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt) return null;
  return { email: scholar.email, emailVisibility: scholar.emailVisibility };
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
    /** #536 — co-author chip link suppression for hidden roles. */
    roleCategory: string | null;
  }>;
}>;

export type ProfilePayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  /** #536 — role category of the profile owner. The `/scholars/[slug]` route
   *  404s when this is a hidden identity class (doctoral student); also lets
   *  callers reason about display eligibility. */
  roleCategory: string | null;
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
  /** #684 — slug of the scholar's primary Department (from the deptCode
   *  relation), or null when no Department row joins. The sidebar links the
   *  `primaryDepartment` display label to `/departments/<slug>` when present,
   *  strengthening the on-site profile↔department link graph. */
  departmentSlug: string | null;
  /** Curated official department name from the Department relation (e.g.
   *  "Samuel J. Wood Library"). NULL when the dept has no curated override or
   *  no joined Department row — the sidebar then falls back to
   *  `primaryDepartment`. Resolved via lib/org-unit-names.ts:officialUnitName
   *  conceptually, but precomputed here so the view stays presentational. */
  departmentOfficialName: string | null;
  /** Issue #167 — division name when the scholar has a populated divCode
   *  AND the joined division name is not "Administration" (an admin-style
   *  level2 unit that should not be surfaced as a research/clinical
   *  division). Used by the sidebar to render "<Division> (<Department>)"
   *  when present, falling back to department-only when null. */
  division: string | null;
  /** #1266 — formatted leadership-role lines (Chair / Chief / Center Director /
   *  Program Leader), in that order; empty when the scholar holds none. Sourced
   *  from Department.chairCwid / Division.chiefCwid / Center.directorCwid +
   *  CenterProgramLeader rows and rendered beneath `primaryTitle`. Center and
   *  program lines are curated and sparse, so they appear only where curation
   *  exists. */
  leadershipTitles: string[];
  email: string | null;
  /** email-visibility-spec § Cache-safety. True when PROFILE_EMAIL_RELEASE_GATE
   *  is on and the scholar has an email that was WITHHELD from `email` above
   *  because it is not `public` (i.e. `institution` or `none`). The Contact card
   *  mounts the uncacheable client reveal island, which fetches
   *  /api/profile/[cwid]/contact-email and shows the address to internal viewers
   *  only. Never carries the address itself. False when the gate is off, the
   *  email is `public` (already baked), or there is no email. */
  contactEmailRevealable: boolean;
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
    source: string;
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
    /** "InfoEd" (WCM-administered) | "RePORTER" (NIH RePORTER backfill, #1307). */
    source: string;
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
  /** Clinical trials the scholar is an investigator on. Sourced from
   *  reciterdb (institutional spine + ClinicalTrials.gov enrichment) by
   *  etl/clinical-trials. EMPTY unless CLINICAL_TRIALS_SECTION is on — the
   *  section ships dark, so an unflagged env never surfaces trials even after
   *  the ETL backfill. Withdrawn trials are dropped here, not stored away. */
  clinicalTrials: Array<{
    protocolNumber: string;
    nctNumber: string | null;
    title: string;
    /** Raw institutional status (e.g. "Recruiting", "Completed"). */
    status: string | null;
    /** Coarse split for the Active/Completed grouping, derived from status. */
    isActive: boolean;
    /** YYYY-MM-DD, or null when the institutional status date didn't parse. */
    statusDate: string | null;
    /** Enriched study phase (e.g. "Phase 2/Phase 3"); null for non-NCT/N-A. */
    phase: string | null;
    studyType: string | null;
    principalSponsor: string | null;
    /** Derived role: 'Principal Investigator' | 'Investigator'. */
    role: string;
    conditions: string | null;
    briefSummary: string | null;
    enrollment: number | null;
    /** Where the detail came from ("ClinicalTrials.gov" today); null when only
     *  institutional data exists. Drives the data-vintage note + the
     *  third-party swap-point. */
    enrichmentSource: string | null;
  }>;
  keywords: ProfileKeywords;
  /** #799 — family-primary Methods lens rows. Empty when the lens flag is off
   *  or the `scholar_family` rollup has no rows for this scholar (dormant until
   *  the SCHOLAR_TOOL_SOURCE=s3 cutover). */
  families: ScholarFamilyView[];
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
    /** #536 — the sidebar card renders the mentor name as plain text rather
     *  than a profile link when the mentor is a hidden identity class. */
    roleCategory: string | null;
  } | null;
  /** Issue #90 — preferred NIH RePORTER PI profile_id, when the scholar
   *  has appeared on at least one NIH grant we could resolve. Drives the
   *  outbound "View NIH portfolio on RePORTER ↗" link in the Funding
   *  section header. Null when no mapping exists. */
  nihReporterProfileId: number | null;
  /** #1103 — the scholar's ACTIVE center memberships (reverse of the center
   *  roster), for the sidebar "Centers" card. Empty when PROFILE_CENTER_AFFILIATION
   *  is off (the reverse query is never issued) or the scholar has no active
   *  membership. Prisma-sourced; carries no search-index/browse-facet key. */
  centers: ScholarCenterAffiliation[];
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

/** A trial we never display (withdrawn / never-enrolled). Checked before the
 *  active test below so "no longer available" doesn't count as "available".
 *  The institutional `overallCurrentStatus` vocabulary (OPEN/CLOSED TO ACCRUAL,
 *  IRB STUDY CLOSURE, SUSPENDED) has no withdrawn state, so this only matches the
 *  ClinicalTrials.gov terms — kept for any future CTgov-sourced status.
 *  @internal exported for tests. */
export function isWithdrawnTrialStatus(status: string | null): boolean {
  const s = (status ?? "").toLowerCase();
  return s.includes("withdrawn") || s.includes("no longer available");
}

/** Coarse Active vs Completed split for the trial section, from the raw status.
 *  The live source is the institutional `overallCurrentStatus` — "OPEN TO
 *  ACCRUAL" is the only actively-enrolling state ("CLOSED TO ACCRUAL", "IRB STUDY
 *  CLOSURE", "SUSPENDED" fall through to completed). The ClinicalTrials.gov terms
 *  are also matched so an enriched/future CTgov status classifies correctly.
 *  @internal exported for tests. */
export function isActiveTrialStatus(status: string | null): boolean {
  const s = (status ?? "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("open to accrual") || // institutional: actively enrolling
    s.includes("recruiting") || // ClinicalTrials.gov (covers "not yet recruiting")
    s.includes("enrolling") ||
    s.includes("active") || // CTgov "active, not recruiting"
    s.includes("available")
  );
}

export const getScholarFullProfileBySlug = cache(async (
  slug: string,
  now: Date = new Date(),
): Promise<ProfilePayload | null> => {
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
      // Clinical trials (#clinical-trials). Always joined (a small, usually-empty
      // relation); the payload is gated dark in the mapper below, so an env with
      // CLINICAL_TRIALS_SECTION off returns [] even after the ETL backfill lands.
      clinicalTrials: {
        include: { trial: true },
      },
      // Issue #167 — surface the division name so the sidebar can render
      // "<Division> (<Department>)". Department display still comes from
      // the existing `primaryDepartment` text column.
      division: { select: { name: true } },
      // #684 — the department page slug, so the sidebar department name can
      // link to /departments/<slug> (null when the scholar's deptCode has no
      // joined Department row). `officialName` is the curated ceremonial name
      // (e.g. ED "Library" -> "Samuel J. Wood Library") preferred over the raw
      // `primaryDepartment` string for display; falls back when NULL.
      department: { select: { slug: true, officialName: true } },
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
          roleCategory: true,
        },
      },
    },
  });
  if (!scholar) return null;

  // These reads are all keyed only on the (already-fetched) scholar cwid and
  // have no data dependency on one another, so they run concurrently in one
  // round of awaits rather than serially. Anything that consumes `authorships`
  // (suppressions, ranking) stays sequential below, after this resolves.
  //   - effectiveOverview      — field_override('overview') merge (#356)
  //   - authorships            — drives the publications list (#63 type filter)
  //   - nihProfileRow          — preferred NIH RePORTER profile_id (#90)
  //   - families               — gated Methods-lens rows (#799); [] when off
  //   - manualHighlightPmids   — field_override('selectedHighlightPmids') (#836);
  //                              read only when the flag is on, else null (dark)
  const [
    effectiveOverview,
    authorships,
    nihProfileRow,
    families,
    manualHighlightPmids,
    centers,
    leadershipTitles,
  ] = await Promise.all([
      // The effective `overview` merges a manual `field_override` over the ETL
      // column at read time (#356, lib/api/manual-layer.ts). A self-edited bio is
      // sanitized on write, so it is rendered as-is.
      getEffectiveOverview(scholar.cwid, scholar.overview, prisma),
      // Authorships for this scholar — drives the publications list. Pull author
      // rows for every publication so coauthor chips can be rendered. Issue #63:
      // drop Retraction / Erratum rows at fetch time so the list, header counts,
      // and keyword aggregation all see the same filtered set.
      prisma.publicationAuthor.findMany({
        where: {
          cwid: scholar.cwid,
          isConfirmed: true,
          publication: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
        },
        include: {
          publication: {
            // Tight projection — the publications table carries the huge
            // `fullAuthorsString` (db.Text) plus ~12 scalars this read never
            // touches. Select only the scalars the mappers below consume
            // (verified against every `a.publication.<field>` access) so the row
            // stays small. `authors` + `publicationScores` are unchanged (nested
            // relations are listed alongside scalars under `select`).
            select: {
              pmid: true,
              title: true,
              authorsString: true,
              journal: true,
              year: true,
              publicationType: true,
              citationCount: true,
              dateAddedToEntrez: true,
              doi: true,
              pmcid: true,
              pubmedUrl: true,
              meshTerms: true,
              abstract: true,
              impactScore: true,
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
                      roleCategory: true,
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
      }),
      // Issue #90 — preferred NIH RePORTER profile_id for this scholar, used to
      // render the outbound "View NIH portfolio on RePORTER" link in the Funding
      // section header. Null when no mapping was found by the etl:nih-profile
      // resolver.
      prisma.personNihProfile.findFirst({
        where: { cwid: scholar.cwid, isPreferred: true },
        select: { nihProfileId: true },
      }),
      // #799 — family-primary Methods lens rows (gated + overlay-filtered).
      // Returns [] when the lens flag is off, so this is a no-op until on.
      loadScholarFamilies(scholar.cwid),
      // #836 — the scholar's manual Highlights override, in stored order, read
      // only when the flag is on (else null, keeping the feature fully dark).
      // The precedence/visibility resolution happens below once the ranked AI
      // set exists; this fetch is independent and only the read is hoisted here.
      isManualHighlightsEnabled()
        ? getSelectedHighlightPmids(scholar.cwid, prisma)
        : Promise.resolve(null),
      // #1103 — the scholar's ACTIVE center memberships for the "Centers" card,
      // read only when the flag is on (else [] — the reverse query is never
      // issued, keeping the feature fully dark). Date-filtered inside the loader.
      isProfileCenterAffiliationEnabled()
        ? getScholarCenterAffiliations(scholar.cwid)
        : Promise.resolve([] as ScholarCenterAffiliation[]),
      // #1266 — leadership-role title lines (Chair / Chief / Center Director /
      // Program Leader), rendered beneath the academic rank. Point lookups on the
      // already-populated FK columns; each returns 0-1 rows for almost every
      // scholar. Chair/Chief come from the ED ETL (populated); Center director and
      // CenterProgramLeader are curated and sparse, so those lines appear only
      // where curation exists — an empty array renders nothing.
      // ponytail: centerProgramLeader.cwid is unindexed but the table is tiny; add
      // @@index([cwid]) only if profile-load latency ever flags it.
      Promise.all([
        prisma.department.findMany({
          where: { chairCwid: scholar.cwid },
          select: { name: true, officialName: true },
        }),
        prisma.division.findMany({
          where: { chiefCwid: scholar.cwid },
          select: { name: true },
        }),
        prisma.center.findMany({
          where: { directorCwid: scholar.cwid },
          select: { name: true, officialName: true, leaderInterim: true },
        }),
        prisma.centerProgramLeader.findMany({
          where: { cwid: scholar.cwid },
          select: {
            interim: true,
            program: {
              select: {
                label: true,
                center: { select: { name: true, officialName: true } },
              },
            },
          },
        }),
      ]).then(([chairDepts, chiefDivs, dirCenters, progLeads]) => [
        ...chairDepts.map((d) => `Chair, ${d.officialName ?? d.name}`),
        ...chiefDivs.map((d) => `Chief, ${d.name}`),
        ...dirCenters.map(
          (c) =>
            `${c.leaderInterim ? "Interim Director" : "Director"}, ${c.officialName ?? c.name}`,
        ),
        ...progLeads.map(
          (l) =>
            `${l.interim ? "Interim Leader" : "Leader"}, ${l.program.label} (${l.program.center.officialName ?? l.program.center.name})`,
        ),
      ]),
    ]);

  // #356 — publication suppression. A publication this scholar has hidden
  // (a per-author suppression on their own cwid), or one taken down whole,
  // drops from their record entirely: the publications list, Selected
  // highlights, and the keyword cloud all derive from `visibleAuthorships`.
  // The grant-linked publications in the Funding section are filtered the same
  // way below, so every profile pmid is covered by this one suppression load.
  const grantPmids = scholar.grants.flatMap((g) =>
    g.publications.map((gp) => gp.publication.pmid),
  );
  const suppressions = await loadPublicationSuppressions(
    [...authorships.map((a) => a.publication.pmid), ...grantPmids],
    prisma,
  );
  const visibleAuthorships = authorships.filter(
    (a) =>
      !isAuthorHidden(suppressions, a.publication.pmid, scholar.cwid) &&
      !suppressions.darkPmids.has(a.publication.pmid),
  );

  // #160 — whole-entity suppressions. A hidden education / appointment / grant
  // drops from the profile (sidebars + funding section). Keyed on the stable
  // `externalId` (#352). A grant row is per-investigator, so suppressing it
  // hides that one role from this profile.
  const [suppressedEducationIds, suppressedAppointmentIds, suppressedGrantIds] =
    await Promise.all([
      loadEntitySuppressions(
        "education",
        scholar.educations.map((e) => e.externalId),
        prisma,
      ),
      loadEntitySuppressions(
        "appointment",
        scholar.appointments.map((a) => a.externalId),
        prisma,
      ),
      loadEntitySuppressions(
        "grant",
        scholar.grants.map((g) => g.externalId),
        prisma,
      ),
    ]);

  const rankablePubs = visibleAuthorships.map((a) => {
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
            au.scholar.status === "active" &&
            // #356 — a co-author who hid this publication drops from its chips.
            !isAuthorHidden(suppressions, a.publication.pmid, au.scholar.cwid),
        )
        .map((au) => ({
          name: au.scholar!.preferredName,
          cwid: au.scholar!.cwid,
          slug: au.scholar!.slug,
          identityImageEndpoint: identityImageEndpoint(au.scholar!.cwid),
          isFirst: au.isFirst,
          isLast: au.isLast,
          position: au.position,
          roleCategory: au.scholar!.roleCategory,
        })),
      scholar.cwid,
    ),
    };
  });

  // AI-selected Highlights — the top-N first/senior pubs by the
  // `selected_highlights` curve. `rankablePubs` is already suppression-filtered
  // (it derives from `visibleAuthorships`), so neither these nor any manual
  // override below can resurface a hidden publication.
  const aiHighlights = rankForSelectedHighlights(rankablePubs, now).slice(
    0,
    MAX_SELECTED_HIGHLIGHTS,
  );
  // #836 — `manualHighlightPmids` (the scholar's stored override, or null when
  // the flag is off / no override) was fetched in the cwid-only Promise.all
  // above. When the flag is on it takes precedence over the AI selection, in
  // stored order, restricted to their still-visible publications
  // (`pickManualHighlights` drops any suppressed/out-of-set pmid and falls back
  // to the AI set if none survive). Flag off ⇒ the read was never issued, so the
  // feature is fully dark.
  let highlights: ProfilePublication[];
  if (manualHighlightPmids && manualHighlightPmids.length > 0) {
    // Only when a manual override is actually present do we build the pickable
    // pool — every visible pub (not just the AI-positive ones), carrying its
    // `selected_highlights` score so the picked `ProfilePublication` has the same
    // `score` shape the AI highlights do. A manual pick the AI filter would have
    // scored 0 (e.g. a 2nd-author paper) is still honoured — the scholar chose it
    // deliberately. Skipping this map on the (overwhelmingly common) no-override
    // path keeps the hot profile render off an O(pubs) re-score.
    const scoredPool: ProfilePublication[] = rankablePubs.map((p) => ({
      ...p,
      score: scorePublication(p, "selected_highlights", true, now),
    }));
    highlights = pickManualHighlights(scoredPool, aiHighlights, manualHighlightPmids);
  } else {
    highlights = aiHighlights;
  }

  // Issue #73 — aggregate keywords from this scholar's accepted publications.
  // Operates over `visibleAuthorships` (which includes `publication.meshTerms`
  // via the earlier include) so we don't re-query, and so a suppressed
  // publication contributes no keywords. Excludes Retraction/Erratum types
  // from per-keyword counts unconditionally, ahead of issue #63 fully landing
  // the same exclusion in the publications list.
  const keywords: ProfileKeywords = aggregateKeywords(
    visibleAuthorships.map((a) => ({
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
  const sortedAppointments = [...scholar.appointments]
    // #160 — drop suppressed appointments before annotate/collapse so a hidden
    // primary can't win the single-visible-primary collapse.
    .filter((a) => !suppressedAppointmentIds.has(a.externalId))
    .sort((a, b) => tier(a.source) - tier(b.source));
  const annotatedAppointments = annotateAppointments(sortedAppointments, now);

  // `nihProfileRow` (#90 — preferred NIH RePORTER profile_id, drives the
  // "View NIH portfolio on RePORTER" link) and `families` (#799 — gated +
  // overlay-filtered Methods-lens rows, [] when the lens flag is off) were both
  // fetched in the cwid-only Promise.all above.

  return {
    cwid: scholar.cwid,
    slug: scholar.slug,
    preferredName: scholar.preferredName,
    roleCategory: scholar.roleCategory,
    postnominal: scholar.postnominal,
    publishedName: scholar.postnominal
      ? `${scholar.preferredName}, ${scholar.postnominal}`
      : scholar.preferredName,
    fullName: scholar.fullName,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    departmentSlug: scholar.department?.slug ?? null,
    departmentOfficialName: scholar.department?.officialName ?? null,
    // Issue #167 — belt-and-suspenders filter for the "Administration"
    // division label. The ED ETL drops Administration at the divCode level
    // (EXCLUDED_DIV_NAMES), so this typically only matters when divCode
    // exists but the joined Division row's name is "Administration" (e.g.
    // a row that pre-dates the ETL filter).
    division:
      scholar.division && scholar.division.name !== "Administration"
        ? scholar.division.name
        : null,
    leadershipTitles,
    // email-visibility-spec § A + Cache-safety — this payload is rendered into
    // the CloudFront PATH-cached profile page, so it MUST be viewer-independent.
    // Bake only the cache-safe email: when the gate is on, `public` survives and
    // `institution`/`none`/null are withheld (gateEmailForViewer with
    // internalViewer=false). `institution` emails are revealed to internal
    // viewers out-of-band via the uncacheable /api/profile/[cwid]/contact-email
    // endpoint (see `contactEmailRevealable`). No-op (raw email) while off.
    email: gateEmailForViewer(
      scholar.email,
      scholar.emailVisibility,
      false,
      isEmailReleaseGateEnabled(),
    ),
    // True when the gate is on and the scholar has an email withheld above
    // because it is not `public` — the Contact card mounts the client reveal
    // island. Covers `institution` (revealed to internal viewers) and `none`
    // (endpoint returns nothing); both fetch so an external viewer cannot tell
    // them apart. Carries no address. False when gate off / public / no email.
    contactEmailRevealable:
      isEmailReleaseGateEnabled() &&
      scholar.email != null &&
      scholar.emailVisibility !== "public",
    identityImageEndpoint: identityImageEndpoint(scholar.cwid),
    hasClinicalProfile: scholar.hasClinicalProfile,
    clinicalProfileUrl: scholar.clinicalProfileUrl,
    orcid: scholar.orcid,
    overview: effectiveOverview,
    appointments: collapseToSingleVisiblePrimary(annotatedAppointments).map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isPrimary: a.isPrimary,
      isInterim: a.isInterim,
      isActive: a.isActive,
      source: a.source,
    })),
    educations: scholar.educations
      // #160 — drop suppressed education entries from the sidebar.
      .filter((e) => !suppressedEducationIds.has(e.externalId))
      .map((e) => ({
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
    grants: scholar.grants
      // #160 — drop a suppressed grant role from the funding section.
      .filter((g) => !suppressedGrantIds.has(g.externalId))
      .map((g) => {
      const lowerConfidenceCutoff = new Date(now);
      lowerConfidenceCutoff.setMonth(lowerConfidenceCutoff.getMonth() - 12);
      const pubs = g.publications
        // #356 — drop a publication this scholar has hidden, or one taken
        // down whole, from the grant's publication list too.
        .filter(
          (gp) =>
            !isAuthorHidden(suppressions, gp.publication.pmid, scholar.cwid) &&
            !suppressions.darkPmids.has(gp.publication.pmid),
        )
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
        source: g.source,
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
    // Clinical trials (#clinical-trials). Dark unless CLINICAL_TRIALS_SECTION is
    // on: an unflagged env returns [] regardless of the table contents, so the
    // ETL backfill can land before the flag flip without exposing the section.
    // Withdrawn/never-enrolled trials are dropped; the rest sort active-first
    // then by most recent status date.
    clinicalTrials:
      process.env.CLINICAL_TRIALS_SECTION === "on"
        ? scholar.clinicalTrials
            .filter((ct) => !isWithdrawnTrialStatus(ct.trial.status))
            .map((ct) => ({
              protocolNumber: ct.trial.protocolNumber,
              nctNumber: ct.trial.nctNumber,
              title: ct.trial.title,
              status: ct.trial.status,
              isActive: isActiveTrialStatus(ct.trial.status),
              statusDate: ct.trial.statusDate
                ? ct.trial.statusDate.toISOString().slice(0, 10)
                : null,
              phase: ct.trial.phase,
              studyType: ct.trial.studyType,
              principalSponsor: ct.trial.principalSponsor,
              role: ct.role,
              conditions: ct.trial.conditions,
              briefSummary: ct.trial.briefSummary,
              enrollment: ct.trial.enrollment,
              enrichmentSource: ct.trial.enrichmentSource,
            }))
            .sort((a, b) => {
              if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
              return (b.statusDate ?? "").localeCompare(a.statusDate ?? "");
            })
        : [],
    keywords,
    families,
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
            roleCategory: scholar.postdoctoralMentor.roleCategory,
          }
        : null,
    nihReporterProfileId: nihProfileRow?.nihProfileId ?? null,
    centers,
  };
});

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
  roleCategory: string | null;
} | null> {
  const row = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: {
      slug: true,
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
      roleCategory: true,
    },
  });
  return row ?? null;
}

/**
 * Schema.org Person JSON-LD for a loaded profile. Single source of truth for
 * the field mapping — consumed by the on-page <script type="application/ld+json">
 * (components/profile/profile-view.tsx) and the standalone `/{slug}/jsonld`
 * endpoint (app/(public)/[slug]/jsonld/route.ts) so the two can't drift.
 */
export function buildProfileJsonLd(
  profile: ProfilePayload,
): Record<string, unknown> {
  return buildPersonJsonLd({
    slug: profile.slug,
    preferredName: profile.publishedName,
    primaryTitle: profile.primaryTitle ?? null,
    primaryDepartment: profile.primaryDepartment ?? null,
    overview: profile.overview ?? null,
    identityImageEndpoint: profile.identityImageEndpoint,
    clinicalProfileUrl: profile.clinicalProfileUrl ?? null,
    orcid: profile.orcid ?? null,
    keywords: profile.keywords.keywords,
    // #684 — bare (postnominal-free) name drives givenName/familyName +
    // alternateName; the postnominal becomes honorificSuffix.
    nameParts: profile.preferredName,
    honorificSuffix: profile.postnominal ?? null,
  });
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
