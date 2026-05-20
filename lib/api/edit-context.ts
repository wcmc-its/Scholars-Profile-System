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
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface `loadEditContext` needs — a client or tx satisfies it. */
type EditContextReadClient = Pick<
  PrismaClient,
  "scholar" | "suppression" | "publicationAuthor" | "fieldOverride"
>;

export type EditContextScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  /** The effective bio — `field_override(overview) ?? scholar.overview`, sanitized. Empty string = "no overview". */
  overview: string;
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

export type EditContext = {
  scholar: EditContextScholar;
  publications: ReadonlyArray<EditContextPublication>;
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
): Promise<EditContext | null> {
  const scholar = await client.scholar.findUnique({
    where: { cwid },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      fullName: true,
      overview: true,
      deletedAt: true,
    },
  });
  if (!scholar || scholar.deletedAt !== null) return null;

  const effectiveOverview = await getEffectiveOverview(cwid, scholar.overview, client);

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
        overview: effectiveOverview ?? "",
        suppression: {
          ownRow: ownRow ? { id: ownRow.id, reason: ownRow.reason } : null,
          adminRow: adminRow
            ? { id: adminRow.id, reason: adminRow.reason, createdAt: adminRow.createdAt }
            : null,
        },
      },
      publications,
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
      overview: effectiveOverview ?? "",
      suppression: {
        ownRow: ownRow ? { id: ownRow.id, reason: ownRow.reason } : null,
        adminRow: adminRow
          ? { id: adminRow.id, reason: adminRow.reason, createdAt: adminRow.createdAt }
          : null,
      },
    },
    publications,
  };
}
