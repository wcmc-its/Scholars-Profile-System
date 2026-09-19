/**
 * `app/edit/reports/7/page.tsx` — the Mentored publications page's gate and
 * wiring. Mirrors `edit-reports-index-page-gap5.test.tsx`'s scaffold: the
 * page's collaborators are mocked at the module boundary and the returned
 * element tree is walked (no render). Protects: no session → SSO redirect;
 * an EMPTY scope set → `notFound()` (fail closed); a holder's scopes reach
 * the loader and default to the two most recent years (plus "unknown" when
 * the selection has year-less learners), the choices being the SELECTED
 * types'; requested years the selection has no class in are dropped; the
 * "Viewers" panel is rendered ONLY for superuser / comms_steward; "Type of
 * mentorship" is a checkbox group (no Program select): a holder is offered
 * only the roster types they hold, the default is their roster type(s) — a
 * superuser's every confirmed type — co-author inferences never; a roster
 * type outside the caller's scopes is silently dropped, never widened; the
 * view tabs carry every param; `pubs` is a select in the filter form and
 * reaches the loader and the download link (never `view`); the filter form
 * is the auto-submit island; the tables are the `MentoredPublicationsTable`
 * island and receive `view` / `summary` / `publications` / `pubsMode`; an
 * unloaded all-pubs bridge renders the notice, not the island; the PubMed-
 * only sentence names the dropped count; the description and the closed
 * "Sources" disclosure speak the office's words (AOC, pairing sheet; the
 * Faculty Review Tool named as not yet a source) and the Viewers panel's
 * `md` scope reads "AOC". `HoverTooltip` is mocked to its children — the
 * walker calls plain function components, and Radix's provider uses hooks.
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
  mockHoverTooltip: vi.fn(({ children }: { children: React.ReactNode }) => children),
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
vi.mock("@/components/ui/hover-tooltip", () => ({
  HoverTooltip: h.mockHoverTooltip,
}));
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
    async (args: {
      scopes: string[];
      types: string[];
      gradYears: number[] | null;
      tail: number;
      pubs: "mentored" | "all";
    }) => ({
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
const AOC = { types: ["aoc"] } as const;

/** Every `<input type="checkbox">` in `node` as `[name, value, checked]`. */
function checkboxes(node: unknown): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk); // the mapped checkbox lists
    const el = asEl(n);
    if (el.type === "input" && el.props.type === "checkbox") {
      out.push([String(el.props.name), String(el.props.value), !!el.props.defaultChecked]);
    }
    for (const c of childrenOf(el)) walk(c);
  };
  walk(node);
  return out;
}

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
  it("a holder: loader gets their scopes, their roster type and the two most recent years; the download carries types; no Viewers panel", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md"], ["aoc"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    expect(findByType(result, h.mockPanel)).toBeNull();
    expect(h.mockListReportAccess).not.toHaveBeenCalled();
    expect(findByType(result, h.mockTable)?.props.downloadHref).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025&types=aoc&tail=1&pubs=mentored",
    );
  });

  it("Type of mentorship: an md holder sees AOC (checked) and the four non-roster types, never MD-PhD / ECR; no Program select", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(checkboxes(form).filter(([name]) => name === "types")).toEqual([
      ["types", "aoc", true],
      ["types", "thesis", false],
      ["types", "postdoc", false],
      ["types", "likely", false],
      ["types", "possible", false],
    ]);
    const text = textOf(form);
    expect(text).toContain("Type of mentorship");
    expect(text).toContain("AOC");
    expect(text).toContain("Likely mentee (from co-authorship)");
    expect(text).not.toContain("All programs");
    // Each label hovers its plain-language description — the text, never the input.
    const hovers: Array<{ text: string; wide?: boolean; children: El }> = [];
    const collect = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(collect);
      const el = asEl(node);
      if (el.type === h.mockHoverTooltip) hovers.push(el.props as (typeof hovers)[number]);
      for (const c of childrenOf(el)) collect(c);
    };
    collect(form);
    expect(hovers.every((p) => p.wide === true && p.children.type === "span")).toBe(true);
    expect(hovers.map((p) => p.text)).toEqual([
      "Pairs recorded by the Areas of Concentration program (the MD scholarly-concentration program) in its pairing sheet.",
      "Thesis-advisor pairs from the Graduate School's Jenzabar records (MAJSP). Conferral year known; start year not.",
      expect.stringContaining("reporting manager from the ED appointment record"),
      expect.stringContaining("Not on any roster"),
      expect.stringContaining("research staff or MD alumni"),
    ]);
    const selects: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      const el = asEl(node);
      if (el.type === "select") selects.push(String(el.props.name));
      for (const c of childrenOf(el)) walk(c);
    };
    walk(form);
    expect(selects).toEqual(["pubs", "tail"]);
  });

  it("requested types reach both loaders and the links; a roster type outside the holder's scopes is dropped — never widens; nothing left → the default", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ types: "likely,aoc", years: "2025", tail: "2" }),
    });
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md"], ["aoc", "likely"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      types: ["aoc", "likely"],
      gradYears: [2025],
      tail: 2,
      ...MENTORED,
    });
    expect(checkboxes(findByType(result, h.mockAutoSubmitForm)).filter(([, , on]) => on)).toEqual([
      ["types", "aoc", true],
      ["types", "likely", true],
      ["years", "2025", true],
    ]);
    expect(findByType(result, h.mockTable)?.props.downloadHref).toBe(
      "/api/edit/reports/mentored-publications?years=2025&types=aoc%2Clikely&tail=2&pubs=mentored",
    );

    await EditReportsMentoredPublicationsPage({
      searchParams: sp({ types: "mdphd,thesis", years: "2025" }),
    });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      types: ["thesis"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    await EditReportsMentoredPublicationsPage({
      searchParams: sp({ types: "mdphd", years: "2025" }),
    });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    // A legacy program=<scope> link reads as that roster type.
    await EditReportsMentoredPublicationsPage({
      searchParams: sp({ program: "md", years: "2025" }),
    });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("malformed params fall back to the defaults instead of erroring", async () => {
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "nope", tail: "9" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    await EditReportsMentoredPublicationsPage({
      searchParams: sp({ pubs: "everything", view: "raw", types: "nope" }),
    });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
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
      ...AOC,
      gradYears: [2026, 2025, null],
      tail: 1,
      ...MENTORED,
    });
    expect(
      checkboxes(findByType(result, h.mockAutoSubmitForm)).filter(([name]) => name === "years"),
    ).toEqual([
      ["years", "2026", true],
      ["years", "2025", true],
      ["years", "2024", false],
      ["years", "unknown", true],
      ["years", "all", false],
    ]);
    expect(textOf(findByType(result, h.mockAutoSubmitForm))).toContain("Unknown grad year");
    expect(findByType(result, h.mockTable)?.props.downloadHref).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025%2Cunknown&types=aoc&tail=1&pubs=mentored",
    );
  });

  it("requested years the selection has no class in are dropped; nothing left → the default", async () => {
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "2018" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "2024,2018" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2024],
      tail: 1,
      ...MENTORED,
    });
    // years=all is never "empty".
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "all" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: null,
      tail: 1,
      ...MENTORED,
    });
  });

  it("the filter form is the auto-submit island (id'd for the island's hidden view input), carrying the set as a select", async () => {
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
    expect(hidden).toEqual([]);
    expect(form!.props.id).toBe("mentored-pubs-filters");
    expect(selects).toContainEqual(["pubs", "all"]);
    expect(findByTestId(form, "mentored-pubs-set")?.props.name).toBe("pubs");
  });

  it("view tabs keep every param; the download carries pubs but never view", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2025", tail: "2", pubs: "all", view: "publications" }),
    });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2025],
      tail: 2,
      pubs: "all",
    });
    const base = "years=2025&types=aoc&tail=2";
    // The island owns the tabs and the download link; it gets every href
    // with the other params kept, and the download carries pubs but never view.
    expect(findByType(result, h.mockTable)?.props).toMatchObject({
      view: "publications",
      pubsMode: "all",
      viewHrefs: {
        summary: `/edit/reports/7?${base}&pubs=all`,
        publications: `/edit/reports/7?${base}&pubs=all&view=publications`,
      },
      downloadHref: `/api/edit/reports/mentored-publications?${base}&pubs=all`,
    });
    expect(findByTestId(result, "mentored-pubs-set-all")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-all-missing")).toBeNull();
  });


  it("with data: the island receives view / summary / publications / pubsMode; the description names the five sources and the dropped counts", async () => {
    const summaryRow = {
      gradYear: 2025, entryYear: 2021, entryYearSource: "bridge", cwid: "stu0001",
      firstName: "Ada", lastName: "Learner", program: "AOC",
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorship: { program: "md", source: "roster", tier: "confirmed" } }],
      pubsInWindow: 1, withMentorInWindow: 1, pubsAllTime: 1, highImpactInWindow: 0, firstAuthorInWindow: 1,
    };
    const pub = {
      pmid: "12345678", title: "A paper", journal: "J Test", year: 2024, citation: "Learner A, Mentor G. A paper. J Test. 2024.",
      jif: 3.2, citations: 4, dateAdded: null, authorCount: 2,
      learners: [{ cwid: "stu0001", firstName: "Ada", lastName: "Learner", firstAuthor: true, authorPosition: 1, inWindow: true }],
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorships: [{ program: "md", source: "roster", tier: "confirmed" }] }],
      withMentor: true,
    };
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [summaryRow], detail: [], publications: [pub],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
      droppedUnresolved: 0,
    }));

    const summary = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(findByType(summary, h.mockTable)?.props).toEqual({
      view: "summary",
      viewHrefs: {
        summary: "/edit/reports/7?years=2026%2C2025&types=aoc&tail=1&pubs=mentored",
        publications:
          "/edit/reports/7?years=2026%2C2025&types=aoc&tail=1&pubs=mentored&view=publications",
      },
      downloadHref:
        "/api/edit/reports/mentored-publications?years=2026%2C2025&types=aoc&tail=1&pubs=mentored",
      summary: [summaryRow],
      publications: [pub],
      pubsMode: "mentored",
      highImpactThreshold: 10,
    });
    expect(textOf(summary)).toContain(
      "Pairs come from the AOC pairing sheet, the MD-PhD program office, Jenzabar thesis-advisor records, ED postdoc appointments, and co-authorship inferences (off by default) — see Sources below.",
    );
    expect(textOf(summary)).toContain("an AOC learner with no entry year on the pairing sheet");
    expect(textOf(summary)).not.toContain("MD-program");
    expect(textOf(summary)).not.toContain("presumptive");
    expect(textOf(summary)).not.toContain("PubMed-indexed publications only");
    expect(textOf(summary)).not.toContain("not yet in the local corpus");

    const pubs = await EditReportsMentoredPublicationsPage({ searchParams: sp({ view: "publications" }) });
    expect(findByType(pubs, h.mockTable)?.props).toMatchObject({ view: "publications", publications: [pub] });

    // Suggestion-evidence pubs with no local row yet get one sentence.
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [summaryRow], detail: [], publications: [pub],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
      droppedUnresolved: 1,
    }));
    const dropped = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(textOf(dropped)).toContain(
      "is assumed to have entered four years before graduating. 1 co-publications not yet in the local corpus are not shown.",
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
          program: "AOC",
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

  it("a superuser: every type offered, the confirmed ones checked by default, co-author inferences unchecked", async () => {
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(
      checkboxes(findByType(result, h.mockAutoSubmitForm)).filter(([name]) => name === "types"),
    ).toEqual([
      ["types", "aoc", true],
      ["types", "mdphd", true],
      ["types", "ecr", true],
      ["types", "thesis", true],
      ["types", "postdoc", true],
      ["types", "likely", false],
      ["types", "possible", false],
    ]);
    const confirmed = ["aoc", "mdphd", "ecr", "thesis", "postdoc"];
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["*"], confirmed);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["*"],
      types: confirmed,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("a superuser: the chosen types reach BOTH loaders with the '*' scope, and the Viewers panel renders with the current rows", async () => {
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
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ types: "ecr" }),
    });
    // Year choices come from ECR's classes, not every selectable type.
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["*"], ["ecr"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["*"],
      types: ["ecr"],
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    const panel = findByType(result, h.mockPanel);
    expect(panel).not.toBeNull();
    expect(panel!.props.reportKey).toBe("mentored-publications");
    expect(panel!.props.initialRows).toEqual([
      expect.objectContaining({ cwid: "usr0001", scopeKey: "md", grantedAt: "2026-09-18T12:00:00.000Z" }),
    ]);
    expect(panel!.props.scopeOptions).toEqual([
      ["*", "All programs"],
      ["md", "AOC"],
      ["mdphd", "MD-PhD"],
      ["ecr", "ECR"],
    ]);
  });

  it("Sources: a closed disclosure under the description, one entry per type in filter order, ending with the Faculty Review Tool as not yet a source", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    const sources = findByTestId(result, "mentored-pubs-sources");
    expect(sources).not.toBeNull();
    expect(sources!.type).toBe("details");
    expect(sources!.props.open).toBeUndefined();
    const text = textOf(sources);
    expect(text.startsWith("Sources")).toBe(true);
    for (const label of [
      "AOC",
      "MD-PhD (program office)",
      "ECR",
      "PhD / MD-PhD thesis advisor",
      "Postdoc supervisor",
      "Likely mentee (from co-authorship)",
      "Possible mentee (from co-authorship)",
    ]) {
      expect(text).toContain(label);
    }
    // The date facts the one-sentence descriptions lack.
    expect(text).toContain("Carries the graduation year and, for recent classes, the entry year.");
    expect(text).toContain("No entry or graduation years yet.");
    expect(text).toContain("Conferral year known; start year not.");
    expect(text).toContain("Carries the appointment start and end dates.");
    expect(text).not.toContain("presumptive");
    const frt = findByTestId(result, "mentored-pubs-sources-frt");
    expect(textOf(frt)).toBe(
      "Not yet a source: the Faculty Review Tool’s self-reported mentees — the mentoring extract from that system has not been provided.",
    );
  });
});
