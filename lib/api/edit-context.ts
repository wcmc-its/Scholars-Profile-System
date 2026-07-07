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
import { MAX_SELECTED_HIGHLIGHTS, SECTION_VISIBILITY_FIELDS } from "@/lib/edit/validators";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { isFundingActive } from "@/lib/funding-active";
import { isChairTitleFor } from "@/lib/leadership";
import { formatProgramLabel } from "@/lib/mentoring-labels";
import { isRejectReason } from "@/lib/edit/reject-reason";
import type { FeedbackReason } from "@/lib/coi-gap/feedback";
import { subjectId as deriveSubjectId } from "@/lib/coi-gap/mention";
import type { SubjectType } from "@/lib/coi-gap/mention";
import { relationshipKinds as deriveRelationshipKinds } from "@/lib/coi-gap/pipeline";
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
  | "publicationConflictStatement"
  | "reporterProfileCandidate"
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
  /** Effective email release audience from the Web Directory (`email_visibility`):
   *  'public' | 'institution' | 'none'. NULL until the first ED ETL backfill;
   *  read-only, owned by the Web Directory SOR. Drives the informational
   *  visibility label and explainer on the read-only Email tab — never a control. */
  emailVisibility: string | null;
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
  /**
   * section-visibility-spec — the profile section keys currently HIDDEN
   * (`field_override(scholar, <key>)` = "true"), a subset of
   * `SECTION_VISIBILITY_FIELDS`. Drives the Visibility card's Sections panel
   * switches; absent key = shown. Read suppression-OFF like every other field.
   */
  hiddenSections: string[];
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
  /** "InfoEd" (WCM-administered) | "RePORTER" (NIH RePORTER backfill, #1307). */
  source: string;
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
 * One relationship on the "Reviewed" (current-state) view: a group where EVERY
 * source has been acted on (no `new` source remains), so it is settled history,
 * not a nag. It still cites every source publication (verbatim `sourceSentence`
 * always rendered) and supports change-of-mind + undo, which is why the
 * scholar's own recorded `reason` and `reviewedAt` (their action date) cross to
 * the client — the ONLY two formerly-starved fields that do, and ONLY for
 * Reviewed rows. The numeric `entityScore`, `attribution`, `category`, and the
 * raw lifecycle `status` still NEVER reach the client.
 */
export type EditContextCoiGapReviewed = {
  /** Group key — the normalized entity (same opaque key the active rows use). */
  key: string;
  /** Display label — the raw `entity` of the newest source. */
  entity: string;
  /** Highest qualitative tier across the grouped sources (display only). */
  tier: "High" | "Medium";
  /** Every source publication naming this relationship, newest first. */
  sources: ReadonlyArray<EditContextCoiGapSource>;
  /** The recorded feedback reason of the newest acted source — drives the
   *  settled label and the change-of-mind preselect. */
  reason: FeedbackReason;
  /** The scholar's own action date (newest `reviewed_at` across sources), as an
   *  ISO `YYYY-MM-DD` string — governance-allowed because it is the scholar's
   *  own action, not a model verdict. */
  reviewedAt: string;
  /** Sort key: the newest source's publication date as epoch ms. NEVER
   *  displayed — it only orders the list. */
  newestTs: number;
};

/**
 * #1112 — one MENTION (one paper × one matched organization) in the redesigned
 * "From the scholar's publications" review surface. This is the FLAT atomic unit
 * the client fetches ONCE and pivots into Organization OR Paper view entirely
 * client-side (spec §3/§9: "both views derive from one fetched mention set"). The
 * three grouped arrays above (`unmatchedPubmedCoi*`) stay for the existing card +
 * rail badge; this is the parallel projection the redesign consumes.
 *
 * GOVERNANCE (same starvation as the grouped projection): the numeric
 * `entityScore`, the internal `attribution` LEVEL, `category`, and the raw
 * lifecycle `status` NEVER cross. Confidence is the qualitative `tier` only, mapped
 * to a `confidence` marker ("high" | "low") for the spec's primary-counter rule
 * (Medium = low-confidence, collapsed + excluded from the primary count). Subject
 * attribution is honest: `subjectType: "unknown"` is emitted when the parse could
 * not resolve a subject — NEVER guessed "self".
 *
 * The DECISION UNIT is `(pmid, subjectId)` (see `lib/coi-gap/mention.ts`):
 * resolving it POSTs the existing per-id `/feedback` (or `/restore`) for EVERY
 * `candidateId` whose mention shares that `(pmid, subjectId)`. The 3-way feedback
 * SEMANTICS are unchanged — only the client-side fan-out set changes.
 */
export type EditContextCoiGapMention = {
  /** Source `CoiGapCandidate.id` — the unit the per-id `/feedback` & `/restore`
   *  routes target. One mention === one candidate row. */
  candidateId: string;
  pmid: string;
  /** Publication year for display, or null when unknown. */
  year: number | null;
  /** Canonical/normalized matched org — the dedupe/group key for Organization view
   *  (a lowercased form already shown verbatim; never the score/status). */
  organization: string;
  /** The organization as PRINTED in the sentence ("Roche/Genentech"). */
  organizationRaw: string;
  /** Grammatical subject of the clause naming this org. `"unknown"` when the parse
   *  could not resolve it — never guessed `"self"`. */
  subjectType: SubjectType;
  /** The exact subject token as written ("Dr Altorki", "A Saxena", "SR"), or null
   *  when `subjectType === "unknown"`. */
  subjectMention: string | null;
  /** Stable decision-unit key WITHIN this pmid — `subjectId(pmid,…)` from
   *  `lib/coi-gap/mention.ts` ("self" | "coauthor:<norm>" | "unknown:#idx"). All
   *  mentions sharing `(pmid, subjectId)` resolve together. */
  subjectId: string;
  /** Trimmed span for the Organization-view row (subject token + matched org +
   *  ~6 words connective, eliding with "…"). Organization view marks org + subject
   *  per spec §4. */
  clause: string;
  /** The ENTIRE competing-interests statement (verbatim) — Paper view renders this
   *  with no trimming, since the statement appears exactly once there. */
  fullText: string;
  /** Disclosure kinds parsed from the clause ("advisory_board", "grant", …); `[]`
   *  when none recognized. Humanize via `lib/coi-gap/mention.ts`. */
  relationshipKinds: ReadonlyArray<string>;
  /** Qualitative confidence ONLY: "high" === High tier, "low" === Medium tier
   *  (the lower-confidence bucket — collapsed + EXCLUDED from the primary counter
   *  per spec §2/§7). Never a percentage, never the numeric score. */
  confidence: "high" | "low";
  /** Review status of THIS mention's decision unit: `"current"` (not yet responded
   *  — i.e. the candidate row is still `new`) vs `"set_aside"` (responded — the row
   *  was `acknowledged`/`dismissed`). Mirrors the grouped active/Reviewed split at
   *  the mention grain. `resolved` rows are excluded entirely (the gap closed). */
  status: "current" | "set_aside";
  /** The recorded 3-way feedback reason for a set-aside mention, else null. */
  reason: FeedbackReason | null;
  /** The scholar's own action date as ISO `YYYY-MM-DD` for a set-aside mention,
   *  else null. Governance-allowed (the scholar's own action, not a verdict). */
  reviewedAt: string | null;
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
  pickable: ReadonlyArray<{
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    /** Global-or-per-scholar ReCiterAI impact (0–100), the same signal the AI
     *  ranking and the public profile use. Round at render (`Impact: NN`). 0 when
     *  unscored. Lets the picker sort by Impact and show it per row. */
    impact: number;
    /** Canonical publication-type string (e.g. "Academic Article", "Review") or
     *  null. Render through `displayPublicationType()` for the badge label. */
    publicationType: string | null;
  }>;
};

/** One sample grant on a RePORTER "Is this you?" card (recognition aid). Year-
 *  only — never an amount. Mirrors the ETL's persisted `sample_grants` JSON. */
export type EditContextReporterSampleGrant = {
  title: string;
  startYear: number | null;
  endYear: number | null;
};

/**
 * One PENDING RePORTER PMID-overlap "Is this you?" candidate (a K=2 suggestion),
 * surfaced ONLY to a genuine self viewer (or genuine superuser) behind
 * `REPORTER_MATCH_V2`. Populated only when `loadEditContext` is called with
 * `opts.includeReporterProfile === true`; empty for every other caller.
 *
 * GOVERNANCE (projection-starved, per the COI-gap + [[project_topic_score_is_internal]]
 * rule): the numeric overlap `overlapK` NEVER crosses to the client — the scholar
 * adjudicates from the grant titles, not a score. Only human-recognizable fields
 * cross.
 */
export type EditContextReporterProfileCandidate = {
  /** `ReporterProfileCandidate.id` — the confirm/reject route target. */
  candidateId: string;
  /** NIH eRA `profile_id` — display-stable key, not shown. */
  externalProfileId: number;
  /** PI name as it appears in RePORTER ("Karuna Ganesh"). */
  candidateName: string;
  /** Comma-joined grantee orgs — a recognition aid. */
  candidateOrgs: string;
  /** # net-new grants riding on this match (the card's headline count). */
  grantCount: number;
  /** Up to 3 sample grants for human recognition. */
  sampleGrants: ReadonlyArray<EditContextReporterSampleGrant>;
};

/**
 * One CONFIRMED RePORTER match in the "Confirmed matches" history (incl. system
 * auto-locks, labeled "matched automatically"). Self-revocable. Same starvation
 * (no `overlapK`).
 */
export type EditContextReporterProfileConfirmed = {
  candidateId: string;
  externalProfileId: number;
  candidateName: string;
  candidateOrgs: string;
  grantCount: number;
  sampleGrants: ReadonlyArray<EditContextReporterSampleGrant>;
  /** The confirm date (ISO `YYYY-MM-DD`), or null. Governance-allowed — it is the
   *  scholar's own action (or the system match), not a model verdict. */
  reviewedAt: string | null;
  /** true when `reviewedBy === "system-autolock"` → "matched automatically". */
  autolocked: boolean;
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
   *
   * HIGH-tier ACTIVE groups only (a group with any `new` source whose tier is
   * High). Pure-`Medium` active groups go to `unmatchedPubmedCoiLower`; fully
   * acted groups go to `unmatchedPubmedCoiReviewed`.
   */
  unmatchedPubmedCoi: ReadonlyArray<EditContextCoiGapCandidate>;
  /**
   * Pure-`Medium` ACTIVE COI-gap groups (any `new` source, but no `new` source
   * is High) — the lower-confidence bucket the card renders in a collapsed
   * expander. Same starved client shape as `unmatchedPubmedCoi`. Empty for every
   * non-self caller and when `includeCoiGap` is absent.
   */
  unmatchedPubmedCoiLower: ReadonlyArray<EditContextCoiGapCandidate>;
  /**
   * COI-gap groups where EVERY source has been acted on (no `new` source) —
   * settled history the card renders in a collapsed "Reviewed" section with
   * change-of-mind + undo. The scholar's own `reason` + `reviewedAt` cross here
   * (and ONLY here); score/status/attribution/category stay starved. Empty for
   * every non-self caller and when `includeCoiGap` is absent.
   */
  unmatchedPubmedCoiReviewed: ReadonlyArray<EditContextCoiGapReviewed>;
  /**
   * #1112 — the FLAT mention set (one paper × one matched org) the redesigned
   * review surface pivots into Organization OR Paper view entirely client-side
   * (spec §3/§9). Holds BOTH `current` (not-yet-responded) and `set_aside`
   * (responded) mentions, each marked `confidence: "high" | "low"` so the UI can
   * collapse the low-confidence (Medium) ones and exclude them from the primary
   * counter. Same governance starvation as the grouped arrays (no score/attribution
   * /category/raw status). Populated ONLY with `opts.includeCoiGap === true`
   * (behind `SELF_EDIT_COI_GAP_HINT`); empty for every other caller. `resolved`
   * candidates are excluded (the gap closed once the disclosure appeared).
   */
  unmatchedPubmedCoiMentions: ReadonlyArray<EditContextCoiGapMention>;
  /**
   * PENDING RePORTER PMID-overlap matches awaiting an "Is this you?" answer
   * (`REPORTER_MATCH_V2`). Populated only when `loadEditContext` is called with
   * `opts.includeReporterProfile === true` for a genuine self/superuser viewer;
   * empty for every other caller. Projection-starved (no `overlapK`).
   */
  reporterProfileCandidates: ReadonlyArray<EditContextReporterProfileCandidate>;
  /**
   * CONFIRMED RePORTER matches (incl. system auto-locks) — the revocable
   * "Confirmed matches" history. Same gate + starvation as
   * `reporterProfileCandidates`.
   */
  reporterProfileConfirmed: ReadonlyArray<EditContextReporterProfileConfirmed>;
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
  // #955 finding #5 — the `/edit` Mentees panel renders only name + hide-state,
  // never the co-pub count, so skip the per-mentee co-pub query (a cross-VPC
  // ReciterDB / bridge read) on every edit load. `class-year` gives a
  // deterministic order without the now-absent co-pub sort key.
  const { mentees } = await getMenteesForMentor(mentorCwid, {
    includeCopubs: false,
    sort: "class-year",
  });
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
/** Coerce the persisted `sample_grants` JSON (a `Prisma.JsonValue`) to the typed,
 *  starved card shape. Defensive — our own ETL writes it (`summarizeCandidateGrants`),
 *  but a Json column is `unknown` at the type level, so narrow rather than cast. */
function coerceReporterSampleGrants(value: unknown): EditContextReporterSampleGrant[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((g): g is Record<string, unknown> => typeof g === "object" && g !== null)
    .map((g) => ({
      title: typeof g.title === "string" ? g.title : "",
      startYear: typeof g.startYear === "number" ? g.startYear : null,
      endYear: typeof g.endYear === "number" ? g.endYear : null,
    }))
    .filter((g) => g.title.length > 0);
}

export async function loadEditContext(
  cwid: string,
  client: EditContextReadClient,
  now: Date = new Date(),
  loadMentees: LoadMentees = defaultLoadMentees,
  opts?: { includeCoiGap?: boolean; includeHighlights?: boolean; includeReporterProfile?: boolean },
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
      emailVisibility: true,
      orcid: true,
      overview: true,
      deletedAt: true,
      roleCategory: true,
    },
  });
  if (!scholar || scholar.deletedAt !== null) return null;

  const effectiveOverview = await getEffectiveOverview(cwid, scholar.overview, client);

  // #836 — only the manual-Highlights editor needs the ranking fields on the
  // authorship read (computed up here so the batched read below can widen its
  // `publication` select on the gated path; the common /edit load stays lean).
  const includeHighlights = opts?.includeHighlights === true;

  // --- Finding #4: batch the cwid-only, mutually-independent reads ---
  // Everything below depends ONLY on `cwid` / `now` / `includeHighlights` (all
  // already in scope) and NOT on any sibling's result, so they run concurrently
  // in one `Promise.all` instead of strictly sequentially. The reads that DO
  // consume a sibling stay staged AFTER this batch and remain sequential:
  //   - `effectiveOverview` already ran above (needs `scholar.overview`);
  //   - the entity-suppression scan keys on appointment/education/grant rows;
  //   - the mentee-suppression scan keys on `menteeRows`;
  //   - the COI-gap pub-date join keys on the gap rows' pmids;
  //   - `pubSuppressions` / `confirmedAuthors` / `buildHighlightsContext` key on
  //     the authorship pmid set.
  // `loadMentees` is the reporting-DB seam and BEST-EFFORT: its rejection is
  // caught inside the batch (warn + empty list) so a Promise.all rejection can
  // never 500 the page — preserving the existing try/catch contract. The
  // null/soft-deleted guard stays ABOVE the batch so a missing scholar still
  // returns `null` with zero follow-on queries.
  const [
    slugOverrideRow,
    scholarSuppressions,
    appointmentRows,
    educationRows,
    grantRows,
    coiRows,
    chairedDept,
    authorships,
    menteeRows,
    sectionOverrideRows,
  ] = await Promise.all([
    // Phase 7 — the slug-card baseline. `null` = no override; superuser slug card
    // shows the "no override" state. The self surface does not surface this field
    // (slug edits are superuser-only, `self-edit-spec.md` § Authorization).
    client.fieldOverride.findUnique({
      where: {
        entityType_entityId_fieldName: {
          entityType: "scholar",
          entityId: cwid,
          fieldName: "slug",
        },
      },
      select: { value: true },
    }),
    client.suppression.findMany({
      where: {
        entityType: "scholar",
        entityId: cwid,
        contributorCwid: null,
        revokedAt: null,
      },
      select: { id: true, reason: true, createdBy: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    // --- #160 UI follow-up: the three whole-entity attributes ---
    // Each panel lists exactly what the public profile renders, keyed on the
    // stable `externalId` (#352). Active appointments only — mirrors the profile
    // sidebar's default set (`endDate` null or in the future). The interim-drop /
    // single-visible-primary collapse the profile also applies are a display
    // refinement deferred here: a hidden interim row is a no-op against the
    // read-path anyway. Education and grants render in full on the profile.
    client.appointment.findMany({
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
    }),
    client.education.findMany({
      where: { cwid },
      select: { externalId: true, degree: true, institution: true, field: true, year: true },
      orderBy: [{ year: "desc" }],
    }),
    client.grant.findMany({
      where: { cwid },
      select: {
        externalId: true,
        title: true,
        role: true,
        funder: true,
        source: true,
        primeSponsor: true,
        primeSponsorRaw: true,
        startDate: true,
        endDate: true,
      },
      orderBy: [{ endDate: "desc" }, { startDate: "desc" }],
    }),
    // Conflicts of interest — read-only (the Weill Research Gateway is the SOR).
    // Same select shape + ordering the public profile uses (`lib/api/profile.ts`
    // `coiActivities`) so the /edit panel groups identically.
    client.coiActivity.findMany({
      where: { cwid },
      select: { entity: true, activityGroup: true },
      orderBy: [{ activityGroup: "asc" }, { entity: "asc" }],
    }),
    // Chair lock — a current chair appointment is not hideable (the route refuses
    // it 409 before authz, for the chair AND a superuser). Mirror that exact
    // predicate: the dept the scholar chairs (0–1 rows) + a per-appointment title
    // match (`isChairTitleFor`) — NOT a bare `chairCwid` existence check, which
    // would over-lock the chair's other (suppressible) appointments. Keep in
    // lockstep with `validators.isChairAppointment`.
    client.department.findFirst({
      where: { chairCwid: cwid },
      select: { name: true },
    }),
    // #836 — widen the `publication` select with the ranking fields
    // (publicationType / dateAddedToEntrez / impactScore / per-scholar score)
    // only when the Highlights editor is requested.
    client.publicationAuthor.findMany({
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
    }),
    // Mentees — suppressible, derived from training records (reporting DB) via the
    // injected `loadMentees` seam. BEST-EFFORT: a thrown error (reporting DB
    // unreachable) yields zero mentees rather than 500-ing the page, so the
    // rejection is caught HERE — inside the batch — to keep the surrounding
    // Promise.all from rejecting.
    loadMentees(cwid).catch((err) => {
      console.warn(
        JSON.stringify({
          event: "edit_context_mentees_unavailable",
          cwid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return [] as EditContextMenteeSource[];
    }),
    // section-visibility-spec — the per-scholar section-hide overrides currently
    // set to "true" (hidden). Drives the Visibility card's Sections panel; a
    // "false" row (or none) is "shown", so only "true" is read.
    client.fieldOverride.findMany({
      where: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: { in: [...SECTION_VISIBILITY_FIELDS] },
        value: "true",
      },
      select: { fieldName: true },
    }),
  ]);

  const slugOverride = slugOverrideRow?.value ?? null;
  const hiddenSections = sectionOverrideRows.map((r) => r.fieldName);

  // Defensive: multiple un-revoked rows of either kind shouldn't occur (the
  // suppress endpoint is idempotent — edge case 19), but a superuser row +
  // a self row coexisting is the documented edge case 4. Take the most recent
  // of each kind.
  const ownRow = scholarSuppressions.find((r) => r.createdBy === cwid) ?? null;
  const adminRow = scholarSuppressions.find((r) => r.createdBy !== cwid) ?? null;

  const coiDisclosures: EditContextCoiDisclosure[] = coiRows.map((c) => ({
    entity: c.entity,
    activityGroup: c.activityGroup,
  }));

  // Publication-derived COI-gap candidates (`SELF_EDIT_COI_GAP_HINT`) — SELF-
  // ONLY, and the opt-in IS the self guard: only the self page passes
  // `includeCoiGap: true`, and only for a genuine (non-impersonating) self
  // viewer with the flag on. Every other caller leaves `opts` unset, so the
  // query never runs and the arrays are empty — the candidates are never read
  // for a non-self viewer.
  //
  // THREE SURFACES, ONE QUERY. The query widens to the three reviewable
  // lifecycle states (`new`, `acknowledged`, `dismissed`; `resolved` excluded —
  // the gap closed itself once the disclosure appeared), and each normalized-
  // entity group is partitioned by whether it still has a `new` source:
  //   • ACTIVE (any `new` source) → `unmatchedPubmedCoi` when its active tier is
  //     High, else `unmatchedPubmedCoiLower` (pure-Medium). A group with a `new`
  //     source is ALWAYS active and NEVER appears in Reviewed, even if some of
  //     its other sources were already acted on — its acted sources are simply
  //     not shown again, so a relationship is never in two lists at once.
  //   • REVIEWED (every source acted) → `unmatchedPubmedCoiReviewed`: settled
  //     history the card renders read-only with change-of-mind + undo.
  //
  // HIGH TIER is still the only thing that NAGS. The active High bucket
  // (`unmatchedPubmedCoi`) drives the rail badge; `Medium` active rows are the
  // dominated-by-co-author-leakage bucket (a diagnostic recompute found ~92% of
  // surfaced candidates `unattributed`) and surface only in a collapsed,
  // muted, opt-in expander — never as a nag, never in the badge count.
  //
  // Mapped to the STARVED client shape — `normalizedEntity`, `attribution`,
  // `entityScore`, `category`, and the raw lifecycle `status` never cross to the
  // client. Two formerly-starved fields cross ONLY into Reviewed rows: the
  // scholar's own `feedbackReason` (as `reviewed.reason`, enabling the settled
  // label + change-of-mind) and `reviewedAt` (as `reviewed.reviewedAt`, the
  // scholar's own action date — governance-allowed because it is the scholar's
  // action, not a model verdict). They never reach an active row.
  const unmatchedPubmedCoi: EditContextCoiGapCandidate[] = [];
  const unmatchedPubmedCoiLower: EditContextCoiGapCandidate[] = [];
  const unmatchedPubmedCoiReviewed: EditContextCoiGapReviewed[] = [];
  // #1112 — the FLAT mention set the redesigned review surface pivots client-side.
  const unmatchedPubmedCoiMentions: EditContextCoiGapMention[] = [];

  if (opts?.includeCoiGap === true) {
    const gapRows = await client.coiGapCandidate.findMany({
      // The three reviewable states. `resolved` is excluded (the gap closed
      // itself once the disclosure appeared — nothing left to review). Per-group
      // partitioning below decides active (any `new`) vs reviewed (all acted).
      where: { cwid, status: { in: ["new", "acknowledged", "dismissed"] } },
      // `normalizedEntity` is the group (dedupe) key; it never reaches the
      // client. `status`, `feedbackReason`, `reviewedAt` are read server-side to
      // partition + (for Reviewed only) derive `reason`/`reviewedAt`.
      select: {
        id: true,
        pmid: true,
        entity: true,
        normalizedEntity: true,
        tier: true,
        sourceSentence: true,
        status: true,
        feedbackReason: true,
        reviewedAt: true,
        // #1112 per-mention subject attribution (null on pre-#1112 rows until the
        // next `etl:coi-gap` recompute backfills them — treated as "unknown").
        subjectType: true,
        subjectMention: true,
      },
      // Stable secondary order by id so the per-paper `unknown:#idx` decision-unit
      // index (see `subjectId`) is reproducible across reloads.
      orderBy: [{ entity: "asc" }, { id: "asc" }],
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
    // #1112 — the ENTIRE competing-interests statement per pmid, for Paper view's
    // verbatim `fullText` (the candidate row stores only the per-clause
    // `sourceSentence`). Keyed by pmid (one statement per publication). Falls back
    // to the clause's `sourceSentence` when no statement row exists.
    const statementRows =
      gapPmids.length > 0
        ? await client.publicationConflictStatement.findMany({
            where: { pmid: { in: gapPmids } },
            select: { pmid: true, statementText: true },
          })
        : [];
    const statementByPmid = new Map(statementRows.map((s) => [s.pmid, s.statementText]));

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
    // citing every source publication. Each source carries its own lifecycle
    // (`status`) and the scholar's recorded `feedbackReason`/`reviewedAt`, used
    // server-side to partition the group (active vs reviewed) and — for Reviewed
    // groups only — to derive the crossing `reason`/`reviewedAt`.
    type GapSrc = {
      id: string;
      pmid: string;
      sourceSentence: string;
      year: number | null;
      ts: number;
      entity: string;
      normalizedEntity: string;
      tier: "High" | "Medium";
      status: string;
      feedbackReason: string | null;
      reviewedAt: Date | null;
      // #1112 per-mention subject (null → "unknown" on pre-#1112 rows).
      subjectType: SubjectType;
      subjectMention: string | null;
    };
    const groups = new Map<string, { key: string; sources: GapSrc[] }>();
    for (const g of gapRows) {
      // The DB column is a free `VarChar(16)`; narrow to the rendered union and
      // treat any unexpected value as the more conservative "Medium" tier.
      const tier: "High" | "Medium" = g.tier === "High" ? "High" : "Medium";
      const d = dateByPmid.get(g.pmid) ?? { year: null, ts: 0 };
      // Narrow the free-text `subject_type` column to the union; any unexpected
      // value (incl. NULL on pre-#1112 rows) degrades to the honest "unknown" —
      // never guessed "self".
      const subjectType: SubjectType =
        g.subjectType === "self" ? "self" : g.subjectType === "coauthor" ? "coauthor" : "unknown";
      const src: GapSrc = {
        id: g.id,
        pmid: g.pmid,
        sourceSentence: g.sourceSentence,
        year: d.year,
        ts: d.ts,
        entity: g.entity,
        normalizedEntity: g.normalizedEntity,
        tier,
        status: g.status,
        feedbackReason: g.feedbackReason,
        reviewedAt: g.reviewedAt,
        subjectType,
        subjectMention: subjectType === "unknown" ? null : g.subjectMention,
      };
      const existing = groups.get(g.normalizedEntity);
      if (existing) {
        existing.sources.push(src);
      } else {
        groups.set(g.normalizedEntity, { key: g.normalizedEntity, sources: [src] });
      }
    }

    // Newest-first source comparator (pmid desc as a stable tiebreak) — shared by
    // every partition so SSR + the card's default sort agree.
    const newestFirst = (a: GapSrc, b: GapSrc) => b.ts - a.ts || b.pmid.localeCompare(a.pmid);
    const newestTsOf = (sources: GapSrc[]) => sources.reduce((m, s) => Math.max(m, s.ts), 0);
    // A row's derivable feedback reason: the explicit `feedbackReason`, else
    // `will_disclose` inferred from an `acknowledged` status (legacy rows recorded
    // intent before the reason column). `new`/null → undefined (no reason).
    const reasonOf = (s: GapSrc): FeedbackReason | undefined =>
      (s.feedbackReason as FeedbackReason | null) ??
      (s.status === "acknowledged" ? "will_disclose" : undefined);

    const toCandidate = (key: string, sources: GapSrc[]): EditContextCoiGapCandidate => {
      const sorted = [...sources].sort(newestFirst);
      return {
        key,
        entity: sorted[0].entity,
        tier: sorted.some((s) => s.tier === "High") ? "High" : "Medium",
        sources: sorted.map((s) => ({
          id: s.id,
          pmid: s.pmid,
          sourceSentence: s.sourceSentence,
          year: s.year,
        })),
        newestTs: newestTsOf(sorted),
      };
    };

    for (const grp of groups.values()) {
      const newSources = grp.sources.filter((s) => s.status === "new");
      if (newSources.length > 0) {
        // ACTIVE — show ONLY the still-`new` sources (acted siblings are not
        // re-shown). High active tier nags; pure-Medium drops to the expander.
        const candidate = toCandidate(grp.key, newSources);
        if (candidate.tier === "High") unmatchedPubmedCoi.push(candidate);
        else unmatchedPubmedCoiLower.push(candidate);
        continue;
      }
      // REVIEWED — every source acted; settled history. Reason = newest source
      // with a derivable reason; reviewedAt = newest non-null action date.
      const sorted = [...grp.sources].sort(newestFirst);
      const reason = sorted.map(reasonOf).find((r): r is FeedbackReason => r !== undefined);
      if (reason === undefined) continue; // legacy /dismiss rows with null reason — none while dark.
      const reviewedMs = grp.sources.reduce(
        (m, s) => (s.reviewedAt ? Math.max(m, s.reviewedAt.getTime()) : m),
        0,
      );
      if (reviewedMs === 0) continue; // all reviewedAt null (shouldn't happen for acted rows).
      unmatchedPubmedCoiReviewed.push({
        key: grp.key,
        entity: sorted[0].entity,
        tier: sorted.some((s) => s.tier === "High") ? "High" : "Medium",
        sources: sorted.map((s) => ({
          id: s.id,
          pmid: s.pmid,
          sourceSentence: s.sourceSentence,
          year: s.year,
        })),
        reason,
        reviewedAt: new Date(reviewedMs).toISOString().slice(0, 10),
        newestTs: newestTsOf(sorted),
      });
    }

    // Default SSR order for active lists = "Newest + confidence": High tier
    // first, newest within tier (entity asc as a final tiebreak). The card
    // re-sorts on the chosen mode, but this matches the default control so SSR
    // and hydration agree. The Lower list shares the comparator.
    const activeSort = (a: EditContextCoiGapCandidate, b: EditContextCoiGapCandidate) =>
      (a.tier === b.tier ? 0 : a.tier === "High" ? -1 : 1) ||
      b.newestTs - a.newestTs ||
      a.entity.localeCompare(b.entity);
    unmatchedPubmedCoi.sort(activeSort);
    unmatchedPubmedCoiLower.sort(activeSort);
    // Reviewed = most recently reviewed first (then newest source, then entity).
    unmatchedPubmedCoiReviewed.sort(
      (a, b) =>
        b.reviewedAt.localeCompare(a.reviewedAt) ||
        b.newestTs - a.newestTs ||
        a.entity.localeCompare(b.entity),
    );

    // #1112 — the FLAT mention set. One mention per candidate row (one paper × one
    // matched org), projected from the SAME `groups` the three grouped arrays were
    // built from — so a decision taken in either view (Org / Paper) reconciles to
    // the same persisted rows. Both `current` (still `new`) and `set_aside`
    // (`acknowledged`/`dismissed`) mentions cross; the UI partitions on `status`.
    //
    // `subjectId` is the per-paper decision-unit key. For `unknown` (and a
    // tokenless `coauthor`) the contract uses a STABLE per-paper index so two
    // unresolved subjects in one paper never merge — assigned here from the
    // candidates' deterministic fetch order (entity asc, id asc) within each pmid.
    const allSources: GapSrc[] = [];
    for (const grp of groups.values()) allSources.push(...grp.sources);
    // Deterministic order so the per-pmid index is reproducible across reloads.
    allSources.sort((a, b) => a.pmid.localeCompare(b.pmid) || a.entity.localeCompare(b.entity) || a.id.localeCompare(b.id));
    const indexableSeen = new Map<string, number>(); // `${pmid}::${id}` → assigned idx
    const indexCursor = new Map<string, number>(); // pmid → next index for an indexable subject
    const indexFor = (s: GapSrc): number => {
      const k = `${s.pmid}::${s.id}`;
      const prev = indexableSeen.get(k);
      if (prev !== undefined) return prev;
      const next = indexCursor.get(s.pmid) ?? 0;
      indexCursor.set(s.pmid, next + 1);
      indexableSeen.set(k, next);
      return next;
    };
    for (const s of allSources) {
      if (s.status === "resolved") continue; // defensive — query already excludes it
      // This surface is the scholar's OWN relationships only: a co-author's
      // disclosure that rode along in a shared paper's statement is not theirs to
      // act on, so it never crosses to the client. Keep `self` + `unknown`.
      if (s.subjectType === "coauthor") continue;
      const sid = deriveSubjectId(s.subjectType, s.subjectMention, indexFor(s));
      const acted = s.status === "acknowledged" || s.status === "dismissed";
      const reason = acted ? (reasonOf(s) ?? null) : null;
      const reviewedAt = acted && s.reviewedAt ? s.reviewedAt.toISOString().slice(0, 10) : null;
      unmatchedPubmedCoiMentions.push({
        candidateId: s.id,
        pmid: s.pmid,
        year: s.year,
        organization: s.normalizedEntity,
        organizationRaw: s.entity,
        subjectType: s.subjectType,
        subjectMention: s.subjectMention,
        subjectId: sid,
        // The candidate stores the trimmed clause as `sourceSentence` (see
        // `mentionMeta`/`analyzeStatement`), so Organization view uses it directly.
        clause: s.sourceSentence,
        // Paper view's verbatim statement — fall back to the clause if absent.
        fullText: statementByPmid.get(s.pmid) ?? s.sourceSentence,
        // Re-derived (pure) from the stored clause — `relationshipKinds` is not a
        // persisted column; the same cue parser the pipeline uses runs here.
        relationshipKinds: deriveRelationshipKinds(s.sourceSentence),
        confidence: s.tier === "High" ? "high" : "low",
        status: acted ? "set_aside" : "current",
        reason,
        reviewedAt,
      });
    }
    // Stable client order: high-confidence first, newest within, then pmid/org.
    unmatchedPubmedCoiMentions.sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
        (b.year ?? 0) - (a.year ?? 0) ||
        b.pmid.localeCompare(a.pmid) ||
        a.organization.localeCompare(b.organization),
    );
  }

  // RePORTER PMID-overlap "Is this you?" candidates (`REPORTER_MATCH_V2`) —
  // SELF-ONLY, and the opt-in IS the gate (same posture as COI-gap above): only
  // the self/superuser page passes `includeReporterProfile: true`, and only with
  // the flag on for a genuine (non-impersonating) viewer. One query over the two
  // reviewable states: `pending` → the confirm card, `confirmed` (incl. system
  // auto-locks) → the revocable "Confirmed matches" history. `rejected`/`revoked`
  // are terminal and never surfaced. PROJECTION-STARVED: `overlapK` is never
  // selected, so the numeric score cannot reach the client.
  const reporterProfileCandidates: EditContextReporterProfileCandidate[] = [];
  const reporterProfileConfirmed: EditContextReporterProfileConfirmed[] = [];
  if (opts?.includeReporterProfile === true) {
    const reporterRows = await client.reporterProfileCandidate.findMany({
      where: { cwid, status: { in: ["pending", "confirmed"] } },
      select: {
        id: true,
        externalProfileId: true,
        candidateName: true,
        candidateOrgs: true,
        grantCount: true,
        sampleGrants: true,
        status: true,
        reviewedBy: true,
        reviewedAt: true,
        // overlapK deliberately NOT selected (projection-starved).
      },
      orderBy: [{ grantCount: "desc" }, { firstSeenAt: "asc" }],
    });
    for (const r of reporterRows) {
      const sampleGrants = coerceReporterSampleGrants(r.sampleGrants);
      if (r.status === "pending") {
        reporterProfileCandidates.push({
          candidateId: r.id,
          externalProfileId: r.externalProfileId,
          candidateName: r.candidateName,
          candidateOrgs: r.candidateOrgs,
          grantCount: r.grantCount,
          sampleGrants,
        });
      } else {
        reporterProfileConfirmed.push({
          candidateId: r.id,
          externalProfileId: r.externalProfileId,
          candidateName: r.candidateName,
          candidateOrgs: r.candidateOrgs,
          grantCount: r.grantCount,
          sampleGrants,
          reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString().slice(0, 10) : null,
          autolocked: r.reviewedBy === "system-autolock",
        });
      }
    }
  }

  // Mentees — suppressible, derived from training records (reporting DB). The
  // raw `menteeRows` were fetched best-effort in the batch above (any failure
  // already degraded to `[]`). Each mentee's `externalId` is `{cwid}:{menteeCwid}`,
  // which is also the suppress entityId (owner = this mentor). The four-state
  // annotation reuses the same per-request suppression lookup pattern the
  // whole-entity panels use (`contributorCwid IS NULL`, `revokedAt IS NULL`).
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

  // Chair lock — `chairedDept` (the dept the scholar chairs, 0–1 rows) was
  // fetched in the batch above; combine it with a per-appointment title match
  // (`isChairTitleFor`) to lock ONLY a current chair appointment, in lockstep
  // with the route's 409 guard / `validators.isChairAppointment`.
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
      source: g.source,
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

  // #836 — `authorships` (widened with the ranking fields on the gated path) and
  // `includeHighlights` were both resolved above; derive the confirmed pmid set
  // here, which the per-author suppression / displayed-author / Highlights stages
  // below all key on.
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
        emailVisibility: scholar.emailVisibility,
        orcid: scholar.orcid,
        roleCategory: scholar.roleCategory,
        overview: effectiveOverview ?? "",
        slugOverride,
        hiddenSections,
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
      unmatchedPubmedCoiLower,
      unmatchedPubmedCoiReviewed,
      unmatchedPubmedCoiMentions,
      reporterProfileCandidates,
      reporterProfileConfirmed,
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
      emailVisibility: scholar.emailVisibility,
      orcid: scholar.orcid,
      roleCategory: scholar.roleCategory,
      overview: effectiveOverview ?? "",
      slugOverride,
      hiddenSections,
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
    unmatchedPubmedCoiLower,
    unmatchedPubmedCoiReviewed,
    unmatchedPubmedCoiMentions,
    reporterProfileCandidates,
    reporterProfileConfirmed,
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
  // reads top-to-bottom newest-first like the profile's publications list. Join
  // the per-pub impact + type already computed above in `rankable` (no extra DB
  // read) so the redesigned picker can sort by Impact and badge the pub type.
  const rankByPmid = new Map(rankable.map((r) => [r.pmid, r]));
  const pickable = publications
    .filter((p) => p.state === "shown")
    .map((p) => {
      const r = rankByPmid.get(p.pmid);
      return {
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        impact: r?.reciteraiImpact ?? 0,
        publicationType: r?.publicationType ?? null,
      };
    })
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  return {
    manualEnabled: manual !== null,
    manualPmids: manual ?? [],
    aiPmids,
    pickable,
  };
}
