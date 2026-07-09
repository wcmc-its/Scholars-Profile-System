/**
 * The facts contract for the overview-statement generator (#742,
 * `docs/overview-statement-generator-spec.md` + the v3.1 plan §1/§5).
 *
 * `assembleOverviewFacts(cwid, selection?)` reads the scholar's live Scholars
 * data and shapes it into the ONLY input the model ever sees
 * (`lib/edit/overview-generator.ts` serializes it as a data block, never as
 * instructions). Nothing here is invented: every field maps to a column. A null
 * value is omitted by the prompt, never guessed.
 *
 * **v3.1 grounding shift (decision 4):** the model is grounded on ReciterAI
 * *distilled* signals — per publication a one-line `synopsis`, an
 * `impactJustification`, and a `topicRationale` — NOT the raw 400-char abstract,
 * which is dropped. The candidate pool is the scholar's **scored** publications
 * (those carrying an impact score / synopsis from ReciterAI), which is exactly
 * the bio-worthy set; the default selection is their **first/last-author** scored
 * work (the ReciterAI-POC `pipeline_person_synopsis` quality gate). The scholar
 * can override the default through the Sources drawer (`selection`).
 *
 * `methods` are the scholar's #799 method families — the live `scholar_family`
 * rollup, the SAME data the public Methods & tools panel shows (#886) — degrading
 * to `[]` when the scholar has none. `facultyMetrics` arrives in C3 (the ETL that
 * lands the DynamoDB `FACULTY#` signal); until then it is null.
 *
 * Read-only — this module performs NO write. Node-runtime only (Prisma).
 */
import { db } from "@/lib/db";
import { familyOverlayKey } from "@/lib/api/methods-overlay";
import { scoreFundingImportance } from "@/lib/edit/funding-importance";
import { isChairTitleFor } from "@/lib/leadership";
import {
  applyDeltas,
  OVERVIEW_METHOD_PMID_FLOOR,
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  type OverviewPositionMode,
  type OverviewSelection,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";
import {
  rankRepresentativePublications,
  type RepresentativeRanked,
  type RepresentativeTier,
} from "@/lib/edit/overview-representative";

/** How many parent topics the facts payload carries. */
const TOPIC_LIMIT = 4;
/** The combined publications + funding ceiling on what the model sees (decision 3). */
const REPRESENTATIVE_LIMIT = OVERVIEW_SELECTION_MAX_ITEMS;

/** A publication's author role, derived from `PublicationAuthor.isFirst/isLast`. */
export type OverviewAuthorPosition = "first" | "last" | "middle";

/**
 * The facts contract — `assembleOverviewFacts`'s output, and the model's only
 * input.
 *
 * NOTE: there is deliberately NO `abstractExcerpt` (v3.1 decision 4 — distilled
 * signals replace the raw abstract). `methods` are LIVE from the `scholar_family`
 * rollup (#886) and `facultyMetrics` is populated from the `FACULTY#` scale ETL —
 * both reach the model, so the #742 grounding rules treat them as nameable FACTS.
 */
export type OverviewFacts = {
  // --- identity (authoritative, from ED — NEVER taken from a source bio) ---
  name: string;
  title: string | null;
  department: string | null;

  // --- research signal (the quality lever) ---
  /** Top parent topics by distinct-pmid count, each with one representative rationale. */
  topics: { label: string; rationale: string | null }[];
  /** The selected (or default first/last-author scored) publications, impact desc.
   *  Grounded on ReciterAI distilled signals — no raw abstract. PMID-keyed (v3.1). */
  representativePublications: {
    pmid: string;
    title: string;
    venue: string | null;
    year: number | null;
    impact: number | null;
    /** One-line plain-language synopsis (ReciterAI `IMPACT#`, SPS-mirrored). */
    synopsis: string | null;
    /** Natural-language impact justification (ReciterAI `IMPACT#`, SPS-mirrored). */
    impactJustification: string | null;
    /** "Why this work maps to topic X" (ReciterAI `TOPIC#.rationale`, SPS-mirrored). */
    topicRationale: string | null;
    /** First / last / middle author, from `PublicationAuthor`. */
    authorPosition: OverviewAuthorPosition | null;
    /** Scopus citation count (`Publication.citationCount`). #917 v6 — WITHHELD from
     *  the public overview (`toModelFacts` drops it); surfaced only by the biosketch
     *  projection as a grounded citation-magnitude signal. Optional: the loader always
     *  populates it, but older fixtures / non-loader callers may omit it. */
    citationCount?: number | null;
    /** NIH iCite Relative Citation Ratio (`reciterdb.analysis_nih`). #917 v6 — the
     *  field-normalized impact figure the biosketch may cite (judiciously); biosketch-only. */
    relativeCitationRatio?: number | null;
    /** NIH iCite percentile for the RCR. #917 v6 — biosketch-only. */
    nihPercentile?: number | null;
    /** NIH iCite cumulative citation count. #917 v6 — biosketch-only. */
    citedByCount?: number | null;
  }[];
  /** Distinct confirmed-authorship pmid count (the whole corpus, not just scored). */
  publicationCount: number;
  /** First / last publication year across the corpus. */
  yearsActive: { first: number | null; last: number | null };

  // --- funding / training ---
  /** The selected (or default PI/Co-PI) active awards. `title` is the project
   *  title (v3.1); `mechanism` the award mechanism. */
  activeGrants: {
    role: string;
    funderLabel: string;
    title: string | null;
    mechanism: string | null;
  }[];
  education: { degree: string; institution: string; field: string | null; year: number | null }[];
  /** Significant CURRENT leadership / administrative titles BEYOND the primary
   *  appointment (#742 §7). The primary title is already in `title` (the always-shown
   *  scaffolding line), so it is deliberately omitted here; this carries the
   *  *additional* roles the scholar has not hidden. Sourced from the `appointment`
   *  table (significance-thresholded), filtered by the scholar's `title` deltas,
   *  AND the org-unit leadership-FK roles (chair / chief / director / program leader
   *  recorded on the department / division / center tables, §2.5), deduped against
   *  the appointment + primary titles. `[]` when there are none. */
  titles: { title: string; organization: string }[];

  // --- methods (the scholar's #799 method families; `[]` when none) ---
  /** The selected method families — `name` is the family label, `category` its
   *  supercategory, and `examples` up to a few exemplar member-tool names the
   *  model can ground concrete prose on (#886). `exemplarContexts` (#1119) adds,
   *  for the exemplars that have one, the tool's best per-paper usage sentence
   *  (EXTRACTED publication text, grounding-eligible like `synopsis`) so the model
   *  can describe what a tool actually does instead of citing a bare name. Sourced
   *  from the live `scholar_family` rollup, the same data the public Methods panel
   *  shows; all of it is injection-safe DATA, never instructions. */
  methods: {
    name: string;
    category: string | null;
    examples: string[];
    exemplarContexts: { name: string; context: string }[];
  }[];
  /** Faculty-scale framing from ReciterAI `FACULTY#` (C3 — null until ingested). */
  facultyMetrics: {
    firstAuthorCount: number | null;
    lastAuthorCount: number | null;
    scoredPubCount: number | null;
    hIndex: number | null;
  } | null;

  // --- OPTIONAL enrichment: an existing human-written bio, when one exists ---
  existingBio: { text: string; source: string } | null;
};

/** A drawer candidate publication (the light shape the Sources picker renders).
 *  Since the #742 Phase 2c flip the picker + client resolver drive off `featured`
 *  (the §5.1 auto-set). `defaultSelected` is RETAINED — the v3.1 first/last-impact
 *  rule — as a stable, back-compatible flag (and the loader still emits it), but it
 *  no longer governs what the drawer pre-includes; `featured` does. */
export type OverviewSourcePublication = {
  pmid: string;
  title: string;
  venue: string | null;
  year: number | null;
  impact: number | null;
  isFirstOrLast: boolean;
  /** first / last / middle — drives the drawer's author marker. */
  authorPosition: OverviewAuthorPosition | null;
  /** Whether this row is pre-checked when the drawer opens (the v3.1 default). */
  defaultSelected: boolean;
  /** §5.1 position in the Recommended order (0-based). */
  recommendedRank?: number;
  /** §4.2 coarse weight — BACKEND framing only, never a user-facing number. */
  tier?: RepresentativeTier;
  /** Top impact-quantile work, protected from recency decay + coverage drop. */
  isLandmark?: boolean;
  /** In the §5.1 auto-set (the Feedstock tier the three-state UI features). */
  featured?: boolean;
  /** Numberless "why this?" copy (§3.2). */
  reason?: string;
};

/** A drawer candidate funding award. `featured`/`reason` are the §5.1-era
 *  additive fields; `defaultSelected` stays the current lead-role rule. */
export type OverviewSourceFunding = {
  id: string;
  role: string;
  funder: string;
  title: string | null;
  award: string | null;
  endYear: number | null;
  defaultSelected: boolean;
  /** Mirrors `defaultSelected` today (active lead-role award); a distinct field so
   *  the three-state UI can read featured-ness uniformly across types. */
  featured?: boolean;
  reason?: string;
};

/** A drawer candidate "Titles & positions" record (#742 §7 merged type). Sourced
 *  from the `appointment` table plus the org-unit leadership-FK roles (chair /
 *  chief / director / program leader, §2.5); the primary title also feeds the
 *  non-editable scaffolding line, so the drawer dedupes it. */
export type OverviewSourceTitle = {
  id: string;
  title: string;
  organization: string;
  isPrimary: boolean;
  isInterim: boolean;
  /** No end date ⇒ a current appointment. */
  isCurrent: boolean;
  endYear: number | null;
  /** Significant + current (or the primary title): the Feedstock tier. The
   *  secondary / interim / end-dated tail is Available. */
  featured: boolean;
  reason: string;
};

/** A drawer candidate education record (#742 §7 — feedstock + a hide switch). */
export type OverviewSourceEducation = {
  id: string;
  degree: string;
  institution: string;
  field: string | null;
  year: number | null;
  /** Terminal / professional degrees feature; minor certs drop to Available. */
  featured: boolean;
  reason: string;
};

/** The `GET /api/edit/overview/source-options` payload (v3.1 §4). `tools` carries
 *  the scholar's #799 method families (#886) — `[]` when the scholar has none, so
 *  the drawer's Methods section stays hidden then. The shape is unchanged from the
 *  C2 `scholar_tool` bucket so the drawer / selection / route are untouched. */
export type OverviewSourceOptions = {
  publications: OverviewSourcePublication[];
  funding: OverviewSourceFunding[];
  tools: {
    /** The method-family label — also the selection key (`selection.toolNames`). */
    toolName: string;
    /** The family supercategory. */
    category: string | null;
    pmidCount: number;
    /** Constant `1` for families (they carry no per-tool confidence); only orders
     *  ties within the tool bucket. */
    maxConfidence: number;
    /** Whether this family is pre-checked when the drawer opens (the #765 §2 floor). */
    defaultSelected: boolean;
    /** §5.1-era additive: numberless "why this?" copy for the three-state UI. */
    reason?: string;
  }[];
  /** #742 §7 merged "Titles & positions" candidates. Additive (`?`) so existing
   *  callers/fixtures are unaffected; the loader always populates it. */
  titles?: OverviewSourceTitle[];
  /** #742 §7 education candidates. Additive; the loader always populates it. */
  education?: OverviewSourceEducation[];
  /** Resolved identity for the Titles section's "Always shown" scaffold — the SAME
   *  strings the generator grounds on (`scholar.preferredName` / `primaryTitle` /
   *  `primaryDepartment`), so the scaffold can never misrepresent what anchors the
   *  bio. Additive (`?`); the loader always populates it. */
  identity?: { name: string; primaryTitle: string | null; primaryDepartment: string | null };
};

/** Strip HTML tags + collapse whitespace — `existingBio.text` is plain text. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Coerce a Prisma `Decimal | null` (impact score, RCR, …) to a plain number. A missing
 *  column (undefined) is treated as null, so a row that didn't select a Decimal field never
 *  throws. */
function decimalToNumber(
  value: { toNumber: () => number } | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : value.toNumber();
}

/** A funding role that counts as "lead" (PI / PI-Subaward / Co-PI) — the default
 *  pre-check set (§3.2). `Co-I` / `Key Personnel` are candidates but unchecked. */
function isLeadRole(role: string): boolean {
  return /^(pi\b|pi-subaward|co-pi)/i.test(role.trim());
}


/**
 * The default pre-check rule (shared by the assembler's empty-selection path and
 * the Sources drawer so the UI and the server agree). Lead-role active funding
 * is small + high-value, so it's kept first; first/last-author scored
 * publications (impact desc) fill the rest of the combined budget. Tools take
 * the top of their own separate budget, gated by the #765 §2 pmid_count floor.
 * Pure.
 */
function pickDefaultSelection(
  pubs: { pmid: string; isFirstOrLast: boolean }[],
  funding: { id: string; isLead: boolean }[],
  tools: { toolName: string; pmidCount: number }[] = [],
  maxItems = REPRESENTATIVE_LIMIT,
  maxTools = OVERVIEW_SELECTION_MAX_TOOLS,
): { pmids: string[]; grantIds: string[]; toolNames: string[] } {
  const grantIds = funding
    .filter((f) => f.isLead)
    .map((f) => f.id)
    .slice(0, maxItems);
  const remaining = Math.max(0, maxItems - grantIds.length);
  const pmids = pubs
    .filter((p) => p.isFirstOrLast)
    .map((p) => p.pmid)
    .slice(0, remaining);
  // Tools arrive pre-sorted (pmidCount desc); take the top of their own budget,
  // but only families above the #765 §2 honesty floor (≥ 2 publications).
  const toolNames = tools
    .filter((t) => t.pmidCount >= OVERVIEW_METHOD_PMID_FLOOR)
    .map((t) => t.toolName)
    .slice(0, maxTools);
  return { pmids, grantIds, toolNames };
}

/** The scholar's scored confirmed publications (the bio candidate pool), impact
 *  desc, each tagged with its author position. The single source of truth for
 *  both the facts assembler and the Sources drawer. */
async function loadScoredCandidatePublications(cwid: string): Promise<
  {
    pmid: string;
    title: string;
    venue: string | null;
    year: number | null;
    impact: number | null;
    synopsis: string | null;
    impactJustification: string | null;
    citationCount: number | null;
    relativeCitationRatio: number | null;
    nihPercentile: number | null;
    citedByCount: number | null;
    authorPosition: OverviewAuthorPosition | null;
    isFirstOrLast: boolean;
  }[]
> {
  const authorships = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true, isFirst: true, isLast: true },
  });
  if (authorships.length === 0) return [];
  const positionByPmid = new Map<string, OverviewAuthorPosition>();
  for (const a of authorships) {
    positionByPmid.set(a.pmid, a.isFirst ? "first" : a.isLast ? "last" : "middle");
  }
  const pmids = Array.from(positionByPmid.keys());

  // Scored only: ReciterAI impact-scored pubs are the ones carrying the distilled
  // grounding (synopsis / justification) and are the bio-worthy subset.
  const rows = await db.read.publication.findMany({
    where: { pmid: { in: pmids }, impactScore: { not: null } },
    orderBy: [{ impactScore: { sort: "desc", nulls: "last" } }, { year: "desc" }],
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      impactScore: true,
      synopsis: true,
      impactJustification: true,
      // #917 v6 -- NIH iCite bibliometrics for the biosketch impact grounding.
      // Loaded here (read directly from MySQL, no reindex) but WITHHELD from the
      // public overview projection; only `toBiosketchModelFacts` surfaces them.
      citationCount: true,
      relativeCitationRatio: true,
      nihPercentile: true,
      citedByCount: true,
    },
  });

  return rows.map((r) => {
    const position = positionByPmid.get(r.pmid) ?? null;
    return {
      pmid: r.pmid,
      title: r.title,
      venue: r.journal,
      year: r.year,
      impact: decimalToNumber(r.impactScore),
      synopsis: r.synopsis,
      impactJustification: r.impactJustification,
      citationCount: r.citationCount ?? null,
      relativeCitationRatio: decimalToNumber(r.relativeCitationRatio),
      nihPercentile: decimalToNumber(r.nihPercentile),
      citedByCount: r.citedByCount ?? null,
      authorPosition: position,
      isFirstOrLast: position === "first" || position === "last",
    };
  });
}

/** The scholar's active funding (end date today or later), importance-sorted. */
async function loadActiveFunding(cwid: string): Promise<
  {
    id: string;
    role: string;
    funder: string;
    title: string;
    programType: string;
    mechanism: string | null;
    nihIc: string | null;
    awardNumber: string | null;
    isSubaward: boolean;
    endYear: number | null;
    isLead: boolean;
  }[]
> {
  const today = startOfToday();
  const rows = await db.read.grant.findMany({
    where: { cwid, endDate: { gte: today } },
    orderBy: { endDate: "desc" },
    select: {
      id: true,
      role: true,
      funder: true,
      title: true,
      programType: true,
      mechanism: true,
      nihIc: true,
      awardNumber: true,
      isSubaward: true,
      endDate: true,
    },
  });
  const mapped = rows.map((g) => ({
    id: g.id,
    role: g.role,
    funder: g.funder,
    title: g.title,
    programType: g.programType,
    mechanism: g.mechanism,
    nihIc: g.nihIc,
    awardNumber: g.awardNumber,
    isSubaward: g.isSubaward,
    endYear: g.endDate.getUTCFullYear(),
    isLead: isLeadRole(g.role),
  }));
  // Order by importance (NIH research > NIH center/training > foundation > industry
  // > equipment, weighted by role) so the most important awards win the selection cap
  // and lead the candidate list; tie-break by most-recent end year, nulls last. This
  // changes ONLY the candidate ORDER — not which awards are returned, nor `isLead`.
  return mapped.sort((a, b) => {
    const byScore = scoreFundingImportance(b) - scoreFundingImportance(a);
    if (byScore !== 0) return byScore;
    return (b.endYear ?? -Infinity) - (a.endYear ?? -Infinity);
  });
}

/**
 * The scholar's #799 method-family rollup (`scholar_family`), most-used first,
 * mapped into the generator's tool-bucket shape so the drawer / selection /
 * assembler pipeline is unchanged (#886). This is the SAME live data the public
 * Methods & tools panel renders — `familyLabel` → `toolName` (the selection
 * key), `supercategory` → `category`, the per-scholar publication count →
 * `pmidCount` (which drives ranking and the #765 §2 ≥2 default floor), and a few
 * `exemplarTools` for grounding. `maxConfidence` is a constant `1` — families
 * carry no per-tool confidence; it only orders ties within the bucket.
 *
 * Reads ALL the scholar's own families — unlike the public panel it does NOT apply:
 *   - the #801 SENSITIVITY gate — that is a public-viewer protection. The reader
 *     is the scholar themselves OR a superuser / comms_steward authoring the bio
 *     on their behalf (#844 widened the generator to admins — so this is NOT an
 *     owner-only path). All are trusted internal viewers already entitled to see
 *     the scholar's sensitive families under #866, so omitting the gate stays
 *     within that trust boundary; and
 *   - the `METHODS_LENS_ENABLED` public-render master flag — the generator needs
 *     the DATA, which exists independent of the public lens rollout.
 *
 * The #800 SUPPRESSION overlay IS applied: a family the curators marked generic
 * is non-distinctive grounding, and the public panel hides it too — grounding a
 * bio on it would contradict the profile.
 */
async function loadScholarMethodFamilies(cwid: string): Promise<
  {
    toolName: string;
    category: string | null;
    pmidCount: number;
    maxConfidence: number;
    examples: string[];
    /** #1119 — best per-exemplar-tool usage snippet (name aligned to `examples`). */
    exemplarContexts: { name: string; context: string }[];
  }[]
> {
  const rows = await db.read.scholarFamily.findMany({
    where: { cwid },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    // #879 D-19 LOCKED — do NOT add `definition` to this select. The generated
    // family definition is RENDER-ONLY and must never enter the overview/bio
    // generator's grounding (an LLM prompt). Family identity + counts only here.
    //
    // #1119 — `exemplarContexts` is the OPPOSITE case and IS selected: it is
    // EXTRACTED real publication text (the tool-usage snippet), grounding-eligible
    // like `synopsis`, not a generated gloss. Still injection-safe DATA downstream.
    select: {
      familyId: true,
      familyLabel: true,
      supercategory: true,
      pmidCount: true,
      exemplarTools: true,
      exemplarContexts: true,
    },
  });
  if (rows.length === 0) return [];

  // #800 — drop curator-suppressed (generic) families: the public panel hides
  // them, so they are not honest grounding for the bio either. Keyed on the
  // stable (supercategory, family_label), the same overlay the lens applies.
  const suppression = await db.read.familySuppressionOverlay.findMany({
    select: { supercategory: true, familyLabel: true },
  });
  const suppressed = new Set(
    suppression.map((o) => familyOverlayKey(o.supercategory, o.familyLabel)),
  );

  return rows
    .filter((r) => !suppressed.has(familyOverlayKey(r.supercategory, r.familyLabel)))
    .map((r) => {
      const examples = Array.isArray(r.exemplarTools)
        ? (r.exemplarTools as unknown[]).map(String)
        : [];
      // #1119 — align the per-exemplar usage snippets to `examples` order, keeping
      // only exemplars that resolved a snippet. The JSON is keyed by display name.
      const ctx =
        r.exemplarContexts && typeof r.exemplarContexts === "object" && !Array.isArray(r.exemplarContexts)
          ? (r.exemplarContexts as Record<string, unknown>)
          : {};
      const exemplarContexts = examples
        .map((name) => ({ name, context: typeof ctx[name] === "string" ? (ctx[name] as string) : null }))
        .filter((e): e is { name: string; context: string } => e.context != null);
      return {
        toolName: r.familyLabel,
        category: r.supercategory,
        pmidCount: r.pmidCount,
        maxConfidence: 1,
        examples,
        exemplarContexts,
      };
    });
}

/** Highest-score topic rationale per pmid for `cwid` ("why this work maps here"). */
async function loadTopicRationaleByPmid(
  cwid: string,
  pmids: string[],
): Promise<Map<string, string>> {
  if (pmids.length === 0) return new Map();
  const rows = await db.read.publicationTopic.findMany({
    where: { cwid, pmid: { in: pmids }, rationale: { not: null } },
    orderBy: { score: "desc" },
    select: { pmid: true, rationale: true },
  });
  const byPmid = new Map<string, string>();
  for (const r of rows) {
    if (r.rationale && !byPmid.has(r.pmid)) byPmid.set(r.pmid, r.rationale);
  }
  return byPmid;
}

/**
 * Assemble the facts payload for `cwid`, grounded on the chosen `selection` (or
 * the v3.1 default when none is given). Returns `null` when no scholar row
 * exists. Reads only.
 *
 * The effective selection is ownership-filtered against the scholar's own
 * candidate pools (a forged/foreign pmid or grant id simply matches nothing),
 * then capped to the combined 25 ceiling.
 */
export async function assembleOverviewFacts(
  cwid: string,
  selection?: OverviewSelection,
  opts?: { deltas?: OverviewSelectionDeltas },
): Promise<OverviewFacts | null> {
  const scholar = await db.read.scholar.findUnique({
    where: { cwid },
    select: {
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
      overview: true,
      // #742 C3 — ReciterAI FACULTY# scale metrics (null until the ETL runs).
      hIndex: true,
      firstAuthorCount: true,
      lastAuthorCount: true,
      scoredPubCount: true,
    },
  });
  if (!scholar) return null;

  const [
    candidatePubs,
    funding,
    methodFamilies,
    publicationCount,
    yearsActive,
    topics,
    educationCandidates,
    titleCandidates,
  ] = await Promise.all([
    loadScoredCandidatePublications(cwid),
    loadActiveFunding(cwid),
    loadScholarMethodFamilies(cwid),
    countConfirmedPublications(cwid),
    assembleYearsActive(cwid),
    assembleTopics(cwid),
    // Titles & education share the drawer's candidate loaders (the single source of
    // truth with the Sources picker), so the bio's default featured set is exactly
    // what the drawer marks "included".
    loadOverviewEducationCandidates(cwid),
    loadOverviewTitleCandidates(cwid),
  ]);

  // Resolve the effective selection. Explicit picks are ownership-filtered to the
  // candidate pools (validity + IDOR safety); an empty selection falls back to the
  // shared default rule so there is no dead-end empty state.
  const candidatePmidSet = new Set(candidatePubs.map((p) => p.pmid));
  const candidateGrantSet = new Set(funding.map((f) => f.id));
  const candidateToolSet = new Set(methodFamilies.map((t) => t.toolName));

  let selectedPmids: string[];
  let selectedGrantIds: string[];
  let selectedToolNames: string[];
  const hasExplicit =
    selection !== undefined &&
    (selection.pmids.length > 0 || selection.grantIds.length > 0 || selection.toolNames.length > 0);
  if (hasExplicit) {
    selectedPmids = selection!.pmids.filter((p) => candidatePmidSet.has(p));
    selectedGrantIds = selection!.grantIds.filter((g) => candidateGrantSet.has(g));
    selectedToolNames = selection!.toolNames.filter((t) => candidateToolSet.has(t));
  } else {
    // No explicit snapshot → the §5.1 LIVE auto-set (the flip): the model now
    // grounds on the Recommended featured set, not the v3.1 first/last-impact rule.
    // The scholar's DURABLE three-state deltas (§2.5) layer on top — pins reach past
    // the auto-set AND survive the cap (ordered first), excludes veto. The led ⇄ all
    // toggle (§2.2) re-filters the candidate POOL the auto-set ranks over. Each
    // delta-resolved list is re-filtered to the FULL candidate pool (a stale/forged
    // pinned id matches nothing; a pin of an off-position pub is still honored).
    const deltas = opts?.deltas;
    const pubMode = deltas?.publicationPositions ?? "led";
    const fundMode = deltas?.fundingRoles ?? "led";

    // Publications — the §5.1 featured set over the mode pool (the flip).
    const rankByPmid = await rankCandidatePublications(cwid, candidatePubs, pubMode);
    const defaultPmids = featuredPmidsInRankOrder(rankByPmid);
    // Funding — lead-role default; `all` widens to every active award (§2.2).
    const defaultGrantIds = funding.filter((f) => fundMode === "all" || f.isLead).map((f) => f.id);
    // Tools — unchanged: the top of the tool budget above the #765 §2 pmid floor.
    const defaultToolNames = methodFamilies
      .filter((t) => t.pmidCount >= OVERVIEW_METHOD_PMID_FLOOR)
      .map((t) => t.toolName)
      .slice(0, OVERVIEW_SELECTION_MAX_TOOLS);

    // Pins ahead of the auto-set (`pinsFirst`) so a deliberate pin SURVIVES the
    // `slice(0, REPRESENTATIVE_LIMIT)` cap below instead of being evicted past the
    // budget — the #742 §2.1 pin-loss fix (decision #3), mirroring the client resolver.
    selectedPmids = applyDeltas(
      defaultPmids,
      deltas?.pinned.publication,
      deltas?.excluded.publication,
      { pinsFirst: true },
    ).filter((p) => candidatePmidSet.has(p));
    selectedGrantIds = applyDeltas(
      defaultGrantIds,
      deltas?.pinned.funding,
      deltas?.excluded.funding,
      { pinsFirst: true },
    ).filter((g) => candidateGrantSet.has(g));
    selectedToolNames = applyDeltas(
      defaultToolNames,
      deltas?.pinned.method,
      deltas?.excluded.method,
      { pinsFirst: true },
    ).filter((t) => candidateToolSet.has(t));

    // Surface (observability) when a scholar's pins ALONE exceed the publication
    // budget — the cap below drops the lowest-ranked, so this flags the over-pin
    // rather than letting it vanish silently (decision #3).
    const pinnedPubCount = (deltas?.pinned.publication ?? []).filter((p) =>
      candidatePmidSet.has(p),
    ).length;
    if (pinnedPubCount > REPRESENTATIVE_LIMIT) {
      console.warn(
        JSON.stringify({
          event: "overview_pins_exceed_budget",
          cwid,
          pinnedPublications: pinnedPubCount,
          budget: REPRESENTATIVE_LIMIT,
        }),
      );
    }
  }
  // Defensive caps (the route normalizes too): publications first within the
  // shared 25, tools within their own 10.
  selectedPmids = selectedPmids.slice(0, REPRESENTATIVE_LIMIT);
  selectedGrantIds = selectedGrantIds.slice(
    0,
    Math.max(0, REPRESENTATIVE_LIMIT - selectedPmids.length),
  );
  selectedToolNames = selectedToolNames.slice(0, OVERVIEW_SELECTION_MAX_TOOLS);

  const selectedPmidSet = new Set(selectedPmids);
  const selectedGrantSet = new Set(selectedGrantIds);
  const selectedToolSet = new Set(selectedToolNames);

  // Build the representative pubs from the selected candidates (impact-desc order
  // is preserved from the candidate query), enriched with the topic rationale.
  const rationaleByPmid = await loadTopicRationaleByPmid(cwid, selectedPmids);
  const representativePublications = candidatePubs
    .filter((p) => selectedPmidSet.has(p.pmid))
    .map((p) => ({
      pmid: p.pmid,
      title: p.title,
      venue: p.venue,
      year: p.year,
      impact: p.impact,
      synopsis: p.synopsis,
      impactJustification: p.impactJustification,
      topicRationale: rationaleByPmid.get(p.pmid) ?? null,
      authorPosition: p.authorPosition,
      citationCount: p.citationCount,
      relativeCitationRatio: p.relativeCitationRatio,
      nihPercentile: p.nihPercentile,
      citedByCount: p.citedByCount,
    }));

  const activeGrants = funding
    .filter((f) => selectedGrantSet.has(f.id))
    .map((f) => ({
      role: f.role,
      funderLabel: f.funder,
      title: f.title,
      mechanism: f.mechanism,
    }));

  // The selected method families (#799 `scholar_family`, #886); empty when the
  // scholar has none or deselected them all. `examples` carry exemplar member-tool
  // names so the model can ground concrete prose, not just the family label.
  const methods = methodFamilies
    .filter((t) => selectedToolSet.has(t.toolName))
    .map((t) => ({
      name: t.toolName,
      category: t.category,
      examples: t.examples,
      exemplarContexts: t.exemplarContexts,
    }));

  // Titles & education ground through the same three-state deltas (#742 §7) but are
  // NOT part of the OverviewSelection snapshot, so they resolve here directly from the
  // durable deltas — applied on EVERY path (explicit-snapshot or default) so a hide /
  // add bites regardless of how the pubs were chosen. The default set is the
  // candidates' "featured" tier (the rows the drawer shows as included); pins reach
  // into the Available tail, excludes veto. Candidate order (relevance / recency) is
  // preserved by filtering the candidate list rather than the delta-resolved id list.
  const sourceDeltas = opts?.deltas;
  const featuredTitleIds = titleCandidates
    .filter((t) => t.featured && !t.isPrimary)
    .map((t) => t.id);
  const effectiveTitleIds = new Set(
    applyDeltas(featuredTitleIds, sourceDeltas?.pinned.title, sourceDeltas?.excluded.title),
  );
  // The primary title is the always-shown scaffolding line (`title`); never duplicate
  // it into the additional-titles list. We drop it by both the appointment `isPrimary`
  // flag AND a normalized string match against `scholar.primaryTitle`, since the two
  // are distinct sources that can disagree (a flag may be missing while the role text
  // matches) — and a pinned id bypasses the featured filter, so the string guard is the
  // backstop.
  const primaryTitleNorm = normalizeTitleForDedup(scholar.primaryTitle);
  const titles = titleCandidates
    .filter(
      (t) =>
        !t.isPrimary &&
        effectiveTitleIds.has(t.id) &&
        normalizeTitleForDedup(t.title) !== primaryTitleNorm,
    )
    .map((t) => ({ title: t.title, organization: t.organization }));

  const featuredEducationIds = educationCandidates.filter((e) => e.featured).map((e) => e.id);
  const effectiveEducationIds = new Set(
    applyDeltas(
      featuredEducationIds,
      sourceDeltas?.pinned.education,
      sourceDeltas?.excluded.education,
    ),
  );
  let education = educationCandidates
    .filter((e) => effectiveEducationIds.has(e.id))
    .map((e) => ({ degree: e.degree, institution: e.institution, field: e.field, year: e.year }));
  // Defensive empty-tier fallback: if the degree classifier recognized nothing as
  // featured AND the scholar made no education choice, emit every row rather than
  // silently drop all education — a degree string the heuristic doesn't yet know
  // (an unusual international or historical credential) must never erase the section.
  const hasEduDeltas =
    (sourceDeltas?.pinned.education?.length ?? 0) > 0 ||
    (sourceDeltas?.excluded.education?.length ?? 0) > 0;
  if (education.length === 0 && !hasEduDeltas && educationCandidates.length > 0) {
    education = educationCandidates.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      field: e.field,
      year: e.year,
    }));
  }

  const hasMetrics =
    scholar.hIndex !== null ||
    scholar.firstAuthorCount !== null ||
    scholar.lastAuthorCount !== null ||
    scholar.scoredPubCount !== null;
  const facultyMetrics = hasMetrics
    ? {
        firstAuthorCount: scholar.firstAuthorCount,
        lastAuthorCount: scholar.lastAuthorCount,
        scoredPubCount: scholar.scoredPubCount,
        hIndex: scholar.hIndex,
      }
    : null;

  const existingBioText = scholar.overview ? htmlToPlainText(scholar.overview) : "";

  return {
    name: scholar.preferredName,
    title: scholar.primaryTitle,
    department: scholar.primaryDepartment,
    topics,
    representativePublications,
    publicationCount,
    yearsActive,
    activeGrants,
    education,
    titles,
    methods,
    facultyMetrics,
    existingBio: existingBioText ? { text: existingBioText, source: "vivo" } : null,
  };
}

/** Highest-score PARENT topic (research area) per pmid — the coverage-pass key
 *  for the §5.1 ranking (topic spread + per-area dedup). */
async function loadPrimaryAreaByPmid(cwid: string, pmids: string[]): Promise<Map<string, string>> {
  if (pmids.length === 0) return new Map();
  const rows = await db.read.publicationTopic.findMany({
    where: { cwid, pmid: { in: pmids } },
    orderBy: { score: "desc" },
    select: { pmid: true, parentTopicId: true },
  });
  const byPmid = new Map<string, string>();
  for (const r of rows) if (!byPmid.has(r.pmid)) byPmid.set(r.pmid, r.parentTopicId);
  return byPmid;
}

/** Run the candidate pubs through the §5.1 Recommended ranking (spread + landmark
 *  floor + tiers + reasons + near-dup dedup), keyed by pmid for enrichment AND for
 *  the live auto-set (the flip). The `mode` re-filters the candidate POOL the
 *  ranking spans (§2.2): `led` (default) = first/last-author work the scholar drove;
 *  `all` = also middle-author. Pins reach any candidate regardless — they are
 *  layered on top of this set by the caller — so the pool filter only shapes the
 *  AUTO-set. The per-scholar impact quantiles (tiers / landmarks) are taken over the
 *  filtered pool, the scholar's own distribution for that lens (decision #5). */
async function rankCandidatePublications(
  cwid: string,
  candidatePubs: {
    pmid: string;
    title: string;
    impact: number | null;
    year: number | null;
    authorPosition: OverviewAuthorPosition | null;
    isFirstOrLast: boolean;
  }[],
  mode: OverviewPositionMode = "led",
): Promise<Map<string, RepresentativeRanked>> {
  const pool = mode === "all" ? candidatePubs : candidatePubs.filter((p) => p.isFirstOrLast);
  if (pool.length === 0) return new Map();
  const areaByPmid = await loadPrimaryAreaByPmid(
    cwid,
    pool.map((p) => p.pmid),
  );
  const ranked = rankRepresentativePublications(
    pool.map((p) => ({
      pmid: p.pmid,
      impact: p.impact,
      year: p.year,
      authorPosition: p.authorPosition,
      topicAreaId: areaByPmid.get(p.pmid) ?? null,
      // §2.4 — near-duplicate dedup key. No ReciterAI cluster id reaches SPS
      // (decision #4), so this is the spec fallback: a normalized title + year
      // collapses a paper indexed twice (preprint/published, paper + erratum) to a
      // single featured slot. The byline's first author is NOT in this projection —
      // only the scholar's own authorship row is loaded — so title+year is the
      // available near-dup key, near-unique within one scholar's corpus. Landmarks
      // are exempt from the collapse (handled inside the ranker).
      clusterKey: clusterKeyForDedup(p.title, p.year),
    })),
    { featuredLimit: REPRESENTATIVE_LIMIT },
  );
  return new Map(ranked.map((r) => [r.pmid, r]));
}

/** The §5.1 featured (auto-set) pmids in Recommended (rank-ascending) order. */
function featuredPmidsInRankOrder(rankByPmid: Map<string, RepresentativeRanked>): string[] {
  return Array.from(rankByPmid.values())
    .filter((r) => r.featured)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.pmid);
}

/** Normalize a title for primary-title de-duplication (case / whitespace-insensitive). */
function normalizeTitleForDedup(title: string | null): string {
  return (title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** §2.4 near-duplicate cluster key (decision #4 fallback) — normalized title +
 *  year. Reuses the title normalizer so it is case/whitespace-insensitive. */
function clusterKeyForDedup(title: string, year: number | null): string {
  return `${normalizeTitleForDedup(title)}|${year ?? ""}`;
}

/** Significant leadership titles (§7 threshold) — chair / director / chief / etc. */
const SIGNIFICANT_TITLE_RE =
  /\b(chair|chief|director|president|dean|head|provost|principal|editor[-\s]?in[-\s]?chief)\b/i;

const WCM_ORG = "Weill Cornell Medicine";

/** Prepend a unit noun ("Department of") to a bare unit name, unless the name
 *  already opens with a unit noun (so "Department of Department of …" can't form). */
function withUnitNoun(prefix: string, name: string): string {
  const n = name.trim();
  return /^(department|division|center|institute|school|college|program)\b/i.test(n)
    ? n
    : `${prefix} ${n}`;
}

/** Append " Program" to a program label unless it already carries the noun. */
function asProgramName(label: string): string {
  const l = label.trim();
  return /\bprogram\b/i.test(l) ? l : `${l} Program`;
}

/** One synthesized FK-leadership title plus the unit context the dedup needs. */
type FkLeadershipCandidate = {
  candidate: OverviewSourceTitle;
  /** A dept-chair role — gets the role-aware `isChairTitleFor` dedup (the ETL sets
   *  `chairCwid` from a "Chairman …" appointment whose string won't match exactly). */
  isDeptChair: boolean;
  /** The unit name, for the chair dedup against appointment titles. */
  unitName: string;
};

/** Build one FK-leadership candidate. Current leadership ⇒ featured (Feedstock). */
function fkLeadershipCandidate(
  id: string,
  title: string,
  organization: string,
  isInterim: boolean,
  opts: { isDeptChair?: boolean; unitName?: string } = {},
): FkLeadershipCandidate {
  return {
    candidate: {
      id,
      title,
      organization,
      isPrimary: false,
      isInterim,
      isCurrent: true,
      endYear: null,
      featured: true,
      reason: "A leadership role",
    },
    isDeptChair: opts.isDeptChair ?? false,
    unitName: opts.unitName ?? "",
  };
}

/**
 * #742 §2.5 — leadership roles recorded on the org-unit FK tables, not (or not
 * yet) in the appointment table: a department `chairCwid`, a division `chiefCwid`,
 * a center `directorCwid` (+ interim), and `CenterProgramLeader` rows. These catch
 * leadership set via `field_override` or missed by the appointment-title ETL (the
 * Stewart case). Each query keys on the leader being THIS scholar, so an external
 * leader (`lib/external-leaders.ts`, a non-WCM cwid) never matches. The synthesized
 * titles are deduped against the appointment titles + primary title by the caller.
 *
 * NOTE: program leaders live in `CenterProgramLeader` (#1117 replaced the single
 * `CenterProgram.leaderCwid` column), so a co-led program surfaces every leader.
 */
async function loadLeadershipFkCandidates(cwid: string): Promise<FkLeadershipCandidate[]> {
  const [departments, divisions, centers, programLeaders] = await Promise.all([
    db.read.department.findMany({
      where: { chairCwid: cwid },
      select: { code: true, name: true, officialName: true },
    }),
    db.read.division.findMany({
      where: { chiefCwid: cwid },
      select: { code: true, name: true },
    }),
    db.read.center.findMany({
      where: { directorCwid: cwid },
      select: { code: true, name: true, officialName: true, leaderInterim: true },
    }),
    db.read.centerProgramLeader.findMany({
      // #1570 — a `coe_liaison` row is not a leadership title; only program
      // LEADS synthesize a "Leader, {program}" candidate here.
      where: { cwid, role: "leader" },
      select: {
        centerCode: true,
        programCode: true,
        interim: true,
        program: { select: { label: true, center: { select: { name: true, officialName: true } } } },
      },
    }),
  ]);

  const out: FkLeadershipCandidate[] = [];
  for (const d of departments) {
    const name = d.officialName ?? d.name;
    out.push(
      fkLeadershipCandidate(
        `fk:dept:${d.code}`,
        `Chair, ${withUnitNoun("Department of", name)}`,
        WCM_ORG,
        false,
        { isDeptChair: true, unitName: name },
      ),
    );
  }
  for (const v of divisions) {
    out.push(
      fkLeadershipCandidate(`fk:div:${v.code}`, `Chief, ${withUnitNoun("Division of", v.name)}`, WCM_ORG, false),
    );
  }
  for (const c of centers) {
    const name = c.officialName ?? c.name;
    out.push(
      fkLeadershipCandidate(
        `fk:center:${c.code}`,
        `${c.leaderInterim ? "Interim " : ""}Director, ${name}`,
        WCM_ORG,
        c.leaderInterim,
      ),
    );
  }
  for (const p of programLeaders) {
    const centerName = p.program.center.officialName ?? p.program.center.name;
    out.push(
      fkLeadershipCandidate(
        `fk:program:${p.centerCode}:${p.programCode}`,
        `${p.interim ? "Interim " : ""}Leader, ${asProgramName(p.program.label)}`,
        centerName,
        p.interim,
      ),
    );
  }
  return out;
}

/** "Titles & positions" candidates from the `appointment` table (#742 §7),
 *  augmented with the org-unit leadership-FK roles (§2.5). The primary title also
 *  drives the scaffolding line; it is still listed here (the drawer dedupes it). */
async function loadOverviewTitleCandidates(cwid: string): Promise<OverviewSourceTitle[]> {
  const [rows, fkCandidates, scholar] = await Promise.all([
    db.read.appointment.findMany({
      where: { cwid },
      orderBy: [
        { isPrimary: "desc" },
        { endDate: { sort: "desc", nulls: "first" } },
        { startDate: "desc" },
      ],
      select: {
        id: true,
        title: true,
        organization: true,
        startDate: true,
        endDate: true,
        isPrimary: true,
        isInterim: true,
      },
    }),
    loadLeadershipFkCandidates(cwid),
    db.read.scholar.findUnique({ where: { cwid }, select: { primaryTitle: true } }),
  ]);
  const appointments = rows.map((a) => {
    const isCurrent = a.endDate === null;
    const significant = SIGNIFICANT_TITLE_RE.test(a.title);
    // Featured = the primary title, or a current, non-interim leadership role.
    const featured = a.isPrimary || (isCurrent && !a.isInterim && significant);
    const reason = a.isPrimary
      ? "Your primary appointment"
      : significant
        ? isCurrent
          ? "A leadership role"
          : "A past leadership role"
        : isCurrent
          ? "A current appointment"
          : "A past appointment";
    return {
      id: a.id,
      title: a.title,
      organization: a.organization,
      isPrimary: a.isPrimary,
      isInterim: a.isInterim,
      isCurrent,
      endYear: a.endDate ? a.endDate.getUTCFullYear() : null,
      featured,
      reason,
    };
  });

  // §2.5 dedup — drop an FK-leadership title the appointments (or the primary title)
  // already carry, so a chair recorded in BOTH places doesn't double. Exact
  // normalized match covers the general case; a dept chair additionally gets the
  // role-aware `isChairTitleFor` check, because `chairCwid` is derived from a
  // "Chairman …" appointment whose text won't match the synthesized "Chair, …".
  const apptTitles = appointments.map((a) => a.title);
  const primaryTitle = scholar?.primaryTitle ?? null;
  const takenNorm = new Set(apptTitles.map((t) => normalizeTitleForDedup(t)));
  const primaryNorm = normalizeTitleForDedup(primaryTitle);
  if (primaryNorm) takenNorm.add(primaryNorm);
  const chairContexts = primaryTitle ? [...apptTitles, primaryTitle] : apptTitles;

  const fkTitles = fkCandidates
    .filter((fk) => {
      if (takenNorm.has(normalizeTitleForDedup(fk.candidate.title))) return false;
      if (fk.isDeptChair && chairContexts.some((t) => isChairTitleFor(t, fk.unitName))) return false;
      return true;
    })
    .map((fk) => fk.candidate);

  return [...appointments, ...fkTitles];
}

/** Terminal (doctoral) degrees — the strongest education signal. Includes the
 *  international medical-doctorate family (MBBS / MBChB / MBBCh / Bachelor of
 *  Medicine) and DSc, common among internationally-trained faculty. */
const TERMINAL_DEGREE_RE =
  /\b(ph\.?\s?d|m\.?\s?d|d\.?\s?o|d\.?\s?d\.?\s?s|d\.?\s?m\.?\s?d|pharm\.?\s?d|sc\.?\s?d|d\.?\s?sc|dr\.?\s?p\.?\s?h|d\.?\s?v\.?\s?m|j\.?\s?d|ed\.?\s?d|d\.?\s?n\.?\s?p|d\.?\s?phil|m\.?\s?b\.?\s?b\.?\s?s|m\.?\s?b\.?\s?ch\.?\s?b|m\.?\s?b\.?\s?b\.?\s?ch|bachelor of medicine|doctor)\b/i;
/** Professional / graduate degrees that still feature when no doctorate applies.
 *  `m\.?\s?sc` / `sc\.?\s?m` are listed explicitly because the bare `m\.?\s?s`
 *  alternative below fails the `\b` boundary on "MSc" / "ScM" (the trailing/leading
 *  "c" abuts the match). */
const PROFESSIONAL_DEGREE_RE =
  /\b(m\.?\s?p\.?\s?h|m\.?\s?b\.?\s?a|m\.?\s?sc|sc\.?\s?m|m\.?\s?s|m\.?\s?a|m\.?\s?eng|master)\b/i;

/** Education candidates (#742 §7) — terminal/professional degrees feature; minor
 *  certificates / training entries drop to the Available tail. */
async function loadOverviewEducationCandidates(cwid: string): Promise<OverviewSourceEducation[]> {
  const rows = await db.read.education.findMany({
    where: { cwid },
    orderBy: { year: { sort: "desc", nulls: "last" } },
    select: { id: true, degree: true, institution: true, field: true, year: true },
  });
  return rows.map((e) => {
    const terminal = TERMINAL_DEGREE_RE.test(e.degree);
    const professional = !terminal && PROFESSIONAL_DEGREE_RE.test(e.degree);
    const featured = terminal || professional;
    const reason = terminal
      ? "Terminal degree"
      : professional
        ? "Professional degree"
        : "Training / certificate";
    return {
      id: e.id,
      degree: e.degree,
      institution: e.institution,
      field: e.field,
      year: e.year,
      featured,
      reason,
    };
  });
}

/**
 * The Sources drawer candidate lists for `cwid` (v3.1 §4) — every scored pub,
 * every active award, and every method family, each flagged `defaultSelected`
 * per the shared default rule so the drawer's pre-checks match the server's
 * empty-selection behavior. `tools` is empty when the scholar has no #799
 * families, so the drawer's Methods section stays hidden then.
 *
 * #742 §5.1/§7 (additive): publications also carry the Recommended ranking
 * (`tier` / `isLandmark` / `featured` / `reason` / `recommendedRank`), funding and
 * methods carry a numberless `reason`, and the payload now includes `titles` and
 * `education` candidate lists. None of this changes `defaultSelected` — the live
 * default + generator behaviour is unchanged until the three-state UI (PR-2)
 * adopts the §5.1 auto-set.
 */
export async function loadOverviewSourceOptions(cwid: string): Promise<OverviewSourceOptions> {
  const [scholar, candidatePubs, funding, methodFamilies, titles, education] = await Promise.all([
    db.read.scholar.findUnique({
      where: { cwid },
      select: { preferredName: true, primaryTitle: true, primaryDepartment: true },
    }),
    loadScoredCandidatePublications(cwid),
    loadActiveFunding(cwid),
    loadScholarMethodFamilies(cwid),
    loadOverviewTitleCandidates(cwid),
    loadOverviewEducationCandidates(cwid),
  ]);

  const def = pickDefaultSelection(candidatePubs, funding, methodFamilies);
  const defaultPmids = new Set(def.pmids);
  const defaultGrants = new Set(def.grantIds);
  const defaultTools = new Set(def.toolNames);

  // The drawer's `featured` flags are the §5.1 auto-set in the DEFAULT (led) mode —
  // the publication tier the picker pre-includes and the client resolver grounds on
  // (`overview-resolve.ts`). Middle-author work is ranked only when the scholar flips
  // the led ⇄ all toggle (resolved server-side on generation), so here it is left
  // un-featured and surfaces in the drawer's "all positions" tail for manual pinning.
  const rankByPmid = await rankCandidatePublications(cwid, candidatePubs, "led");

  return {
    publications: candidatePubs.map((p) => {
      const r = rankByPmid.get(p.pmid);
      return {
        pmid: p.pmid,
        title: p.title,
        venue: p.venue,
        year: p.year,
        impact: p.impact,
        isFirstOrLast: p.isFirstOrLast,
        authorPosition: p.authorPosition,
        defaultSelected: defaultPmids.has(p.pmid),
        recommendedRank: r?.rank,
        tier: r?.tier,
        isLandmark: r?.isLandmark,
        featured: r?.featured ?? defaultPmids.has(p.pmid),
        reason: r?.reason,
      };
    }),
    funding: funding.map((f) => ({
      id: f.id,
      role: f.role,
      funder: f.funder,
      title: f.title,
      award: f.awardNumber ?? f.mechanism,
      endYear: f.endYear,
      defaultSelected: defaultGrants.has(f.id),
      featured: defaultGrants.has(f.id),
      reason: isLeadRole(f.role) ? "An active grant you lead" : "An active grant you're part of",
    })),
    // The drawer `tools[]` shape is unchanged (#886). `reason` (the "show evidence"
    // reveal) names the family's concrete exemplar tools so each row is specific —
    // e.g. "Includes 10x Chromium, Seurat" — instead of one repeated generic line;
    // it falls back to the generic phrasing only when a family has no exemplars.
    tools: methodFamilies.map((t) => ({
      toolName: t.toolName,
      category: t.category,
      pmidCount: t.pmidCount,
      maxConfidence: t.maxConfidence,
      defaultSelected: defaultTools.has(t.toolName),
      reason:
        t.examples.length > 0
          ? `Includes ${t.examples.slice(0, 3).join(", ")}`
          : t.pmidCount >= OVERVIEW_METHOD_PMID_FLOOR
            ? "A method recurring across your work"
            : "A method in your work",
    })),
    titles,
    education,
    identity: {
      name: scholar?.preferredName ?? "",
      primaryTitle: scholar?.primaryTitle ?? null,
      primaryDepartment: scholar?.primaryDepartment ?? null,
    },
  };
}

/** Distinct confirmed-authorship pmid count. */
async function countConfirmedPublications(cwid: string): Promise<number> {
  const rows = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true },
  });
  return new Set(rows.map((r) => r.pmid)).size;
}

/** Min / max publication year across the confirmed corpus. */
async function assembleYearsActive(cwid: string): Promise<OverviewFacts["yearsActive"]> {
  const authorships = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true },
  });
  const pmids = Array.from(new Set(authorships.map((a) => a.pmid)));
  if (pmids.length === 0) return { first: null, last: null };
  const agg = await db.read.publication.aggregate({
    where: { pmid: { in: pmids }, year: { not: null } },
    _min: { year: true },
    _max: { year: true },
  });
  return { first: agg._min.year ?? null, last: agg._max.year ?? null };
}

/**
 * Top parent topics for the scholar, ranked by distinct-pmid count desc, each
 * resolved to its `Topic.label` and one representative non-null rationale.
 */
async function assembleTopics(cwid: string): Promise<OverviewFacts["topics"]> {
  const rows = await db.read.publicationTopic.findMany({
    where: { cwid },
    select: { parentTopicId: true, pmid: true, rationale: true },
  });
  if (rows.length === 0) return [];

  const byTopic = new Map<string, { pmids: Set<string>; rationale: string | null }>();
  for (const row of rows) {
    const entry = byTopic.get(row.parentTopicId) ?? { pmids: new Set<string>(), rationale: null };
    entry.pmids.add(row.pmid);
    if (entry.rationale === null && row.rationale) entry.rationale = row.rationale;
    byTopic.set(row.parentTopicId, entry);
  }

  const ranked = Array.from(byTopic.entries())
    .sort((a, b) => b[1].pmids.size - a[1].pmids.size)
    .slice(0, TOPIC_LIMIT);

  const labels = await db.read.topic.findMany({
    where: { id: { in: ranked.map(([id]) => id) } },
    select: { id: true, label: true },
  });
  const labelById = new Map(labels.map((t) => [t.id, t.label]));

  return ranked.flatMap(([id, entry]) => {
    const label = labelById.get(id);
    return label ? [{ label, rationale: entry.rationale }] : [];
  });
}

/** UTC midnight today — the active-funding cutoff (`endDate >= today`). */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Whether the facts payload has enough real signal to draft a non-padded
 * overview (v3.1 §5). A scholar with no representative (scored) publication, no
 * active award, and fewer than two topics is too sparse — the route returns 422
 * rather than ask the model to confabulate over a thin record.
 */
export function hasSufficientFacts(facts: OverviewFacts): boolean {
  return (
    facts.representativePublications.length >= 1 ||
    facts.activeGrants.length >= 1 ||
    facts.topics.length >= 2
  );
}
