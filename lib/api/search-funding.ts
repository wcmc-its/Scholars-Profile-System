/**
 * Search-funding API — issue #80 items 4 + 5: OpenSearch port.
 *
 * Powers the third tab on the unified search results page. One hit per
 * *project* — pre-deduped at index time across the per-(scholar,
 * account_number) Grant rows. Returns the same shape as the v1 Prisma
 * implementation so callers don't change.
 *
 * Key shifts vs. v1:
 *   - Text relevance ranks against title + sponsor text + people names
 *     via a multi_match. v1 aliased "relevance" to endDate-asc.
 *   - Per-facet excluding-self aggregations. Each facet's bucket counts
 *     reflect the dataset with all OTHER axes' filters applied — ticking
 *     "Active" doesn't collapse the Funder list to only Active funders.
 *     Mirrors the searchPeople / searchPublications pattern.
 *   - Multi-select preserved on every axis (issue #80 requirement).
 *
 * Spec references:
 *   F1 — tab + sort options
 *   F2 — result row (title, people, sponsor, dates, mechanism, IDs)
 *   F3 — facets: Funder, Type, Mechanism, Status, Department, Role
 *   F6 — prime/direct sponsor + isSubaward
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  FUNDING_INDEX,
  FUNDING_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  PUBLICATIONS_RESTRUCTURED_MSM,
  searchClient,
} from "@/lib/search";
import { coreProjectNum } from "@/lib/award-number";
import {
  resolveFundingConceptEnabled,
  resolveFundingMatchReason,
  resolveFundingMeshGateField,
  resolveFundingPhraseBoost,
  resolveFundingTabMsm,
  resolveFundingTextEvidence,
  type Scope,
} from "@/lib/api/search-flags";
import { clampAroundMarks } from "@/lib/api/result-evidence";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const PAGE_SIZE = 20;

/** 12 months grace beyond end_date (issue #78 Q6). */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;
const ENDING_SOON_MS = 365 * 24 * 60 * 60 * 1000;
const RECENTLY_ENDED_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type FundingSort = "relevance" | "endDate" | "startDate" | "pubCount";

export type FundingStatus = "active" | "ending_soon" | "recently_ended";

export type FundingRoleBucket = "PI" | "Multi-PI" | "Co-I";

export type FundingFilters = {
  /** Canonical sponsor short names (e.g. "NCI"). Filters on PRIME sponsor.
   *  Multi-select OR within the axis. */
  funder?: string[];
  /** Canonical sponsor short names matched against the DIRECT sponsor
   *  (subaward issuer). Multi-select OR within the axis (issue #80 item 7). */
  directFunder?: string[];
  /** programType values from InfoEd. Multi-select OR. */
  programType?: string[];
  /** NIH activity codes. Multi-select OR. */
  mechanism?: string[];
  /** Status buckets — multi-select OR. */
  status?: FundingStatus[];
  /** Lead-PI primary-department strings. Multi-select OR. */
  department?: string[];
  /** Role buckets — multi-select OR. */
  role?: FundingRoleBucket[];
  /** Issue #94 — WCM investigator CWIDs. Multi-select OR within the
   *  axis; matches the wcmAuthor filter pattern on the Publications
   *  search. */
  investigator?: string[];
};

/** Issue #94 — Investigator facet bucket, hydrated server-side with
 *  display name, slug, and avatar endpoint so the client component just
 *  renders. Mirrors WcmAuthorFacetBucket on the Publications search. */
export type WcmInvestigatorFacetBucket = {
  cwid: string;
  displayName: string;
  slug: string;
  identityImageEndpoint: string;
  count: number;
};

export type FundingPersonChip = {
  cwid: string;
  slug: string;
  preferredName: string;
  /** Per-person role on this grant: PI | Multi-PI | Co-I | Sub-PI | KP. */
  role: string;
  identityImageEndpoint: string;
  /** #536 — scholar role category (enriched from the DB; the funding index
   *  does not store it). Drives investigator-chip link suppression for hidden
   *  identity classes (e.g. an F31 predoctoral PI). Null when unresolved. */
  roleCategory: string | null;
};

export type FundingHit = {
  /** Project key — Account_Number from InfoEd. Dedupe key. */
  projectId: string;
  title: string;
  /** Canonical short when matched, raw fallback otherwise. */
  primeSponsor: string;
  primeSponsorRaw: string | null;
  /** Direct sponsor for subawards; null when WCM holds prime directly. */
  directSponsor: string | null;
  isSubaward: boolean;
  programType: string;
  mechanism: string | null;
  nihIc: string | null;
  awardNumber: string | null;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  isActive: boolean;
  status: FundingStatus | "ended";
  isMultiPi: boolean;
  /** WCM scholars on the grant — lead PI first, Multi-PIs next, Co-Is last. */
  people: FundingPersonChip[];
  totalPeople: number;
  /** Department of record — typically lead PI's primary appointment. */
  department: string | null;
  /** Issue #86 — count of distinct PMIDs attributed to this project across
   *  its scholar rows. Drives the pubCount sort and is rendered on the
   *  result row. */
  pubCount: number;
  /** Issue #86 — RePORTER abstract for inline expansion on the result row. */
  abstract: string | null;
  /** Issue #92 — origin of `abstract`: 'reporter' | 'nsf' | 'pcori' | 'cdmrp' | 'gates'. */
  abstractSource: string | null;
  /** Issue #86 — RePORTER application ID; outbound deep-link target. */
  applId: number | null;
  /** Issue #86 — pub list for the inline expand affordance. Capped at
   *  PUB_LIST_CAP entries during indexing. */
  publications: Array<{
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    citationCount: number;
    isLowerConfidence: boolean;
  }>;
  /** Issue #86 — RePORTER core_project_num parsed from the awardNumber.
   *  Used by the expanded view to build the PubMed grant-search outbound
   *  link. Null for non-NIH grants. */
  coreProjectNum: string | null;
  /** PLAN P4 — highlighted title fragment (`<mark>`-wrapped) when the literal
   *  query matched the grant title. Present only under
   *  `SEARCH_FUNDING_MATCH_REASON=on`; null otherwise (or no title hit). A
   *  literal-title hit is self-evident from the highlight, so the row suppresses
   *  the reason line. */
  titleHighlight: string | null;
  /** PLAN P4 — the grant was admitted (at least in part) by a literal text hit
   *  on its title. Derived from `titleHighlight` presence. */
  matchedLiteralTitle: boolean;
  /** PLAN P4 — the grant was admitted via the resolved MeSH concept
   *  (`meshDescriptorUi` ∩ descendant set), read from `matched_queries`. NOTE:
   *  this is RePORTER project-keyword topicality, a distinct signal from
   *  funded-publication MeSH (`matchedFundedPubs`). */
  matchedConcept: boolean;
  /** PLAN P4 — X = distinct on-topic funded publications: the count of this
   *  grant's funded pmids whose publication-index MeSH (`meshDescriptorUi`)
   *  intersects the resolved descendant set, computed by a query-time
   *  `cardinality(pmid)` aggregation (no reindex). Capped at `pubCount` (Y) for
   *  coherent "X of Y" phrasing. Present only under the flag + a resolved
   *  concept; 0 when the grant has no on-topic funded outputs. */
  matchedFundedPubs: number;
  /** Tier 3 (`SEARCH_FUNDING_TEXT_EVIDENCE`) — the clamped, mark-aware snippet of
   *  the best non-title / non-concept text-field highlight (abstract → keyword →
   *  sponsor), so a grant matched ONLY on text still shows a "why it matched"
   *  reason line. `field` names the source for the row's leading label; `snippet`
   *  carries only balanced `<mark>` spans (non-mark tags stripped, clamped via
   *  `clampAroundMarks`). Null under the flag-off path / empty query / no text
   *  highlight, so the off contract is byte-identical to today. */
  textEvidence: { field: "abstract" | "keywordsText" | "sponsorText"; snippet: string } | null;
};

export type SearchFacetBucket = { value: string; count: number };

export type FundingSearchResult = {
  hits: FundingHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    funders: Array<{ value: string; label: string; count: number }>;
    directFunders: Array<{ value: string; label: string; count: number }>;
    programTypes: SearchFacetBucket[];
    mechanisms: SearchFacetBucket[];
    status: { active: number; endingSoon: number; recentlyEnded: number };
    departments: SearchFacetBucket[];
    roles: { pi: number; multiPi: number; coI: number };
    /** Issue #94 — top WCM investigators in the current result set,
     *  hydrated server-side. */
    investigators: WcmInvestigatorFacetBucket[];
    /** Total distinct WCM investigators across the current result set
     *  (header count). May exceed `investigators.length` when the agg
     *  cap is hit; mirrors `wcmAuthorsTotal` on the Publications search. */
    investigatorsTotal: number;
  };
};

/** Re-export the historical isFundingActive helper so existing callers
 *  (notably `lib/api/profile.ts`) keep their import shape. */
export function isFundingActive(endDate: Date, now: Date): boolean {
  return endDate.getTime() + NCE_GRACE_MS > now.getTime();
}

function statusForGrant(endDate: Date, now: Date): FundingStatus | "ended" {
  const t = endDate.getTime();
  const n = now.getTime();
  if (t + NCE_GRACE_MS <= n) {
    if (n - t <= RECENTLY_ENDED_WINDOW_MS) return "recently_ended";
    return "ended";
  }
  if (t - n <= ENDING_SOON_MS) return "ending_soon";
  return "active";
}

/** Build the date-range filter that corresponds to one or more status
 *  buckets. The OR-within-axis semantics translate to a `bool.should`
 *  with `minimum_should_match: 1` over per-bucket date ranges. */
function statusToFilterClause(
  statuses: FundingStatus[],
  now: Date,
): Record<string, unknown> | null {
  if (statuses.length === 0) return null;
  const should: Record<string, unknown>[] = [];
  if (statuses.includes("active")) {
    should.push({
      range: { endDate: { gt: new Date(now.getTime() - NCE_GRACE_MS).toISOString() } },
    });
  }
  if (statuses.includes("ending_soon")) {
    should.push({
      range: {
        endDate: {
          gte: now.toISOString(),
          lte: new Date(now.getTime() + ENDING_SOON_MS).toISOString(),
        },
      },
    });
  }
  if (statuses.includes("recently_ended")) {
    should.push({
      range: {
        endDate: {
          gte: new Date(now.getTime() - RECENTLY_ENDED_WINDOW_MS).toISOString(),
          lt: new Date(now.getTime() - NCE_GRACE_MS).toISOString(),
        },
      },
    });
  }
  if (should.length === 0) return null;
  return { bool: { should, minimum_should_match: 1 } };
}

/** Tier 3 — visible-length budget for the abstract/keyword text-evidence
 *  snippet. Short enough to sit as a one-line reason; clamped mark-aware. */
const TEXT_EVIDENCE_MAX_LEN = 160;

/** Tier 3 — strip every NON-`<mark>` tag (the contract `clampAroundMarks`
 *  requires: only balanced `<mark>`/`</mark>` may remain). Inlined here rather
 *  than importing the `highlight-snippet` client component into this server
 *  module. */
function stripNonMarkTags(s: string): string {
  return s.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
}

/** Tier 3 — pick the best non-title text-field highlight fragment and return a
 *  clamped, mark-aware snippet. Precedence abstract → keywordsText →
 *  sponsorText. A field is only evidence when its first fragment actually
 *  carries a `<mark>` (OpenSearch can return a fragment with no mark on a
 *  partial highlight). Returns null when no text field produced a marked
 *  fragment. */
function pickTextEvidence(
  highlight: { abstract?: string[]; keywordsText?: string[]; sponsorText?: string[] } | undefined,
): { field: "abstract" | "keywordsText" | "sponsorText"; snippet: string } | null {
  if (!highlight) return null;
  const order: Array<"abstract" | "keywordsText" | "sponsorText"> = [
    "abstract",
    "keywordsText",
    "sponsorText",
  ];
  for (const field of order) {
    const frag = highlight[field]?.[0];
    if (!frag || !frag.includes("<mark>")) continue;
    const snippet = clampAroundMarks(stripNonMarkTags(frag), TEXT_EVIDENCE_MAX_LEN);
    if (!snippet.includes("<mark>")) continue; // defensive: clamp dropped the mark
    return { field, snippet };
  }
  return null;
}

export async function searchFunding(opts: {
  q: string;
  page?: number;
  sort?: FundingSort;
  filters?: FundingFilters;
  /**
   * Issue #295 — MeSH resolution for `q`, computed once by the route handler
   * / SSR page (the same value passed to `searchPublications`). When
   * `SEARCH_FUNDING_TAB_CONCEPT=on` and this resolves to a descriptor, the
   * funding query gains an OR-of-evidence clause matching grants by
   * `meshDescriptorUi`. Null/undefined → today's text-only query.
   */
  meshResolution?: MeshResolution | null;
  /**
   * PLAN R5 / handoff item 3 — the user-facing match scope. Drives the funding
   * result-SET admission so the list AND the badge shrink under the non-default
   * scopes:
   *   - `exact`    → literal text admission only (drops the #295 concept clause).
   *   - `expanded` → today's #295 union (text OR `meshDescriptorUi` descendants);
   *                  byte-identical to the pre-gate body and the headless default.
   *   - `concept`  → concept-only admission via the `meshDescriptorUi` terms set.
   * Concept gating here rides the grant's RePORTER project-keyword descriptors
   * (`meshDescriptorUi`), NOT funded-publication MeSH — that signal isn't
   * indexed yet (see the `// TODO(P4)` below). Both the concept and exact
   * branches only diverge from `expanded` when the concept flag is on AND `q`
   * resolved to a descriptor; otherwise all three collapse to text-only, exactly
   * as today. Absent ⇒ `expanded`.
   */
  scope?: Scope;
  /**
   * Perf — count-only mode for the inactive search tabs. See the
   * `searchPeople` `countOnly` doc: skips the facet aggregations and the
   * Prisma investigator hydration, returning just `total` for the tab
   * badge. The total comes from the same query predicate, so it matches a
   * full search.
   */
  countOnly?: boolean;
}): Promise<FundingSearchResult> {
  const { q } = opts;
  const page = Math.max(0, opts.page ?? 0);
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();
  const now = new Date();

  // Main query. The text clause matches title / sponsor / people / abstract /
  // keywords via multi_match. User-axis filters live in post_filter so each
  // per-facet aggregation can re-apply only the OTHER axes and produce correct
  // excluding-self counts.
  // Tier 1 (relevance gate). When SEARCH_FUNDING_TAB_MSM is on, the funding
  // multi_match gains the same minimum_should_match floor the publications tab
  // uses (PUBLICATIONS_RESTRUCTURED_MSM) so a multi-token query can't be admitted
  // by ONE stemmed token in one field (e.g. `natural language processing`
  // matching a kidney grant on `processing`->`process`), and the abstract boost
  // drops ^1 -> ^0.5 (matching the pub-tab abstract weight) so a passing abstract
  // mention can't dominate a direct title hit. Both are local to this clause: the
  // shared FUNDING_FIELD_BOOSTS constant is NOT mutated (other call sites read it).
  // Flag off => `fields` is the unchanged constant and the conditional spread is
  // empty, so the emitted body is byte-identical to today.
  const useFundingMsm = resolveFundingTabMsm();
  const fundingFields = useFundingMsm
    ? FUNDING_FIELD_BOOSTS.map((f) => (f === "abstract^1" ? "abstract^0.5" : f))
    : [...FUNDING_FIELD_BOOSTS];
  const textClause: Record<string, unknown> =
    trimmed.length > 0
      ? {
          multi_match: {
            query: trimmed,
            fields: fundingFields,
            type: "best_fields",
            ...(useFundingMsm
              ? {
                  operator: "or",
                  minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
                }
              : {}),
          },
        }
      : { match_all: {} };

  // Issue #295 — OR-of-evidence. When the funding concept flag is on and `q`
  // resolved to a MeSH descriptor, wrap the text clause so a grant tagged
  // with the resolved descriptor (or a tree descendant) is admitted even
  // without a text hit. Kept INSIDE `must` (rather than promoted to a
  // top-level should + msm, as the pub tab does for its SPEC §5.2
  // byte-identical body): `must` stays non-empty, so the excluding-self
  // aggregations below — `{ bool: { must, filter } }` — need no shape change.
  // Flag off / no resolution / empty descendant set → text-only, byte-
  // identical to the pre-#295 query.
  const meshResolution = opts.meshResolution ?? null;
  // PLAN R5 / handoff item 3 — the user-facing match scope drives funding
  // result-SET admission. `expanded` (and the headless default) is byte-
  // identical to the pre-gate #295 body below; `exact`/`concept` only diverge
  // when the concept clause would have applied (flag on + resolved descriptor).
  const scope = opts.scope ?? "expanded";
  const must: Record<string, unknown>[] = [textClause];
  // The concept evidence set: grants whose MeSH ∩ the resolved descriptor's
  // descendant set is non-empty. Which funding-index field carries that MeSH is
  // chosen by `SEARCH_FUNDING_MESH_GATE` (resolveFundingMeshGateField):
  //   - default `meshDescriptorUi` — RePORTER *project* keywords (always
  //     present; the only MeSH-shaped field pre-reindex).
  //   - `fundedPubMeshUi` — the MeSH of the grant's *funded publications*,
  //     matching the "X of Y funded publications" reason. Flip the env var only
  //     AFTER the funding index is reindexed with that field (funding-projection.ts),
  //     or concept results go empty (absent field → no doc matches).
  const conceptClauseApplies =
    resolveFundingConceptEnabled() &&
    meshResolution !== null &&
    meshResolution.descendantUis.length > 0;
  const meshGateField = resolveFundingMeshGateField();
  // PLAN P4 — tag the concept-admission `terms` clause with a query name so the
  // hit map can read `matched_queries` and distinguish a concept hit from a
  // literal-text hit. `_name` is pure metadata: it does NOT change the clause's
  // score, so the `expanded` body stays byte-identical to today AT THE DEFAULT
  // gate field (`meshDescriptorUi`); the `fundedPubMeshUi` opt-in deliberately
  // changes the admission field. Only attached when the reason flag is on,
  // keeping the flag-off body byte-identical to today.
  const conceptName = resolveFundingMatchReason() ? { _name: "concept" } : {};
  if (conceptClauseApplies && scope === "concept") {
    // Concept-only admission: drop the literal-text predicate, admit purely by
    // descriptor topicality. The terms set is byte-identical to the `should`
    // sub-clause `expanded` uses, so the badge/list ride the same evidence set.
    must[0] = {
      terms: {
        [meshGateField]: meshResolution.descendantUis,
        ...conceptName,
      },
    };
  } else if (conceptClauseApplies && scope !== "exact") {
    // `expanded` (default) — today's #295 union: text OR descriptor-tagged.
    // Byte-identical to the pre-gate body at the default gate field. `exact`
    // deliberately skips this branch and rides the bare `[textClause]`
    // literal-only admission.
    must[0] = {
      bool: {
        should: [
          textClause,
          {
            terms: {
              [meshGateField]: meshResolution.descendantUis,
              boost: 4,
              ...conceptName,
            },
          },
        ],
        minimum_should_match: 1,
      },
    };
  }

  // TIER 2 — phrase-first ranking. A pure scoring `should` (NO
  // `minimum_should_match`) so it can never change which documents are
  // admitted: a contiguous-phrase title/abstract hit gets a strong score boost
  // over a doc that merely scatters the same tokens via the `must` multi_match.
  // Lives on the SAME bool as `must` (added in the body assembly below). The
  // facet aggregations and the countOnly path read `must` directly, so the
  // admission set AND every excluding-self facet count stay byte-identical to
  // the flag-off body. Omitted entirely (empty array → no `should` key) when the
  // flag is off or `q` is empty (a phrase on `match_all` is meaningless).
  // No reindex: `title` / `abstract` are analyzed text in `fundingIndexMapping`.
  const phraseShould: Record<string, unknown>[] =
    resolveFundingPhraseBoost() && trimmed.length > 0
      ? [
          { match_phrase: { title: { query: trimmed, boost: 6 } } },
          { match_phrase: { abstract: { query: trimmed, boost: 2 } } },
        ]
      : [];

  // Named filter clauses — built once, re-used for post_filter and for
  // each per-facet excluding-self aggregation.
  const funderClause =
    filters.funder && filters.funder.length > 0
      ? { terms: { primeSponsor: filters.funder } }
      : null;
  const directFunderClause =
    filters.directFunder && filters.directFunder.length > 0
      ? { terms: { directSponsor: filters.directFunder } }
      : null;
  const programTypeClause =
    filters.programType && filters.programType.length > 0
      ? { terms: { programType: filters.programType } }
      : null;
  const mechanismClause =
    filters.mechanism && filters.mechanism.length > 0
      ? { terms: { mechanism: filters.mechanism } }
      : null;
  const statusClause = filters.status && filters.status.length > 0
    ? statusToFilterClause(filters.status, now)
    : null;
  const departmentClause =
    filters.department && filters.department.length > 0
      ? { terms: { department: filters.department } }
      : null;
  const roleClause =
    filters.role && filters.role.length > 0
      ? { terms: { roles: filters.role } }
      : null;
  const investigatorClause =
    filters.investigator && filters.investigator.length > 0
      ? { terms: { wcmInvestigatorCwids: filters.investigator } }
      : null;

  const userAxisFilters: Record<string, unknown>[] = [];
  if (funderClause) userAxisFilters.push(funderClause);
  if (directFunderClause) userAxisFilters.push(directFunderClause);
  if (programTypeClause) userAxisFilters.push(programTypeClause);
  if (mechanismClause) userAxisFilters.push(mechanismClause);
  if (statusClause) userAxisFilters.push(statusClause);
  if (departmentClause) userAxisFilters.push(departmentClause);
  if (roleClause) userAxisFilters.push(roleClause);
  if (investigatorClause) userAxisFilters.push(investigatorClause);

  type Axis =
    | "funder"
    | "directFunder"
    | "programType"
    | "mechanism"
    | "status"
    | "department"
    | "role"
    | "investigator";

  const filtersExcept = (axis: Axis): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "funder" && funderClause) out.push(funderClause);
    if (axis !== "directFunder" && directFunderClause) out.push(directFunderClause);
    if (axis !== "programType" && programTypeClause) out.push(programTypeClause);
    if (axis !== "mechanism" && mechanismClause) out.push(mechanismClause);
    if (axis !== "status" && statusClause) out.push(statusClause);
    if (axis !== "department" && departmentClause) out.push(departmentClause);
    if (axis !== "role" && roleClause) out.push(roleClause);
    if (axis !== "investigator" && investigatorClause) out.push(investigatorClause);
    return out;
  };

  // Sort. relevance falls through to default _score; endDate uses a
  // script sort so active grants surface first (the 12-month NCE grace
  // means the active threshold is `endDate + 365d > now`); startDate
  // sorts newest-first.
  const sortClause: Record<string, unknown>[] = [];
  if (sort === "endDate") {
    sortClause.push({
      _script: {
        type: "number",
        script: {
          source:
            "doc['endDate'].size() == 0 ? 1 : (doc['endDate'].value.toInstant().toEpochMilli() + params.grace > params.now ? 0 : 1)",
          params: {
            now: now.getTime(),
            grace: NCE_GRACE_MS,
          },
        },
        order: "asc",
      },
    });
    sortClause.push({ endDate: "asc" });
  } else if (sort === "startDate") {
    sortClause.push({ startDate: "desc" });
  } else if (sort === "pubCount") {
    // Most-publications first. Ties broken by endDate desc so an active
    // grant with the same count surfaces above a completed one.
    sortClause.push({ pubCount: "desc" });
    sortClause.push({ endDate: "desc" });
  }

  // Status agg — three separate filter aggs since each "bucket" is a
  // date range, not a discrete keyword. Each excludes the status axis
  // from its filter chain so ticking "Active" doesn't zero out the
  // "Ending in 12 months" count.
  const statusBaseFilters = filtersExcept("status");
  const activeRange: Record<string, unknown> = {
    range: { endDate: { gt: new Date(now.getTime() - NCE_GRACE_MS).toISOString() } },
  };
  const endingSoonRange: Record<string, unknown> = {
    range: {
      endDate: {
        gte: now.toISOString(),
        lte: new Date(now.getTime() + ENDING_SOON_MS).toISOString(),
      },
    },
  };
  const recentlyEndedRange: Record<string, unknown> = {
    range: {
      endDate: {
        gte: new Date(now.getTime() - RECENTLY_ENDED_WINDOW_MS).toISOString(),
        lt: new Date(now.getTime() - NCE_GRACE_MS).toISOString(),
      },
    },
  };

  const aggs: Record<string, unknown> = {
    funders: {
      filter: { bool: { must, filter: filtersExcept("funder") } },
      aggs: { keys: { terms: { field: "primeSponsor", size: 50 } } },
    },
    directFunders: {
      filter: { bool: { must, filter: filtersExcept("directFunder") } },
      aggs: { keys: { terms: { field: "directSponsor", size: 50 } } },
    },
    programTypes: {
      filter: { bool: { must, filter: filtersExcept("programType") } },
      aggs: { keys: { terms: { field: "programType", size: 20 } } },
    },
    mechanisms: {
      filter: { bool: { must, filter: filtersExcept("mechanism") } },
      aggs: { keys: { terms: { field: "mechanism", size: 30 } } },
    },
    departments: {
      filter: { bool: { must, filter: filtersExcept("department") } },
      aggs: { keys: { terms: { field: "department", size: 30 } } },
    },
    roleBuckets: {
      filter: { bool: { must, filter: filtersExcept("role") } },
      aggs: { keys: { terms: { field: "roles", size: 5 } } },
    },
    // Issue #94 — Investigator facet. Top 500 mirrors the Author facet
    // on the Publications search; client-side typeahead narrows further.
    // Cardinality sub-agg surfaces the true distinct count for the rail
    // header so the user sees the full scope of the facet.
    investigators: {
      filter: { bool: { must, filter: filtersExcept("investigator") } },
      aggs: {
        keys: { terms: { field: "wcmInvestigatorCwids", size: 500 } },
        total: {
          cardinality: { field: "wcmInvestigatorCwids", precision_threshold: 4000 },
        },
      },
    },
    statusActive: {
      filter: { bool: { must, filter: [...statusBaseFilters, activeRange] } },
    },
    statusEndingSoon: {
      filter: { bool: { must, filter: [...statusBaseFilters, endingSoonRange] } },
    },
    statusRecentlyEnded: {
      filter: { bool: { must, filter: [...statusBaseFilters, recentlyEndedRange] } },
    },
  };

  // Perf — count-only fast path (inactive tab). Same `{ bool: { must } }`
  // query as the full body, so the badge total is identical; skips the
  // facet aggregations and the Prisma investigator hydration below.
  if (opts.countOnly) {
    const countResp = await searchClient().search({
      index: FUNDING_INDEX,
      body: {
        size: 0,
        track_total_hits: true,
        query: { bool: { must } },
      } as object,
    });
    const total =
      (countResp.body as unknown as { hits: { total: { value: number } } })
        .hits.total.value;
    return {
      hits: [],
      total,
      page,
      pageSize: PAGE_SIZE,
      facets: {
        funders: [],
        directFunders: [],
        programTypes: [],
        mechanisms: [],
        status: { active: 0, endingSoon: 0, recentlyEnded: 0 },
        departments: [],
        roles: { pi: 0, multiPi: 0, coI: 0 },
        investigators: [],
        investigatorsTotal: 0,
      },
    };
  }

  // PLAN P4 — funding has no title highlight today (only `sanitizePubTitle`).
  // Add one so a literal title hit is self-evident on the row and correctly
  // suppresses the reason line (mirrors `searchPublications`). `highlight_query`
  // is a plain `match` on the trimmed query so the marked terms reflect the
  // literal text hit, independent of the concept-admission `should` clause.
  // Omitted when the flag is off / query is empty ⇒ body byte-identical to today.
  const matchReason = resolveFundingMatchReason();
  const wantTitleHighlight = matchReason && trimmed.length > 0;
  // Tier 3 — also highlight the text fields (abstract / keywordsText /
  // sponsorText) so a grant matched ONLY on text still shows a reason line.
  const wantTextEvidence = resolveFundingTextEvidence() && trimmed.length > 0;
  const anyHighlight = wantTitleHighlight || wantTextEvidence;

  // Per-field highlight config. `title` keeps the whole-field fragment
  // (`number_of_fragments: 0`) as today; the text fields use a single best
  // fragment (`number_of_fragments: 1`, default fragment_size) since abstracts
  // are long. Each field carries its OWN `highlight_query` `match` so the marks
  // reflect the literal text hit, independent of the concept-admission clause.
  // #1351 — mark the literal query AND (when one resolved) the concept term the
  // grant actually matched on. Widen the per-field `highlight_query` to a should of
  // [literal `match`, concept `match_phrase`]; collapses to the bare literal `match`
  // (byte-identical to before) when no concept resolved. Highlight-only — admission
  // and ranking are untouched. `sponsorText` stays literal-only (a MeSH descriptor
  // is not a sponsor name).
  const conceptLabel = meshResolution?.name ?? "";
  const hlFieldQuery = (field: string) =>
    conceptLabel.length > 0
      ? { bool: { should: [{ match: { [field]: trimmed } }, { match_phrase: { [field]: conceptLabel } }] } }
      : { match: { [field]: trimmed } };

  const highlightFields: Record<string, unknown> = {};
  if (wantTitleHighlight) {
    highlightFields.title = {
      number_of_fragments: 0,
      highlight_query: hlFieldQuery("title"),
    };
  }
  if (wantTextEvidence) {
    highlightFields.abstract = {
      number_of_fragments: 1,
      highlight_query: hlFieldQuery("abstract"),
    };
    highlightFields.keywordsText = {
      number_of_fragments: 1,
      highlight_query: hlFieldQuery("keywordsText"),
    };
    highlightFields.sponsorText = {
      number_of_fragments: 1,
      highlight_query: { match: { sponsorText: trimmed } },
    };
  }

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    track_total_hits: true,
    // TIER 2 — `phraseShould` rides as a top-level `should` on the SAME bool as
    // `must`. With no `minimum_should_match`, a bool that already matches via
    // `must` is NOT filtered by the should — it only adds to `_score`. Spread is
    // empty (key omitted) when the phrase-boost flag is off / q is empty, so the
    // off-path body is byte-identical to today.
    query: { bool: { must, ...(phraseShould.length > 0 ? { should: phraseShould } : {}) } },
    ...(userAxisFilters.length > 0
      ? { post_filter: { bool: { filter: userAxisFilters } } }
      : {}),
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    // Tier 3 keeps the highlight request byte-identical to the pre-Tier-3
    // match-reason path UNLESS the text-evidence flag is on. With text evidence
    // OFF we emit the original top-level `highlight_query` + single `title`
    // field shape, so the DEFAULT-ON `SEARCH_FUNDING_MATCH_REASON` request is
    // unchanged (no structural drift on the live path). Only when
    // `SEARCH_FUNDING_TEXT_EVIDENCE` is on do we switch to the per-field shape
    // (title carries its own `highlight_query`, plus the abstract/keyword/sponsor
    // fields) — that change rides entirely behind the new flag.
    ...(anyHighlight
      ? {
          highlight: wantTextEvidence
            ? {
                fields: highlightFields,
                pre_tags: ["<mark>"],
                post_tags: ["</mark>"],
              }
            : {
                fields: { title: { number_of_fragments: 0 } },
                highlight_query: hlFieldQuery("title"),
                pre_tags: ["<mark>"],
                post_tags: ["</mark>"],
              },
        }
      : {}),
    aggs,
  };

  const resp = await searchClient().search({
    index: FUNDING_INDEX,
    body: body as object,
  });

  type StoredPerson = {
    cwid: string;
    slug: string;
    preferredName: string;
    role: string;
  };
  type Hit = {
    /** PLAN P4 — OpenSearch named-query provenance: which `_name`-tagged
     *  clauses this hit matched. Present only when the reason flag tagged a
     *  clause (the concept admission); a literal-text hit is read off
     *  `highlight.title` instead. */
    matched_queries?: string[];
    /** PLAN P4 — title highlight fragments under `SEARCH_FUNDING_MATCH_REASON`.
     *  Tier 3 — abstract/keywordsText/sponsorText fragments under
     *  `SEARCH_FUNDING_TEXT_EVIDENCE`. */
    highlight?: {
      title?: string[];
      abstract?: string[];
      keywordsText?: string[];
      sponsorText?: string[];
    };
    _source: {
      projectId: string;
      title: string;
      primeSponsor: string;
      primeSponsorRaw: string | null;
      directSponsor: string | null;
      isSubaward: boolean;
      programType: string;
      mechanism: string | null;
      nihIc: string | null;
      awardNumber: string | null;
      startDate: string;
      endDate: string;
      isMultiPi: boolean;
      department: string | null;
      totalPeople: number;
      people: StoredPerson[];
      pubCount: number;
      abstract: string | null;
      abstractSource: string | null;
      applId: number | null;
      publications: Array<{
        pmid: string;
        title: string;
        journal: string | null;
        year: number | null;
        citationCount: number;
        isLowerConfidence: boolean;
      }>;
    };
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      funders?: { keys: { buckets: Bucket[] } };
      directFunders?: { keys: { buckets: Bucket[] } };
      programTypes?: { keys: { buckets: Bucket[] } };
      mechanisms?: { keys: { buckets: Bucket[] } };
      departments?: { keys: { buckets: Bucket[] } };
      roleBuckets?: { keys: { buckets: Bucket[] } };
      statusActive?: { doc_count: number };
      statusEndingSoon?: { doc_count: number };
      statusRecentlyEnded?: { doc_count: number };
      investigators?: {
        keys: { buckets: Bucket[] };
        total: { value: number };
      };
    };
  };

  // #536 — the funding index stores no role category on its `people`, so
  // enrich the per-row investigator chips with one bounded DB lookup (mirrors
  // the investigator-facet hydration below) to suppress profile links for
  // hidden identity classes.
  const personCwids = [
    ...new Set(r.hits.hits.flatMap((h) => (h._source.people ?? []).map((p) => p.cwid))),
  ];
  // Issue #94 — the investigator-facet bucket cwids (aggregation top-500 plus
  // any active selections). Computed here so its display-name hydration can run
  // concurrently with the per-row `roleByCwid` lookup above — two independent
  // Prisma reads against different cwid sets, no data dependency between them.
  const investigatorBuckets = r.aggregations?.investigators?.keys.buckets ?? [];
  const facetCwids = new Set(investigatorBuckets.map((b) => b.key));
  if (filters.investigator) for (const c of filters.investigator) facetCwids.add(c);
  const facetCwidList = Array.from(facetCwids);
  const [roleRows, facetScholarRows] = await Promise.all([
    personCwids.length > 0
      ? prisma.scholar.findMany({
          where: { cwid: { in: personCwids } },
          select: { cwid: true, roleCategory: true },
        })
      : Promise.resolve([] as { cwid: string; roleCategory: string | null }[]),
    facetCwidList.length === 0
      ? Promise.resolve([] as { cwid: string; preferredName: string; slug: string }[])
      : prisma.scholar.findMany({
          where: { cwid: { in: facetCwidList }, deletedAt: null, status: "active" },
          select: { cwid: true, preferredName: true, slug: true },
        }),
  ]);
  const roleByCwid = new Map(roleRows.map((s) => [s.cwid, s.roleCategory]));

  // PLAN P4 — funded-outputs count X (per project), at QUERY TIME, no reindex.
  // The funding hit already carries each grant's funded pmids (`publications[]`),
  // and the publications index has `pmid` + `meshDescriptorUi` (funded-pub MeSH).
  // So one aggregation against the pub index counts, per project, the distinct
  // funded pmids whose MeSH intersects the resolved descendant set — the same
  // query-time `cardinality(pmid)` trick `searchPeople` uses for its scholar
  // reason counts. The pub index has no project key, so we bucket with a
  // `filters` agg: one named filter per project scoped to that project's pmid
  // set, each carrying a `cardinality(pmid)` sub-agg, all under a top-level
  // `meshDescriptorUi` ∩ descendantUis filter. Distinct-pmid throughout (never
  // a summed per-UI count) per MEMORY #651.
  //
  // CAVEAT (bounded): the stored `publications[]` is capped at PUB_LIST_CAP=250
  // while `pubCount` (Y) is uncapped, so a mega-grant's X is computed only over
  // the capped pmid set → a possible X-vs-Y undercount on a handful of grants.
  // `Math.min(X, pubCount)` keeps the phrasing coherent; the common case is exact.
  const descendantUis = meshResolution?.descendantUis ?? [];
  const fundedOutputs = new Map<string, number>();
  if (matchReason && descendantUis.length > 0 && r.hits.hits.length > 0) {
    const pmidsByProject = new Map<string, string[]>();
    const allPmids = new Set<string>();
    for (const h of r.hits.hits) {
      const pmids = [
        ...new Set((h._source.publications ?? []).map((p) => p.pmid).filter(Boolean)),
      ];
      if (pmids.length === 0) continue;
      pmidsByProject.set(h._source.projectId, pmids);
      for (const p of pmids) allPmids.add(p);
    }
    if (allPmids.size > 0) {
      const projectFilters: Record<string, unknown> = {};
      for (const [projectId, pmids] of pmidsByProject) {
        projectFilters[projectId] = { terms: { pmid: pmids } };
      }
      const aggResp = await searchClient().search({
        index: PUBLICATIONS_INDEX,
        body: {
          size: 0,
          query: {
            bool: {
              filter: [
                { terms: { pmid: [...allPmids] } },
                { terms: { meshDescriptorUi: descendantUis } },
              ],
            },
          },
          aggs: {
            byProject: {
              filters: { filters: projectFilters },
              aggs: { d: { cardinality: { field: "pmid" } } },
            },
          },
        } as object,
      });
      const buckets =
        (
          aggResp.body as {
            aggregations?: {
              byProject?: {
                buckets?: Record<string, { d?: { value?: number } }>;
              };
            };
          }
        ).aggregations?.byProject?.buckets ?? {};
      for (const [projectId, b] of Object.entries(buckets)) {
        fundedOutputs.set(projectId, b.d?.value ?? 0);
      }
    }
  }

  const hits: FundingHit[] = r.hits.hits.map((h) => {
    const src = h._source;
    const endDate = new Date(src.endDate);
    const pubCount = src.pubCount ?? 0;
    // PLAN P4 — three distinct admission paths, kept separate so the row never
    // conflates a keyword-concept hit with a funded-output hit:
    //   literal-title ← title highlight presence (self-evident → suppresses reason)
    //   concept       ← `matched_queries` carries the `_name:"concept"` tag
    //   funded-outputs← the query-time pub-index agg (X), capped at Y for "X of Y"
    // All gated on `matchReason` so the flag-off contract is inert regardless of
    // what the index happens to return.
    const titleHighlight = matchReason ? (h.highlight?.title?.[0] ?? null) : null;
    // `conceptClauseApplies` guards against a stale index response: the
    // `_name:"concept"` clause is only emitted when a concept actually resolved,
    // so a `matched_queries` tag is only meaningful then.
    const matchedConcept =
      matchReason && conceptClauseApplies && (h.matched_queries ?? []).includes("concept");
    const matchedFundedPubs = matchReason
      ? Math.min(fundedOutputs.get(src.projectId) ?? 0, pubCount)
      : 0;
    // Tier 3 — abstract/keyword/sponsor text-hit snippet, only under the flag.
    const textEvidence = wantTextEvidence ? pickTextEvidence(h.highlight) : null;
    return {
      projectId: src.projectId,
      title: src.title,
      primeSponsor: src.primeSponsor,
      primeSponsorRaw: src.primeSponsorRaw,
      directSponsor: src.directSponsor,
      isSubaward: src.isSubaward,
      programType: src.programType,
      mechanism: src.mechanism,
      nihIc: src.nihIc,
      awardNumber: src.awardNumber,
      startDate: src.startDate.slice(0, 10),
      endDate: src.endDate.slice(0, 10),
      isActive: isFundingActive(endDate, now),
      status: statusForGrant(endDate, now),
      isMultiPi: src.isMultiPi,
      department: src.department,
      totalPeople: src.totalPeople,
      pubCount,
      abstract: src.abstract ?? null,
      abstractSource: src.abstractSource ?? null,
      applId: src.applId ?? null,
      publications: src.publications ?? [],
      coreProjectNum: coreProjectNum(src.awardNumber),
      titleHighlight,
      matchedLiteralTitle: titleHighlight !== null,
      matchedConcept,
      matchedFundedPubs,
      textEvidence,
      people: (src.people ?? []).map((p) => ({
        cwid: p.cwid,
        slug: p.slug,
        preferredName: p.preferredName,
        role: p.role,
        identityImageEndpoint: identityImageEndpoint(p.cwid),
        roleCategory: roleByCwid.get(p.cwid) ?? null,
      })),
    };
  });

  // Role bucket map — convert keyword agg to the named structure.
  const roleBucketMap = new Map<string, number>(
    (r.aggregations?.roleBuckets?.keys.buckets ?? []).map((b) => [b.key, b.doc_count]),
  );

  // Issue #94 — hydrate Investigator facet buckets with display name +
  // slug + avatar. `investigatorBuckets` / `facetCwidList` / `facetScholarRows`
  // were resolved above (the facet display-name lookup runs in the same
  // Promise.all as the per-row role lookup). Active selections may not appear in
  // the top-500 result set, so they were already folded into `facetCwidList`.
  const scholarByCwid = new Map(facetScholarRows.map((s) => [s.cwid, s]));
  const investigators: WcmInvestigatorFacetBucket[] = investigatorBuckets.flatMap((b) => {
    const s = scholarByCwid.get(b.key);
    if (!s) return []; // scholar deleted/suppressed since the index was built
    return [{
      cwid: s.cwid,
      displayName: s.preferredName,
      slug: s.slug,
      identityImageEndpoint: identityImageEndpoint(s.cwid),
      count: b.doc_count,
    }];
  });
  // Surface active selections even with zero count so the rail can pin
  // them in the selected section after other filters knock their count
  // to zero (or below the top-500 cutoff).
  if (filters.investigator) {
    const present = new Set(investigators.map((b) => b.cwid));
    for (const cwid of filters.investigator) {
      if (present.has(cwid)) continue;
      const s = scholarByCwid.get(cwid);
      if (!s) continue;
      investigators.push({
        cwid: s.cwid,
        displayName: s.preferredName,
        slug: s.slug,
        identityImageEndpoint: identityImageEndpoint(s.cwid),
        count: 0,
      });
    }
  }

  return {
    hits,
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    facets: {
      funders: (r.aggregations?.funders?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        label: b.key,
        count: b.doc_count,
      })),
      directFunders: (r.aggregations?.directFunders?.keys.buckets ?? []).map(
        (b) => ({ value: b.key, label: b.key, count: b.doc_count }),
      ),
      programTypes: (r.aggregations?.programTypes?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      mechanisms: (r.aggregations?.mechanisms?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      status: {
        active: r.aggregations?.statusActive?.doc_count ?? 0,
        endingSoon: r.aggregations?.statusEndingSoon?.doc_count ?? 0,
        recentlyEnded: r.aggregations?.statusRecentlyEnded?.doc_count ?? 0,
      },
      departments: (r.aggregations?.departments?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      roles: {
        pi: roleBucketMap.get("PI") ?? 0,
        multiPi: roleBucketMap.get("Multi-PI") ?? 0,
        coI: roleBucketMap.get("Co-I") ?? 0,
      },
      investigators,
      investigatorsTotal: r.aggregations?.investigators?.total.value ?? 0,
    },
  };
}
