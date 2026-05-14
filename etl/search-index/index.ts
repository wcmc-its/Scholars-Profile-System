/**
 * Build the OpenSearch people + publications indices from MySQL.
 *
 * In production this lives behind EventBridge, fired after the daily ETL chain
 * completes (decision #5 chain order: ED → ASMS → InfoEd → ReCiter → COI →
 * search-index). For the prototype, run on demand via `npm run search:index`.
 *
 * Key indexing decisions (spec lines 156-177):
 *   - Per-field boosts apply at QUERY time (multi_match), not at index time.
 *   - Authorship-weighted contributions (×1.0 / ×0.4 / ×0.1) apply at INDEX
 *     time via term repetition into the publication_titles and
 *     publication_mesh fields. We use the integer ratio 10:4:1.
 *   - Minimum-evidence threshold for MeSH terms: term contributes only if it
 *     appears in ≥2 of a scholar's publications OR in ≥1 first/last-author
 *     publication. Filters BEFORE emission.
 *   - Sparse-profile filter (spec line 196): scholars below the completeness
 *     threshold are still indexed (so name searches find them) but flagged
 *     `isComplete: false`. The query layer applies the filter for default
 *     browse-style searches.
 *   - Soft-deleted and suppressed scholars are NOT indexed (decision #4).
 */
import { prisma } from "../../lib/db";
import {
  FUNDING_INDEX,
  PEOPLE_INDEX,
  PUBLICATIONS_INDEX,
  fundingIndexMapping,
  peopleIndexMapping,
  publicationsIndexMapping,
  searchClient,
} from "@/lib/search";
import { parseExternalId, projectFromRows } from "@/lib/funding-projection";
import { coreProjectNum } from "@/lib/award-number";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import { isFundingActive } from "@/lib/api/search-funding";
import { isTrainingOnlyGrant } from "@/lib/grants/training-exclusions";

const AUTHORSHIP_WEIGHTS = {
  firstOrLast: 10,
  secondOrPenultimate: 4,
  middle: 1,
} as const;

type AuthorshipKind = keyof typeof AUTHORSHIP_WEIGHTS;

/**
 * Build trailing-token slices of a name so the OpenSearch completion
 * suggester resolves arbitrary middle-token prefixes. For "M. Cary Reid"
 * returns ["Cary Reid", "Reid"] — these get added as suggestion inputs
 * alongside the canonical full name, so typing "Cary" or "Reid" matches.
 *
 * Drops trailing generational suffixes ("Jr", "Sr", "II", "III", "IV") so
 * "Smith Jr" still surfaces a "Smith" slice. Empty for single-token names.
 */
/**
 * Issue #259 §1.6 — derive the deduped `reciterParentTopicId` array for one
 * publication doc from its joined `publicationTopics` rows. The Prisma
 * `distinct: ["parentTopicId"]` clause is the primary dedupe at the query
 * layer; this is a belt-and-braces against any future relaxation. Returns
 * either `{ reciterParentTopicId: [...] }` to be spread into the doc, or
 * `{}` for pubs with zero topic rows so the field is omitted (not stored
 * as `[]`) — see the call site for the `_source`-distinguishability
 * rationale.
 *
 * Exported solely for unit testing. Not part of the indexer's public API.
 */
export function buildReciterParentTopicIdField(
  publicationTopics: ReadonlyArray<{ parentTopicId: string }>,
): { reciterParentTopicId: string[] } | Record<string, never> {
  const ids = Array.from(new Set(publicationTopics.map((pt) => pt.parentTopicId)));
  return ids.length > 0 ? { reciterParentTopicId: ids } : {};
}

/**
 * Issue #259 §1.8 — derive the `impactScore` (doc-level MAX, sortable float)
 * and `topicImpacts` (per-topic MAX, used by the API to compute the
 * "Concept impact" badge value when a MeSH descriptor resolves to one or
 * more anchored curated topics).
 *
 * Input rows come from the un-deduped publication_topic join: one row per
 * (pmid, cwid, parentTopicId). For each parentTopicId we take the MAX
 * across cwids, skipping null impact scores. Pubs with zero non-null
 * impact rows write nothing for either field — the OMIT-on-empty pattern
 * matches `reciterParentTopicId` and lets `_source` consumers distinguish
 * "no signal" from "[]" / 0.
 *
 * `impactScore` is a `number` (JSON float, not Prisma Decimal) so the
 * OpenSearch float mapping accepts it directly and sort works as expected.
 * Decimal(8,4) fits well within float precision.
 *
 * Exported solely for unit testing.
 */
export function buildPubImpactFields(
  publicationTopics: ReadonlyArray<{
    parentTopicId: string;
    impactScore: { toNumber(): number } | number | null;
  }>,
):
  | {
      impactScore: number;
      topicImpacts: Array<{ parentTopicId: string; impactScore: number }>;
    }
  | Record<string, never> {
  const perTopic = new Map<string, number>();
  for (const pt of publicationTopics) {
    if (pt.impactScore === null || pt.impactScore === undefined) continue;
    const v =
      typeof pt.impactScore === "number"
        ? pt.impactScore
        : pt.impactScore.toNumber();
    if (!Number.isFinite(v)) continue;
    const prev = perTopic.get(pt.parentTopicId);
    if (prev === undefined || v > prev) perTopic.set(pt.parentTopicId, v);
  }
  if (perTopic.size === 0) return {};
  const topicImpacts = Array.from(perTopic.entries(), ([parentTopicId, impactScore]) => ({
    parentTopicId,
    impactScore,
  }));
  let max = topicImpacts[0].impactScore;
  for (let i = 1; i < topicImpacts.length; i++) {
    if (topicImpacts[i].impactScore > max) max = topicImpacts[i].impactScore;
  }
  return { impactScore: max, topicImpacts };
}

function trailingNameSlices(name: string): string[] {
  if (!name) return [];
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length <= 1) return [];
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  // Drop trailing suffix tokens so the "last name" slice anchors on the
  // surname, not "Jr".
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  const tokens = raw.slice(0, end);
  const slices: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    slices.push(tokens.slice(i).join(" "));
  }
  return slices;
}

/**
 * Extract the surname token from a "Given Last" preferredName. Strips
 * trailing generational suffixes ("Jr", "II", etc.) so "Smith Jr" yields
 * "Smith". Returns "" for empty input. Used to populate the keyword
 * `lastNameSort` field on each people doc — see issue #82.
 */
function extractLastNameSort(name: string): string {
  if (!name) return "";
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return "";
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  return raw[end - 1].toLowerCase();
}

/**
 * Build a "first + last" slice that drops middle tokens, so users typing
 * "Ronald Crystal" find "Ronald G. Crystal". Returns null for names that
 * don't have at least one middle token, and for names whose first/last is
 * already the full name (avoid duplicating the canonical input).
 */
function firstLastSlice(name: string): string | null {
  if (!name) return null;
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length < 3) return null;
  const SUFFIXES = /^(Jr|Sr|I{1,3}|IV|V|VI{0,3}|Esq)\.?,?$/i;
  let end = raw.length;
  while (end > 1 && SUFFIXES.test(raw[end - 1])) end -= 1;
  const tokens = raw.slice(0, end);
  if (tokens.length < 3) return null;
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

function classifyAuthorship(a: {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
}): AuthorshipKind {
  if (a.isFirst || a.isLast) return "firstOrLast";
  if (a.isPenultimate) return "secondOrPenultimate";
  return "middle";
}

async function ensureIndex(name: string, body: unknown) {
  const client = searchClient();
  const exists = await client.indices.exists({ index: name });
  if (exists.body) {
    await client.indices.delete({ index: name });
  }
  await client.indices.create({ index: name, body: body as object });
}

async function indexPeople() {
  const client = searchClient();
  const scholars = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      postnominal: true,
      primaryTitle: true,
      primaryDepartment: true,
      overview: true,
      // Phase 2 — replaces the Phase-1 hard-coded "Faculty" placeholder.
      // Sourced from ED ETL deriveRoleCategory (see etl/ed/index.ts).
      roleCategory: true,
      // Issue #8 item 4 — combined "Department / division" facet:
      // pull the FK-resolved names so we can render "Cardiology — Medicine"
      // bucket labels and "Cardiology · Department of Medicine" person rows
      // without an extra DB hit at query time.
      deptCode: true,
      divCode: true,
      department: { select: { name: true } },
      division: { select: { name: true } },
      topicAssignments: { orderBy: { score: "desc" } },
      grants: true,
      authorships: {
        // Issue #63 — drop Retraction / Erratum so retracted-paper titles
        // and MeSH don't pull a person into search results for unrelated
        // queries. Filtering on the related publication keeps the rollup
        // shape unchanged for everything else.
        where: {
          isConfirmed: true,
          publication: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
        },
        include: {
          publication: {
            // Issue #21 — `abstract` joins via the existing publication FK;
            // we de-dup at the field level (one copy per pmid) rather than
            // repeating by authorship position the way titles/mesh do.
            select: { title: true, meshTerms: true, abstract: true },
          },
        },
      },
    },
  });

  // Center memberships per cwid (Center has no back-relation on Scholar,
  // so this is a separate batched query). Folded into deptDivKey so the
  // sidebar's dept/div/center facet matches scholars whose center
  // membership the user clicks.
  const centerRows = await prisma.centerMembership.findMany({
    select: { cwid: true, centerCode: true },
  });
  const centerCodesByCwid = new Map<string, string[]>();
  for (const m of centerRows) {
    const arr = centerCodesByCwid.get(m.cwid) ?? [];
    arr.push(m.centerCode);
    centerCodesByCwid.set(m.cwid, arr);
  }

  const docs: Array<{ cwid: string; doc: Record<string, unknown> }> = [];

  for (const s of scholars) {
    // Title-field repetition by authorship position.
    const titleParts: string[] = [];
    // Per-term aggregation for the min-evidence threshold.
    const termAgg = new Map<
      string,
      { distinctPubs: number; hasFirstOrLast: boolean; weightedCount: number }
    >();
    // Issue #21 — collect each scholar's abstract texts (one copy per pmid;
    // duplicates can occur if the same publication shows up twice in a
    // listing, so dedupe).
    const abstractParts: string[] = [];
    const seenAbstractPmids = new Set<string>();

    for (const a of s.authorships) {
      const kind = classifyAuthorship(a);
      const weight = AUTHORSHIP_WEIGHTS[kind];

      // Repeat the title `weight` times.
      for (let i = 0; i < weight; i++) titleParts.push(a.publication.title);

      // Issue #21 — abstract: one copy per distinct pmid, no weight
      // repetition. Skip empty abstracts (many older pubs and editorials
      // have none).
      if (a.publication.abstract && !seenAbstractPmids.has(a.pmid)) {
        seenAbstractPmids.add(a.pmid);
        abstractParts.push(a.publication.abstract);
      }

      const mesh = Array.isArray(a.publication.meshTerms)
        ? (a.publication.meshTerms as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      for (const term of mesh) {
        const cur = termAgg.get(term) ?? {
          distinctPubs: 0,
          hasFirstOrLast: false,
          weightedCount: 0,
        };
        cur.distinctPubs += 1;
        if (kind === "firstOrLast") cur.hasFirstOrLast = true;
        cur.weightedCount += weight;
        termAgg.set(term, cur);
      }
    }

    // Apply min-evidence threshold and emit term repetitions.
    const meshParts: string[] = [];
    for (const [term, agg] of termAgg.entries()) {
      if (agg.distinctPubs < 2 && !agg.hasFirstOrLast) continue;
      for (let i = 0; i < agg.weightedCount; i++) meshParts.push(term);
    }

    // Issue #233 — `hasActiveGrants` realigned onto NCE 12-month grace
    // semantics so the People-tab Activity facet, the PI facet, and the
    // Funding tab all share one definition of "currently active." Small
    // behavior delta: grants in their NCE window flip from "inactive" to
    // "active" here.
    const now = new Date();
    const PI_ROLES = new Set(["PI", "PI-Subaward"]);
    const hasActiveGrants = s.grants.some((g) => isFundingActive(g.endDate, now));
    const piRoleEver = s.grants.some((g) => PI_ROLES.has(g.role));
    const activePiGrantCount = s.grants.reduce((n, g) => {
      if (!PI_ROLES.has(g.role)) return n;
      if (!isFundingActive(g.endDate, now)) return n;
      if (isTrainingOnlyGrant(g)) return n;
      return n + 1;
    }, 0);
    const isComplete =
      !!s.overview && s.authorships.length >= 3 && hasActiveGrants ? true : false;
    // Phase 2 — sourced from ED ETL derivation (lib/eligibility.ts RoleCategory).
    // "unknown" only fires for scholars whose ED ETL has not yet backfilled
    // role_category (transitional state during the first refresh after migration).
    const personType = s.roleCategory ?? "unknown";

    const aoi = s.topicAssignments.map((t) => t.topic).join(" ");

    // Most recent publication date for the "Most recent publication" sort
    // option (spec line 194). Pull from authorships; null-safe.
    const pubDates = await prisma.publicationAuthor.findMany({
      where: { cwid: s.cwid, isConfirmed: true },
      select: { publication: { select: { dateAddedToEntrez: true } } },
    });
    const mostRecentPubDate = pubDates
      .map((p) => p.publication.dateAddedToEntrez)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    // OpenSearch's `completion` suggester matches a PREFIX of the input
    // string (not tokens within it), so feeding only `preferredName` ("M.
    // Cary Reid") means queries like "Cary" or "Reid" never resolve. Add a
    // suggestion input for every trailing-token slice ("Cary Reid", "Reid")
    // plus a "Last, First" variant so middle-name and last-name search both
    // work without changing the mapping. The suggest API resolves matched
    // docs back to preferredName via mget, so the dropdown still shows the
    // canonical full name regardless of which slice matched.
    const displayName = s.postnominal
      ? `${s.preferredName}, ${s.postnominal}`
      : s.preferredName;
    const nameSuggestInputs: Array<{ input: string; weight: number }> = [
      { input: displayName, weight: 100 },
      // CWID is the canonical scholar identifier; a prefix match resolves
      // back to the canonical preferredName via mget in suggestNames(),
      // so a paste of "pja2002" surfaces the same row a name lookup would.
      { input: s.cwid, weight: 99 },
    ];
    const slices = trailingNameSlices(s.preferredName);
    for (const slice of slices) {
      nameSuggestInputs.push({ input: slice, weight: 95 });
    }
    // "First Last" with middle tokens dropped — so "Ronald Crystal" matches
    // "Ronald G. Crystal". Apply to both preferredName and fullName since the
    // two can differ (e.g. fullName carries an unabridged middle name).
    const firstLastFromPreferred = firstLastSlice(s.preferredName);
    if (firstLastFromPreferred) {
      nameSuggestInputs.push({ input: firstLastFromPreferred, weight: 92 });
    }
    const firstLastFromFull = firstLastSlice(s.fullName);
    if (firstLastFromFull && firstLastFromFull !== firstLastFromPreferred) {
      nameSuggestInputs.push({ input: firstLastFromFull, weight: 92 });
    }
    const lastName = slices[slices.length - 1];
    if (lastName) {
      nameSuggestInputs.push({
        input: `${lastName}, ${s.preferredName}`,
        weight: 90,
      });
    }
    if (s.primaryTitle) {
      nameSuggestInputs.push({
        input: `${displayName} — ${s.primaryTitle}`,
        weight: 80,
      });
    }

    // Combined dept/division/center facet keys. The field is multi-valued
    // so a scholar with a primary appointment AND center memberships
    // contributes one bucket per affiliation. Labels are resolved
    // server-side in the page (see PeopleResults) — the keys here are
    // stable identifiers, the display strings come from Prisma.
    const deptName = s.department?.name ?? s.primaryDepartment ?? null;
    const divisionName = s.division?.name ?? null;
    const deptDivKeys: string[] = [];
    if (s.deptCode) {
      // Always emit the bare department key so the facet rail surfaces a
      // department roll-up bucket (e.g. "Medicine 682") alongside the
      // per-division detail buckets (#154 follow-up). Without this, scholars
      // who have a division (Cardiology, GI, etc.) only contribute to the
      // composite "Cardiology — Medicine" bucket and the umbrella department
      // disappears from the list when other facets narrow the result set.
      deptDivKeys.push(s.deptCode);
      if (s.divCode) {
        deptDivKeys.push(`${s.deptCode}--${s.divCode}`);
      }
    } else if (deptName) {
      // Long-tail: no FK code, free-text dept name. Use the name itself
      // as the key so the facet stays useful during the ED-backfill window.
      deptDivKeys.push(`name:${deptName}`);
    }
    for (const code of centerCodesByCwid.get(s.cwid) ?? []) {
      deptDivKeys.push(`center:${code}`);
    }
    void divisionName; // retained for potential future enrichment

    docs.push({
      cwid: s.cwid,
      doc: {
        cwid: s.cwid,
        slug: s.slug,
        preferredName: displayName,
        lastNameSort: extractLastNameSort(s.preferredName),
        // Append postnominal to fullName for search recall ("Curtis Cole MD"
        // matching), keep the constructed full form as a fallback.
        fullName: s.postnominal
          ? `${s.fullName}, ${s.postnominal}`
          : s.fullName,
        primaryTitle: s.primaryTitle,
        primaryDepartment: s.primaryDepartment,
        deptCode: s.deptCode,
        divCode: s.divCode,
        deptName,
        divisionName: s.division?.name ?? null,
        deptDivKey: deptDivKeys,
        nameSuggest: nameSuggestInputs,
        areasOfInterest: aoi,
        overview: s.overview,
        publicationTitles: titleParts.join(" "),
        publicationMesh: meshParts.join(" "),
        publicationAbstracts: abstractParts.join(" "),
        hasActiveGrants,
        piRoleEver,
        activePiGrantCount,
        isComplete,
        personType,
        publicationCount: s.authorships.length,
        grantCount: s.grants.length,
        mostRecentPubDate,
      },
    });
  }

  if (docs.length === 0) return 0;

  // Bulk index in chunks to stay under OpenSearch's 10 MB request limit.
  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const body: Record<string, unknown>[] = [];
    for (const { cwid, doc } of chunk) {
      body.push({ index: { _index: PEOPLE_INDEX, _id: cwid } });
      body.push(doc);
    }
    const resp = await client.bulk({ refresh: true, body });
    if (resp.body.errors) {
      const firstError = resp.body.items.find(
        (it: { index?: { error?: unknown } }) => it.index?.error,
      );
      throw new Error(
        `People bulk indexing had errors: ${JSON.stringify(firstError, null, 2)}`,
      );
    }
    console.log(`  ...indexed ${Math.min(i + CHUNK, docs.length)}/${docs.length} people`);
  }
  return docs.length;
}

async function indexPublications() {
  const client = searchClient();
  const PUB_PAGE = 2000;
  let cursor: string | undefined;
  let totalIndexed = 0;

  for (;;) {
    // Only publications that have at least one ACTIVE WCM author with a
    // confirmed authorship — matches the spec's authorship-confirmation logic.
    const pubs = await prisma.publication.findMany({
      take: PUB_PAGE,
      ...(cursor ? { skip: 1, cursor: { pmid: cursor } } : {}),
      orderBy: { pmid: "asc" },
      // Issue #63 — never index Retraction notices or Errata. Filtering at
      // index-build time keeps the publications index clean without any
      // query-time gymnastics; a future search hit by PMID for a retracted
      // paper simply returns zero hits.
      where: { publicationType: { notIn: [...NEVER_DISPLAY_TYPES] } },
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
        // Issue #259 §1.6 + §1.8 — ReciterAI parent-topic IDs (for the
        // OR-of-evidence pub filter) and per-(scholar, topic) `impactScore`
        // (for the §1.8 doc-level MAX + per-topic-MAX badge values).
        //
        // No `distinct: ["parentTopicId"]` here: §1.8 needs all cwid rows
        // so the helper can take MAX(impactScore) per parentTopicId across
        // cwids. `buildReciterParentTopicIdField` does its own Set-based
        // dedup, so the §1.6 field stays correct without the query-layer
        // distinct.
        publicationTopics: {
          select: { parentTopicId: true, impactScore: true },
        },
      },
    });

    if (pubs.length === 0) break;
    cursor = pubs[pubs.length - 1].pmid;

  const docs: Array<{ pmid: string; doc: Record<string, unknown> }> = [];
  for (const p of pubs) {
    const authorNames = p.authors
      .map((a) => a.externalName ?? a.scholar?.preferredName ?? "")
      .filter(Boolean)
      .join(", ");

    const wcmAuthorRows = p.authors.filter(
      (a) =>
        a.scholar &&
        !a.scholar.deletedAt &&
        a.scholar.status === "active",
    );
    const wcmAuthors = wcmAuthorRows.map((a) => ({
      cwid: a.scholar!.cwid,
      slug: a.scholar!.slug,
      preferredName: a.scholar!.preferredName,
      position: a.position,
    }));

    // WCM author position roles (issue #8 follow-up). For each WCM author
    // on the paper, classify their position into {first, senior, middle}
    // and union the results so a paper with one WCM first-author and one
    // WCM middle-author shows up under both filters. Single-author papers
    // count as both first AND senior — matches CV / promotion-committee
    // convention (sole authorship = highest possible authorship signal).
    const wcmAuthorPositions = new Set<string>();
    for (const a of wcmAuthorRows) {
      if (a.totalAuthors === 1) {
        wcmAuthorPositions.add("first");
        wcmAuthorPositions.add("senior");
        continue;
      }
      if (a.isFirst) wcmAuthorPositions.add("first");
      if (a.isLast) wcmAuthorPositions.add("senior");
      if (!a.isFirst && !a.isLast) wcmAuthorPositions.add("middle");
    }

    const mesh = Array.isArray(p.meshTerms)
      ? (p.meshTerms as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    // Issue #259 §1.6 — ReciterAI parent-topic IDs. `parentTopicId` is
    // non-nullable on PublicationTopic (it's part of the composite PK
    // `[pmid, cwid, parentTopicId]` per prisma/schema.prisma:744), so no
    // null filter is needed. The helper handles dedup + omit-on-empty.
    const reciterParentTopicIdField = buildReciterParentTopicIdField(
      p.publicationTopics,
    );

    // Issue #259 §1.8 — doc-level MAX `impactScore` (sortable) and per-topic
    // MAX `topicImpacts` (used by the API to compute the "Concept impact"
    // badge value against the resolved concept's anchored topics).
    // OMIT-on-empty: pubs with no non-null impact rows write neither
    // field, mirroring the `reciterParentTopicId` distinction.
    const pubImpactFields = buildPubImpactFields(p.publicationTopics);

    docs.push({
      pmid: p.pmid,
      doc: {
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        publicationType: p.publicationType,
        citationCount: p.citationCount,
        dateAddedToEntrez: p.dateAddedToEntrez,
        doi: p.doi,
        pmcid: p.pmcid,
        pubmedUrl: p.pubmedUrl,
        meshTerms: mesh.join(" "),
        // Issue #32 — index abstract text on the publications doc so
        // thematic queries (e.g. "psychiatric comorbidities") can match
        // the paper itself, not just the scholar. Empty/missing abstracts
        // are stored as empty string; OpenSearch indexes nothing for them.
        abstract: p.abstract ?? "",
        authorNames,
        wcmAuthors,
        wcmAuthorPositions: Array.from(wcmAuthorPositions),
        // Issue #88 — flat CWID array for the Author facet aggregation.
        wcmAuthorCwids: wcmAuthors.map((a) => a.cwid),
        // Issue #259 §1.6 — OMIT-on-empty: pubs with zero publication_topic
        // rows write nothing for this field, not an empty array. Lets
        // `_source` consumers (the §1.11 chip path, debug tooling)
        // distinguish "no signal" from "[]". OpenSearch treats absent and
        // `[]` identically at query time, so this is a `_source`-only
        // distinction.
        ...reciterParentTopicIdField,
        // Issue #259 §1.8 — same OMIT-on-empty contract for the doc-level
        // impact aggregates; spread emits nothing on pubs with no non-null
        // impact rows.
        ...pubImpactFields,
      },
    });
  }

    if (docs.length === 0) { if (pubs.length < PUB_PAGE) break; continue; }

    // Bulk index this page's docs in 500-doc chunks.
    const CHUNK = 500;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      const body: Record<string, unknown>[] = [];
      for (const { pmid, doc } of chunk) {
        body.push({ index: { _index: PUBLICATIONS_INDEX, _id: pmid } });
        body.push(doc);
      }
      const resp = await client.bulk({ refresh: true, body });
      if (resp.body.errors) {
        const firstError = resp.body.items.find(
          (it: { index?: { error?: unknown } }) => it.index?.error,
        );
        throw new Error(
          `Publications bulk indexing had errors: ${JSON.stringify(firstError, null, 2)}`,
        );
      }
    }
    totalIndexed += docs.length;
    console.log(`  ...indexed ${totalIndexed} publications so far`);
    if (pubs.length < PUB_PAGE) break;
  }
  return totalIndexed;
}

async function indexFunding() {
  const client = searchClient();
  const rows = await prisma.grant.findMany({
    where: { scholar: { deletedAt: null, status: "active" } },
    select: {
      cwid: true,
      externalId: true,
      title: true,
      role: true,
      startDate: true,
      endDate: true,
      awardNumber: true,
      programType: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      directSponsor: true,
      directSponsorRaw: true,
      mechanism: true,
      nihIc: true,
      isSubaward: true,
      // Issue #86 — pulled into the OpenSearch funding doc for sort
      // (pubCount), full-text relevance (abstract), and the inline
      // publications-expand UX on result rows.
      abstract: true,
      abstractSource: true,
      applId: true,
      publications: {
        select: {
          pmid: true,
          sourceReporter: true,
          sourceReciterdb: true,
          reciterdbFirstSeen: true,
          publication: {
            select: {
              title: true,
              journal: true,
              year: true,
              citationCount: true,
            },
          },
        },
      },
      scholar: {
        select: {
          slug: true,
          preferredName: true,
          primaryDepartment: true,
        },
      },
    },
  });

  // Group key: coreProjectNum when available, else Account_Number.
  // InfoEd sometimes splits one NIH award across multiple Account_Numbers
  // (rebookings, supplements, administrative continuations); coreProjectNum
  // collapses those into one search result. Non-NIH grants fall back to
  // Account_Number since they have no coreProjectNum.
  const byProject = new Map<string, typeof rows>();
  for (const r of rows) {
    const ext = parseExternalId(r.externalId);
    if (!ext) continue;
    const key = coreProjectNum(r.awardNumber) ?? ext.accountNumber;
    const arr = byProject.get(key) ?? [];
    arr.push(r);
    byProject.set(key, arr);
  }

  const docs: Array<{ projectId: string; doc: Record<string, unknown> }> = [];
  for (const [key, projectRows] of byProject.entries()) {
    const doc = projectFromRows(projectRows);
    if (!doc) continue;
    // Override projectId to the grouping key so the OpenSearch _id stays
    // stable across re-indexes even when the order of merged
    // Account_Numbers under one coreProjectNum changes.
    doc.projectId = key;
    docs.push({ projectId: key, doc: doc as unknown as Record<string, unknown> });
  }

  if (docs.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const body: Record<string, unknown>[] = [];
    for (const { projectId, doc } of chunk) {
      body.push({ index: { _index: FUNDING_INDEX, _id: projectId } });
      body.push(doc);
    }
    const resp = await client.bulk({ refresh: true, body });
    if (resp.body.errors) {
      const firstError = resp.body.items.find(
        (it: { index?: { error?: unknown } }) => it.index?.error,
      );
      throw new Error(
        `Funding bulk indexing had errors: ${JSON.stringify(firstError, null, 2)}`,
      );
    }
    console.log(`  ...indexed ${Math.min(i + CHUNK, docs.length)}/${docs.length} funding projects`);
  }
  return docs.length;
}

async function main() {
  console.log("Recreating indices...");
  await ensureIndex(PEOPLE_INDEX, peopleIndexMapping);
  await ensureIndex(PUBLICATIONS_INDEX, publicationsIndexMapping);
  await ensureIndex(FUNDING_INDEX, fundingIndexMapping);

  console.log("Indexing people...");
  const peopleCount = await indexPeople();

  console.log("Indexing publications...");
  const pubCount = await indexPublications();

  console.log("Indexing funding...");
  const fundingCount = await indexFunding();

  console.log(
    `Indexed ${peopleCount} scholars, ${pubCount} publications, ${fundingCount} funding projects.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
