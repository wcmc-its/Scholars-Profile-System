/**
 * `app/edit/core/[coreId]/review/page.tsx` authorization gates (cores-as-org-units
 * P3/P4 restructure — the pub review queue split out of the core editor).
 *
 * Mirrors `center-history-page.test.tsx`'s shape: signed-out → SAML redirect,
 * no-role + core exists → 403 + logged denial, core absent → 404, authorized →
 * loads the queue and renders it. `authorizeCoreClaim`/`getCoreOwnerRole` are
 * the real (pure/injectable) functions from `lib/edit/authz` — only the DB
 * surface, session, and `loadCoreReviewQueue` are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Type-only, so the runtime mocks below are untouched: it is what makes the
// QUEUE fixture a REAL queue and stops `mockLoadPaperCounts` from accepting a
// counts row that has drifted out of shape (round-3 G6 — a fixture missing the
// required `total` type-checked only because the mock was a bare `vi.fn()`).
import type { CoreQueueRow, CoreReviewQueue } from "@/lib/api/core-queue";
import type { loadCoreClientPaperCounts } from "@/lib/api/core-clients";

const {
  mockGetEditSession,
  mockRedirect,
  mockNotFound,
  mockCoreFindUnique,
  mockUnitAdminFindUnique,
  mockLoadQueue,
  mockLogAuthzDenied,
  mockForbidden,
  mockQueueComponent,
  mockLoadClients,
  mockLoadPaperCounts,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockCoreFindUnique: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockLoadQueue: vi.fn(),
  mockLogAuthzDenied: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockQueueComponent: vi.fn(() => null),
  // "Known clients" (ReciterAI #383 / SPS #2607) — this page also loads the
  // core's active client list alongside the queue; stubbed out here since
  // this file is purely about the authorization gates above it.
  mockLoadClients: vi.fn(),
  mockLoadPaperCounts: vi.fn<typeof loadCoreClientPaperCounts>(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/core-queue", () => ({ loadCoreReviewQueue: mockLoadQueue }));
vi.mock("@/lib/api/core-clients", () => ({
  loadCoreClients: mockLoadClients,
  loadCoreClientPaperCounts: mockLoadPaperCounts,
}));
vi.mock("@/lib/auth/authz-events", () => ({ logAuthzDenied: mockLogAuthzDenied }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: {},
  },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/core-claim-queue", () => ({ CoreClaimQueue: mockQueueComponent }));

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import EditCoreReviewPage from "@/app/edit/core/[coreId]/review/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const params = (coreId: string) => Promise.resolve({ coreId });

/** Depth-first search of a returned element tree for the first node whose
 *  `type` matches — React.createElement never CALLS a component in these
 *  server-component tests, it just records `{ type, props }`, so finding the
 *  mocked `CoreClaimQueue` means walking `props.children`, not spying on a call. */
function findByType(node: unknown, type: unknown): El | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const el = asEl(node);
  if (el.type === type) return el;
  return findByType(el.props?.children, type);
}

/** A WCM byline author, the only part of a queue row this page reads. */
const author = (cwid: string) => ({ cwid, name: cwid.toUpperCase(), slug: null, dept: null });

/** A queue row as `loadCoreReviewQueue` builds one. Typed, not a partial cast:
 *  the page unions `wcmAuthors` across all three lists into the paper-counts
 *  query, so the field it reads must not be free to drift. */
function row(pmid: string, wcmAuthors: CoreQueueRow["wcmAuthors"]): CoreQueueRow {
  return {
    pmid,
    title: `Paper ${pmid}`,
    journal: null,
    journalAbbrev: null,
    year: 2021,
    dateAddedToEntrez: null,
    authorsString: null,
    fullAuthorsString: null,
    synopsis: null,
    likelihood: 0.5,
    status: "candidate",
    coauthors: [],
    coauthorScholars: [],
    wcmAuthors,
    signalAck: false,
    ackAlias: null,
    ackSnippet: null,
    llmScore: null,
    llmRationale: null,
    authorAffinity: null,
    topicalPrior: null,
    methodTier: null,
    methodEvidence: [],
    citationCount: 0,
    pubmedUrl: null,
    doi: null,
    claimed: false,
    isManual: false,
    relativeCitationRatio: null,
    nihPercentile: null,
  };
}

const QUEUE: CoreReviewQueue = {
  // Both staff counts travel on `core` (etl/dynamodb Block 6b ->
  // loadCoreReviewQueue); null is the common case — the engine has published
  // no counts for this core.
  core: { id: "2", name: "Biomedical Imaging", staffCount: null, staffTrackedCount: null },
  // POPULATED, one row per list, each carrying WCM byline authors. Three empty
  // arrays is what made the paper-counts assertion below vacuous (round-3 G6):
  // the page's byline-author union folds over these three lists, so with them
  // empty the union is `[]` whether the page spreads them in or not — and the
  // whole "name the repeat user" feature could be deleted with this file green.
  candidates: [row("1", [author("cand01"), author("cand02")])],
  confirmed: [row("2", [author("conf01"), author("sab2028")])],
  rejected: [row("3", [author("rej01")])],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadQueue.mockResolvedValue(QUEUE);
  mockLoadClients.mockResolvedValue([]);
  mockLoadPaperCounts.mockResolvedValue({});
});

describe("/edit/core/[coreId]/review — authorization", () => {
  it("signed-out → SAML redirect with ?return=…/review, no queue load", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("2") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/core/2/review",
    );
    expect(mockUnitAdminFindUnique).not.toHaveBeenCalled();
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("no role + core exists → ForbiddenEditPage + logged denial, no queue load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "non001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue(null);
    mockCoreFindUnique.mockResolvedValue({ id: "2" });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    // The denial branch is now wrapped in the same reduced-chrome shell (bare
    // div + ConsoleTopBar) the success path already uses, so ForbiddenEditPage
    // is nested rather than the return value itself — walk the tree like the
    // success-path assertion below does.
    const forbidden = findByType(result, mockForbidden);
    expect(forbidden).toBeTruthy();
    expect(forbidden!.props.targetEntity).toBe("2");
    expect(mockLogAuthzDenied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_core_owner", target_entity_id: "2" }),
    );
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("no role + core absent → 404, no queue load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "non001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue(null);
    mockCoreFindUnique.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("nope") })).rejects.toThrow("__NOTFOUND__");
    expect(mockLogAuthzDenied).not.toHaveBeenCalled();
    expect(mockLoadQueue).not.toHaveBeenCalled();
  });

  it("owner/curator/superuser → loads the queue, renders CoreClaimQueue", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    expect(mockLoadQueue).toHaveBeenCalledWith("2", expect.anything());
    const queueEl = findByType(result, mockQueueComponent);
    expect(queueEl).toBeTruthy();
    expect(queueEl!.props).toMatchObject({
      core: QUEUE.core,
      candidates: QUEUE.candidates,
      confirmed: QUEUE.confirmed,
      rejected: QUEUE.rejected,
    });
  });

  it("loads client paper counts over the CONFIRMED list, this core's client CWIDs AND every WCM byline author, and passes them down", async () => {
    // The wiring, not the fold: `paperCounts` cannot be derived in the component
    // (row.wcmAuthors is capped at 12), so if the page stops passing it the
    // evidence line silently loses "18 papers, 11 recent" with nothing failing.
    //
    // The second half of the union is the load-bearing one and the reason this
    // test asserts the WHOLE array rather than a `containing`: the repeat-user
    // line has to NAME someone, and the only defensible name is a person whose
    // confirmed count was computed here. Drop the byline spread from page.tsx
    // and the counts map goes from 246 keys to 1 on staging core 14, taking the
    // named "Repeat user" line off 2,183 of 2,267 candidate rows in silence.
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    mockLoadClients.mockResolvedValue([
      { id: "r1", cwid: "sab2028", name: "S B", slug: null, affiliation: null, addedByName: null, addedAt: new Date(), addedBy: "rev01" },
      // A name-only client has no cwid and must not reach the counts query.
      { id: "r2", cwid: null, name: "Ada", slug: null, affiliation: null, addedByName: null, addedAt: new Date(), addedBy: "rev01" },
    ]);
    mockLoadPaperCounts.mockResolvedValue({ sab2028: { papers: 18, recent: 11, total: 29 } });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    expect(mockLoadPaperCounts).toHaveBeenCalledWith(
      QUEUE.confirmed,
      // Roster CWIDs first, then the byline authors of candidates, confirmed and
      // rejected in that order. Raw, NOT de-duped — sab2028 is both a listed
      // client and a byline author here and appears twice on purpose: the loader
      // lowercases and de-dupes, so paying for a second pass in the page would
      // buy nothing.
      ["sab2028", "cand01", "cand02", "conf01", "sab2028", "rej01"],
      expect.anything(),
    );
    const queueEl = findByType(result, mockQueueComponent);
    expect(queueEl!.props.paperCounts).toEqual({
      sab2028: { papers: 18, recent: 11, total: 29 },
    });
  });

  it("passes the byline authors even when the core has no listed clients at all", async () => {
    // The roster is empty on a core that has never used the client panel, and
    // that is exactly when the byline union is the only source of names — so it
    // gets its own case rather than riding on the roster one above.
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    mockLoadClients.mockResolvedValue([]);
    await EditCoreReviewPage({ params: params("2") });
    expect(mockLoadPaperCounts).toHaveBeenCalledWith(
      QUEUE.confirmed,
      ["cand01", "cand02", "conf01", "sab2028", "rej01"],
      expect.anything(),
    );
  });

  it("queue absent (core row gone between the authz check and the load) → 404", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "sup001", isSuperuser: true });
    mockLoadQueue.mockResolvedValue(null);
    await expect(EditCoreReviewPage({ params: params("2") })).rejects.toThrow("__NOTFOUND__");
  });

  // dwd2001 nav fix: this page has no AdminSubnav, so the top bar must carry
  // the account menu itself (ConsoleTopBar's showAccountMenu) — same pattern
  // as ScholarHistoryView / CenterHistoryView.
  it("owner/curator/superuser → the top bar carries the account menu itself (no AdminSubnav on this page)", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false });
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const result = asEl(await EditCoreReviewPage({ params: params("2") }));
    const topBar = findByType(result, ConsoleTopBar);
    expect(topBar).toBeTruthy();
    expect(topBar!.props.showAccountMenu).toBe(true);
  });
});
