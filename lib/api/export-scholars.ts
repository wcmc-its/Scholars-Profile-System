/**
 * #847 — internal "download the leading scholars" CSV export (server-side
 * builder).
 *
 * Resolves an export SCOPE (method-family, supercategory, topic, subtopic) + its
 * params into the scope's OWN ranked top-50 roster, projects each scholar to a
 * flat CSV row, and serializes via `toCsv`. The route handler gates auth + the
 * feature flags; this builder trusts validated inputs and only does the data
 * assembly.
 *
 * Ranking is the SCOPE's own ranking (NOT alphabetical), capped at
 * SCHOLAR_EXPORT_CAP. The existing page loaders cannot back this directly — they
 * are either alphabetical (`getMethodScholars` / `getTopicScholars`) or ranked
 * but hard-capped well below 50 and carved to FT faculty (`getFamilyScholarRows`
 * / `getSubtopicScholars` / `getTopScholarsForSupercategory`). So each scope gets
 * a small ranked loader here that ranks by the per-scholar publication count
 * within the scope, ALL roles, top 50.
 *
 * Method scopes (method-family, supercategory) inherit the public
 * #800-suppression / #801-sensitivity overlay gate VERBATIM — the resolver
 * (`getFamily` / `getSupercategory`) applies the master lens gate and rejects an
 * all-suppressed/sensitive target, and the rosters re-apply `isFamilyPublicly-
 * Visible` per row, so a suppressed/sensitive family never contributes a scholar.
 *
 * NO email or any contact column is ever emitted (internal directory data only).
 */
import { prisma } from "@/lib/db";
import { toCsv, type CsvCell } from "@/lib/csv";
import { profilePath } from "@/lib/profile-url";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import {
  loadFamilyOverlayGate,
  isFamilyPubliclyVisible,
} from "@/lib/api/methods-overlay";
import { getFamily, getSupercategory } from "@/lib/api/methods";
import { getTopic } from "@/lib/api/topics";

/** Fixed cap: top 50 scholars by the scope's own ranking. */
export const SCHOLAR_EXPORT_CAP = 50;

export type ScholarExportScope =
  | "method-family"
  | "supercategory"
  | "topic"
  | "subtopic";

/** A read-capable Prisma client (the live client by default; injectable for
 *  tests). Typed as the imported `prisma` so the loaders type-check 1:1. */
type PrismaRead = typeof prisma;

/**
 * The common identity columns every scope emits, in order. A scope appends its
 * own count column(s) after these (see SCOPE_HEADERS). `profile_url` is the
 * end-state root profile path (`/{slug}`), built via `profilePath` so it matches
 * the on-page link shape.
 *
 * Deliberately EXCLUDES email / phone / any contact field — internal-use export,
 * never a contact list.
 */
const COMMON_HEADERS = [
  "rank",
  "cwid",
  "preferred_name",
  "postnominal",
  "primary_title",
  "primary_department",
  "role_category",
  "profile_url",
] as const;

/** Per-scope CSV header arrays = the common identity columns + the scope's count
 *  column(s). Exported so the route + tests can assert the exact header row. */
export const SCOPE_HEADERS: Readonly<Record<ScholarExportScope, ReadonlyArray<string>>> = {
  "method-family": [...COMMON_HEADERS, "pubs_in_family"],
  supercategory: [...COMMON_HEADERS, "pubs_in_supercategory", "top_family"],
  topic: [...COMMON_HEADERS, "pubs_in_topic"],
  subtopic: [...COMMON_HEADERS, "pubs_in_subtopic", "pubs_total"],
};

/** Human report-name prefix for the download filename, per scope. */
const SCOPE_REPORT_NAME: Readonly<Record<ScholarExportScope, string>> = {
  "method-family": "Method-Family",
  supercategory: "Supercategory",
  topic: "Topic",
  subtopic: "Subtopic",
};

/** The scholar identity fields every ranked loader selects + projects. */
const SCHOLAR_SELECT = {
  cwid: true,
  slug: true,
  preferredName: true,
  postnominal: true,
  primaryTitle: true,
  primaryDepartment: true,
  roleCategory: true,
} as const;

type ScholarIdentity = {
  cwid: string;
  slug: string;
  preferredName: string;
  postnominal: string | null;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  roleCategory: string | null;
};

/** One ranked roster row: identity + the scope count column(s). */
type ExportRosterRow = ScholarIdentity & {
  count: number;
  /** supercategory only — the scholar's most-prolific visible family label. */
  topFamily?: string;
  /** subtopic only — the scholar's total confirmed pub count. */
  total?: number;
};

export type ScholarExport = { filename: string; csv: string };

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Common identity cells in COMMON_HEADERS order. `rank` is 1-indexed. */
function commonCells(row: ScholarIdentity, rank: number): Record<string, CsvCell> {
  return {
    rank,
    cwid: row.cwid,
    preferred_name: row.preferredName,
    postnominal: row.postnominal,
    primary_title: row.primaryTitle,
    primary_department: row.primaryDepartment,
    role_category: row.roleCategory,
    // Parity with the public roster: hidden-display roles (#536 doctoral
    // students / affiliate-alumni) are listed by name but NOT linked there, and
    // the /{slug} route itself 404s for them. Emit a blank URL rather than a
    // dead link the public surface deliberately withholds.
    profile_url: isPubliclyDisplayed(row.roleCategory) ? profilePath(row.slug) : "",
  };
}

// ---------------------------------------------------------------------------
// Ranked top-50 loaders (one per scope) — all roles, ranked by the per-scholar
// publication count within the scope. Inherit the same active-scholar join +
// (method scopes) overlay gate the public page loaders use.
// ---------------------------------------------------------------------------

/** method-family: per-scholar `scholar_family.pmidCount` desc, top 50. The
 *  resolver already gated the family; re-applied here defensively per row. */
async function loadFamilyRoster(
  db: PrismaRead,
  supercategory: string,
  familyLabel: string,
): Promise<ExportRosterRow[]> {
  const gate = await loadFamilyOverlayGate();
  if (!isFamilyPubliclyVisible(supercategory, familyLabel, gate)) return [];

  const rows = await db.scholarFamily.findMany({
    where: {
      supercategory,
      familyLabel,
      scholar: { deletedAt: null, status: "active" },
    },
    orderBy: [{ pmidCount: "desc" }, { familyId: "asc" }],
    take: SCHOLAR_EXPORT_CAP,
    select: { pmidCount: true, scholar: { select: SCHOLAR_SELECT } },
  });

  return rows
    .filter((r) => r.scholar)
    .map((r) => ({ ...(r.scholar as ScholarIdentity), count: r.pmidCount }));
}

/** supercategory: aggregate per-scholar `pmidCount` across the supercategory's
 *  PUBLICLY-VISIBLE families (gated rows dropped before aggregating), ranked
 *  desc, top 50. `top_family` = the scholar's most-prolific visible family. */
async function loadSupercategoryRoster(
  db: PrismaRead,
  supercategory: string,
): Promise<ExportRosterRow[]> {
  const gate = await loadFamilyOverlayGate();

  const rows = await db.scholarFamily.findMany({
    where: {
      supercategory,
      scholar: { deletedAt: null, status: "active" },
    },
    select: {
      familyLabel: true,
      pmidCount: true,
      scholar: { select: SCHOLAR_SELECT },
    },
  });

  type Agg = { scholar: ScholarIdentity; total: number; topFamily: string; topCount: number };
  const byCwid = new Map<string, Agg>();
  for (const r of rows) {
    if (!r.scholar) continue;
    if (!isFamilyPubliclyVisible(supercategory, r.familyLabel, gate)) continue;
    const entry =
      byCwid.get(r.scholar.cwid) ??
      { scholar: r.scholar as ScholarIdentity, total: 0, topFamily: "", topCount: -1 };
    entry.total += r.pmidCount;
    if (r.pmidCount > entry.topCount) {
      entry.topCount = r.pmidCount;
      entry.topFamily = r.familyLabel;
    }
    byCwid.set(r.scholar.cwid, entry);
  }

  return Array.from(byCwid.values())
    .sort((a, b) => b.total - a.total || a.scholar.cwid.localeCompare(b.scholar.cwid))
    .slice(0, SCHOLAR_EXPORT_CAP)
    .map((e) => ({ ...e.scholar, count: e.total, topFamily: e.topFamily }));
}

/** topic: rank by distinct publication count per scholar within the topic (all
 *  positions, no year floor, all roles — a transparent count, not Variant-B). */
async function loadTopicRoster(db: PrismaRead, topicSlug: string): Promise<ExportRosterRow[]> {
  const counts = await db.publicationTopic.groupBy({
    by: ["cwid"],
    where: {
      parentTopicId: topicSlug,
      scholar: { deletedAt: null, status: "active" },
    },
    _count: { pmid: true },
    orderBy: { _count: { pmid: "desc" } },
    take: SCHOLAR_EXPORT_CAP,
  });

  const cwids = counts.map((c) => c.cwid).filter((c): c is string => c !== null);
  if (cwids.length === 0) return [];

  const scholars = await db.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: SCHOLAR_SELECT,
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s as ScholarIdentity]));

  const out: ExportRosterRow[] = [];
  for (const c of counts) {
    if (!c.cwid) continue;
    const s = byCwid.get(c.cwid);
    if (!s) continue;
    out.push({ ...s, count: c._count.pmid });
  }
  return out;
}

/** subtopic: rank by distinct publication count per scholar within the subtopic;
 *  `pubs_total` = the scholar's total confirmed (#356-adjusted not applied here —
 *  raw confirmed) pub count across their corpus. */
async function loadSubtopicRoster(
  db: PrismaRead,
  topicSlug: string,
  subtopicId: string,
): Promise<ExportRosterRow[]> {
  const counts = await db.publicationTopic.groupBy({
    by: ["cwid"],
    where: {
      parentTopicId: topicSlug,
      primarySubtopicId: subtopicId,
      scholar: { deletedAt: null, status: "active" },
    },
    _count: { pmid: true },
    orderBy: { _count: { pmid: "desc" } },
    take: SCHOLAR_EXPORT_CAP,
  });

  const cwids = counts.map((c) => c.cwid).filter((c): c is string => c !== null);
  if (cwids.length === 0) return [];

  const [scholars, totalCounts] = await Promise.all([
    db.scholar.findMany({ where: { cwid: { in: cwids } }, select: SCHOLAR_SELECT }),
    db.publicationAuthor.groupBy({
      by: ["cwid"],
      where: { cwid: { in: cwids }, isConfirmed: true },
      _count: { pmid: true },
    }),
  ]);
  const byCwid = new Map(scholars.map((s) => [s.cwid, s as ScholarIdentity]));
  const totalByCwid = new Map<string, number>();
  for (const t of totalCounts) if (t.cwid) totalByCwid.set(t.cwid, t._count.pmid);

  const out: ExportRosterRow[] = [];
  for (const c of counts) {
    if (!c.cwid) continue;
    const s = byCwid.get(c.cwid);
    if (!s) continue;
    out.push({ ...s, count: c._count.pmid, total: totalByCwid.get(c.cwid) ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scope resolution + row projection
// ---------------------------------------------------------------------------

/** Project a ranked roster into positional CSV cells per the scope's header
 *  order. The scope count column(s) map onto the trailing headers. */
function projectRows(scope: ScholarExportScope, roster: ExportRosterRow[]): CsvCell[][] {
  const headers = SCOPE_HEADERS[scope];
  return roster.map((row, i) => {
    const cells: Record<string, CsvCell> = commonCells(row, i + 1);
    if (scope === "method-family") {
      cells.pubs_in_family = row.count;
    } else if (scope === "supercategory") {
      cells.pubs_in_supercategory = row.count;
      cells.top_family = row.topFamily ?? "";
    } else if (scope === "topic") {
      cells.pubs_in_topic = row.count;
    } else {
      cells.pubs_in_subtopic = row.count;
      cells.pubs_total = row.total ?? 0;
    }
    return headers.map((h) => cells[h]);
  });
}

/**
 * Build the ranked top-50 CSV export for a scope. Resolves the scope target via
 * the existing resolvers (which apply the master lens gate + reject suppressed/
 * sensitive method targets), loads the scope's ranked roster, projects the rows,
 * and returns `{ filename, csv }`.
 *
 * Returns `null` when the scope target does not resolve (unknown family / super-
 * category / topic / subtopic, an all-suppressed method scope, or the lens is
 * off) so the route can 404. An empty-but-resolved roster still returns a
 * header-only CSV (a valid, downloadable export for a scope with no scholars).
 *
 * `params` keys per scope:
 *   - method-family: { supercategory, family }   (URL slug segments)
 *   - supercategory: { supercategory }            (URL slug segment)
 *   - topic:         { slug }                      (topic id == slug)
 *   - subtopic:      { slug, subtopic }            (topic slug + subtopic id)
 */
export async function buildScholarExport(
  scope: ScholarExportScope,
  params: Record<string, string | undefined>,
  prismaRead: PrismaRead = prisma,
): Promise<ScholarExport | null> {
  let roster: ExportRosterRow[] | null = null;

  if (scope === "method-family") {
    const scSlug = params.supercategory ?? "";
    const famSlug = params.family ?? "";
    if (!scSlug || !famSlug) return null;
    const resolved = await getFamily(scSlug, famSlug);
    if (!resolved) return null;
    roster = await loadFamilyRoster(prismaRead, resolved.supercategory, resolved.familyLabel);
  } else if (scope === "supercategory") {
    const scSlug = params.supercategory ?? "";
    if (!scSlug) return null;
    const resolved = await getSupercategory(scSlug);
    if (!resolved) return null;
    roster = await loadSupercategoryRoster(prismaRead, resolved.id);
  } else if (scope === "topic") {
    const slug = params.slug ?? "";
    if (!slug) return null;
    const topic = await getTopic(slug);
    if (!topic) return null;
    roster = await loadTopicRoster(prismaRead, topic.id);
  } else {
    const slug = params.slug ?? "";
    const subtopicId = params.subtopic ?? "";
    if (!slug || !subtopicId) return null;
    const topic = await getTopic(slug);
    if (!topic) return null;
    const subtopic = await prismaRead.subtopic.findFirst({
      where: { id: subtopicId, parentTopicId: topic.id },
      select: { id: true },
    });
    if (!subtopic) return null;
    roster = await loadSubtopicRoster(prismaRead, topic.id, subtopic.id);
  }

  const headers = SCOPE_HEADERS[scope];
  const csv = toCsv(headers, projectRows(scope, roster));
  const filename = `${SCOPE_REPORT_NAME[scope]}-Scholars-${todayStamp()}.csv`;
  return { filename, csv };
}
