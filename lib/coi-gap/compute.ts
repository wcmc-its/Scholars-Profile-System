/**
 * Compute a scholar's current COI gaps from already-ingested SPS data.
 *
 * Reads (no external/VPC dependency — all SPS-DB):
 *   - the scholar's name (for attribution) from `scholar`;
 *   - their disclosed Self relationships from `coi_activity`;
 *   - their confirmed-authorship PMIDs from `publication_author`;
 *   - the per-PMID PubMed COI statement text from `publication_conflict_statement`;
 *   - the per-PMID author byline from `publication` (for the co-author cross-check).
 *
 * Runs `lib/coi-gap` per statement (with `canonicalizeSponsor` injected so a
 * disclosed "Pfizer" matches an extracted "Pfizer Inc." and the paper's author
 * roster injected so a co-author name bled into the statement is dropped) and
 * returns the current High/Medium gaps, deduped per (pmid, normalized entity).
 * Pure of any verdict: the result is recomputed each run and reconciled by
 * `lib/coi-gap/lifecycle`.
 */
import { db } from "@/lib/db";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { analyzeStatement, buildAuthorRoster, deriveScholar, type AuthorRoster, type Scholar } from "./pipeline";
import type { FreshGap } from "./lifecycle";

/** Derive an attribution Scholar from the display name ("First [Middle] Last"). */
export function scholarFromDisplayName(preferredName: string | null | undefined, fallback?: string | null): Scholar {
  const name = (preferredName || fallback || "").trim();
  const toks = name.split(/\s+/).filter(Boolean);
  const first = toks[0] ?? "";
  const last = toks.length > 1 ? toks[toks.length - 1] : "";
  return deriveScholar(first, last);
}

const RANK = { High: 3, Medium: 2 } as const;

/** The already-ingested inputs a scholar's COI-gap analysis needs, loaded once.
 *  Shared by `computeScholarGaps` (production) and the diagnostic export so both
 *  read the disclosed set + statements through one query path. `null` when the
 *  scholar is unknown or has no usable surname (can't attribute → surface
 *  nothing); `statements` is empty when they have no confirmed authorships. */
export type CoiInputs = {
  scholar: Scholar;
  disclosed: string[];
  statements: { pmid: string; statementText: string }[];
  /** Per-PMID author byline parsed for the co-author cross-check (see
   *  `buildAuthorRoster`). A PMID is absent when its publication row has no byline. */
  rosters: Map<string, AuthorRoster>;
};

export async function loadCoiInputs(cwid: string): Promise<CoiInputs | null> {
  const scholar = await db.read.scholar.findUnique({
    where: { cwid },
    select: { preferredName: true, fullName: true },
  });
  if (!scholar) return null;
  const s = scholarFromDisplayName(scholar.preferredName, scholar.fullName);
  if (!s.surname) return null; // no usable surname → can't attribute; surface nothing

  // Disclosed Self relationships (recall-biased: null relatesTo treated as Self).
  const disclosedRows = await db.read.coiActivity.findMany({
    where: { cwid },
    select: { entity: true, activityRelatesTo: true },
  });
  const disclosed = disclosedRows
    .filter((d) => d.entity && (d.activityRelatesTo == null || /self/i.test(d.activityRelatesTo)))
    .map((d) => d.entity as string);

  // Confirmed-authorship PMIDs → their COI statements.
  const links = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: { pmid: true },
  });
  const pmids = [...new Set(links.map((l) => l.pmid))];
  if (pmids.length === 0) return { scholar: s, disclosed, statements: [], rosters: new Map() };

  const statements = await db.read.publicationConflictStatement.findMany({
    where: { pmid: { in: pmids } },
    select: { pmid: true, statementText: true },
  });

  // Author bylines for the co-author cross-check: prefer the untruncated
  // `fullAuthorsString` (every author incl. externals), fall back to the rendered
  // `authorsString`. Both are surname-first "Lastname Initials" (see Publication).
  const pubs = await db.read.publication.findMany({
    where: { pmid: { in: pmids } },
    select: { pmid: true, fullAuthorsString: true, authorsString: true },
  });
  const rosters = new Map<string, AuthorRoster>();
  for (const p of pubs) {
    const byline = p.fullAuthorsString || p.authorsString;
    if (byline) rosters.set(p.pmid, buildAuthorRoster(byline));
  }

  return { scholar: s, disclosed, statements, rosters };
}

export async function computeScholarGaps(cwid: string): Promise<FreshGap[]> {
  const inputs = await loadCoiInputs(cwid);
  if (!inputs || inputs.statements.length === 0) return [];
  const { scholar: s, disclosed, statements, rosters } = inputs;

  const byKey = new Map<string, FreshGap>();
  for (const st of statements) {
    const { candidates } = analyzeStatement(st.statementText, s, disclosed, {
      canonicalize: canonicalizeSponsor,
      roster: rosters.get(st.pmid),
    });
    for (const c of candidates) {
      if (c.tier !== "High" && c.tier !== "Medium") continue; // analyzeStatement never returns Low, but narrow the type
      const fg: FreshGap = {
        pmid: st.pmid,
        normalizedEntity: c.normalized,
        entity: c.entity,
        tier: c.tier,
        attribution: c.attribution,
        entityScore: c.entityScore,
        category: c.category,
        sourceSentence: c.sourceSentence,
      };
      const k = `${fg.pmid}::${fg.normalizedEntity}`;
      const prev = byKey.get(k);
      if (!prev || RANK[fg.tier] > RANK[prev.tier]) byKey.set(k, fg);
    }
  }
  return [...byKey.values()];
}
