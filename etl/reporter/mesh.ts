/**
 * Issue #295 — resolve a grant's RePORTER `keywords` to NLM MeSH descriptor
 * UIs.
 *
 * Pure logic (the resolver is injected, defaulting to the real one) so the
 * reporter ETL and its unit tests both import it directly — `etl/reporter/
 * index.ts` runs `main()` on import and cannot be imported from a test, the
 * same constraint that put `parseReporterTerms` in `lib/reporter-terms.ts`.
 */
import {
  normalizeForMatch,
  resolveMeshDescriptor,
  type MeshResolution,
} from "@/lib/api/search-taxonomy";

/** Mirrors MIN_QUERY_LEN in `lib/api/search-taxonomy.ts` — the resolver
 *  ignores normalized forms shorter than this, so there is no point
 *  resolving them. */
const MIN_FORM_LEN = 3;

/**
 * Raw RCDC terms whose MeSH resolution is noise. The reporter ETL's resolver
 * pass skips a keyword whose `normalizeForMatch` form matches one of these
 * *before* resolving it — so the term contributes to neither the stored
 * descriptor set nor the coverage metric.
 *
 * Seeded from `etl/reporter/mesh-probe.ts`'s top-150 most-frequent *resolving*
 * terms across the live `grant.keywords` corpus (issue #295 Open Question).
 * Kept as raw, human-readable strings — and grouped by reason — so the list
 * is auditable in PR review. Adding a term is safe (a no-op if it never
 * appears); removing one re-admits its descriptor on the next resolver run.
 */
const STOPWORD_TERMS: readonly string[] = [
  // ── MeSH check-tags ──────────────────────────────────────────────────────
  // Age group / sex / species. Describe the study population, not the topic.
  // ReciterDB strips check-tags from the publication MeSH path (#292);
  // RePORTER's `pref_terms` do not, so they are filtered here instead.
  "humans", "human", "animals", "male", "female", "child", "adult", "aged",
  "elderly", "infant", "adolescent", "middle aged", "young adult",
  "mice", "mus", "rats", "rat",
  // ── Wrong-sense resolutions ──────────────────────────────────────────────
  // The RCDC term resolves to an unrelated MeSH descriptor: "lead" → the
  // metal, "mediating" → Negotiating, "address" → the publication type,
  // "grant"/"award" → funding-administration descriptors, "play" → Play and
  // Playthings (observed on non-pediatric grants), etc.
  "address", "affect", "mediating", "future", "measures", "lead", "caring",
  "generations", "grant", "biological", "foundations", "maps", "life",
  "award", "role", "mentors", "fostering", "acceleration", "adoption",
  "nature", "elements", "guidelines", "communities", "feedback", "maintenance",
  "play",
  // ── Generic research vocabulary ──────────────────────────────────────────
  // Resolves to the correct sense, but carries no topical signal — would
  // match an enormous, undifferentiated slice of the funding corpus.
  "goals", "disease", "cells", "health", "genes", "knowledge", "methods",
  "patients", "research", "medicine", "biology", "growth", "population",
  "education", "persons", "research personnel", "biomedical research",
  "anatomy", "faculty", "physicians", "environment", "communication",
  "family", "laboratories", "public health", "pathology", "engineering",
  "incidence", "kinetics", "diagnosis", "proteins", "hospitals",
  // ── Methodology / infrastructure ─────────────────────────────────────────
  // Describe how a study is run, not what it is about.
  "in vitro", "biological assay", "cell line", "animal model",
  "biological models", "knockout mice", "data set", "interview",
  "computer software",
];

/** Normalized lookup set derived from {@link STOPWORD_TERMS}. Keyed on the
 *  `normalizeForMatch` form so it catches whatever surface variant a grant
 *  happens to carry. */
export const MESH_RESOLVE_STOPWORDS: ReadonlySet<string> = new Set(
  STOPWORD_TERMS.map(normalizeForMatch),
);

export type GrantMeshResolution = {
  /** Deduped resolved descriptor UIs in first-seen order; `null` when no
   *  keyword resolves (the value written to `grant.mesh_descriptor_uis`). */
  meshDescriptorUis: string[] | null;
  /** Resolved-form count / non-stopword unique-form count, rounded to 4 dp.
   *  `null` only when the denominator is 0 (every keyword was empty, shorter
   *  than MIN_FORM_LEN, or a stopword). `0` means "terms were tried, none
   *  resolved". */
  meshResolutionCoverage: number | null;
};

/**
 * Resolve one grant's `keywords` to MeSH descriptor UIs.
 *
 *   1. map each keyword through `normalizeForMatch`, drop forms shorter than
 *      MIN_FORM_LEN, dedupe;
 *   2. drop forms in {@link MESH_RESOLVE_STOPWORDS} — the surviving set is the
 *      coverage denominator;
 *   3. resolve each surviving form; a non-null resolution counts toward the
 *      numerator and contributes its `descriptorUi`;
 *   4. `meshDescriptorUis` = deduped descriptor UIs (first-seen order), or
 *      `null` when none resolved;
 *   5. `meshResolutionCoverage` = numerator / denominator (rounded), or `null`
 *      when the denominator is 0.
 *
 * `resolve` is injected so unit tests run without a DB or the MeSH cache.
 * Two RCDC terms can resolve to the same descriptor — the numerator counts
 * resolved *forms* while `meshDescriptorUis` holds deduped *descriptors*, so
 * the two need not have equal length.
 */
export async function resolveGrantKeywords(
  keywords: readonly string[],
  resolve: (term: string) => Promise<MeshResolution | null> = resolveMeshDescriptor,
): Promise<GrantMeshResolution> {
  const forms = new Set<string>();
  for (const kw of keywords) {
    const form = normalizeForMatch(kw);
    if (form.length < MIN_FORM_LEN) continue;
    if (MESH_RESOLVE_STOPWORDS.has(form)) continue;
    forms.add(form);
  }
  if (forms.size === 0) {
    return { meshDescriptorUis: null, meshResolutionCoverage: null };
  }

  const uis: string[] = [];
  const seenUi = new Set<string>();
  let resolvedForms = 0;
  for (const form of forms) {
    const resolution = await resolve(form);
    if (!resolution) continue;
    resolvedForms += 1;
    if (!seenUi.has(resolution.descriptorUi)) {
      seenUi.add(resolution.descriptorUi);
      uis.push(resolution.descriptorUi);
    }
  }

  return {
    meshDescriptorUis: uis.length > 0 ? uis : null,
    meshResolutionCoverage: Math.round((resolvedForms / forms.size) * 1e4) / 1e4,
  };
}
