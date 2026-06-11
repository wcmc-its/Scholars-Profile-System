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
 * `methods` (tools) and `facultyMetrics` arrive in C3 (the ETL that lands the
 * DynamoDB `TOOL#` / `FACULTY#` signal); until then they degrade to `[]` / null.
 *
 * Read-only — this module performs NO write. Node-runtime only (Prisma).
 */
import { db } from "@/lib/db";
import {
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  type OverviewSelection,
} from "@/lib/edit/overview-params";

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
 * signals replace the raw abstract) and NO `methods`-from-`TOOL#` until C3.
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

  // --- tools / methods (C3 — `[]` until the TOOL# ETL lands) ---
  methods: { name: string; category: string | null }[];
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

/** A drawer candidate publication (the light shape the Sources picker renders). */
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
};

/** A drawer candidate funding award. */
export type OverviewSourceFunding = {
  id: string;
  role: string;
  funder: string;
  title: string | null;
  award: string | null;
  endYear: number | null;
  defaultSelected: boolean;
};

/** The `GET /api/edit/overview/source-options` payload (v3.1 §4). `tools` is
 *  empty until C3, so the drawer's Methods section stays hidden. */
export type OverviewSourceOptions = {
  publications: OverviewSourcePublication[];
  funding: OverviewSourceFunding[];
  tools: {
    toolName: string;
    category: string | null;
    pmidCount: number;
    maxConfidence: number;
    /** Whether this tool is pre-checked when the drawer opens. */
    defaultSelected: boolean;
  }[];
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

/** Coerce a Prisma `Decimal | null` (impact score) to a plain number. */
function decimalToNumber(value: { toNumber: () => number } | number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : value.toNumber();
}

/** A funding role that counts as "lead" (PI / PI-Subaward / Co-PI) — the default
 *  pre-check set (§3.2). `Co-I` / `Key Personnel` are candidates but unchecked. */
function isLeadRole(role: string): boolean {
  return /^(pi\b|pi-subaward|co-pi)/i.test(role.trim());
}

/** The #765 §2 / §7.4 honesty floor: a method family is only default-selected
 *  when it appears in ≥ 2 publications. Most families have `pmid_count = 1`; a
 *  top-N-by-count default that surfaced single-paper long-tail families would
 *  contradict the Methods rule line ("ranked by how often each appears"). The
 *  client "Top N by score" Methods quick action applies the same floor. */
export const OVERVIEW_METHOD_PMID_FLOOR = 2;

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
      authorPosition: position,
      isFirstOrLast: position === "first" || position === "last",
    };
  });
}

/** The scholar's active funding (end date today or later), most-recent-ending first. */
async function loadActiveFunding(cwid: string): Promise<
  {
    id: string;
    role: string;
    funder: string;
    title: string;
    mechanism: string | null;
    awardNumber: string | null;
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
      mechanism: true,
      awardNumber: true,
      endDate: true,
    },
  });
  return rows.map((g) => ({
    id: g.id,
    role: g.role,
    funder: g.funder,
    title: g.title,
    mechanism: g.mechanism,
    awardNumber: g.awardNumber,
    endYear: g.endDate.getUTCFullYear(),
    isLead: isLeadRole(g.role),
  }));
}

/** The scholar's tool/method rollup (ReciterAI `TOOL#` → `scholar_tool`),
 *  most-used first. Empty until C3's ETL has populated the table. */
async function loadScholarTools(
  cwid: string,
): Promise<
  { toolName: string; category: string | null; pmidCount: number; maxConfidence: number }[]
> {
  const rows = await db.read.scholarTool.findMany({
    where: { cwid },
    orderBy: [{ pmidCount: "desc" }, { maxConfidence: "desc" }],
    select: { toolName: true, category: true, pmidCount: true, maxConfidence: true },
  });
  return rows.map((r) => ({
    toolName: r.toolName,
    category: r.category,
    pmidCount: r.pmidCount,
    maxConfidence: decimalToNumber(r.maxConfidence) ?? 0,
  }));
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

  const [candidatePubs, funding, scholarTools, publicationCount, yearsActive, topics, education] =
    await Promise.all([
      loadScoredCandidatePublications(cwid),
      loadActiveFunding(cwid),
      loadScholarTools(cwid),
      countConfirmedPublications(cwid),
      assembleYearsActive(cwid),
      assembleTopics(cwid),
      assembleEducation(cwid),
    ]);

  // Resolve the effective selection. Explicit picks are ownership-filtered to the
  // candidate pools (validity + IDOR safety); an empty selection falls back to the
  // shared default rule so there is no dead-end empty state.
  const candidatePmidSet = new Set(candidatePubs.map((p) => p.pmid));
  const candidateGrantSet = new Set(funding.map((f) => f.id));
  const candidateToolSet = new Set(scholarTools.map((t) => t.toolName));

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
    const def = pickDefaultSelection(candidatePubs, funding, scholarTools);
    selectedPmids = def.pmids;
    selectedGrantIds = def.grantIds;
    selectedToolNames = def.toolNames;
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
    }));

  const activeGrants = funding
    .filter((f) => selectedGrantSet.has(f.id))
    .map((f) => ({
      role: f.role,
      funderLabel: f.funder,
      title: f.title,
      mechanism: f.mechanism,
    }));

  // The selected tools (ReciterAI methods/instruments); empty when the ETL hasn't
  // run or the scholar deselected them all.
  const methods = scholarTools
    .filter((t) => selectedToolSet.has(t.toolName))
    .map((t) => ({ name: t.toolName, category: t.category }));

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
    methods,
    facultyMetrics,
    existingBio: existingBioText ? { text: existingBioText, source: "vivo" } : null,
  };
}

/**
 * The Sources drawer candidate lists for `cwid` (v3.1 §4) — every scored pub,
 * every active award, and every tool, each flagged `defaultSelected` per the
 * shared default rule so the drawer's pre-checks match the server's
 * empty-selection behavior. `tools` is empty until C3's ETL has run.
 */
export async function loadOverviewSourceOptions(cwid: string): Promise<OverviewSourceOptions> {
  const [candidatePubs, funding, scholarTools] = await Promise.all([
    loadScoredCandidatePublications(cwid),
    loadActiveFunding(cwid),
    loadScholarTools(cwid),
  ]);

  const def = pickDefaultSelection(candidatePubs, funding, scholarTools);
  const defaultPmids = new Set(def.pmids);
  const defaultGrants = new Set(def.grantIds);
  const defaultTools = new Set(def.toolNames);

  return {
    publications: candidatePubs.map((p) => ({
      pmid: p.pmid,
      title: p.title,
      venue: p.venue,
      year: p.year,
      impact: p.impact,
      isFirstOrLast: p.isFirstOrLast,
      authorPosition: p.authorPosition,
      defaultSelected: defaultPmids.has(p.pmid),
    })),
    funding: funding.map((f) => ({
      id: f.id,
      role: f.role,
      funder: f.funder,
      title: f.title,
      award: f.awardNumber ?? f.mechanism,
      endYear: f.endYear,
      defaultSelected: defaultGrants.has(f.id),
    })),
    tools: scholarTools.map((t) => ({
      toolName: t.toolName,
      category: t.category,
      pmidCount: t.pmidCount,
      maxConfidence: t.maxConfidence,
      defaultSelected: defaultTools.has(t.toolName),
    })),
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

/** Education rows, most-recent first (a null year sorts last). */
async function assembleEducation(cwid: string): Promise<OverviewFacts["education"]> {
  const rows = await db.read.education.findMany({
    where: { cwid },
    orderBy: { year: { sort: "desc", nulls: "last" } },
    select: { degree: true, institution: true, field: true, year: true },
  });
  return rows.map((e) => ({
    degree: e.degree,
    institution: e.institution,
    field: e.field,
    year: e.year,
  }));
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
