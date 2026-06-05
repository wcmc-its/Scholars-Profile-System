/**
 * The facts contract for the overview-statement generator (#742,
 * `docs/overview-statement-generator-spec.md` § The facts contract).
 *
 * `assembleOverviewFacts(cwid)` reads the scholar's live Scholars data — the
 * SAME data the public profile renders — and shapes it into the ONLY input the
 * model ever sees (`lib/edit/overview-generator.ts` serializes it as a data
 * block, never as instructions). Nothing here is invented: every field maps to
 * a column. A null value is omitted by the prompt, never guessed.
 *
 * The governing rule (SPEC § Sources & the staleness principle): identity —
 * `title`, `department`, `education` — ALWAYS comes from the structured ED /
 * Scholars columns, never from `existingBio`, because harvested bios drift. An
 * `existingBio` is opportunistic enrichment for career narrative the structured
 * fields lack, and is treated as possibly stale.
 *
 * Read-only — this module performs NO write (the draft is saved through the
 * existing owner-gated `/api/edit/field` path, never from here). Node-runtime
 * only (Prisma).
 */
import { db } from "@/lib/db";

/** How many parent topics, representative publications, and active grants the
 *  facts payload carries — bounded so the prompt stays small and the cost cap
 *  holds (SPEC § threat model — cost/abuse). */
const TOPIC_LIMIT = 4;
const REPRESENTATIVE_PUBLICATION_LIMIT = 5;
const ACTIVE_GRANT_LIMIT = 5;
/** Abstracts are excerpted, not passed whole — enough to ground a specific
 *  claim without bloating the prompt (SPEC § facts contract). */
const ABSTRACT_EXCERPT_LENGTH = 400;

/**
 * The facts contract — `assembleOverviewFacts`'s output, and the model's only
 * input. Mirrors the SPEC § facts contract.
 *
 * NOTE: there is deliberately NO `methods` field. The SPEC's contract sketch
 * lists a `methods: string[]` sourced from ReciterAI `TOOL#`, but `TOOL#` is
 * NOT ingested into the SPS database (SPEC Open Question #10 — the in-SPS path
 * has no ETL for it). Including the field would mean shipping a value that is
 * always `[]`, so it is omitted until the ingest exists.
 */
export type OverviewFacts = {
  // --- identity (authoritative, from ED — NEVER taken from a source bio) ---
  /** scholar.preferred_name */
  name: string;
  /** scholar.primary_title — CURRENT; overrides any title in `existingBio`. */
  title: string | null;
  /** scholar.primary_department */
  department: string | null;

  // --- research signal (the quality lever) ---
  /** Top parent topics by distinct-pmid count, each with one representative
   *  rationale ("why this body of work maps here"). */
  topics: {
    label: string;
    rationale: string | null;
  }[];
  /** Top publications by impact score (recent-weighted tiebreak), with the
   *  grounding fields that let the model name a true specific. */
  representativePublications: {
    title: string;
    venue: string | null;
    year: number | null;
    impact: number | null;
    abstractExcerpt: string | null;
    impactJustification: string | null;
    synopsis: string | null;
  }[];
  /** Distinct confirmed-authorship pmid count. */
  publicationCount: number;
  /** First / last publication year across the corpus. */
  yearsActive: { first: number | null; last: number | null };

  // --- funding / training ---
  /** Grants whose end date is today or later. */
  activeGrants: { role: string; funderLabel: string; mechanism: string | null }[];
  /** Education rows, most-recent first. `field` is frequently null and must
   *  never be invented (SPEC § facts contract rule 2). */
  education: { degree: string; institution: string; field: string | null; year: number | null }[];

  // --- OPTIONAL enrichment: an existing human-written bio, when one exists ---
  /** The frozen VIVO-seed overview as plain text, when present — mined for
   *  narrative the structured fields lack; the structured fields WIN on title,
   *  current research, and any conflict. `null` when the scholar has none. */
  existingBio: {
    text: string;
    source: string;
  } | null;
};

/** Strip HTML tags + collapse whitespace — `existingBio.text` is plain text,
 *  not the raw `overview` HTML (SPEC § facts contract rule 3). */
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

/**
 * Assemble the facts payload for `cwid` from live Scholars data. Returns `null`
 * when no scholar row exists (a soft-deleted / missing cwid) — the route maps
 * that to a 404. Reads only (`db.read`); writes nothing.
 *
 * Every collection is bounded and ordered the way the SPEC's contract specifies
 * so the model gets the scholar's strongest, most-current signal: topics by
 * how much of the corpus maps to them, publications by impact, grants by
 * recency, education most-recent-first.
 */
export async function assembleOverviewFacts(cwid: string): Promise<OverviewFacts | null> {
  const scholar = await db.read.scholar.findUnique({
    where: { cwid },
    select: {
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
      overview: true,
    },
  });
  if (!scholar) return null;

  // The scholar's confirmed-authorship pmid set — the spine for the pub list,
  // the distinct-pmid count, and yearsActive.
  const authorships = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true },
  });
  const pmids = Array.from(new Set(authorships.map((a) => a.pmid)));
  const publicationCount = pmids.length;

  const [representativePublications, yearsActive, topics, activeGrants, education] =
    await Promise.all([
      assembleRepresentativePublications(pmids),
      assembleYearsActive(pmids),
      assembleTopics(cwid),
      assembleActiveGrants(cwid),
      assembleEducation(cwid),
    ]);

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
    // The seed overview is frozen VIVO prose; pass it as stale-aware enrichment.
    existingBio: existingBioText ? { text: existingBioText, source: "vivo" } : null,
  };
}

/** Top publications by impact score (nulls last), tiebreak year desc. */
async function assembleRepresentativePublications(
  pmids: string[],
): Promise<OverviewFacts["representativePublications"]> {
  if (pmids.length === 0) return [];
  const rows = await db.read.publication.findMany({
    where: { pmid: { in: pmids } },
    orderBy: [{ impactScore: { sort: "desc", nulls: "last" } }, { year: "desc" }],
    take: REPRESENTATIVE_PUBLICATION_LIMIT,
    select: {
      title: true,
      journal: true,
      year: true,
      impactScore: true,
      abstract: true,
      impactJustification: true,
      synopsis: true,
    },
  });
  return rows.map((r) => ({
    title: r.title,
    venue: r.journal,
    year: r.year,
    impact: decimalToNumber(r.impactScore),
    abstractExcerpt: r.abstract ? r.abstract.slice(0, ABSTRACT_EXCERPT_LENGTH) : null,
    impactJustification: r.impactJustification,
    synopsis: r.synopsis,
  }));
}

/** Min / max publication year across the corpus. */
async function assembleYearsActive(
  pmids: string[],
): Promise<OverviewFacts["yearsActive"]> {
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
 *
 * `_count` over-reports when a (pmid, topic) appears under multiple author
 * positions, so distinct-pmid is counted from the rows rather than via a
 * grouped `_count` (the same DISTINCT-pmid lesson as the topic pub counts).
 */
async function assembleTopics(cwid: string): Promise<OverviewFacts["topics"]> {
  const rows = await db.read.publicationTopic.findMany({
    where: { cwid },
    select: { parentTopicId: true, pmid: true, rationale: true },
  });
  if (rows.length === 0) return [];

  // Fold rows into per-topic { distinct pmids, a representative rationale }.
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
    // A topic id with no catalog row is dropped — we never surface a raw slug.
    return label ? [{ label, rationale: entry.rationale }] : [];
  });
}

/** Active grants (end date today or later), most-recent-ending first. */
async function assembleActiveGrants(cwid: string): Promise<OverviewFacts["activeGrants"]> {
  const today = startOfToday();
  const rows = await db.read.grant.findMany({
    where: { cwid, endDate: { gte: today } },
    orderBy: { endDate: "desc" },
    take: ACTIVE_GRANT_LIMIT,
    select: { role: true, funder: true, mechanism: true },
  });
  return rows.map((g) => ({ role: g.role, funderLabel: g.funder, mechanism: g.mechanism }));
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

/** UTC midnight today — the active-grant cutoff (`endDate >= today`). */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Whether the facts payload has enough real signal to draft a non-padded
 * overview (SPEC § States & edge cases G2). A scholar with no representative
 * publication, no active grant, and fewer than two topics is too sparse — the
 * route returns 422 rather than ask the model to confabulate generic praise
 * over a thin record.
 */
export function hasSufficientFacts(facts: OverviewFacts): boolean {
  return (
    facts.representativePublications.length >= 1 ||
    facts.activeGrants.length >= 1 ||
    facts.topics.length >= 2
  );
}
