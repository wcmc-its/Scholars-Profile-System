/**
 * Self-edit v1 — suppression-OFF read for the `/edit/publication/[pmid]`
 * superuser takedown surface (#356 Phase 7 C7, UI-SPEC § `/edit/publication/[pmid]`,
 * SPEC § Surfaces).
 *
 * Loads the publication-summary card data (title, journal, year, DOI; author
 * list with WCM markings + displayed-state per author) AND the active
 * whole-publication takedown (if any), in one server function. Suppression-OFF
 * because the page must show a removed publication so a superuser can restore
 * it.
 *
 * `derivedDark` is the UI-SPEC third visibility state: a publication with
 * **no explicit takedown** but **zero displayed WCM authors** (every WCM
 * author is per-author-hidden). The publication is invisible on the site by
 * ADR-005's derived rule, even though no whole-pub takedown was issued. The
 * UI surfaces this as an informational `Alert` (UI-SPEC § Card 2 row 3).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface `loadPublicationTakedownContext` needs. */
type PublicationTakedownReadClient = Pick<
  PrismaClient,
  "publication" | "publicationAuthor" | "suppression"
>;

export type TakedownAuthor = {
  /** A human-readable author label — preferred name for WCM, external string otherwise. */
  name: string;
  /** `null` for a non-WCM (string-only) author. */
  cwid: string | null;
  /** Whether this is a Weill Cornell scholar (i.e. has a cwid + a scholar row). */
  isWcm: boolean;
  /**
   * Whether this author is currently rendered on the public publication
   * (WCM + active scholar + not per-author-hidden). Non-WCM authors are
   * always "displayed" in the public author list — they have no per-author
   * suppression mechanism.
   */
  isDisplayed: boolean;
  /** Author position (1-based) — for stable display order. */
  position: number;
};

export type PublicationTakedown = {
  id: string;
  reason: string;
  actorCwid: string;
  createdAt: Date;
};

export type PublicationTakedownContext = {
  publication: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    doi: string | null;
  };
  authors: ReadonlyArray<TakedownAuthor>;
  /** The active whole-publication suppression (if any) — drives Card 2 row 2. */
  takedown: PublicationTakedown | null;
  /** No takedown, zero displayed WCM authors → UI-SPEC Card 2 row 3 (derived dark). */
  derivedDark: boolean;
};

/**
 * Load the takedown-page context for `pmid`. Returns `null` when the
 * publication row does not exist; the page handler renders `notFound()`.
 *
 * Reads suppression-OFF so a removed publication is still visible to the
 * superuser for restoration. Three queries: one `publication.findUnique`,
 * one `publicationAuthor.findMany` with the `scholar` join, one
 * `suppression.findMany` over the bounded pmid.
 */
export async function loadPublicationTakedownContext(
  pmid: string,
  client: PublicationTakedownReadClient,
): Promise<PublicationTakedownContext | null> {
  const pub = await client.publication.findUnique({
    where: { pmid },
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      doi: true,
    },
  });
  if (!pub) return null;

  // Authors with their scholar join — for the WCM flag and the displayed-state
  // calculation. Confirmed authorships only (matches edit-context.ts).
  const authorRows = await client.publicationAuthor.findMany({
    where: { pmid, isConfirmed: true },
    select: {
      cwid: true,
      externalName: true,
      position: true,
      scholar: { select: { preferredName: true, status: true, deletedAt: true } },
    },
    orderBy: { position: "asc" },
  });

  // Active publication suppressions — both whole-pub takedowns (contributor=null)
  // and per-author hides (contributor != null).
  const pubSuppressions = await client.suppression.findMany({
    where: { entityType: "publication", entityId: pmid, revokedAt: null },
    select: {
      id: true,
      reason: true,
      createdBy: true,
      createdAt: true,
      contributorCwid: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const wholePubRow = pubSuppressions.find((r) => r.contributorCwid === null);
  const takedown: PublicationTakedown | null = wholePubRow
    ? {
        id: wholePubRow.id,
        reason: wholePubRow.reason,
        actorCwid: wholePubRow.createdBy,
        createdAt: wholePubRow.createdAt,
      }
    : null;
  const perAuthorHidden = new Set<string>();
  for (const row of pubSuppressions) {
    if (row.contributorCwid !== null) perAuthorHidden.add(row.contributorCwid);
  }

  let displayedWcmCount = 0;
  const authors: TakedownAuthor[] = authorRows.map((row) => {
    const isWcm = row.cwid !== null && row.scholar !== null;
    const cwid = row.cwid;
    let name: string;
    if (isWcm && row.scholar) name = row.scholar.preferredName;
    else name = row.externalName ?? "Unknown author";

    // Displayed = WCM + active scholar + not per-author-hidden. Non-WCM
    // authors are always displayed in the public author list but they do
    // not gate the publication's visibility (only WCM scholars do).
    const isDisplayed = (() => {
      if (!isWcm || !row.scholar || cwid === null) return false;
      if (row.scholar.status !== "active" || row.scholar.deletedAt !== null) return false;
      if (perAuthorHidden.has(cwid)) return false;
      return true;
    })();
    if (isDisplayed) displayedWcmCount += 1;

    return {
      name,
      cwid,
      isWcm,
      // For non-WCM authors, `isDisplayed` carries the public render answer
      // (non-WCM = always shown in the author list). For WCM authors it
      // reflects active + not per-author-hidden as computed above.
      isDisplayed: isWcm ? isDisplayed : true,
      position: row.position,
    };
  });

  const derivedDark = takedown === null && displayedWcmCount === 0;

  return {
    publication: {
      pmid: pub.pmid,
      title: pub.title,
      journal: pub.journal,
      year: pub.year,
      doi: pub.doi,
    },
    authors,
    takedown,
    derivedDark,
  };
}
