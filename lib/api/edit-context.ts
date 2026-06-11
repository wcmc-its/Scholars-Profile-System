/**
 * Self-edit v1 — suppression-OFF read for the `/edit` self surface (#356,
 * `self-edit-spec.md` § Surfaces "read the target record with the suppression
 * filter OFF", § Hide a publication; UI-SPEC § `/edit` — the self-edit surface).
 *
 * One server call loads everything the page renders: the scholar's identity +
 * effective bio, the visibility-card state (own / admin / both), and the
 * confirmed authorship list annotated per UI-SPEC § Card 3 row-state table
 * (`shown` / `hidden_by_self` / `removed_by_admin`) plus the sole-displayed-
 * author flag that drives the sole-author confirm dialog (UI-SPEC edge case 11).
 *
 * #160 UI follow-up (`self-edit-launch-spec.md`): the same call also loads the
 * scholar's active appointments, all education, and all grants — each keyed on
 * its stable `externalId` (#352) and annotated with the shared four-state row
 * model (`shown` / `hidden_by_self` / `hidden_by_admin` / `locked`) the new
 * Appointments / Education / Funding panels render. The write-path (suppress /
 * revoke) is unchanged — PR-A #480 / PR-B #482 shipped it; this is the read.
 *
 * Suppression-OFF means: the lookup does not filter `scholar.status='active'`,
 * so a self- or admin-suppressed scholar can still load `/edit` and revoke. The
 * helper still returns `null` when no scholar row exists, or when the row is
 * soft-deleted (`deletedAt` set) — a departed scholar has nothing to edit.
 *
 * Phase 3 / Phase 6 scope (D6.1) — `self-edit-v1-implementation-plan.md` § Phase
 * 3 lists this file as a Phase 3 deliverable; PR #385 shipped only the overview
 * read-merge. Phase 6 absorbs it because Phase 6 is the only v1 consumer.
 *
 * Server-only by construction (uses Prisma) — no explicit `server-only` import
 * so the module loads under vitest without a stub, matching `manual-layer.ts`.
 */
import { getEffectiveOverview, getSelectedHighlightPmids } from "@/lib/api/manual-layer";
import { getMenteesForMentor } from "@/lib/api/mentoring";
import { rankForSelectedHighlights } from "@/lib/ranking";
import { MAX_SELECTED_HIGHLIGHTS } from "@/lib/edit/validators";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { isFundingActive } from "@/lib/funding-active";
import { isChairTitleFor } from "@/lib/leadership";
import { formatProgramLabel } from "@/lib/mentoring-labels";
import { isRejectReason } from "@/lib/edit/reject-reason";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface `loadEditContext` needs — a client or tx satisfies it. */
type EditContextReadClient = Pick<
  PrismaClient,
  | "scholar"
  | "suppression"
  | "publicationAuthor"
  | "fieldOverride"
  | "appointment"
  | "education"
  | "grant"
  | "department"
  | "coiActivity"
  | "coiGapCandidate"
  | "publication"
>;

export type EditContextScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  /** Sourced read-only identity fields echoed in the Name & Title panel
   *  (vision-round T3.5). `primaryTitle` is the job title — the title of the
   *  primary appointment, e.g. "Director of …" — while `postnominal` is the
   *  degree / post-nominal string ("MD, MPH"). All nullable. */
  primaryTitle: string | null;
  postnominal: string | null;
  primaryDepartment: string | null;
  email: string | null;
  orcid: string | null;
  /** #536 — drives the edit-route guard: a hidden identity class (doctoral
   *  student) has no public profile, so only a superuser may reach its edit
   *  surface; a non-superuser (incl. the scholar themselves) 404s. */
  roleCategory: string | null;
  /** The effective bio — `field_override(overview) ?? scholar.overview`, sanitized. Empty string = "no overview". */
  overview: string;
  /**
   * The active `field_override(slug)` value, or `null` when no override exists.
   * Read suppression-OFF; only consumed by the Phase 7 superuser slug card —
   * the self surface does not surface this field (slug is superuser-only,
   * `self-edit-spec.md` § Authorization). Read in one extra `findUnique` so
   * the slug card has a server-fetched baseline (no client round-trip).
   */
  slugOverride: string | null;
  suppression: {
    /** A self-applied, un-revoked whole-scholar suppression — drives the "Make my profile visible" control. */
    ownRow: { id: string; reason: string } | null;
    /** A superuser-applied, un-revoked whole-scholar suppression — drives the "Hidden by an administrator" alert. */
    adminRow: { id: string; reason: string; createdAt: Date } | null;
  };
};

export type EditContextPublication = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  /**
   * UI-SPEC § Card 3 row-state table, plus `rejected` (#750).
   *
   * `rejected` is a per-author suppression written by the "Not mine" reject
   * (#746) rather than a Hide — the two are otherwise identical rows
   * (`contributorCwid === cwid`), distinguished only by `suppression.reason`
   * (`isRejectReason`). It renders as "Rejected — correction pending" with no
   * Show control: revoking locally would leave ReCiter's `rejectedPmids` entry
   * in place, so local and upstream would silently diverge (#750). A reject is
   * undone at the source, not here.
   */
  state: "shown" | "hidden_by_self" | "removed_by_admin" | "rejected";
  /** The active self-applied suppression's id when `state === 'hidden_by_self'`, else null. Wires the "Show" button. (`null` for `rejected` — no Show control.) */
  suppressionId: string | null;
  /**
   * True when this scholar is the only currently-displayed confirmed WCM author
   * on the publication — hiding now would make the publication derive-dark
   * (UI-SPEC edge case 11). Always `false` for `state !== 'shown'`.
   */
  isSoleDisplayedAuthor: boolean;
};

/**
 * The shared four-state row model for the three new whole-entity panels
 * (Appointments / Education / Funding). Publications keeps its own distinct
 * union (`removed_by_admin`, `isSoleDisplayedAuthor`, no `locked`) — a
 * whole-publication takedown is a different mechanism with opposite revoke
 * semantics, so the two are deliberately not unified (`self-edit-launch-spec.md`
 * § Publications is deliberately not refactored).
 *
 * - `shown` — no active whole-entity suppression.
 * - `hidden_by_self` — the scholar hid it (`createdBy === ownerCwid`).
 * - `hidden_by_admin` — a superuser hid it (`createdBy !== ownerCwid`).
 * - `locked` — appointment only: a current chair appointment, not hideable
 *   (the route refuses it 409 before authz).
 */
export type EditEntityState = "shown" | "hidden_by_self" | "hidden_by_admin" | "locked";

export type EditContextAppointment = {
  externalId: string; // the suppress `entityId`
  title: string;
  organization: string;
  startDate: string | null; // ISO `YYYY-MM-DD` for display
  endDate: string | null; // null = current
  isPrimary: boolean;
  state: EditEntityState; // "locked" iff a current chair appointment
  /** Set iff state is `hidden_by_self` | `hidden_by_admin` (the superuser
   *  surface revokes either; the self surface revokes only its own). */
  suppressionId: string | null;
};

export type EditContextEducation = {
  externalId: string;
  degree: string;
  institution: string;
  field: string | null;
  year: number | null;
  state: Exclude<EditEntityState, "locked">;
  suppressionId: string | null;
};

export type EditContextGrant = {
  externalId: string;
  title: string;
  role: string;
  /** The funding-section sponsor label — mirrors the profile's derivation
   *  (`primeSponsor ?? canonicalizeSponsor(primeSponsorRaw)`), falling back to
   *  the legacy `funder` so the label is never empty. */
  funderLabel: string;
  startYear: number;
  endYear: number;
  /** Matches the profile's Active/Past badge — `isFundingActive` (NCE grace
   *  window), NOT a bare `endDate >= today`. */
  isActive: boolean;
  state: Exclude<EditEntityState, "locked">;
  suppressionId: string | null;
};

/**
 * One conflict-of-interest disclosure, narrowed to what the read-only COI panel
 * renders (it groups by `activityGroup` and shows the `entity` names). COI is
 * read-only — managed in the Weill Research Gateway, never suppressible here —
 * so this carries no `state` / `suppressionId` like the whole-entity rows do.
 */
export type EditContextCoiDisclosure = {
  entity: string | null;
  activityGroup: string | null;
};

/**
 * One source publication citing a relationship on the "From your publications"
 * advisory — a single `CoiGapCandidate` row, and the unit a dismiss / restore
 * acts on. The same relationship is often named across several of the scholar's
 * papers; each paper becomes one source under its grouped entity (see
 * `EditContextCoiGapCandidate`). Narrowed to ONLY what the panel renders.
 */
export type EditContextCoiGapSource = {
  /** The underlying `CoiGapCandidate.id` — the unit a dismiss / restore targets. */
  id: string;
  pmid: string;
  /** Verbatim source sentence — always shown so the human, not a score, adjudicates. */
  sourceSentence: string;
  /** Publication year for display, or null when unknown. */
  year: number | null;
};

/**
 * One relationship on the "From your publications" advisory, DEDUPED across the
 * scholar's papers: the same entity named in several PubMed "Competing interests"
 * statements collapses to a single row that CITES every source publication
 * (`sources`), rather than repeating the entity once per PMID. This is the
 * deliberately starved client projection of `CoiGapCandidate`: the persisted rows
 * also carry `attribution`, `entityScore`, `category`, and `status`, NONE of which
 * reach the client — exposing the numeric score or status would re-introduce the
 * "verdict"/false-precision shapes the governance review forbade. (`normalizedEntity`
 * crosses only as the opaque grouping `key` — a lowercased form of the entity that
 * is already shown verbatim — never the score, status, attribution, or category.)
 * Confidence is the qualitative `tier` only
 * (High | Medium), never a percentage; the verbatim `sourceSentence` of every
 * source is always carried so the human, not the score, adjudicates.
 *
 * This array is populated ONLY when `loadEditContext` is called with
 * `opts.includeCoiGap === true`, which the self page sets for a genuine
 * (non-impersonating) self viewer and the superuser page for a genuine
 * (non-impersonating) superuser, both behind `SELF_EDIT_COI_GAP_HINT`. Every
 * other caller (public, search) leaves the opt absent, so this loader is the
 * authoritative enforcement point — the candidates are never even read for a
 * disallowed viewer, not merely UI-hidden.
 */
export type EditContextCoiGapCandidate = {
  /** Group key — the normalized entity. Stable across reloads; the card keys its
   *  dismissed / pending / error state off it. NEVER displayed (the raw `entity`
   *  is what the scholar sees). */
  key: string;
  /** Display label — the relationship as written verbatim (the raw `entity` of
   *  the newest citing source). */
  entity: string;
  /** Highest qualitative tier across the grouped sources — High if ANY source is
   *  High, else Medium (a relationship is "worth reviewing" if any paper is). */
  tier: "High" | "Medium";
  /** Every source publication naming this relationship, newest first. A
   *  group-level dismiss / restore fires for each source's `id`. */
  sources: ReadonlyArray<EditContextCoiGapSource>;
  /** Sort key: the newest source's publication date as epoch ms (0 when no source
   *  has a known date). NEVER displayed — it only orders the list. */
  newestTs: number;
};

/**
 * One mentee on the suppressible Mentees panel. Mentees are derived (no FK; the
 * reporting DB is truncate-rebuilt nightly), so they have no #352 stable DB key
 * — instead `externalId` is the composite `"{mentorCwid}:{menteeCwid}"`, which
 * is what the suppress `entityId` carries (owner = the mentor before the colon).
 * The four-state row model is shared with the other whole-entity panels (minus
 * `locked`, which is appointment-only).
 */
export type EditContextMentee = {
  externalId: string; // `{mentorCwid}:{menteeCwid}` — the suppress entityId
  name: string;
  /** Program / degree-bucket subtitle (e.g. "Immunology (PhD)"), or null. */
  subtitle: string | null;
  state: Exclude<EditEntityState, "locked">;
  suppressionId: string | null;
};

/**
 * The Highlights-editor state (#836). Surfaced ONLY when `loadEditContext` is
 * called with `opts.includeHighlights === true`, which the self page sets behind
 * `SELF_EDIT_MANUAL_HIGHLIGHTS` for a genuine self viewer. `null` for every
 * other caller (and when the flag is off), so the rail item / card never appear.
 */
export type EditContextHighlights = {
  /** Whether the scholar has opted in (a `selectedHighlightPmids` override exists). */
  manualEnabled: boolean;
  /** The scholar's stored manual picks, in order — empty when not opted in. */
  manualPmids: ReadonlyArray<string>;
  /** The AI-selected Highlights PMIDs (the default), to seed the picker when the
   *  scholar opts in. Same ranking + count the public profile shows. */
  aiPmids: ReadonlyArray<string>;
  /** The scholar's shown (non-suppressed) confirmed publications, the pickable
   *  pool. Ordered most-recent-first so the picker reads sensibly. */
  pickable: ReadonlyArray<{ pmid: string; title: string; journal: string | null; year: number | null }>;
};

export type EditContext = {
  scholar: EditContextScholar;
  publications: ReadonlyArray<EditContextPublication>;
  appointments: ReadonlyArray<EditContextAppointment>;
  educations: ReadonlyArray<EditContextEducation>;
  grants: ReadonlyArray<EditContextGrant>;
  /** Read-only COI disclosures (the Weill Research Gateway is the SOR). */
  coiDisclosures: ReadonlyArray<EditContextCoiDisclosure>;
  /** Suppressible mentees (derived from training records; mentor may hide). */
  mentees: ReadonlyArray<EditContextMentee>;
  /**
   * Publication-derived COI-gap candidates surfaced ONLY to the genuine self
   * viewer behind `SELF_EDIT_COI_GAP_HINT`. Populated only when
   * `loadEditContext` is called with `opts.includeCoiGap === true`; an empty
   * array for every other caller (and when the scholar has no candidates). This
   * is a suggestion surface, never a verdict — see `EditContextCoiGapCandidate`.
   */
  unmatchedPubmedCoi: ReadonlyArray<EditContextCoiGapCandidate>;
  /**
   * The manual-Highlights editor state (#836), or `null` when the surface is not
   * available (flag off, or a non-self caller). Populated only when
   * `loadEditContext` is called with `opts.includeHighlights === true`.
   */
  highlights: EditContextHighlights | null;
};

/**
 * The mentee-loader seam. `loadEditContext` calls this to get the mentor's raw
 * mentees from the REPORTING DB (`getMenteesForMentor`), which is a different
 * data source than the Prisma `client` argument. It is injected (and defaulted)
 * so tests need no live reporting DB, and so the page load can guard it:
 * `loadEditContext` wraps the call in try/catch and treats any failure as "no
 * mentees" rather than letting an unreachable reporting DB 500 the whole /edit
 * page. The shape returned is narrowed to what the panel needs.
 */
export type EditContextMenteeSource = {
  cwid: string;
  fullName: string;
  programName: string | null;
  programType: string | null;
};
export type LoadMentees = (mentorCwid: string) => Promise<EditContextMenteeSource[]>;

/**
 * The default mentee-loader: adapts `getMenteesForMentor` (reporting DB) to the
 * narrowed `EditContextMenteeSource` shape. Injected so tests don't need a live
 * reporting connection; `loadEditContext` still wraps the call in try/catch.
 */
const defaultLoadMentees: LoadMentees = async (mentorCwid) => {
  const { mentees } = await getMenteesForMentor(mentorCwid);
  return mentees.map((m) => ({
    cwid: m.cwid,
    fullName: m.fullName,
    programName: m.programName,
    programType: m.programType,
  }));
};

/**
 * Load the full `/edit` page context for one scholar.
 *
 * Returns `null` when no scholar row exists for `cwid`, or when the row is
 * soft-deleted (`deletedAt` set). A suppressed scholar (self or admin) returns
 * normally — the page reads suppression-OFF.
 *
 * `loadMentees` is the reporting-DB seam (default `getMenteesForMentor`). It is
 * called best-effort: a thrown error (reporting DB unreachable) yields an empty
 * mentee list rather than failing the whole page — /edit must never 500 because
 * the mentee source is down.
 *
 * `opts.includeCoiGap` is the AUTHORITATIVE self-only gate for the
 * publication-derived COI-gap candidates (`unmatchedPubmedCoi`). It defaults to
 * `false`, so a caller that does not explicitly opt in NEVER loads the
 * candidates — the superuser-viewing-other path (`/edit/scholar/[cwid]`), public,
 * and search all leave it unset and get an empty array. Only the self page
 * passes `true`, and only when `SELF_EDIT_COI_GAP_HINT` is on AND the viewer is
 * genuinely self (not impersonating). Enforcing self-only here, at the data
 * layer, means the rows are never read for an unauthorized viewer rather than
 * read-then-hidden.
 */
export async function loadEditContext(
  cwid: string,
  client: EditContextReadClient,
  now: Date = new Date(),
  loadMentees: LoadMentees = defaultLoadMentees,
  opts?: { includeCoiGap?: boolean; includeHighlights?: boolean },
): Promise<EditContext | null> {
  const scholar = await client.scholar.findUnique({
    where: { cwid },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      primaryTitle: true,
      postnominal: true,
      primaryDepartment: true,
      email: true,
      orcid: true,
      overview: true,
      deletedAt: true,
      roleCategory: true,
    },
  });
  if (!scholar || scholar.deletedAt !== null) return null;

  const effectiveOverview = await getEffectiveOverview(cwid, scholar.overview, client);

  // Phase 7 — the slug-card baseline. `null` = no override; superuser slug card
  // shows the "no override" state. The self surface does not surface this field
  // (slug edits are superuser-only, `self-edit-spec.md` § Authorization).
  const slugOverrideRow = await client.fieldOverride.findUnique({
    where: {
      entityType_entityId_fieldName: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: "slug",
      },
    },
    select: { value: true },
  });
  const slugOverride = slugOverrideRow?.value ?? null;

  const scholarSuppressions = await client.suppression.findMany({
    where: {
      entityType: "scholar",
      entityId: cwid,
      contributorCwid: null,
      revokedAt: null,
    },
    select: { id: true, reason: true, createdBy: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  // Defensive: multiple un-revoked rows of either kind shouldn't occur (the
  // suppress endpoint is idempotent — edge case 19), but a superuser row +
  // a self row coexisting is the documented edge case 4. Take the most recent
  // of each kind.
  const ownRow = scholarSuppressions.find((r) => r.createdBy === cwid) ?? null;
  const adminRow = scholarSuppressions.find((r) => r.createdBy !== cwid) ?? null;

  // --- #160 UI follow-up: the three whole-entity attributes ---
  // Each panel lists exactly what the public profile renders, keyed on the
  // stable `externalId` (#352). Active appointments only — mirrors the profile
  // sidebar's default set (`endDate` null or in the future). The interim-drop /
  // single-visible-primary collapse the profile also applies are a display
  // refinement deferred here: a hidden interim row is a no-op against the
  // read-path anyway. Education and grants render in full on the profile.
  const appointmentRows = await client.appointment.findMany({
    where: { cwid, OR: [{ endDate: null }, { endDate: { gt: now } }] },
    select: {
      externalId: true,
      title: true,
      organization: true,
      startDate: true,
      endDate: true,
      isPrimary: true,
    },
    orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
  });
  const educationRows = await client.education.findMany({
    where: { cwid },
    select: { externalId: true, degree: true, institution: true, field: true, year: true },
    orderBy: [{ year: "desc" }],
  });
  const grantRows = await client.grant.findMany({
    where: { cwid },
    select: {
      externalId: true,
      title: true,
      role: true,
      funder: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      startDate: true,
      endDate: true,
    },
    orderBy: [{ endDate: "desc" }, { startDate: "desc" }],
  });

  // Conflicts of interest — read-only (the Weill Research Gateway is the SOR).
  // Same select shape + ordering the public profile uses (`lib/api/profile.ts`
  // `coiActivities`) so the /edit panel groups identically.
  const coiRows = await client.coiActivity.findMany({
    where: { cwid },
    select: { entity: true, activityGroup: true },
    orderBy: [{ activityGroup: "asc" }, { entity: "asc" }],
  });
  const coiDisclosures: EditContextCoiDisclosure[] = coiRows.map((c) => ({
    entity: c.entity,
    activityGroup: c.activityGroup,
  }));

  // Publication-derived COI-gap candidates (`SELF_EDIT_COI_GAP_HINT`) — SELF-
  // ONLY, and the opt-in IS the self guard: only the self page passes
  // `includeCoiGap: true`, and only for a genuine (non-impersonating) self
  // viewer with the flag on. Every other caller leaves `opts` unset, so the
  // query never runs and the array is empty — the candidates are never read for
  // a non-self viewer. Surface only actionable lifecycle states (`new` +
  // `acknowledged`); `dismissed`/`resolved` are intentionally excluded so a
  // disavowed nudge never reappears. Ordered tier (High first) then entity, and
  // mapped to the STARVED client shape — `normalizedEntity`, `attribution`,
  // `entityScore`, `category`, and `status` never cross to the client.
  let unmatchedPubmedCoi: EditContextCoiGapCandidate[] = [];
  if (opts?.includeCoiGap === true) {
    const gapRows = await client.coiGapCandidate.findMany({
      where: { cwid, status: { in: ["new", "acknowledged"] } },
      // `normalizedEntity` is the group (dedupe) key; it never reaches the client.
      select: {
        id: true,
        pmid: true,
        entity: true,
        normalizedEntity: true,
        tier: true,
        sourceSentence: true,
      },
      orderBy: [{ entity: "asc" }],
    });

    // The candidate has no date column, so join `publication` by pmid for the
    // year (display) + `dateAddedToEntrez` (a finer sort key than year alone).
    // The numeric date never reaches the client — only the year and a derived
    // sort timestamp do, and the timestamp orders the list without being shown.
    const gapPmids = [...new Set(gapRows.map((g) => g.pmid))];
    const pubDates =
      gapPmids.length > 0
        ? await client.publication.findMany({
            where: { pmid: { in: gapPmids } },
            select: { pmid: true, year: true, dateAddedToEntrez: true },
          })
        : [];
    const dateByPmid = new Map(
      pubDates.map((p) => [
        p.pmid,
        {
          year: p.year ?? null,
          // Prefer the precise Entrez date; fall back to Jan 1 of the year; else 0.
          ts: p.dateAddedToEntrez
            ? p.dateAddedToEntrez.getTime()
            : p.year != null
              ? Date.UTC(p.year, 0, 1)
              : 0,
        },
      ]),
    );

    // Collapse the per-(pmid, entity) rows into ONE row per normalized entity,
    // citing every source publication. Tier is the highest across sources; the
    // display label is the raw entity of the newest source.
    type GapSrc = {
      id: string;
      pmid: string;
      sourceSentence: string;
      year: number | null;
      ts: number;
      entity: string;
    };
    const groups = new Map<
      string,
      { key: string; tier: "High" | "Medium"; newestTs: number; sources: GapSrc[] }
    >();
    for (const g of gapRows) {
      // The DB column is a free `VarChar(16)`; narrow to the rendered union and
      // treat any unexpected value as the more conservative "Medium" tier.
      const tier: "High" | "Medium" = g.tier === "High" ? "High" : "Medium";
      const d = dateByPmid.get(g.pmid) ?? { year: null, ts: 0 };
      const src: GapSrc = {
        id: g.id,
        pmid: g.pmid,
        sourceSentence: g.sourceSentence,
        year: d.year,
        ts: d.ts,
        entity: g.entity,
      };
      const existing = groups.get(g.normalizedEntity);
      if (existing) {
        existing.sources.push(src);
        if (tier === "High") existing.tier = "High";
        if (d.ts > existing.newestTs) existing.newestTs = d.ts;
      } else {
        groups.set(g.normalizedEntity, {
          key: g.normalizedEntity,
          tier,
          newestTs: d.ts,
          sources: [src],
        });
      }
    }

    unmatchedPubmedCoi = [...groups.values()]
      .map((grp) => {
        // Sources newest first (pmid desc as a stable tiebreak); the newest
        // source's raw entity is the group's display label.
        const sorted = [...grp.sources].sort((a, b) => b.ts - a.ts || b.pmid.localeCompare(a.pmid));
        return {
          key: grp.key,
          entity: sorted[0].entity,
          tier: grp.tier,
          sources: sorted.map((s) => ({
            id: s.id,
            pmid: s.pmid,
            sourceSentence: s.sourceSentence,
            year: s.year,
          })),
          newestTs: grp.newestTs,
        };
      })
      // Default SSR order = "Newest + confidence": High tier first, newest within
      // tier (entity asc as a final tiebreak). The card re-sorts on the chosen
      // mode, but this matches the default control so SSR and hydration agree.
      .sort(
        (a, b) =>
          (a.tier === b.tier ? 0 : a.tier === "High" ? -1 : 1) ||
          b.newestTs - a.newestTs ||
          a.entity.localeCompare(b.entity),
      );
  }

  // Mentees — suppressible, derived from training records (reporting DB). The
  // source is queried through the injected `loadMentees` seam and is BEST-
  // EFFORT: if the reporting DB is unreachable we render zero mentees rather
  // than 500 the page. Each mentee's `externalId` is `{cwid}:{menteeCwid}`,
  // which is also the suppress entityId (owner = this mentor). The four-state
  // annotation reuses the same per-request suppression lookup pattern the
  // whole-entity panels use (`contributorCwid IS NULL`, `revokedAt IS NULL`).
  let menteeRows: EditContextMenteeSource[] = [];
  try {
    menteeRows = await loadMentees(cwid);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "edit_context_mentees_unavailable",
        cwid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    menteeRows = [];
  }
  const menteeExternalIds = menteeRows.map((m) => `${cwid}:${m.cwid}`);
  // `{cwid}:{menteeCwid}` → the active mentee hide. Absent key = "shown".
  const menteeHide = new Map<
    string,
    { state: "hidden_by_self" | "hidden_by_admin"; suppressionId: string }
  >();
  if (menteeExternalIds.length > 0) {
    const menteeSuppressions = await client.suppression.findMany({
      where: {
        entityType: "mentee",
        entityId: { in: menteeExternalIds },
        contributorCwid: null,
        revokedAt: null,
      },
      select: { id: true, entityId: true, createdBy: true },
    });
    for (const row of menteeSuppressions) {
      menteeHide.set(row.entityId, {
        // The owner is the mentor (== `cwid` here); a self-hide is one this
        // scholar created, an admin-hide is anyone else's (the superuser
        // surface revokes either).
        state: row.createdBy === cwid ? "hidden_by_self" : "hidden_by_admin",
        suppressionId: row.id,
      });
    }
  }
  const mentees: EditContextMentee[] = menteeRows.map((m) => {
    const externalId = `${cwid}:${m.cwid}`;
    const hide = menteeHide.get(externalId);
    return {
      externalId,
      name: m.fullName,
      // Mirror the public chip's subtitle: program name first, then the
      // degree-bucket label derived from programType.
      subtitle: m.programName ?? formatProgramLabel(m.programType),
      state: hide ? hide.state : "shown",
      suppressionId: hide ? hide.suppressionId : null,
    };
  });

  // One bounded suppression query across all three entity types, keyed on the
  // stable externalId. Whole-entity only (`contributorCwid IS NULL` — PR-A/PR-B
  // reject a contributor for these). Per-request, never cached — the ADR-005
  // immediacy rule the publication path uses. Skipped when the scholar has no
  // entities (keeps the call count down; mirrors the pmid guard below).
  const entityExternalIds = [
    ...appointmentRows.map((a) => a.externalId),
    ...educationRows.map((e) => e.externalId),
    ...grantRows.map((g) => g.externalId),
  ];
  // `${entityType}:${entityId}` → the active hide. Absent key = "shown".
  const entityHide = new Map<
    string,
    { state: "hidden_by_self" | "hidden_by_admin"; suppressionId: string }
  >();
  if (entityExternalIds.length > 0) {
    const entitySuppressions = await client.suppression.findMany({
      where: {
        entityType: { in: ["appointment", "education", "grant"] },
        entityId: { in: entityExternalIds },
        contributorCwid: null,
        revokedAt: null,
      },
      select: { id: true, entityType: true, entityId: true, createdBy: true },
    });
    for (const row of entitySuppressions) {
      // suppressionId is carried for BOTH hidden states — the superuser surface
      // revokes either; the self surface renders a control only for its own.
      entityHide.set(`${row.entityType}:${row.entityId}`, {
        state: row.createdBy === cwid ? "hidden_by_self" : "hidden_by_admin",
        suppressionId: row.id,
      });
    }
  }

  // Chair lock — a current chair appointment is not hideable (the route refuses
  // it 409 before authz, for the chair AND a superuser). Mirror that exact
  // predicate: the dept the scholar chairs (0–1 rows) + a per-appointment title
  // match (`isChairTitleFor`) — NOT a bare `chairCwid` existence check, which
  // would over-lock the chair's other (suppressible) appointments. Keep in
  // lockstep with `validators.isChairAppointment`.
  const chairedDept = await client.department.findFirst({
    where: { chairCwid: cwid },
    select: { name: true },
  });

  const appointments: EditContextAppointment[] = appointmentRows.map((a) => {
    const locked = chairedDept !== null && isChairTitleFor(a.title, chairedDept.name);
    const hide = entityHide.get(`appointment:${a.externalId}`);
    return {
      externalId: a.externalId,
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isPrimary: a.isPrimary,
      state: locked ? "locked" : hide ? hide.state : "shown",
      suppressionId: locked ? null : hide ? hide.suppressionId : null,
    };
  });

  const educations: EditContextEducation[] = educationRows.map((e) => {
    const hide = entityHide.get(`education:${e.externalId}`);
    return {
      externalId: e.externalId,
      degree: e.degree,
      institution: e.institution,
      field: e.field,
      year: e.year,
      state: hide ? hide.state : "shown",
      suppressionId: hide ? hide.suppressionId : null,
    };
  });

  const grants: EditContextGrant[] = grantRows.map((g) => {
    const hide = entityHide.get(`grant:${g.externalId}`);
    return {
      externalId: g.externalId,
      title: g.title,
      role: g.role,
      funderLabel: g.primeSponsor ?? canonicalizeSponsor(g.primeSponsorRaw) ?? g.funder,
      // UTC year (not getFullYear, which is local) so it matches how the
      // profile renders grant dates (`toISOString().slice(0, 10)`).
      startYear: Number(g.startDate.toISOString().slice(0, 4)),
      endYear: Number(g.endDate.toISOString().slice(0, 4)),
      isActive: isFundingActive(g.endDate, now),
      state: hide ? hide.state : "shown",
      suppressionId: hide ? hide.suppressionId : null,
    };
  });

  // #836 — only the manual-Highlights editor needs the ranking fields
  // (publicationType / dateAddedToEntrez / impactScore / per-scholar score) to
  // compute the AI default. Pull them only when that surface is requested so the
  // common /edit load stays lean.
  const includeHighlights = opts?.includeHighlights === true;
  const authorships = await client.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: {
      isFirst: true,
      isLast: true,
      isPenultimate: true,
      isConfirmed: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          ...(includeHighlights
            ? {
                publicationType: true,
                dateAddedToEntrez: true,
                impactScore: true,
                publicationScores: { where: { cwid }, select: { score: true } },
              }
            : {}),
        },
      },
    },
  });
  const pmids = authorships.map((a) => a.publication.pmid);

  const publications: EditContextPublication[] = [];
  if (pmids.length === 0) {
    const noPubManual = includeHighlights ? await getSelectedHighlightPmids(cwid, client) : null;
    return {
      scholar: {
        cwid: scholar.cwid,
        slug: scholar.slug,
        preferredName: scholar.preferredName,
        fullName: scholar.fullName,
        primaryTitle: scholar.primaryTitle,
        postnominal: scholar.postnominal,
        primaryDepartment: scholar.primaryDepartment,
        email: scholar.email,
        orcid: scholar.orcid,
        roleCategory: scholar.roleCategory,
        overview: effectiveOverview ?? "",
        slugOverride,
        suppression: {
          ownRow: ownRow ? { id: ownRow.id, reason: ownRow.reason } : null,
          adminRow: adminRow
            ? { id: adminRow.id, reason: adminRow.reason, createdAt: adminRow.createdAt }
            : null,
        },
      },
      publications,
      appointments,
      educations,
      grants,
      coiDisclosures,
      mentees,
      unmatchedPubmedCoi,
      // No confirmed publications → nothing to pick or rank. Surface an empty
      // editor state (still reading any stored override) when requested.
      highlights: includeHighlights
        ? { manualEnabled: noPubManual !== null, manualPmids: noPubManual ?? [], aiPmids: [], pickable: [] }
        : null,
    };
  }

  // Active publication suppressions for the bounded pmid set — one query
  // covering whole-pub takedowns and per-author hides (own + others'). `reason`
  // is selected to tell a "Not mine" reject apart from a Hide (#750) — both are
  // per-author rows with `contributorCwid === cwid`, distinguished only by it.
  const pubSuppressions = await client.suppression.findMany({
    where: {
      entityType: "publication",
      entityId: { in: pmids },
      revokedAt: null,
    },
    select: { id: true, entityId: true, contributorCwid: true, reason: true },
  });
  const darkPmids = new Set<string>();
  // pmid → THIS scholar's active per-author suppression on it. `isReject`
  // discriminates a reject (#746) from a Hide so the row derives as `rejected`
  // vs `hidden_by_self`; `id` wires the "Show" button (hide only — a reject has
  // no Show control, #750).
  const selfSuppressionByPmid = new Map<string, { id: string; isReject: boolean }>();
  // pmid → set of cwids with an active per-author suppression on it (hide OR
  // reject — both drop the author from display). Used to compute the
  // displayed-author set for `isSoleDisplayedAuthor`.
  const hiddenAuthorsByPmid = new Map<string, Set<string>>();
  for (const row of pubSuppressions) {
    if (row.contributorCwid === null) {
      darkPmids.add(row.entityId);
    } else {
      let hidden = hiddenAuthorsByPmid.get(row.entityId);
      if (!hidden) {
        hidden = new Set();
        hiddenAuthorsByPmid.set(row.entityId, hidden);
      }
      hidden.add(row.contributorCwid);
      if (row.contributorCwid === cwid) {
        // The reject route's idempotency guard means at most one un-revoked
        // self row per pmid, so a plain set is safe; if both ever coexisted,
        // a reject wins (the stronger "not mine" assertion).
        const existing = selfSuppressionByPmid.get(row.entityId);
        if (!existing?.isReject) {
          selfSuppressionByPmid.set(row.entityId, {
            id: row.id,
            isReject: isRejectReason(row.reason),
          });
        }
      }
    }
  }

  // Confirmed, site-visible WCM authors for the same pmid set — minus
  // per-author hides — is the displayed-author set. Used solely for
  // `isSoleDisplayedAuthor`.
  const confirmedAuthors = await client.publicationAuthor.findMany({
    where: {
      pmid: { in: pmids },
      isConfirmed: true,
      cwid: { not: null },
      scholar: { status: "active", deletedAt: null },
    },
    select: { pmid: true, cwid: true },
  });
  const displayedByPmid = new Map<string, Set<string>>();
  for (const row of confirmedAuthors) {
    if (row.cwid === null) continue;
    if (hiddenAuthorsByPmid.get(row.pmid)?.has(row.cwid)) continue;
    let set = displayedByPmid.get(row.pmid);
    if (!set) {
      set = new Set();
      displayedByPmid.set(row.pmid, set);
    }
    set.add(row.cwid);
  }

  for (const a of authorships) {
    const pmid = a.publication.pmid;
    let state: EditContextPublication["state"];
    let suppressionId: string | null = null;
    if (darkPmids.has(pmid)) {
      // Whole-pub takedown outranks a self-hide (UI-SPEC Card 3 — the inline
      // "Removed by an administrator" message is what the user sees, even
      // when the scholar also has a per-author hide on the same pmid).
      state = "removed_by_admin";
    } else if (selfSuppressionByPmid.has(pmid)) {
      const self = selfSuppressionByPmid.get(pmid)!;
      if (self.isReject) {
        // A "Not mine" reject (#746/#750). No Show control — revoking locally
        // would diverge from ReCiter's gold standard — so suppressionId stays
        // null; the row renders "Rejected — correction pending" read-only.
        state = "rejected";
      } else {
        state = "hidden_by_self";
        suppressionId = self.id;
      }
    } else {
      state = "shown";
    }
    // Sole-displayed-author check is only meaningful when the row is shown —
    // it gates the confirm dialog before a hide. For a hidden_by_self,
    // rejected, or removed_by_admin row, no Hide click is reachable, so false.
    const displayed = displayedByPmid.get(pmid);
    const isSoleDisplayedAuthor =
      state === "shown" && displayed !== undefined && displayed.size === 1 && displayed.has(cwid);
    publications.push({
      pmid,
      title: a.publication.title,
      journal: a.publication.journal,
      year: a.publication.year,
      state,
      suppressionId,
      isSoleDisplayedAuthor,
    });
  }

  // #836 — the manual-Highlights editor state. Built only when requested
  // (self + flag on). The pickable pool and the AI default mirror the public
  // profile: the same `shown` (non-suppressed) confirmed authorships, ranked by
  // the `selected_highlights` curve to the same count the profile slices to. A
  // suppressed pub never enters the pool, so it can neither be picked nor seed
  // the AI default — keeping the editor in lockstep with the read path.
  const highlights = includeHighlights
    ? await buildHighlightsContext(cwid, authorships, publications, client, now)
    : null;

  return {
    scholar: {
      cwid: scholar.cwid,
      slug: scholar.slug,
      preferredName: scholar.preferredName,
      fullName: scholar.fullName,
      primaryTitle: scholar.primaryTitle,
      postnominal: scholar.postnominal,
      primaryDepartment: scholar.primaryDepartment,
      email: scholar.email,
      orcid: scholar.orcid,
      roleCategory: scholar.roleCategory,
      overview: effectiveOverview ?? "",
      slugOverride,
      suppression: {
        ownRow: ownRow ? { id: ownRow.id, reason: ownRow.reason } : null,
        adminRow: adminRow
          ? { id: adminRow.id, reason: adminRow.reason, createdAt: adminRow.createdAt }
          : null,
      },
    },
    publications,
    appointments,
    educations,
    grants,
    coiDisclosures,
    mentees,
    unmatchedPubmedCoi,
    highlights,
  };
}

/** The Prisma surface `buildHighlightsContext` needs (the override read). */
type HighlightsReadClient = Pick<PrismaClient, "fieldOverride">;

/** The authorship row shape `buildHighlightsContext` consumes — the ranking
 *  fields are present only when `includeHighlights` widened the select. */
type HighlightsAuthorship = {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
  isConfirmed: boolean;
  publication: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    publicationType?: string | null;
    dateAddedToEntrez?: Date | null;
    impactScore?: { toString(): string } | null;
    publicationScores?: ReadonlyArray<{ score: number }>;
  };
};

/**
 * Compute the #836 Highlights-editor state for one scholar: the stored manual
 * picks, the AI default (same ranking the profile shows), and the pickable
 * publication pool. Pure-ish (one override read), kept out of the main loader
 * body so the ranking import only matters on the gated path.
 */
async function buildHighlightsContext(
  cwid: string,
  authorships: ReadonlyArray<HighlightsAuthorship>,
  publications: ReadonlyArray<EditContextPublication>,
  client: HighlightsReadClient,
  now: Date,
): Promise<EditContextHighlights> {
  const shown = new Set(publications.filter((p) => p.state === "shown").map((p) => p.pmid));

  // Rank the shown pubs by the same curve + impact source the profile uses
  // (`lib/api/profile.ts`), then take the same top-N slice.
  const rankable = authorships
    .filter((a) => shown.has(a.publication.pmid))
    .map((a) => {
      const pub = a.publication;
      const globalImpact =
        pub.impactScore !== null && pub.impactScore !== undefined
          ? Number(pub.impactScore.toString())
          : 0;
      return {
        pmid: pub.pmid,
        publicationType: pub.publicationType ?? null,
        reciteraiImpact: pub.publicationScores?.[0]?.score ?? globalImpact,
        dateAddedToEntrez: pub.dateAddedToEntrez ?? null,
        authorship: { isFirst: a.isFirst, isLast: a.isLast, isPenultimate: a.isPenultimate },
        isConfirmed: a.isConfirmed,
      };
    });
  const aiPmids = rankForSelectedHighlights(rankable, now)
    .slice(0, MAX_SELECTED_HIGHLIGHTS)
    .map((p) => p.pmid);

  const manual = await getSelectedHighlightPmids(cwid, client);
  // The pickable pool: shown pubs, most-recent-first (year desc), so the picker
  // reads top-to-bottom newest-first like the profile's publications list.
  const pickable = publications
    .filter((p) => p.state === "shown")
    .map((p) => ({ pmid: p.pmid, title: p.title, journal: p.journal, year: p.year }))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  return {
    manualEnabled: manual !== null,
    manualPmids: manual ?? [],
    aiPmids,
    pickable,
  };
}
