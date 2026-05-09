/**
 * Pure projection from per-(scholar, account_number) Grant rows to one
 * funding-project document for the OpenSearch funding index (issue #80
 * items 4 + 5).
 *
 * Lives outside `lib/api/search-funding.ts` so the ETL can call it
 * without dragging in the search-runtime imports, and so unit tests can
 * exercise the dedupe + role-bucket logic directly without OpenSearch
 * or Prisma.
 *
 * The shape returned here is the OpenSearch document body — not the
 * `FundingHit` returned by `searchFunding()`. Display-only canonicalization
 * (sponsor labels, NIH IC parent rendering, mechanism expansion) stays in
 * the UI layer.
 */

import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { getSponsor } from "@/lib/sponsor-lookup";

export type GrantRowForIndex = {
  cwid: string;
  externalId: string | null;
  title: string;
  role: string;
  startDate: Date;
  endDate: Date;
  awardNumber: string | null;
  programType: string;
  primeSponsor: string | null;
  primeSponsorRaw: string | null;
  directSponsor: string | null;
  directSponsorRaw: string | null;
  mechanism: string | null;
  nihIc: string | null;
  isSubaward: boolean;
  scholar: {
    slug: string;
    preferredName: string;
    primaryDepartment: string | null;
  };
  /** Pub-grant linkages from grant_publication. Optional so test fixtures
   *  and any caller that doesn't need pub counts can omit it. The
   *  projection collects DISTINCT pmids across the project's rows into
   *  FundingDoc.pubCount. */
  publications?: Array<{ pmid: string }>;
  /** RePORTER abstract for this grant (Phase 2 ETL). Optional. The
   *  projection picks the first non-null value across the project's rows. */
  abstract?: string | null;
};

export type FundingDoc = {
  projectId: string;
  title: string;
  sponsorText: string;
  peopleNames: string;
  primeSponsor: string;
  directSponsor: string | null;
  isSubaward: boolean;
  programType: string;
  mechanism: string | null;
  nihIc: string | null;
  department: string | null;
  roles: string[];
  startDate: string;
  endDate: string;
  awardNumber: string | null;
  primeSponsorRaw: string | null;
  directSponsorRaw: string | null;
  isMultiPi: boolean;
  totalPeople: number;
  people: Array<{
    cwid: string;
    slug: string;
    preferredName: string;
    role: string;
  }>;
  /** Issue #86 — RePORTER abstract for the project, indexed for full-text
   *  search relevance and shown as a snippet in result rows. Picked from
   *  the first row whose abstract is non-null (all rows for one project
   *  share the same coreProjectNum and therefore the same abstract). */
  abstract: string | null;
  /** Issue #86 — count of DISTINCT pmids attributed to the project across
   *  all its scholar rows. Drives the pubCount sort and the inline pub
   *  count on the result row. */
  pubCount: number;
};

/** Parse `INFOED-{accountNumber}-{cwid}` external ID. */
export function parseExternalId(
  externalId: string | null,
): { accountNumber: string; cwid: string } | null {
  if (!externalId) return null;
  const m = externalId.match(/^INFOED-(.+)-([^-]+)$/);
  if (!m) return null;
  return { accountNumber: m[1], cwid: m[2] };
}

/** Per-row role bucket — Multi-PI is a project-level fact (≥2 PI rows on
 *  the same account number) and gets layered in by the caller. */
export function rowRoleBucket(role: string): "PI" | "Co-I" | null {
  if (role === "PI" || role === "PI-Subaward") return "PI";
  if (role === "Co-I" || role === "Co-PI") return "Co-I";
  return null;
}

/** Lead-PI-first ordering for the people chips — keeps the result row
 *  visually consistent with the v1 implementation. */
function sortPeople<T extends { role: string; cwid: string }>(rows: T[]): T[] {
  const rank = (r: string) => {
    if (r === "PI" || r === "PI-Subaward") return 0;
    if (r === "Co-PI") return 1;
    if (r === "Co-I") return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const d = rank(a.role) - rank(b.role);
    if (d !== 0) return d;
    return a.cwid.localeCompare(b.cwid);
  });
}

/** Resolve canonical short with a runtime second-pass against the
 *  current sponsor-lookup. Mirrors the behavior in `lib/api/profile.ts`
 *  and `lib/api/search-funding.ts` so re-indexing picks up lookup edits
 *  even before the recanonicalize backfill runs. */
function resolveCanonical(
  stored: string | null,
  raw: string | null,
): string | null {
  return stored ?? canonicalizeSponsor(raw);
}

/** Build the searchable sponsor-text blob — short + full + aliases for
 *  both prime and direct, joined into one document field. */
function buildSponsorText(args: {
  primeShort: string | null;
  primeRaw: string | null;
  directShort: string | null;
  directRaw: string | null;
}): string {
  const parts = new Set<string>();
  for (const [short, raw] of [
    [args.primeShort, args.primeRaw],
    [args.directShort, args.directRaw],
  ] as const) {
    if (short) {
      parts.add(short);
      const sp = getSponsor(short);
      if (sp) {
        parts.add(sp.full);
        for (const a of sp.aliases ?? []) parts.add(a);
      }
    }
    if (raw && raw !== short) parts.add(raw);
  }
  return Array.from(parts).join(" ");
}

/**
 * Aggregate one project's worth of Grant rows into a single OpenSearch
 * document. Rows must all share the same Account_Number (this is the
 * caller's invariant — usually a `groupBy` upstream).
 *
 * Returns null when the row set is empty or the externalId can't be
 * parsed (no project key — the v1 implementation also drops these).
 */
export function projectFromRows(rows: GrantRowForIndex[]): FundingDoc | null {
  if (rows.length === 0) return null;
  const ext = parseExternalId(rows[0].externalId);
  if (!ext) return null;

  // Per-project canonical fields are taken from any row — all rows for a
  // single account number share these by construction.
  const head = rows[0];

  const peopleRaw = rows.map((r) => ({
    cwid: r.cwid,
    slug: r.scholar.slug,
    preferredName: r.scholar.preferredName,
    role: r.role,
  }));
  const people = sortPeople(peopleRaw);

  // Role buckets — every bucket the project belongs to. Multi-PI is set
  // when the project has ≥2 PI rows.
  const roles = new Set<string>();
  let piCount = 0;
  for (const r of rows) {
    const bucket = rowRoleBucket(r.role);
    if (bucket) roles.add(bucket);
    if (r.role === "PI" || r.role === "PI-Subaward") piCount += 1;
  }
  const isMultiPi = piCount >= 2;
  if (isMultiPi) roles.add("Multi-PI");

  // Lead PI's primary department drives the Department facet.
  const leadPiRow = rows.find(
    (r) => r.role === "PI" || r.role === "PI-Subaward",
  );
  const department = leadPiRow?.scholar.primaryDepartment ?? null;

  const primeShort = resolveCanonical(head.primeSponsor, head.primeSponsorRaw);
  const directShort = resolveCanonical(
    head.directSponsor,
    head.directSponsorRaw,
  );
  const primeFacetKey = primeShort ?? head.primeSponsorRaw ?? "(unknown sponsor)";
  const directFacetKey = head.isSubaward
    ? directShort ?? head.directSponsorRaw ?? null
    : null;

  // Pub count: union of pmids across every grant row in the project.
  // All rows for one Account_Number normally share the same
  // coreProjectNum and therefore the same pub set, but unioning is safe
  // (and correct for the rare project where rows diverge).
  const pmids = new Set<string>();
  for (const r of rows) {
    if (!r.publications) continue;
    for (const p of r.publications) pmids.add(p.pmid);
  }

  // Abstract: take the first non-null one. All rows for one
  // coreProjectNum share an abstract via the Phase 2 ETL, so first-wins
  // is deterministic in practice.
  const abstract = rows.find((r) => r.abstract)?.abstract ?? null;

  return {
    projectId: ext.accountNumber,
    title: head.title,
    sponsorText: buildSponsorText({
      primeShort,
      primeRaw: head.primeSponsorRaw,
      directShort,
      directRaw: head.directSponsorRaw,
    }),
    peopleNames: peopleRaw.map((p) => p.preferredName).join(" "),
    primeSponsor: primeFacetKey,
    directSponsor: directFacetKey,
    isSubaward: head.isSubaward,
    programType: head.programType,
    mechanism: head.mechanism,
    nihIc: head.nihIc,
    department,
    roles: Array.from(roles),
    startDate: head.startDate.toISOString(),
    endDate: head.endDate.toISOString(),
    awardNumber: head.awardNumber,
    primeSponsorRaw: head.primeSponsorRaw,
    directSponsorRaw: head.directSponsorRaw,
    isMultiPi,
    totalPeople: people.length,
    people,
    abstract,
    pubCount: pmids.size,
  };
}
