/**
 * #1511 — reciter change detection. publicationSignature must flag every real
 * content change (and never a representational-only one), and
 * planAuthorshipReconcile must touch only genuine (pmid,cwid) deltas so
 * unchanged rows keep their lastRefreshedAt (the coi-gap watermark fix).
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  publicationSignature,
  planAuthorshipReconcile,
  type PublicationComparable,
  type ExistingAuthorship,
  type IncomingAuthorship,
} from "@/etl/reciter/change-detection";

const basePub = (over: Partial<PublicationComparable> = {}): PublicationComparable => ({
  title: "A paper",
  authorsString: "Smith J, Doe A",
  fullAuthorsString: "Smith John, Doe Alice",
  journal: "Nature",
  year: 2020,
  publicationType: "Academic Article",
  citationCount: 5,
  relativeCitationRatio: null,
  nihPercentile: null,
  citedByCount: null,
  dateAddedToEntrez: new Date("2020-01-15T00:00:00Z"),
  doi: "10.1/x",
  pmcid: null,
  volume: "12",
  issue: "3",
  pages: "1-10",
  journalAbbrev: "Nature",
  pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/1/",
  ecommonsLink: null,
  abstract: "Some abstract",
  meshTerms: [{ ui: "D1", label: "Term" }],
  source: "ReciterDB",
  ...over,
});

describe("publicationSignature", () => {
  it("is stable for identical content", () => {
    expect(publicationSignature(basePub())).toBe(publicationSignature(basePub()));
  });

  it("changes when a real field changes", () => {
    expect(publicationSignature(basePub())).not.toBe(
      publicationSignature(basePub({ citationCount: 6 })),
    );
    expect(publicationSignature(basePub())).not.toBe(
      publicationSignature(basePub({ abstract: "different" })),
    );
    // #1567 — a pub GAINING an eCommons handle must read as changed, or the
    // nightly upsert would skip it and never persist the linkout.
    expect(publicationSignature(basePub({ ecommonsLink: null }))).not.toBe(
      publicationSignature(
        basePub({ ecommonsLink: "https://hdl.handle.net/1813/124348" }),
      ),
    );
  });

  it("distinguishes null from empty string and whitespace (no sentinel collision)", () => {
    expect(publicationSignature(basePub({ abstract: null }))).not.toBe(
      publicationSignature(basePub({ abstract: "" })),
    );
    expect(publicationSignature(basePub({ abstract: null }))).not.toBe(
      publicationSignature(basePub({ abstract: " " })),
    );
  });

  it("treats a Prisma.Decimal and an equal number as unchanged", () => {
    expect(
      publicationSignature(basePub({ relativeCitationRatio: new Prisma.Decimal("1.23") })),
    ).toBe(publicationSignature(basePub({ relativeCitationRatio: 1.23 })));
  });

  it("ignores a time component the DATE column cannot store", () => {
    expect(
      publicationSignature(basePub({ dateAddedToEntrez: new Date("2020-01-15T00:00:00Z") })),
    ).toBe(
      publicationSignature(basePub({ dateAddedToEntrez: new Date("2020-01-15T09:30:00Z") })),
    );
  });

  it("treats meshTerms DbNull and null as equal, but detects a reordered array", () => {
    expect(publicationSignature(basePub({ meshTerms: Prisma.DbNull }))).toBe(
      publicationSignature(basePub({ meshTerms: null })),
    );
    expect(
      publicationSignature(basePub({ meshTerms: [{ ui: "D1" }, { ui: "D2" }] })),
    ).not.toBe(publicationSignature(basePub({ meshTerms: [{ ui: "D2" }, { ui: "D1" }] })));
  });
});

const ea = (
  id: string,
  pmid: string,
  cwid: string | null,
  over: Partial<ExistingAuthorship> = {},
): ExistingAuthorship => ({
  id,
  pmid,
  cwid,
  position: 1,
  totalAuthors: 3,
  isFirst: true,
  isLast: false,
  isPenultimate: false,
  isConfirmed: true,
  ...over,
});
const ia = (
  pmid: string,
  cwid: string,
  over: Partial<IncomingAuthorship> = {},
): IncomingAuthorship => ({
  pmid,
  cwid,
  position: 1,
  totalAuthors: 3,
  isFirst: true,
  isLast: false,
  isPenultimate: false,
  isConfirmed: true,
  ...over,
});

describe("planAuthorshipReconcile", () => {
  it("creates new, updates changed, leaves unchanged, deletes stale", () => {
    const existing = [
      ea("id-unchanged", "1", "a"),
      ea("id-changed", "1", "b", { position: 2, isFirst: false }),
      ea("id-stale", "1", "c"),
    ];
    const incoming = [
      ia("1", "a"), // unchanged
      ia("1", "b", { position: 5, isFirst: false }), // position 2 -> 5
      ia("1", "d"), // new
    ];
    const plan = planAuthorshipReconcile(existing, incoming);
    expect(plan.toCreate.map((r) => r.cwid)).toEqual(["d"]);
    expect(plan.toUpdate.map((u) => u.id)).toEqual(["id-changed"]);
    expect(plan.toDeleteIds).toEqual(["id-stale"]);
    expect(plan.unchanged).toBe(1);
  });

  it("prunes a cwid=NULL existing row (no incoming can match)", () => {
    const plan = planAuthorshipReconcile([ea("id-null", "1", null)], [ia("1", "a")]);
    expect(plan.toDeleteIds).toEqual(["id-null"]);
    expect(plan.toCreate.map((r) => r.cwid)).toEqual(["a"]);
  });

  it("prunes a duplicate existing (pmid,cwid), keeping the first as canonical", () => {
    const plan = planAuthorshipReconcile(
      [ea("id-1", "1", "a"), ea("id-dup", "1", "a")],
      [ia("1", "a")],
    );
    expect(plan.toDeleteIds).toEqual(["id-dup"]);
    expect(plan.unchanged).toBe(1);
  });

  // The coi-gap watermark invariant, stated directly: on a steady-state nightly
  // (the common case — incoming byte-identical to existing across several pmids),
  // the plan must emit ZERO writes. The caller relies on exactly this to `continue`
  // past the timestamp-bumping transaction (etl/reciter/index.ts), leaving every
  // lastRefreshedAt untouched so etl/coi-gap's `lastRefreshedAt > watermark` scan
  // stays bounded to the genuine delta. The pre-#1535 wipe-and-reinsert would have
  // deleted all three rows and re-created them (re-stamping every timestamp), so it
  // could never satisfy this — this asserts the fix, not just per-row diffing.
  it("emits no writes for a fully-unchanged batch (watermark preserved)", () => {
    const existing = [ea("id-a", "1", "a"), ea("id-b", "1", "b"), ea("id-c", "2", "a")];
    const incoming = [ia("1", "a"), ia("1", "b"), ia("2", "a")];
    const plan = planAuthorshipReconcile(existing, incoming);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDeleteIds).toEqual([]);
    expect(plan.unchanged).toBe(3);
  });
});
