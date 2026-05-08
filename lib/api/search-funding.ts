/**
 * Search-funding API — issue #78 Wave D.
 *
 * Powers the third tab on the unified search results page (sibling to
 * People + Publications). Returns one hit per *project*, deduplicating
 * across the per-(scholar, account_number) `Grant` rows so a multi-WCM
 * grant doesn't appear N times.
 *
 * v1 implementation is Prisma-backed and runs JS-side dedup + facet
 * counting. The working set after structured filters is small enough for
 * the dataset (~10K unique projects post-dedup, ~67K rows pre-dedup)
 * that this is fine for the first cut. An OpenSearch index can layer in
 * later if relevance ranking against title text matters.
 *
 * Spec references:
 *   F1 — tab + sort options
 *   F2 — result row (title, people, sponsor, dates, mechanism, IDs)
 *   F3 — facets: Funder, Type, Mechanism, Status, Department, Role
 *   F6 — prime/direct sponsor + isSubaward
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { isFundingActive } from "@/lib/api/profile";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { Prisma } from "@/lib/generated/prisma/client";

const PAGE_SIZE = 20;

/** 12 months grace beyond end_date (issue #78 Q6). Mirrors
 *  `isFundingActive` so derived statuses use the same window. */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;
const ENDING_SOON_MS = 365 * 24 * 60 * 60 * 1000;
const RECENTLY_ENDED_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type FundingSort = "relevance" | "endDate" | "startDate";

export type FundingStatus = "active" | "ending_soon" | "recently_ended";

export type FundingRoleBucket = "PI" | "Multi-PI" | "Co-I";

export type FundingFilters = {
  /** Canonical sponsor short names (e.g. "NCI"). Filters on PRIME sponsor
   *  per F6. Multi-select OR within the group. */
  funder?: string[];
  /** Issue #80 item 7 — canonical short names that should match on the
   *  DIRECT sponsor (subaward issuer) rather than the prime. Surfaced via
   *  the Funder facet's type-ahead with a "via" annotation. */
  directFunder?: string[];
  /** programType values from InfoEd. */
  programType?: string[];
  /** NIH activity codes. Selecting a mechanism implicitly excludes
   *  non-NIH funders (see F3). */
  mechanism?: string[];
  status?: FundingStatus[];
  /** Department code or free-text department name as stored on the
   *  scholar's primary appointment. */
  department?: string[];
  role?: FundingRoleBucket[];
};

export type FundingPersonChip = {
  cwid: string;
  slug: string;
  preferredName: string;
  /** Per-person role on this grant: PI | Multi-PI | Co-I | Sub-PI | KP. */
  role: string;
  identityImageEndpoint: string;
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
  /** WCM scholars on the grant — lead PI first, Multi-PIs next, Co-Is last.
   *  Capped at 4 visible per F2; remainder rolls into `+N more`. */
  people: FundingPersonChip[];
  totalPeople: number;
  /** Department of record — typically lead PI's primary appointment. */
  department: string | null;
};

export type SearchFacetBucket = { value: string; count: number };

export type FundingSearchResult = {
  hits: FundingHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    /** Top-N prime sponsors with display labels (canonical short or raw). */
    funders: Array<{ value: string; label: string; count: number }>;
    /** Direct sponsors (subaward issuers) with their per-project counts.
     *  Used by the Funder type-ahead's "via" surface (issue #80 item 7).
     *  Only includes rows where direct ≠ prime. */
    directFunders: Array<{ value: string; label: string; count: number }>;
    programTypes: SearchFacetBucket[];
    mechanisms: SearchFacetBucket[];
    status: { active: number; endingSoon: number; recentlyEnded: number };
    departments: SearchFacetBucket[];
    roles: { pi: number; multiPi: number; coI: number };
  };
};

/** Parse `INFOED-{accountNumber}-{cwid}` external ID. The cwid is the
 *  last dash-separated segment; everything between the literal "INFOED-"
 *  prefix and that final segment is the account number (which can itself
 *  contain dashes). Returns null when the format doesn't match. */
function parseExternalId(externalId: string | null): { accountNumber: string; cwid: string } | null {
  if (!externalId) return null;
  const m = externalId.match(/^INFOED-(.+)-([^-]+)$/);
  if (!m) return null;
  return { accountNumber: m[1], cwid: m[2] };
}

/** Promote canonical short names; fall back to raw or "(unknown sponsor)". */
function displaySponsor(canonical: string | null, raw: string | null): string {
  return canonical ?? raw ?? "(unknown sponsor)";
}

/** Resolve canonical short with a runtime second-pass against the
 *  current canonicalization rules. Lets sponsor-lookup additions and
 *  normalization tweaks (issue #78 follow-ups) take effect against
 *  existing rows without an ETL re-run. */
function resolveCanonical(stored: string | null, raw: string | null): string | null {
  return stored ?? canonicalizeSponsor(raw);
}

/** Normalize a per-row role to one of the F3 facet buckets. The Multi-PI
 *  bucket is computed at the project level (multiple PI rows for the same
 *  account number); per-row this just splits PI / Co-I / Other. */
function rowRoleBucket(role: string): "PI" | "Co-I" | null {
  if (role === "PI" || role === "PI-Subaward") return "PI";
  if (role === "Co-I" || role === "Co-PI") return "Co-I";
  return null;
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

/** Sort the WCM person chips for a project: lead PIs first (in CWID
 *  order to keep this stable), Multi-PIs next, then everyone else.
 *  Single-PI structure is implied by ordering — no explicit tag (F2). */
function sortPeople(rows: Array<FundingPersonChip>): FundingPersonChip[] {
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

export async function searchFunding(opts: {
  q: string;
  page?: number;
  sort?: FundingSort;
  filters?: FundingFilters;
}): Promise<FundingSearchResult> {
  const { q } = opts;
  const page = Math.max(0, opts.page ?? 0);
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();
  const now = new Date();

  // Build Prisma WHERE clause from the structured facets. Text query
  // applies to grant title (and indirectly to the joined scholar's
  // preferredName) — see post-fetch filter below.
  const where: Prisma.GrantWhereInput = {
    scholar: { deletedAt: null, status: "active" },
  };
  if (filters.funder?.length) where.primeSponsor = { in: filters.funder };
  if (filters.programType?.length) where.programType = { in: filters.programType };
  if (filters.mechanism?.length) where.mechanism = { in: filters.mechanism };
  // Direct-funder filter is applied post-aggregate — the canonical/raw
  // fallback chain runs in resolveCanonical() below, and the same
  // canonicalization should apply when matching the filter values.

  // Status filter: applied per-row via endDate range. Multi-select OR
  // resolves into a UNION of date ranges.
  if (filters.status?.length) {
    const ranges: Prisma.DateTimeFilter[] = [];
    if (filters.status.includes("active")) {
      // endDate + grace > now → endDate > now - grace
      ranges.push({ gt: new Date(now.getTime() - NCE_GRACE_MS) });
    }
    if (filters.status.includes("ending_soon")) {
      ranges.push({
        gte: now,
        lte: new Date(now.getTime() + ENDING_SOON_MS),
      });
    }
    if (filters.status.includes("recently_ended")) {
      ranges.push({
        gte: new Date(now.getTime() - RECENTLY_ENDED_WINDOW_MS),
        lt: new Date(now.getTime() - NCE_GRACE_MS),
      });
    }
    if (ranges.length === 1) {
      where.endDate = ranges[0];
    } else if (ranges.length > 1) {
      // Prisma doesn't natively OR together DateTimeFilters; emit OR clause.
      where.OR = ranges.map((r) => ({ endDate: r }));
    }
  }

  // Role filter is applied post-aggregate (a project counts as Multi-PI
  // when it has 2+ PI rows). Keep it out of the SQL where clause.

  const rows = await prisma.grant.findMany({
    where,
    select: {
      id: true,
      cwid: true,
      title: true,
      role: true,
      funder: true,
      startDate: true,
      endDate: true,
      awardNumber: true,
      externalId: true,
      programType: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      directSponsor: true,
      directSponsorRaw: true,
      mechanism: true,
      nihIc: true,
      isSubaward: true,
      scholar: {
        select: {
          slug: true,
          preferredName: true,
          primaryDepartment: true,
        },
      },
    },
  });

  // Group rows by Account_Number (project key) and aggregate the people
  // list. Department on the project is taken from the lead PI's primary
  // department.
  type Group = {
    accountNumber: string;
    canonical: ReturnType<typeof rowToCanonicalProjectFields>;
    people: FundingPersonChip[];
    rolesByBucket: Set<FundingRoleBucket>;
    leadPiCwid: string | null;
    leadPiDepartment: string | null;
  };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const ext = parseExternalId(r.externalId);
    if (!ext) continue;
    const key = ext.accountNumber;
    let g = groups.get(key);
    if (!g) {
      g = {
        accountNumber: key,
        canonical: rowToCanonicalProjectFields(r),
        people: [],
        rolesByBucket: new Set<FundingRoleBucket>(),
        leadPiCwid: null,
        leadPiDepartment: null,
      };
      groups.set(key, g);
    }
    const chip: FundingPersonChip = {
      cwid: r.cwid,
      slug: r.scholar.slug,
      preferredName: r.scholar.preferredName,
      role: r.role,
      identityImageEndpoint: identityImageEndpoint(r.cwid),
    };
    g.people.push(chip);
    const bucket = rowRoleBucket(r.role);
    if (bucket) g.rolesByBucket.add(bucket);
    if (r.role === "PI" || r.role === "PI-Subaward") {
      if (!g.leadPiCwid) {
        g.leadPiCwid = r.cwid;
        g.leadPiDepartment = r.scholar.primaryDepartment;
      }
    }
  }

  // Multi-PI = ≥2 distinct PI rows on the same project. F2 calls for an
  // inline pill in the people row when this is true.
  for (const g of groups.values()) {
    const piCount = g.people.filter(
      (p) => p.role === "PI" || p.role === "PI-Subaward",
    ).length;
    if (piCount >= 2) g.rolesByBucket.add("Multi-PI");
  }

  // Apply role facet (post-aggregate).
  let groupArr = Array.from(groups.values());
  if (filters.role?.length) {
    const wanted = new Set(filters.role);
    groupArr = groupArr.filter((g) =>
      Array.from(g.rolesByBucket).some((b) => wanted.has(b)),
    );
  }

  // Apply department facet (post-aggregate, against the lead PI's primary
  // department string).
  if (filters.department?.length) {
    const wanted = new Set(filters.department);
    groupArr = groupArr.filter((g) =>
      g.leadPiDepartment ? wanted.has(g.leadPiDepartment) : false,
    );
  }

  // Direct-funder filter (post-aggregate). Match against canonicalized
  // direct sponsor; only subaward projects are eligible candidates.
  if (filters.directFunder?.length) {
    const wanted = new Set(filters.directFunder);
    groupArr = groupArr.filter((g) => {
      if (!g.canonical.isSubaward) return false;
      const dc = resolveCanonical(g.canonical.directSponsor, g.canonical.directSponsorRaw);
      const key = dc ?? g.canonical.directSponsorRaw ?? null;
      return key !== null && wanted.has(key);
    });
  }

  // Apply text query: matches title or any person's preferredName. Naive
  // substring match; replace with OpenSearch when ranking matters.
  if (trimmed.length > 0) {
    const needle = trimmed.toLowerCase();
    groupArr = groupArr.filter((g) => {
      if (g.canonical.title.toLowerCase().includes(needle)) return true;
      for (const p of g.people) {
        if (p.preferredName.toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }

  // Compute facets from the post-filter group set. v1 uses simple counts
  // (no excluding-self aggregation); upgrade later when OpenSearch lands.
  const funderCounts = new Map<string, { label: string; count: number }>();
  const directFunderCounts = new Map<string, { label: string; count: number }>();
  const programTypeCounts = new Map<string, number>();
  const mechanismCounts = new Map<string, number>();
  const departmentCounts = new Map<string, number>();
  let active = 0,
    endingSoon = 0,
    recentlyEnded = 0;
  let pi = 0,
    multiPi = 0,
    coI = 0;
  for (const g of groupArr) {
    const c = g.canonical;
    const primeCanon = resolveCanonical(c.primeSponsor, c.primeSponsorRaw);
    const funderKey = primeCanon ?? c.primeSponsorRaw ?? "(unknown sponsor)";
    const f = funderCounts.get(funderKey);
    if (f) f.count += 1;
    else funderCounts.set(funderKey, { label: funderKey, count: 1 });

    if (c.isSubaward) {
      const directCanon = resolveCanonical(c.directSponsor, c.directSponsorRaw);
      const directKey = directCanon ?? c.directSponsorRaw;
      if (directKey && directKey !== funderKey) {
        const d = directFunderCounts.get(directKey);
        if (d) d.count += 1;
        else directFunderCounts.set(directKey, { label: directKey, count: 1 });
      }
    }

    programTypeCounts.set(c.programType, (programTypeCounts.get(c.programType) ?? 0) + 1);
    if (c.mechanism)
      mechanismCounts.set(c.mechanism, (mechanismCounts.get(c.mechanism) ?? 0) + 1);
    if (g.leadPiDepartment)
      departmentCounts.set(g.leadPiDepartment, (departmentCounts.get(g.leadPiDepartment) ?? 0) + 1);

    const status = statusForGrant(c.endDate, now);
    if (status === "active") active++;
    else if (status === "ending_soon") endingSoon++;
    else if (status === "recently_ended") recentlyEnded++;

    if (g.rolesByBucket.has("PI")) pi++;
    if (g.rolesByBucket.has("Multi-PI")) multiPi++;
    if (g.rolesByBucket.has("Co-I")) coI++;
  }

  // Sort. v1 treats "relevance" the same as "endDate" (next-ending first)
  // until OpenSearch ranking is wired.
  const sortedGroups = [...groupArr].sort((a, b) => {
    if (sort === "startDate") {
      return b.canonical.startDate.getTime() - a.canonical.startDate.getTime();
    }
    // relevance + endDate both sort soonest-ending first, but completed
    // grants sink to the bottom.
    const aActive = isFundingActive(a.canonical.endDate, now) ? 0 : 1;
    const bActive = isFundingActive(b.canonical.endDate, now) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.canonical.endDate.getTime() - b.canonical.endDate.getTime();
  });

  const total = sortedGroups.length;
  const start = page * PAGE_SIZE;
  const slice = sortedGroups.slice(start, start + PAGE_SIZE);

  const hits: FundingHit[] = slice.map((g) => {
    const c = g.canonical;
    const sortedPeople = sortPeople(g.people);
    const primeCanon = resolveCanonical(c.primeSponsor, c.primeSponsorRaw);
    const directCanon = resolveCanonical(c.directSponsor, c.directSponsorRaw);
    return {
      projectId: g.accountNumber,
      title: c.title,
      primeSponsor: displaySponsor(primeCanon, c.primeSponsorRaw),
      primeSponsorRaw: c.primeSponsorRaw,
      directSponsor: c.isSubaward
        ? directCanon ?? c.directSponsorRaw
        : null,
      isSubaward: c.isSubaward,
      programType: c.programType,
      mechanism: c.mechanism,
      nihIc: c.nihIc,
      awardNumber: c.awardNumber,
      startDate: c.startDate.toISOString().slice(0, 10),
      endDate: c.endDate.toISOString().slice(0, 10),
      isActive: isFundingActive(c.endDate, now),
      status: statusForGrant(c.endDate, now),
      isMultiPi: g.rolesByBucket.has("Multi-PI"),
      people: sortedPeople,
      totalPeople: g.people.length,
      department: g.leadPiDepartment,
    };
  });

  return {
    hits,
    total,
    page,
    pageSize: PAGE_SIZE,
    facets: {
      funders: Array.from(funderCounts.entries())
        .map(([value, v]) => ({ value, label: v.label, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50),
      directFunders: Array.from(directFunderCounts.entries())
        .map(([value, v]) => ({ value, label: v.label, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50),
      programTypes: Array.from(programTypeCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      mechanisms: Array.from(mechanismCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30),
      status: { active, endingSoon, recentlyEnded },
      departments: Array.from(departmentCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30),
      roles: { pi, multiPi, coI },
    },
  };
}

/** Per-project canonical fields are taken from the first row encountered.
 *  All rows for a single Account_Number share these by construction (the
 *  query MAXes/MINs across the WCM-scholar partition). */
function rowToCanonicalProjectFields(r: {
  title: string;
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
}) {
  return {
    title: r.title,
    startDate: r.startDate,
    endDate: r.endDate,
    awardNumber: r.awardNumber,
    programType: r.programType,
    primeSponsor: r.primeSponsor,
    primeSponsorRaw: r.primeSponsorRaw,
    directSponsor: r.directSponsor,
    directSponsorRaw: r.directSponsorRaw,
    mechanism: r.mechanism,
    nihIc: r.nihIc,
    isSubaward: r.isSubaward,
  };
}
