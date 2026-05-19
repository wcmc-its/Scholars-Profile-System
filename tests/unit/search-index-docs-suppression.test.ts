import { describe, expect, it } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPublicationDoc,
  type PublicationForIndex,
} from "@/lib/search-index-docs";

/**
 * Phase 4b C3 — publication-suppression integration in `buildPublicationDoc`.
 *
 * Asserts the suppression *delta* explicitly:
 *   - dark (whole-pub takedown OR derived-dark) → `null` (doc not emitted);
 *   - per-author hide → cwid absent from `wcmAuthors` / `wcmAuthorCwids`;
 *   - the derived-dark gate uses the CONFIRMED-WCM set, not the broader
 *     `wcmAuthorRows` chip membership (the §2.1 set-discrepancy code comment).
 *
 * The C2 no-suppression baseline (search-index-docs-golden.test.ts) is the
 * additivity check — those snapshots must NOT change as a result of C3.
 */

function makePub(
  pmid: string,
  authors: ReadonlyArray<{
    cwid: string;
    isConfirmed?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    position: number;
    totalAuthors: number;
  }>,
): PublicationForIndex {
  const p: Partial<PublicationForIndex> = {
    pmid,
    title: `Title ${pmid}`,
    journal: "J",
    year: 2024,
    publicationType: "Journal Article",
    citationCount: 0,
    dateAddedToEntrez: null,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    abstract: null,
    impactScore: null,
    impactJustification: null,
    meshTerms: [] as unknown as PublicationForIndex["meshTerms"],
    authors: authors.map((a) => ({
      pmid,
      cwid: a.cwid,
      externalName: null,
      isConfirmed: a.isConfirmed ?? true,
      isFirst: a.isFirst ?? false,
      isLast: a.isLast ?? false,
      isPenultimate: false,
      position: a.position,
      totalAuthors: a.totalAuthors,
      scholar: {
        cwid: a.cwid,
        slug: a.cwid,
        preferredName: a.cwid,
        deletedAt: null,
        status: "active",
      },
    })) as unknown as PublicationForIndex["authors"],
    publicationTopics: [],
  };
  return p as PublicationForIndex;
}

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

describe("buildPublicationDoc — suppression integration (C3)", () => {
  it("emits an unchanged doc when no suppressions exist (the additivity baseline)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const doc = buildPublicationDoc(p, NO_SUP);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["ann", "bob"]);
  });

  it("returns null for an explicit whole-publication takedown (dark)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, isLast: true, position: 1, totalAuthors: 1 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["1"]),
      hiddenAuthorsByPmid: new Map(),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("returns null when every confirmed WCM author has a per-author hide (derived-dark)", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann", "bob"])]]),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("drops a hidden cwid from wcmAuthors / wcmAuthorCwids when the pub stays displayed", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann"])]]),
    };
    const doc = buildPublicationDoc(p, sup);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["bob"]);
    const wcmAuthors = (doc as { wcmAuthors: Array<{ cwid: string }> }).wcmAuthors;
    expect(wcmAuthors.map((a) => a.cwid)).toEqual(["bob"]);
  });

  it("derived-dark uses the CONFIRMED WCM set, not the broader wcmAuthorRows membership", () => {
    // The §2.1 set-discrepancy code comment in buildPublicationDoc:
    // the derived-dark contract is `isConfirmed`-filtered; the chip contract
    // is not. An unconfirmed WCM author must NOT count against derived-dark.
    //
    // Setup: pmid has confirmed `ann` and unconfirmed `bob`. Ann hides.
    // Confirmed set = [ann]; ann hidden → derived-dark even though `bob` is
    // a "WCM author" in the broader chip sense.
    const p = makePub("1", [
      { cwid: "ann", isConfirmed: true, isFirst: true, position: 1, totalAuthors: 2 },
      { cwid: "bob", isConfirmed: false, isLast: true, position: 2, totalAuthors: 2 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["ann"])]]),
    };
    expect(buildPublicationDoc(p, sup)).toBeNull();
  });

  it("an unrelated pmid's suppression does not affect this pub", () => {
    const p = makePub("1", [
      { cwid: "ann", isFirst: true, isLast: true, position: 1, totalAuthors: 1 },
    ]);
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["999"]),
      hiddenAuthorsByPmid: new Map([["999", new Set(["other"])]]),
    };
    const doc = buildPublicationDoc(p, sup);
    expect(doc).not.toBeNull();
    expect((doc as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["ann"]);
  });
});
