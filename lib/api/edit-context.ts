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
import { getEffectiveOverview } from "@/lib/api/manual-layer";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { isFundingActive } from "@/lib/funding-active";
import { isChairTitleFor } from "@/lib/leadership";
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
>;

export type EditContextScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  /** Sourced read-only identity fields echoed in the Name & Title panel
   *  (vision-round T3.5). `primaryTitle` is a concatenated degree string
   *  ("MD, MPH"), labelled "Degrees" in the UI — not a job title. All nullable. */
  primaryTitle: string | null;
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
  /** UI-SPEC § Card 3 row-state table. */
  state: "shown" | "hidden_by_self" | "removed_by_admin";
  /** The active self-applied suppression's id when `state === 'hidden_by_self'`, else null. Wires the "Show" button. */
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

export type EditContext = {
  scholar: EditContextScholar;
  publications: ReadonlyArray<EditContextPublication>;
  appointments: ReadonlyArray<EditContextAppointment>;
  educations: ReadonlyArray<EditContextEducation>;
  grants: ReadonlyArray<EditContextGrant>;
};

/**
 * Load the full `/edit` page context for one scholar.
 *
 * Returns `null` when no scholar row exists for `cwid`, or when the row is
 * soft-deleted (`deletedAt` set). A suppressed scholar (self or admin) returns
 * normally — the page reads suppression-OFF.
 */
export async function loadEditContext(
  cwid: string,
  client: EditContextReadClient,
  now: Date = new Date(),
): Promise<EditContext | null> {
  const scholar = await client.scholar.findUnique({
    where: { cwid },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      primaryTitle: true,
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

  const authorships = await client.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: {
      publication: {
        select: { pmid: true, title: true, journal: true, year: true },
      },
    },
  });
  const pmids = authorships.map((a) => a.publication.pmid);

  const publications: EditContextPublication[] = [];
  if (pmids.length === 0) {
    return {
      scholar: {
        cwid: scholar.cwid,
        slug: scholar.slug,
        preferredName: scholar.preferredName,
        fullName: scholar.fullName,
        primaryTitle: scholar.primaryTitle,
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
    };
  }

  // Active publication suppressions for the bounded pmid set — one query
  // covering whole-pub takedowns and per-author hides (own + others').
  const pubSuppressions = await client.suppression.findMany({
    where: {
      entityType: "publication",
      entityId: { in: pmids },
      revokedAt: null,
    },
    select: { id: true, entityId: true, contributorCwid: true },
  });
  const darkPmids = new Set<string>();
  // pmid → suppressionId for THIS scholar's per-author hide on it. The "Show"
  // button on a hidden_by_self row revokes by id.
  const selfHideIdByPmid = new Map<string, string>();
  // pmid → set of cwids with an active per-author hide on it. Used to compute
  // the displayed-author set for `isSoleDisplayedAuthor`.
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
        selfHideIdByPmid.set(row.entityId, row.id);
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
    } else if (selfHideIdByPmid.has(pmid)) {
      state = "hidden_by_self";
      suppressionId = selfHideIdByPmid.get(pmid) ?? null;
    } else {
      state = "shown";
    }
    // Sole-displayed-author check is only meaningful when the row is shown —
    // it gates the confirm dialog before a hide. For a hidden_by_self or
    // removed_by_admin row, no Hide click is reachable, so always false.
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

  return {
    scholar: {
      cwid: scholar.cwid,
      slug: scholar.slug,
      preferredName: scholar.preferredName,
      fullName: scholar.fullName,
      primaryTitle: scholar.primaryTitle,
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
  };
}
