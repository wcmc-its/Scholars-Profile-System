/**
 * GET /api/opportunities — browse the funding-opportunity corpus for the matcher.
 * ADMIN-ONLY (superuser OR development-role), mirroring the reverse-matcher route;
 * `force-dynamic` so it's never CloudFront-cached.
 *
 * Curated-first: the hand-curated WCM awards (`source = "wcm_curated"`) are the
 * point of the tool — they're not widely known, so surfacing them IS the value.
 * Grants.gov NOFOs duplicate a public site and would bury the curated list, so
 * they're excluded by default; pass `includeGrantsGov=1` to fold them in.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { asPrestige } from "@/lib/funding/prestige";
import { FACULTY_STAGES, facultyPiMayHold, requirementsFrom } from "@/lib/funding/screening";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
// Lower rank sorts first. Curated leads — hand-vetted WCM awards and staff-submitted
// URLs (`manual_url`, the opportunity-intake queue) — everything else trails.
const SOURCE_RANK: Record<string, number> = { wcm_curated: 0, manual_url: 0 };

/**
 * Sentence-case a snake_case topic slug (`implementation_science` → "Implementation science") —
 * the same rule as `humanizeAreaSlug` in `lib/api/search.ts` (#824), restated locally rather
 * than dragging that whole module into this route. Used only when no `topic` row carries the id.
 */
function humanizeSlug(slug: string): string {
  const words = slug.split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

// Noise floor — measured corpus scores span [0, 0.98]; entries under 0.05 are tail weight
// that would render as a chip indistinguishable from a real signal.
const CONCEPT_SCORE_FLOOR = 0.05;
// The median vector is 6 entries and the max is 61 — uncapped chips are unreadable on a card.
const CONCEPT_TOP_N = 3;

/**
 * A card's Concepts row from the stored `topicVector` (`[{topic_id, score, rationale}]`):
 * top-3 by score, floor-dropped, ids resolved to labels via `labelOf`. Fail-soft on ANY
 * malformed shape — a row whose vector is absent, empty or junk simply renders no Concepts row.
 */
function conceptsFrom(
  topicVector: unknown,
  labelOf: (id: string) => string,
): Array<{ label: string; score: number }> {
  if (!Array.isArray(topicVector)) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const entry of topicVector) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { topic_id: id, score } = entry as { topic_id?: unknown; score?: unknown };
    if (typeof id !== "string" || !id) continue;
    if (typeof score !== "number" || !Number.isFinite(score) || score < CONCEPT_SCORE_FLOOR) {
      continue;
    }
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Dedupe on the RESOLVED label — it is the chip's React key, and two ids can share one
  // (a duplicated vector entry, or a humanized slug colliding with a catalog label).
  const out: Array<{ label: string; score: number }> = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (out.length === CONCEPT_TOP_N) break;
    const label = labelOf(s.id);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, score: s.score });
  }
  return out;
}

/**
 * A card's Eligibility row — display labels derivable from REAL data only, via the same
 * `requirementsFrom` the grant-matcha rail renders (so the two surfaces cannot disagree).
 * The artboard's "MD/PhD" / "Tenure track" / "Grad/Prof students" chips have no source in
 * either half of the stage vocabulary and are deliberately NOT here. `[]` (~88% of the
 * corpus: `careerStages` null, no ESI/US signal) renders no row at all.
 */
function eligibilityLabelsFrom(eligibilityFlags: unknown, eligibility: unknown): string[] {
  const r = requirementsFrom(eligibilityFlags, eligibility);
  const stages = r.careerStages ?? [];
  const labels: string[] = [];
  if (stages.some((s) => FACULTY_STAGES.includes(s))) labels.push("Faculty");
  if (stages.includes("postdoc")) labels.push("Postdocs");
  if (stages.includes("grad")) labels.push("Students");
  if (r.esiTargeted) labels.push("Early Stage Investigators");
  if (r.usRequired) labels.push("US required");
  return labels;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper)) {
    return new NextResponse(null, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const includeGrantsGov =
    sp.get("includeGrantsGov") === "1" || sp.get("includeGrantsGov") === "true";
  // Matcha-admin Phase 1b: manually-suppressed rows are excluded by default;
  // the admin view passes includeSuppressed=1 to render them muted + Restore.
  const includeSuppressed =
    sp.get("includeSuppressed") === "1" || sp.get("includeSuppressed") === "true";

  let limit = 200;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) return apiError("invalid limit", 400);
    limit = Math.min(n, MAX_LIMIT);
  }

  const rowsPromise = db.read.opportunity.findMany({
    where: {
      isResearch: true,
      // Reverse-view honorific gate. 🔴 This drops NULL as well as true — Prisma's `not` compiles
      // to three-valued SQL, where `NULL <> true` is NULL, not a match. The comment here used to
      // claim it "keeps null/false"; it never did, and CHANGING IT TO MATCH THAT CLAIM WOULD BE A
      // REGRESSION. Measured on staging 2026-07-28: 29 of the 333 research, non-grants.gov rows
      // carry `is_honorific IS NULL`, and 28 of those 29 are prizes — National Medal of Science,
      // Vannevar Bush Award, Vilcek Prizes, AAAS science-journalism awards, mentoring medals.
      // NULL means the classifier never labelled the row, and empirically an unlabelled row is an
      // honorific. So the browse shows 304, not 333, and that is the right 304.
      // Stated as `false` rather than `not: true` so the intent is in the code and not in
      // Prisma's null semantics: show only rows the extractor positively classified as
      // non-honorific. Same 304 rows either way. The index now agrees — `lib/search.ts` indexes
      // unclassified AS honorific, so the recommender excludes these too (#2041).
      isHonorific: false,
      ...(includeGrantsGov ? {} : { source: { not: "grants_gov" } }),
      ...(includeSuppressed ? {} : { suppressedAt: null }),
      ...(q ? { title: { contains: q } } : {}),
    },
    select: {
      opportunityId: true,
      title: true,
      sponsor: true,
      mechanism: true,
      dueDate: true,
      source: true,
      status: true,
      prestige: true,
      isHonorific: true,
      awardCeiling: true,
      awardFloor: true,
      suppressedAt: true,
      suppressedBy: true,
      suppressReason: true,
      // Read to DERIVE `facultyPiEligible` + `eligibilityLabels` below; never returned — a
      // per-row eligibility map is ~500 rows of JSON the browse has no use for.
      eligibilityFlags: true,
      eligibility: true,
      // Read to DERIVE `concepts` / `researchArea` below; the raw vector (median 6 entries,
      // max 61, rationale prose included) is likewise never returned.
      topicVector: true,
      primaryTopicId: true,
    },
  });

  // ONE topic-label lookup per request, shared by `concepts` and `researchArea`. The slug
  // fallback is LOAD-BEARING, not belt-and-braces: `primaryTopicId`/`topic_id` are soft slug
  // references, and five live slugs resolve to no `topic` row on staging — among them
  // `implementation_science` (353 opps) and `neuroscience_neurology` (116) — so an unresolved
  // id humanizes rather than leaking a raw slug or dropping the chip.
  const [rows, topicRows] = await Promise.all([
    rowsPromise,
    db.read.topic.findMany({ select: { id: true, label: true } }),
  ]);
  const topicLabels = new Map(topicRows.map((t) => [t.id, t.label]));
  const labelOf = (id: string) => topicLabels.get(id) ?? humanizeSlug(id);

  // ponytail: the whole corpus is small (hundreds), so sort curated-first in JS
  // rather than leaning on a fragile source-string orderBy; slice to the cap.
  // ponytail: curated-first is preserved as the PRIMARY key; prestige leads within
  // a source group (flip to global prestige-first later if the owner wants).
  rows.sort((a, b) => {
    const ra = SOURCE_RANK[a.source ?? ""] ?? 1;
    const rb = SOURCE_RANK[b.source ?? ""] ?? 1;
    if (ra !== rb) return ra - rb;
    const pa = asPrestige(a.prestige)?.score ?? 0;
    const pb = asPrestige(b.prestige)?.score ?? 0;
    if (pa !== pb) return pb - pa;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  // BigInt award fields → number for JSON (mirrors the detail route).
  const opportunities = rows
    .slice(0, limit)
    .map(({ eligibility, eligibilityFlags, topicVector, primaryTopicId, ...r }) => ({
      ...r,
      awardCeiling: r.awardCeiling == null ? null : Number(r.awardCeiling),
      awardFloor: r.awardFloor == null ? null : Number(r.awardFloor),
      // Screening spec §3.1 — false means no WCM faculty PI can hold this award (13.2% of the
      // corpus). The browse gates on it by default; the flag is fail-open, so absent data is `true`.
      facultyPiEligible: facultyPiMayHold(eligibilityFlags, eligibility),
      // Browse data-wiring 2026-08 — the card rows + Research-area facet. Derived here so the
      // wire carries labels, not the raw JSON columns they come from.
      eligibilityLabels: eligibilityLabelsFrom(eligibilityFlags, eligibility),
      concepts: conceptsFrom(topicVector, labelOf),
      researchArea: primaryTopicId ? { id: primaryTopicId, label: labelOf(primaryTopicId) } : null,
    }));

  // Per-source freshness for the Browse-tab strip: row count + newest
  // `ingestedAt` per source. `ingestedAt` is the upstream producer timestamp
  // and the only real freshness signal — `lastRefreshedAt` is re-stamped every
  // night by the upsert (the Phase 0a metric's rationale). Grouped over the
  // whole table (unfiltered): freshness describes the pipeline, not the
  // filtered view, so per-source MAX stays epoch-fallback-safe.
  const bySource = await db.read.opportunity.groupBy({
    by: ["source"],
    _count: { _all: true },
    _max: { ingestedAt: true },
  });
  const sources = bySource
    .map((g) => ({
      source: g.source,
      count: g._count._all,
      newestIngestedAt: g._max.ingestedAt,
    }))
    .sort((a, b) => a.source.localeCompare(b.source));

  return NextResponse.json({ count: opportunities.length, opportunities, sources });
}
