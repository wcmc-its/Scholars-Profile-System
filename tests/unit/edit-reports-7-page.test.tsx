/**
 * `app/edit/reports/7/page.tsx` — the Mentored publications page's gate and
 * wiring. Mirrors `edit-reports-index-page-gap5.test.tsx`'s scaffold: the
 * page's collaborators are mocked at the module boundary and the returned
 * element tree is walked (no render). Protects: no session → SSO redirect;
 * an EMPTY scope set → `notFound()` (fail closed); a holder's scopes reach
 * the loader and default to the two most recent years; the "Viewers" panel
 * is rendered ONLY for superuser / comms_steward; a `program` outside the
 * caller's scopes silently falls back to their own "all"; the view tabs and
 * the publication-set toggle carry every param; `pubs` reaches the loader and
 * the download link (never `view`); the filter form is the auto-submit
 * island; an unloaded all-pubs bridge renders the notice, not a table.
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

  it("the filter form is the auto-submit island, carrying the current view/set as hidden fields", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2025", pubs: "all", view: "publications" }),
    });
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(form).not.toBeNull();
    expect(form!.props["data-testid"]).toBe("mentored-pubs-filters");
    expect(form!.props.action).toBe("/edit/reports/7");
    const hidden: Array<[string, string]> = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      const el = asEl(node);
      if (el.type === "input" && el.props.type === "hidden") hidden.push([String(el.props.name), String(el.props.value)]);
      for (const c of childrenOf(el)) walk(c);
    };
    walk(form);
    expect(hidden).toEqual([
      ["view", "publications"],
      ["pubs", "all"],
    ]);
  });

  it("view tabs and the set toggle keep every param; the download carries pubs but never view", async () => {
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
    expect(findByTestId(result, "mentored-pubs-set-mentored")?.props.href).toBe(
      `/edit/reports/7?${base}&pubs=mentored&view=publications`,
    );
    expect(findByTestId(result, "mentored-pubs-set-all")?.props.href).toBe(
      `/edit/reports/7?${base}&pubs=all&view=publications`,
    );
    expect(findByTestId(result, "mentored-pubs-set-all")?.props["aria-pressed"]).toBe(true);
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      `/api/edit/reports/mentored-publications?${base}&pubs=all`,
    );
    // Publications view renders its table (empty state here), not the summary.
    expect(findByTestId(result, "mentored-pubs-summary")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-all-missing")).toBeNull();
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
    expect(findByTestId(result, "mentored-pubs-summary")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-learner-stu0001")).toBeNull();
  });

  it("a superuser: '*' reaches the loader, and the Viewers panel renders with the current rows", async () => {
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
