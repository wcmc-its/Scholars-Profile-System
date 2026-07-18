/**
 * Issue #1762 — the honors approval queue's loader.
 *
 * The queue exists because Phase 2 (#1761) seeds EVERY honor as `pending`,
 * including the ~156 rows derived from the Dean's spreadsheet. That sheet carries
 * names, not CWIDs, so those CWIDs come from an F1 name match (surname + FULL
 * first name) rather than a human. An F1 match is strong here — its 100%-precision
 * measurement was taken on exactly this regime, contemporary people with
 * affiliation already narrowed — but it is not a sign-off, and `published` renders
 * on a real person's public page. So a human confirms here first.
 *
 * MUTUALLY EXCLUSIVE CANDIDATES ARE THE REASON THIS IS NOT A LIST OF BUTTONS.
 * One roster line can F1-match more than one scholar (same surname, same full
 * first name — two real people). The matcher emits a row PER CANDIDATE, so those
 * rows are competing claims on ONE award: at most one is true. Approving both
 * credits two people with one fellowship, which is the expensive direction —
 * misses are cheap, mismatches are not. `sourceRef` is what links them: Phase 2
 * seeds it as a roster-ROW identity (roster URL + a per-line discriminator), so
 * rows sharing one are candidates for the same assertion.
 *
 * Read-only and pure of authz: the caller gates. `loadHonorQueue` is only ever
 * reached from a page that has already checked `isSuperuser || isHonorsCurator`
 * (#1762 — the Research Dean's office self-serves; see `lib/auth/honors-curator.ts`).
 */
import { toCsv } from "@/lib/csv";
import { formatPublishedName } from "@/lib/postnominal";
import { formatRoleCategory } from "@/lib/role-display";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { HonorCategory, HonorStatus } from "@/lib/generated/prisma/enums";

/** The Prisma surface this loader needs — same idiom as `SlugRequestQueueClient`.
 *  A hand-rolled structural type does NOT accept a real `PrismaClient`. */
type HonorQueueClient = Pick<PrismaClient, "honor" | "scholar">;

export type HonorQueueRow = {
  id: string;
  cwid: string;
  slug: string | null;
  /** The name AS THE PROFILE RENDERS IT — preferredName + postnominal
   *  ("Robert C Young, MD"). The single source of truth every scholar-name
   *  surface uses (`lib/postnominal.ts`), so the queue previews exactly what an
   *  approval will publish. */
  scholarName: string;
  /** roleCategory display label ("Full-time faculty", "Affiliated faculty").
   *  Null when the scholar carries no category. */
  roleLabel: string | null;
  /** Raw roleCategory for filtering (`full_time_faculty`, …). */
  roleCategory: string | null;
  title: string | null;
  department: string | null;
  category: HonorCategory;
  name: string;
  organization: string;
  year: number | null;
  /** Prestige weight of the honor from `HONOR_PRESTIGE` keyed on `organization`.
   *  Mostly 0–100; the individual mega-prizes (Nobel/Lasker/MacArthur) score
   *  above 100. A sort dimension, not a hard rank; unknown bodies score 0 and
   *  sink. Editable — see the map. */
  prestige: number;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  /** When the row was decided (approve/reject) — its `updatedAt`. Meaningful
   *  only on the Approved/Rejected views; on Pending it equals the seed time. */
  decidedAt: string;
  /** Competing claims on the same roster line — see the module note. Empty for
   *  an ordinary unambiguous row. */
  competingCwids: string[];
};

/** One roster line's worth of candidates. A group of 1 is the normal case. */
export type HonorQueueGroup = {
  /** `sourceRef` when present; otherwise the row id (an unlinked singleton). */
  key: string;
  rows: HonorQueueRow[];
  /** The name AS PRINTED ON THE SOURCE ROSTER — "the name being matched against".
   *  Shared by every candidate on a contested line. Null when the row carries no
   *  roster-line identity (a hand-entered honor). See `rosterMatchedName()`. */
  rosterMatchedName: string | null;
  /** True when >1 candidate competes for this line ⇒ approving one MUST reject
   *  the others. The UI must not offer a plain "approve" here. */
  contested: boolean;
};

/**
 * Prestige weight per conferring body, 0–100. A curator sort dimension (#1762
 * round 3), NOT an eligibility gate — nothing is dropped by a low score, it just
 * sorts later. Keyed on the honor's `organization` string exactly as seeded.
 *
 * These weights are a DEFERABLE JUDGEMENT, deliberately in one editable table so
 * the Dean's office can retune without touching logic. The ordering encodes the
 * usual academic reading — the individual mega-prizes above the national
 * academies and HHMI, the clinical/scientific societies next, the early-career
 * fellowships below — but it is a starting point, not a claim of exact rank.
 * Unknown bodies → 0.
 *
 * The 0–100 band is descriptive, NOT a cap (#1762 round 4): a Nobel is another
 * tier above academy *membership*, so the mega-prizes score above 100. Retune
 * with the Dean's office.
 */
export const HONOR_PRESTIGE: Readonly<Record<string, number>> = {
  // Individual mega-prizes — above 100 on purpose (see note). Keyed on the exact
  // `organization` the seed writes; the specific prize lives in the honor `name`
  // ("Nobel Prize in Physiology or Medicine", "National Medal of Science").
  "Nobel Foundation": 120,
  "National Science Foundation": 115, // National Medal of Science — US highest science honor
  "Lasker Foundation": 112,
  "John D. and Catherine T. MacArthur Foundation": 108,
  "Shaw Prize Foundation": 106,
  "Columbia University": 104, // Louisa Gross Horwitz Prize (strong Nobel predictor)
  "National Academy of Sciences": 100,
  "National Academy of Engineering": 100,
  "National Academy of Medicine": 100,
  "Howard Hughes Medical Institute": 96,
  "American Philosophical Society": 92,
  "American Academy of Arts and Sciences": 90,
  "Association of American Physicians": 78,
  "American Society for Clinical Investigation": 74,
  "National Academy of Inventors": 70,
  "American Association for the Advancement of Science": 66,
  "U.S. Government (PECASE)": 60,
  "Alfred P. Sloan Foundation": 56,
  "David and Lucile Packard Foundation": 54,
  "Pew Charitable Trusts": 50,
  "Searle Scholars Program": 50,
  "Burroughs Wellcome Fund": 48, // Career Award (early-career, ~Damon Runyon tier)
  "Damon Runyon Cancer Research Foundation": 46,
};

export function honorPrestige(organization: string): number {
  return HONOR_PRESTIGE[organization.trim()] ?? 0;
}

export function isHonorQueueEnabled(): boolean {
  return process.env.HONORS_APPROVAL_QUEUE === "on";
}

/**
 * Whether to advertise the "Honors" tab in the admin sub-nav for this viewer:
 * the surface is enabled AND the viewer can open it. Mirrors
 * `isMethodsTabVisible` (`lib/auth/comms-steward.ts`), including the reason it
 * role-gates rather than only flag-gating: a unit Owner can land on some admin
 * surfaces but is neither superuser nor curator, and must never be shown a tab
 * that 403s.
 *
 * 🔴 `isSuperuser || isHonorsCurator`, never a bare `isHonorsCurator`. The
 * session route reports `isDeveloper: false` FOR a superuser to skip a redundant
 * LDAPS call (`app/api/auth/session/route.ts`), and any bare role read inherits
 * that shape — locking superusers out of the surface they administer.
 *
 * Takes the resolved session booleans rather than a cwid, so this module needs no
 * LDAP import and stays safe to pull into any server component.
 */
export function isHonorsQueueTabVisible(session: {
  isSuperuser: boolean;
  isHonorsCurator?: boolean;
}): boolean {
  return isHonorQueueEnabled() && (session.isSuperuser || session.isHonorsCurator === true);
}

/**
 * The name AS PRINTED ON THE SOURCE ROSTER, recovered from `sourceRef`.
 *
 * The seed writes `sourceRef` as `<roster>|<printed-name>|<year>`, so the middle
 * segment is exactly "the name we matched against" — what the curator needs to
 * verify a match. Returns null when `sourceRef` is absent (hand-entered) or does
 * not carry the 3-part shape.
 *
 * ponytail: parses the grouping key rather than storing the roster name in its own
 * column. Fine while the seed owns the `sourceRef` format; if Phase 2 switches to
 * `<url>#<id>` line-keys (the SPEC's other option), add a `roster_matched_name`
 * column and read it here instead — this parse then returns null and the UI just
 * omits the line, no crash.
 */
export function rosterMatchedName(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  const parts = sourceRef.split("|");
  if (parts.length !== 3) return null;
  const name = parts[1].trim();
  return name.length > 0 ? name : null;
}

/**
 * Name-match confidence for sorting, 0..2. Higher = surface sooner.
 *  - Contested line ⇒ 0. Ambiguous by construction; the curator must disambiguate.
 *  - Single match ⇒ 1 + the fraction of roster-name tokens present in the matched
 *    scholar's name. An exact match (every printed token accounted for) scores 2;
 *    a roster that printed only "Robert Young" against scholar "Robert C Young"
 *    scores between 1 and 2. F1 already guaranteed surname+first, so this only
 *    ranks the *cleanliness* of an already-valid match.
 */
function matchConfidence(group: HonorQueueGroup): number {
  if (group.contested) return 0;
  const row = group.rows[0];
  const rosterTokens = tokenize(group.rosterMatchedName ?? "");
  if (rosterTokens.length === 0) return 1;
  const nameTokens = new Set(tokenize(row.scholarName));
  const covered = rosterTokens.filter((t) => nameTokens.has(t)).length;
  return 1 + covered / rosterTokens.length;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1); // drop bare initials/punctuation
}

/**
 * Honors in one status bucket, grouped by the roster line they came from.
 *
 * `status` defaults to `pending` (the working queue). `published`/`rejected` load
 * the decided history for the Approved/Rejected views.
 *
 * Ordering (per the 2026-07-17 curator ask): name-confidence DESC, then recency
 * (award year) DESC, nulls last. Confident single matches rank above ambiguous
 * contested lines; within a tier, the most recent award first. `createdAt` breaks
 * the final tie so the order is deterministic rather than DB-dependent.
 */
export async function loadHonorQueue(
  client: HonorQueueClient,
  status: HonorStatus = "pending",
  // #1762 round 5: partition self-asserted honors (`source='SELF'`) into their
  // own tab. `self:true` ⇒ only self-entered; `self:false` ⇒ everything a scholar
  // did NOT enter themselves; omitted ⇒ no source filter (the original behavior).
  opts: { self?: boolean } = {},
): Promise<HonorQueueGroup[]> {
  const rows = await client.honor.findMany({
    where: {
      status,
      ...(opts.self === true ? { source: "SELF" } : opts.self === false ? { source: { not: "SELF" } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      cwid: true,
      category: true,
      name: true,
      organization: true,
      year: true,
      source: true,
      sourceRef: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (rows.length === 0) return [];

  // One query for every scholar, not one per row: this queue is ~250 rows on day
  // one and an N+1 here would be 250 round trips. (slug-request's loader does
  // per-row lookups, but its queue is a handful of rows.)
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: [...new Set(rows.map((r) => r.cwid))] } },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      postnominal: true,
      fullName: true,
      roleCategory: true,
      primaryTitle: true,
      primaryDepartment: true,
    },
  });
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));

  // Group by roster line. A NULL sourceRef cannot be linked to anything, so it is
  // its own group keyed by id — never lumped with other NULLs, which would
  // silently mark unrelated rows as competing.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.sourceRef ?? `id:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const out: HonorQueueGroup[] = [];
  for (const [key, groupRows] of groups) {
    const cwids = groupRows.map((r) => r.cwid);
    const contested = new Set(cwids).size > 1;
    out.push({
      key,
      contested,
      rosterMatchedName: rosterMatchedName(groupRows[0].sourceRef),
      rows: groupRows.map((r) => {
        const s = byCwid.get(r.cwid);
        const preferred = s?.preferredName ?? s?.fullName ?? r.cwid;
        return {
          id: r.id,
          cwid: r.cwid,
          slug: s?.slug ?? null,
          scholarName: formatPublishedName(preferred, s?.postnominal ?? null),
          roleLabel: formatRoleCategory(s?.roleCategory ?? null),
          roleCategory: s?.roleCategory ?? null,
          title: s?.primaryTitle ?? null,
          department: s?.primaryDepartment ?? null,
          category: r.category,
          name: r.name,
          organization: r.organization,
          year: r.year,
          prestige: honorPrestige(r.organization),
          source: r.source,
          sourceRef: r.sourceRef,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.updatedAt.toISOString(),
          competingCwids: contested ? cwids.filter((c) => c !== r.cwid) : [],
        };
      }),
    });
  }

  // Confidence DESC, then award year DESC (nulls last), then createdAt for a
  // stable final order. `rows[0]` is safe: a group is never empty.
  return out.sort((a, b) => {
    const conf = matchConfidence(b) - matchConfidence(a);
    if (conf !== 0) return conf;
    const ay = a.rows[0].year;
    const by = b.rows[0].year;
    if (ay !== by) {
      if (ay === null) return 1; // unknown year sinks
      if (by === null) return -1;
      return by - ay; // recent first
    }
    return a.rows[0].createdAt.localeCompare(b.rows[0].createdAt);
  });
}

/** roleCategory values that count as full-time faculty for the queue's default
 *  filter. A single-member set today, but named so the intent is legible and a
 *  second FT code (were one ever added) has an obvious home. */
export const FULL_TIME_FACULTY_ROLES: ReadonlySet<string> = new Set(["full_time_faculty"]);

export function isFullTimeFaculty(roleCategory: string | null): boolean {
  return roleCategory !== null && FULL_TIME_FACULTY_ROLES.has(roleCategory);
}

/**
 * Award-year plausibility — a SIGNAL a reviewer weighs, NEVER a silent drop rule.
 *
 * A pre-1996 award sitting on someone whose CURRENT title is junior is very likely
 * a generational name collision (the D3 re-run's smoking gun was a 1970s award
 * matched to a current postdoc). But a genuine emeritus hit is entirely plausible
 * in the 1980s band, so this only ever annotates a row for a human. The moment it
 * filters anything, it becomes the silent-drop rule the SPEC forbids.
 */
const JUNIOR_TITLE = /postdoc|fellow|resident|student|instructor|assistant/i;

/**
 * Awards MORE than this many years old are worth a second look when the title
 * reads junior. 30 reproduces the D3 adjudication's "pre-1996 award + junior
 * current title" suspect rule exactly as of 2026 (`> 30` ⇒ 1995 and earlier), and
 * then keeps meaning the same thing as the years pass, which a literal 1996 would
 * not. Strictly greater, not >=: 1996 itself was NOT a suspect year under the
 * original rule, and quietly widening the net by one year is the kind of drift
 * nobody would catch.
 */
const SUSPECT_AWARD_AGE_YEARS = 30;

export function yearPlausibilityNote(
  row: { year: number | null; title: string | null },
  // Per call, not frozen at module load — the same reason `honorYearMax`
  // (lib/edit/honor.ts) takes it: a hardcoded year silently rots, and this one
  // would drift the annotation threshold by one every Jan 1 without any test
  // noticing.
  now: Date = new Date(),
): string | null {
  if (row.year === null) return null;
  if (!row.title || !JUNIOR_TITLE.test(row.title)) return null;
  const age = now.getUTCFullYear() - row.year;
  if (age <= SUSPECT_AWARD_AGE_YEARS) return null;
  return `Awarded ${age} years ago, but the current title reads junior — check this is the same person, not a namesake.`;
}

/** Count pending honors — the admin sub-nav's pending-count pill (#1762). */
export function countPendingHonors(
  client: Pick<PrismaClient, "honor">,
): Promise<number> {
  return client.honor.count({ where: { status: "pending" } });
}

/** Column headers for the honors CSV report — the Research Dean's export (#1762). */
const HONOR_CSV_HEADERS = [
  "#",
  "Scholar",
  "CWID",
  "Role",
  "Department",
  "Honor",
  "Organization",
  "Year",
  "Category",
  "Status",
  "Source",
  "Updated",
] as const;

/**
 * Every honor across all three statuses, flattened one row each and tagged with
 * its status — the Research Dean's report scope (the full record, filterable in a
 * spreadsheet). Reuses `loadHonorQueue` so the scholar join and name formatting
 * match the queue exactly; the roster-line grouping is discarded. SELF-asserted
 * honors are included — their `Source` column distinguishes them.
 */
export async function loadHonorExport(
  client: HonorQueueClient,
): Promise<Array<HonorQueueRow & { status: HonorStatus }>> {
  const [pending, published, rejected] = await Promise.all([
    loadHonorQueue(client, "pending"),
    loadHonorQueue(client, "published"),
    loadHonorQueue(client, "rejected"),
  ]);
  const flat = (groups: HonorQueueGroup[], status: HonorStatus) =>
    groups.flatMap((g) => g.rows.map((r) => ({ ...r, status })));
  return [...flat(pending, "pending"), ...flat(published, "published"), ...flat(rejected, "rejected")];
}

/** Serialize honor export rows to a CSV report (RFC-4180 via `lib/csv`, which also
 *  guards spreadsheet formula injection). Pure — the export route just streams it. */
export function buildHonorCsv(rows: ReadonlyArray<HonorQueueRow & { status: string }>): string {
  const body = rows.map((r, i) => [
    i + 1,
    r.scholarName,
    r.cwid,
    r.roleLabel ?? r.roleCategory ?? "",
    r.department ?? "",
    r.name,
    r.organization,
    r.year ?? "",
    r.category,
    r.status,
    r.source,
    r.decidedAt.slice(0, 10),
  ]);
  return toCsv(HONOR_CSV_HEADERS, body);
}
