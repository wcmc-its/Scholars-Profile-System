/**
 * `lib/api/publication-takedown-context.ts` — suppression-OFF read for the
 * superuser publication takedown surface (#356 Phase 7 C7).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { loadPublicationTakedownContext } from "@/lib/api/publication-takedown-context";

type AnyMock = ReturnType<typeof vi.fn>;
type FakeClient = {
  publication: { findUnique: AnyMock };
  publicationAuthor: { findMany: AnyMock };
  suppression: { findMany: AnyMock };
};
type Client = Parameters<typeof loadPublicationTakedownContext>[1];

const PMID = "12345";

function fakeClient(): FakeClient {
  return {
    publication: { findUnique: vi.fn() },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    suppression: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const asClient = (c: FakeClient) => c as unknown as Client;

function pubRow() {
  return {
    pmid: PMID,
    title: "A landmark study",
    journal: "Cell",
    year: 2024,
    doi: "10.1234/cell.2024.001",
  };
}

function wcmAuthor(opts: {
  cwid: string;
  preferredName: string;
  position: number;
  status?: "active" | "suppressed";
  deletedAt?: Date | null;
}) {
  return {
    cwid: opts.cwid,
    externalName: null,
    position: opts.position,
    scholar: {
      preferredName: opts.preferredName,
      status: opts.status ?? "active",
      deletedAt: opts.deletedAt ?? null,
    },
  };
}

function extAuthor(name: string, position: number) {
  return { cwid: null, externalName: name, position, scholar: null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPublicationTakedownContext — boundary", () => {
  it("returns null when the publication row does not exist", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(null);
    const ctx = await loadPublicationTakedownContext("missing", asClient(c));
    expect(ctx).toBeNull();
    // Author + suppression queries are skipped — short-circuit.
    expect(c.publicationAuthor.findMany).not.toHaveBeenCalled();
    expect(c.suppression.findMany).not.toHaveBeenCalled();
  });
});

describe("loadPublicationTakedownContext — visibility states", () => {
  it("no takedown, all WCM authors displayed → takedown:null, derivedDark:false", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({ cwid: "a", preferredName: "Author A", position: 1 }),
      wcmAuthor({ cwid: "b", preferredName: "Author B", position: 2 }),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.takedown).toBeNull();
    expect(ctx!.derivedDark).toBe(false);
    expect(ctx!.authors).toHaveLength(2);
    expect(ctx!.authors[0].isDisplayed).toBe(true);
    expect(ctx!.authors[1].isDisplayed).toBe(true);
  });

  it("whole-publication takedown row exists → takedown is populated, derivedDark:false", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({ cwid: "a", preferredName: "Author A", position: 1 }),
    ]);
    c.suppression.findMany.mockResolvedValue([
      {
        id: "sup-1",
        reason: "retraction notice",
        createdBy: "adm001",
        createdAt: new Date("2026-05-15"),
        contributorCwid: null,
      },
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.takedown).toEqual({
      id: "sup-1",
      reason: "retraction notice",
      actorCwid: "adm001",
      createdAt: new Date("2026-05-15"),
    });
    expect(ctx!.derivedDark).toBe(false);
  });

  it("derived dark: every WCM author is per-author-hidden, no whole-pub takedown", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({ cwid: "a", preferredName: "Author A", position: 1 }),
      wcmAuthor({ cwid: "b", preferredName: "Author B", position: 2 }),
    ]);
    c.suppression.findMany.mockResolvedValue([
      { id: "h1", reason: "", createdBy: "a", createdAt: new Date(), contributorCwid: "a" },
      { id: "h2", reason: "", createdBy: "b", createdAt: new Date(), contributorCwid: "b" },
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.takedown).toBeNull();
    expect(ctx!.derivedDark).toBe(true);
    expect(ctx!.authors.every((a) => a.isWcm && !a.isDisplayed)).toBe(true);
  });

  it("publication with only non-WCM authors is derived dark (no WCM authors at all)", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      extAuthor("Jane Outside", 1),
      extAuthor("Sam External", 2),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.derivedDark).toBe(true);
    // Non-WCM authors are "displayed" in the public author list (no per-author
    // hide mechanism for them) — the flag reflects render, not visibility-gating.
    expect(ctx!.authors[0].isDisplayed).toBe(true);
    expect(ctx!.authors[0].isWcm).toBe(false);
  });
});

describe("loadPublicationTakedownContext — author shape", () => {
  it("uses scholar.preferredName for WCM authors, externalName for non-WCM", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({ cwid: "wcm1", preferredName: "Jordan WCM", position: 1 }),
      extAuthor("Outside External", 2),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.authors[0]).toMatchObject({
      name: "Jordan WCM",
      cwid: "wcm1",
      isWcm: true,
      position: 1,
    });
    expect(ctx!.authors[1]).toMatchObject({
      name: "Outside External",
      cwid: null,
      isWcm: false,
      position: 2,
    });
  });

  it("a WCM author with a soft-deleted scholar row is not displayed", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({
        cwid: "wcm1",
        preferredName: "Jordan WCM",
        position: 1,
        deletedAt: new Date("2024-01-01"),
      }),
      wcmAuthor({ cwid: "wcm2", preferredName: "Other Wcm", position: 2 }),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.authors[0].isDisplayed).toBe(false);
    expect(ctx!.authors[1].isDisplayed).toBe(true);
    expect(ctx!.derivedDark).toBe(false);
  });

  it("a WCM author with suppressed status is not displayed", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({
        cwid: "wcm1",
        preferredName: "Jordan Suppressed",
        position: 1,
        status: "suppressed",
      }),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.authors[0].isDisplayed).toBe(false);
    expect(ctx!.derivedDark).toBe(true);
  });

  it("a soft-deleted WCM author still uses preferredName as the display label", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    c.publicationAuthor.findMany.mockResolvedValue([
      wcmAuthor({
        cwid: "wcm1",
        preferredName: "Jordan WCM",
        position: 1,
        deletedAt: new Date("2024-01-01"),
      }),
    ]);
    const ctx = await loadPublicationTakedownContext(PMID, asClient(c));
    expect(ctx!.authors[0].name).toBe("Jordan WCM");
  });
});

describe("loadPublicationTakedownContext — query shape", () => {
  it("queries suppression.findMany with the takedown-surface filter (entityType=publication, revokedAt:null)", async () => {
    const c = fakeClient();
    c.publication.findUnique.mockResolvedValue(pubRow());
    await loadPublicationTakedownContext(PMID, asClient(c));
    expect(c.suppression.findMany).toHaveBeenCalledTimes(1);
    const args = c.suppression.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      entityType: "publication",
      entityId: PMID,
      revokedAt: null,
    });
  });
});
