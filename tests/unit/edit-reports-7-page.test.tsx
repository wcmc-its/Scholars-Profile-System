/**
 * `app/edit/reports/7/page.tsx` — the Mentored publications page's gate and
 * wiring. Mirrors `edit-reports-index-page-gap5.test.tsx`'s scaffold: the
 * page's collaborators are mocked at the module boundary and the returned
 * element tree is walked (no render). Protects: no session → SSO redirect;
 * an EMPTY scope set → `notFound()` (fail closed); a holder's scopes reach
 * the loader and default to the two most recent years (plus "unknown" when
 * the program has year-less learners), the choices being the SELECTED
 * program's; requested years the program has no class in are dropped; the
 * "Viewers" panel is rendered ONLY for superuser / comms_steward; a `program`
 * outside the caller's scopes silently falls back to their own "all"; the
 * view tabs carry every param; `pubs` is a select in the filter form and
 * reaches the loader and the download link (never `view`); the filter form
 * is the auto-submit island; the tables are the `MentoredPublicationsTable`
 * island and receive `view` / `summary` / `publications` / `pubsMode`; an
 * unloaded all-pubs bridge renders the notice, not the island; the PubMed-
 * only sentence names the dropped count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockGetReportScopes: vi.fn(),
  mockListReportAccess: vi.fn(),
  mockLoadGradYears: vi.fn(),
  mockLoadReport: vi.fn(),
  mockPanel: vi.fn(() => null),
  mockTable: vi.fn(() => null),
  mockAutoSubmitForm: vi.fn(({ children }: { children: React.ReactNode }) => children),
}));

vi.mock("next/navigation", () => ({ notFound: h.mockNotFound, redirect: h.mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockGetEditSession }));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return { ...actual, getReportScopes: h.mockGetReportScopes, listReportAccess: h.mockListReportAccess };
});
vi.mock("@/lib/edit/mentored-publications-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/mentored-publications-report")>();
  return { ...actual, loadMentoredGradYears: h.mockLoadGradYears, loadMentoredPublicationsReport: h.mockLoadReport };
});
vi.mock("@/components/edit/report-access-panel", () => ({ ReportAccessPanel: h.mockPanel }));
vi.mock("@/components/edit/mentored-publications-table", () => ({ MentoredPublicationsTable: h.mockTable }));
vi.mock("@/components/edit/auto-submit-form", () => ({ AutoSubmitForm: h.mockAutoSubmitForm }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import EditReportsMentoredPublicationsPage from "@/app/edit/reports/7/page";

const HOLDER = { cwid: "usr0001", isSuperuser: false, isCommsSteward: false };
const SUPERUSER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };
const sp = (q: Record<string, string> = {}) => Promise.resolve(q);

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;

/** The element's children — plus, for a plain (non-mock, hook-free) function
 *  component such as the page's own `FilterForm` / `ViewControls`, what it
 *  renders, so the walk reaches the links and inputs inside. `Link` and the
 *  mocked islands are not plain functions and stay opaque. */
function childrenOf(el: El): unknown[] {
  const children = el.props?.children;
  const list = Array.isArray(children) ? [...children] : [children];
  if (typeof el.type === "function" && !("mock" in el.type)) {
    const out = (el.type as (p: unknown) => unknown)(el.props);
    if (out && typeof out === "object" && !(out instanceof Promise)) list.push(out);
  }
  return list;
}

function findByType(node: unknown, type: unknown): El | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  const el = asEl(node);
  if (el.type === type) return el;
  for (const c of childrenOf(el)) {
    const found = findByType(c, type);
    if (found) return found;
  }
  return null;
}


/** Every string/number leaf under `node`, joined — what a user would read. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return "";
  return childrenOf(asEl(node)).map(textOf).join("");
}

function findByTestId(node: unknown, testId: string): El | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  const el = asEl(node);
  if (el.props?.["data-testid"] === testId) return el;
  for (const c of childrenOf(el)) {
    const found = findByTestId(c, testId);
    if (found) return found;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockGetEditSession.mockResolvedValue(HOLDER);
  h.mockGetReportScopes.mockResolvedValue(new Set(["md"]));
  h.mockListReportAccess.mockResolvedValue([]);
  h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024]);
  h.mockLoadReport.mockImplementation(
    async (args: { scopes: string[]; gradYears: number[] | null; tail: number; pubs: "mentored" | "all" }) => ({
      summary: [],
      detail: [],
      publications: [],
      generatedAt: new Date("2026-09-18T00:00:00Z"),
      filters: { ...args },
      allPubsLoaded: args.pubs === "all" ? true : null,
    }),
  );
});

const MENTORED = { pubs: "mentored" } as const;

describe("/edit/reports/7 — gate", () => {
  it("no session → SSO login with the return path", async () => {
    h.mockGetEditSession.mockResolvedValue(null);
    await expect(EditReportsMentoredPublicationsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/reports/7",
    );
  });

  it("an empty scope set → notFound(), before any data is read", async () => {
    h.mockGetReportScopes.mockResolvedValue(new Set());
    await expect(EditReportsMentoredPublicationsPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockLoadReport).not.toHaveBeenCalled();
    expect(h.mockLoadGradYears).not.toHaveBeenCalled();
  });
});

describe("/edit/reports/7 — wiring", () => {
  it("a holder: loader gets their scopes and the two most recent years; no Viewers panel", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2026, 2025], tail: 1, ...MENTORED });
    expect(findByType(result, h.mockPanel)).toBeNull();
    expect(h.mockListReportAccess).not.toHaveBeenCalled();
    const download = findByTestId(result, "mentored-pubs-download");
    expect(download?.props.href).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025&program=all&tail=1&pubs=mentored",
    );
  });

  it("a program outside the holder's scopes falls back to their own 'all' — never widens", async () => {
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ program: "mdphd", years: "2025", tail: "2" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2025], tail: 2, ...MENTORED });
  });

  it("malformed params fall back to the defaults instead of erroring", async () => {
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "nope", tail: "9" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2026, 2025], tail: 1, ...MENTORED });
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ pubs: "everything", view: "raw" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("year-less learners in scope: the default adds 'unknown' and the form offers the checkbox, checked", async () => {
    h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024, null]);
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      gradYears: [2026, 2025, null],
      tail: 1,
      ...MENTORED,
    });
    const boxes: Array<[string, boolean]> = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk); // the mapped checkbox list
      const el = asEl(node);
      if (el.type === "input" && el.props.type === "checkbox") boxes.push([String(el.props.value), !!el.props.defaultChecked]);
      for (const c of childrenOf(el)) walk(c);
    };
    walk(findByType(result, h.mockAutoSubmitForm));
    expect(boxes).toEqual([
      ["2026", true],
      ["2025", true],
      ["2024", false],
      ["unknown", true],
      ["all", false],
    ]);
    expect(textOf(findByType(result, h.mockAutoSubmitForm))).toContain("Unknown grad year");
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025%2Cunknown&program=all&tail=1&pubs=mentored",
    );
  });

  it("requested years the program has no class in are dropped; nothing left → the default", async () => {
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "2018" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2026, 2025], tail: 1, ...MENTORED });
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "2024,2018" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({ scopes: ["md"], gradYears: [2024], tail: 1, ...MENTORED });
    // years=all is never "empty".
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "all" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({ scopes: ["md"], gradYears: null, tail: 1, ...MENTORED });
  });

  it("the filter form is the auto-submit island, carrying the view as a hidden field and the set as a select", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2025", pubs: "all", view: "publications" }),
    });
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(form).not.toBeNull();
    expect(form!.props["data-testid"]).toBe("mentored-pubs-filters");
    expect(form!.props.action).toBe("/edit/reports/7");
    const hidden: Array<[string, string]> = [];
    const selects: Array<[string, string]> = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      const el = asEl(node);
      if (el.type === "input" && el.props.type === "hidden") hidden.push([String(el.props.name), String(el.props.value)]);
      if (el.type === "select") selects.push([String(el.props.name), String(el.props.defaultValue)]);
      for (const c of childrenOf(el)) walk(c);
    };
    walk(form);
    expect(hidden).toEqual([["view", "publications"]]);
    expect(selects).toContainEqual(["pubs", "all"]);
    expect(findByTestId(form, "mentored-pubs-set")?.props.name).toBe("pubs");
  });

  it("view tabs keep every param; the download carries pubs but never view", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2025", tail: "2", pubs: "all", view: "publications" }),
    });
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2025], tail: 2, pubs: "all" });
    const base = "years=2025&program=all&tail=2";
    expect(findByTestId(result, "mentored-pubs-view-summary")?.props.href).toBe(`/edit/reports/7?${base}&pubs=all`);
    expect(findByTestId(result, "mentored-pubs-view-publications")?.props.href).toBe(
      `/edit/reports/7?${base}&pubs=all&view=publications`,
    );
    expect(findByTestId(result, "mentored-pubs-view-publications")?.props["aria-current"]).toBe("page");
    expect(findByTestId(result, "mentored-pubs-set-all")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      `/api/edit/reports/mentored-publications?${base}&pubs=all`,
    );
    // The island gets the view; the notice is absent.
    expect(findByType(result, h.mockTable)?.props).toMatchObject({ view: "publications", pubsMode: "all" });
    expect(findByTestId(result, "mentored-pubs-all-missing")).toBeNull();
  });


  it("with data: the island receives view / summary / publications / pubsMode; the description names the four sources and the dropped counts", async () => {
    const summaryRow = {
      gradYear: 2025, entryYear: 2021, entryYearSource: "bridge", cwid: "stu0001",
      firstName: "Ada", lastName: "Learner", program: "MD",
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorship: { program: "md", source: "roster", tier: "confirmed" } }],
      pubsInWindow: 1, withMentorInWindow: 1, pubsAllTime: 1, highImpactInWindow: 0, firstAuthorInWindow: 1,
    };
    const pub = {
      pmid: 12345678, title: "A paper", journal: "J Test", year: 2024, citation: "Learner A, Mentor G. A paper. J Test. 2024.",
      jif: 3.2, citations: 4, dateAdded: null, authorCount: 2,
      learners: [{ cwid: "stu0001", firstName: "Ada", lastName: "Learner", firstAuthor: true, authorPosition: 1, inWindow: true }],
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorships: [{ program: "md", source: "roster", tier: "confirmed" }] }],
      withMentor: true,
    };
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [summaryRow], detail: [], publications: [pub],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
      droppedNonPubmed: 0, droppedUnresolved: 0,
    }));

    const summary = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(findByType(summary, h.mockTable)?.props).toEqual({
      view: "summary",
      summary: [summaryRow],
      publications: [pub],
      pubsMode: "mentored",
      highImpactThreshold: 10,
    });
    expect(textOf(summary)).toContain(
      "Pairs come from the AOC roster, Jenzabar thesis-advisor records, ED postdoc appointments, and co-authorship patterns (presumptive — unchecked by default).",
    );
    expect(textOf(summary)).toContain(
      "PubMed-indexed publications only; Scopus-only co-publications are excluded when the bridge is imported.",
    );

    const pubs = await EditReportsMentoredPublicationsPage({ searchParams: sp({ view: "publications" }) });
    expect(findByType(pubs, h.mockTable)?.props).toMatchObject({ view: "publications", publications: [pub] });

    // Suggestion-evidence pubs the loader dropped are folded into the PubMed-only sentence.
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [summaryRow], detail: [], publications: [pub],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
      droppedNonPubmed: 3, droppedUnresolved: 1,
    }));
    const dropped = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(textOf(dropped)).toContain(
      "excluded when the bridge is imported (co-publications not shown: 3 non-PubMed, 1 not yet in the local corpus).",
    );
  });

  it("all mode with an unloaded bridge renders the notice and no table", async () => {
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [
        {
          gradYear: 2025,
          entryYear: 2021,
          entryYearSource: "bridge",
          cwid: "stu0001",
          firstName: "Ada",
          lastName: "Learner",
          program: "MD",
          mentors: [],
          pubsInWindow: 0,
          withMentorInWindow: 0,
          pubsAllTime: 0,
          highImpactInWindow: 0,
          firstAuthorInWindow: 0,
        },
      ],
      detail: [],
      publications: [],
      generatedAt: new Date("2026-09-18T00:00:00Z"),
      filters: { ...args },
      allPubsLoaded: false,
    }));
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ pubs: "all" }) });
    expect(findByTestId(result, "mentored-pubs-all-missing")).not.toBeNull();
    expect(findByType(result, h.mockTable)).toBeNull();
  });

  it("a superuser: the chosen program's scope reaches BOTH loaders, and the Viewers panel renders with the current rows", async () => {
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    h.mockListReportAccess.mockResolvedValue([
      {
        reportKey: "mentored-publications",
        scopeKey: "md",
        cwid: "usr0001",
        grantedBy: "adm0001",
        grantedAt: new Date("2026-09-18T12:00:00Z"),
      },
    ]);
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ program: "ecr" }) });
    // Year choices come from ECR's classes, not every held scope.
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["ecr"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["ecr"], gradYears: [2026, 2025], tail: 1, ...MENTORED });
    const panel = findByType(result, h.mockPanel);
    expect(panel).not.toBeNull();
    expect(panel!.props.reportKey).toBe("mentored-publications");
    expect(panel!.props.initialRows).toEqual([
      expect.objectContaining({ cwid: "usr0001", scopeKey: "md", grantedAt: "2026-09-18T12:00:00.000Z" }),
    ]);
    expect((panel!.props.scopeOptions as Array<[string, string]>).map(([k]) => k)).toEqual(["*", "md", "mdphd", "ecr"]);
  });
});
