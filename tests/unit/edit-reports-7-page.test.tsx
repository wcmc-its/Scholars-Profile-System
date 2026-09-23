/**
 * `app/edit/reports/[report]/page.tsx` at the `mentored-publications` slug
 * (report 7, the registry's one person-gated entry) — the Mentored
 * publications page's gate and wiring. Mirrors
 * `edit-reports-index-page-gap5.test.tsx`'s scaffold: the page's
 * collaborators are mocked at the module boundary and the returned element
 * tree is walked (no render). `report_meta` is an empty table
 * (`reportMeta.findMany` on the db mock), so the slug resolves through the
 * real `loadReportMeta` default and every in-page href is built on it.
 * Protects: no session → SSO redirect;
 * an EMPTY scope set → `notFound()` (fail closed); a holder's scopes reach
 * the loader and default to the two most recent years (plus "unknown" when
 * the selection has year-less learners), the choices being the SELECTED
 * types'; requested years the selection has no class in are dropped; the
 * "Who can run this report" popover (`ReportAccessPopover`, mocked to a
 * marker) is `ReportHeader`'s `access` for EVERY viewer, with the grant
 * rows (`listReportAccess` read for a plain holder too) and the shared
 * scope options — `canManage` false for a holder, true for a superuser;
 * "Type of mentorship" is a checkbox group (no Program select): a holder is offered
 * only the roster types they hold, the default is their roster type(s) — a
 * superuser's every confirmed type — co-author inferences never; a roster
 * type outside the caller's scopes is silently dropped, never widened; the
 * view tabs carry every param; `pubs` is a select in the filter form and
 * reaches the loader and the download link (never `view`); the filter form
 * is the auto-submit island; the tables are the `MentoredPublicationsTable`
 * island and receive `view` / `summary` / `publications` / `pubsMode`; an
 * unloaded all-pubs bridge renders the notice, not the island; the PubMed-
 * only sentence names the dropped count; the description speaks the
 * office's words (AOC, pairing sheet) and points at the "About this report"
 * disclosure (the former hardcoded "Sources" disclosure is gone — the h1 and
 * the disclosure are `ReportHeader`'s, over `report_meta`) and the
 * popover's `md` scope reads "MD". `HoverTooltip` is mocked to its children —
 * the walker calls plain function components, and Radix's provider uses hooks.
 * "Faculty-asserted" is offered to every holder, checked by default for
 * `"*"` only, and its CWID-less entries get their own sentence.
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
  mockPopover: vi.fn(() => null),
  mockTable: vi.fn(() => null),
  mockAutoSubmitForm: vi.fn(({ children }: { children: React.ReactNode }) => children),
  mockHoverTooltip: vi.fn(({ children }: { children: React.ReactNode }) => children),
  mockReportHeader: vi.fn(({ children }: { children: React.ReactNode }) => children),
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
vi.mock("@/components/edit/report-access-popover", () => ({ ReportAccessPopover: h.mockPopover }));
// The h1 + "About this report" disclosure live in `ReportHeader` (an async
// Server Component over `report_meta`, covered by `report-header.test.tsx`);
// here it is a pass-through so the walk still reaches the page's subtitle.
vi.mock("@/components/edit/report-header", () => ({ ReportHeader: h.mockReportHeader }));
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
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: vi.fn().mockResolvedValue([]) } }, write: {} },
  prisma: {},
}));

import EditReportPage from "@/app/edit/reports/[report]/page";

/** The dynamic page at report 7's default slug — the same call shape the
 *  numbered page used to take, plus the segment. */
const EditReportsMentoredPublicationsPage = ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) => EditReportPage({ params: Promise.resolve({ report: "mentored-publications" }), searchParams });
const BASE = "/edit/reports/mentored-publications";

const HOLDER = { cwid: "usr0001", isSuperuser: false, isCommsSteward: false };
const SUPERUSER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };
const sp = (q: Record<string, string> = {}) => Promise.resolve(q);

/** One grant row as `listReportAccess` hands it (a `Date`, a resolved `name`). */
const ACCESS_ROW = {
  reportKey: "mentored-publications",
  scopeKey: "md",
  cwid: "usr0001",
  granteeName: "Holder Person",
  name: "Holder Person",
  grantedBy: "adm0001",
  grantedAt: new Date("2026-09-18T12:00:00Z"),
};
/** `MENTORED_PUBS_SCOPE_OPTIONS` — the real constant (the module is spread
 *  from the original), pinned here by value so a wording drift is visible. */
const SCOPE_OPTIONS = [
  ["*", "All programs"],
  ["md", "MD"],
  ["mdphd", "MD-PhD"],
  ["ecr", "ECR"],
];

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

/** The popover element the page hands `ReportHeader` as `access`. The mocked
 *  header is opaque to the walk (its `access` is a prop, not a child), so it
 *  is read off the header's props directly. */
function accessPopover(result: unknown): El {
  const header = findByType(result, h.mockReportHeader);
  expect(header).not.toBeNull();
  const access = asEl(header!.props.access);
  expect(access.type).toBe(h.mockPopover);
  return access;
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

describe("/edit/reports/mentored-publications (7) — gate", () => {
  it("no session → SSO login with the return path", async () => {
    h.mockGetEditSession.mockResolvedValue(null);
    await expect(EditReportsMentoredPublicationsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/reports/mentored-publications",
    );
  });

  it("an empty scope set → notFound(), before any data is read", async () => {
    h.mockGetReportScopes.mockResolvedValue(new Set());
    await expect(EditReportsMentoredPublicationsPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockLoadReport).not.toHaveBeenCalled();
    expect(h.mockLoadGradYears).not.toHaveBeenCalled();
  });
});

describe("/edit/reports/mentored-publications (7) — wiring", () => {
  it("a holder: loader gets their scopes, their roster type and the two most recent years; the download carries types; the popover is the header's access with canManage=false and the rows", async () => {
    h.mockListReportAccess.mockResolvedValue([ACCESS_ROW]);
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md"], ["aoc"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    // Who can run it is shown to everyone who can — the list is read for a
    // plain holder too; only the controls are gated.
    expect(h.mockListReportAccess).toHaveBeenCalledWith("mentored-publications");
    const popover = accessPopover(result);
    expect(popover.props).toEqual({
      mode: "person",
      reportKey: "mentored-publications",
      initialRows: [{ ...ACCESS_ROW, grantedAt: "2026-09-18T12:00:00.000Z" }],
      scopeOptions: SCOPE_OPTIONS,
      canManage: false,
    });
    // Nothing else of it below the tables — the bottom-of-page card is gone.
    expect(findByTestId(result, "report-access-panel")).toBeNull();
    expect(findByType(result, h.mockTable)?.props.downloadHref).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored",
    );
  });

  it("Type of mentorship: an md holder sees MD (checked) and the five non-roster types, never MD-PhD / ECR; faculty offered but unchecked; no Program select", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(checkboxes(form).filter(([name]) => name === "mtype")).toEqual([
      ["mtype", "aoc", true],
      ["mtype", "thesis", false],
      ["mtype", "postdoc", false],
      ["mtype", "likely", false],
      ["mtype", "possible", false],
      ["mtype", "faculty", false],
    ]);
    const text = textOf(form);
    expect(text).toContain("Type of mentorship");
    expect(text).toContain("MD");
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
      "MD students' pairs, recorded by the Areas of Concentration (AOC) program — the MD scholarly-concentration program — in its pairing sheet.",
      "Thesis-advisor pairs from the Graduate School's Jenzabar records (MAJSP). Conferral year known; start year not.",
      expect.stringContaining("reporting manager from the ED appointment record"),
      expect.stringContaining("Not on any roster"),
      expect.stringContaining("research staff or MD alumni"),
      expect.stringContaining("Added by the mentor on their Scholars profile"),
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
      ["mtype", "aoc", true],
      ["mtype", "likely", true],
      ["years", "2025", true],
    ]);
    expect(findByType(result, h.mockTable)?.props.downloadHref).toBe(
      "/api/edit/reports/mentored-publications?years=2025&mtype=aoc%2Clikely&tail=2&pubs=mentored",
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
      "/api/edit/reports/mentored-publications?years=2026%2C2025%2Cunknown&mtype=aoc&tail=1&pubs=mentored",
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
    expect(form!.props.action).toBe(BASE);
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
    const base = "years=2025&mtype=aoc&tail=2";
    // The island owns the tabs and the download link; it gets every href
    // with the other params kept, and the download carries pubs but never view.
    expect(findByType(result, h.mockTable)?.props).toMatchObject({
      view: "publications",
      pubsMode: "all",
      viewHrefs: {
        summary: `${BASE}?${base}&pubs=all`,
        publications: `${BASE}?${base}&pubs=all&view=publications`,
      },
      downloadHref: `/api/edit/reports/mentored-publications?${base}&pubs=all`,
    });
    expect(findByTestId(result, "mentored-pubs-set-all")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-all-missing")).toBeNull();
  });


  it("with data: the island receives view / summary / publications / pubsMode; the description names the five sources and the dropped counts", async () => {
    const summaryRow = {
      gradYear: 2025, entryYear: 2021, entryYearSource: "bridge", cwid: "stu0001",
      firstName: "Ada", lastName: "Learner", program: "MD",
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
        summary: `${BASE}?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored`,
        publications:
          `${BASE}?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored&view=publications`,
      },
      downloadHref:
        "/api/edit/reports/mentored-publications?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored",
      summary: [summaryRow],
      publications: [pub],
      pubsMode: "mentored",
      highImpactThreshold: 10,
      // The server filter form rides in as the island's children — the top
      // of its rail, never a strip above it.
      children: expect.objectContaining({ props: expect.objectContaining({ typeChoices: ["aoc", "thesis", "postdoc", "likely", "possible", "faculty"] }) }),
    });
    // …and it IS the auto-submit form (the element is the page-local FilterForm; walk it).
    expect(findByType(findByType(summary, h.mockTable)?.props.children, h.mockAutoSubmitForm)?.props.id).toBe(
      "mentored-pubs-filters",
    );
    // The sources list lives ONLY in the "About this report" disclosure now —
    // the subtitle points at it instead of restating it (2026-09-20).
    expect(textOf(summary)).toContain("the sources are under “About this report”.");
    expect(textOf(summary)).not.toContain("Pairs come from");
    expect(textOf(summary)).toContain("an MD learner with no entry year on the pairing sheet");
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
    expect(textOf(dropped)).not.toContain("faculty-asserted mentees");

    // Faculty-asserted entries with no CWID get the same sentence slot.
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [summaryRow], detail: [], publications: [pub],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
      droppedUnresolved: 0,
      droppedNoCwid: 2,
    }));
    const noCwid = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(textOf(noCwid)).toContain(
      "is assumed to have entered four years before graduating. 2 faculty-asserted mentees have no CWID and are not shown.",
    );
    expect(textOf(noCwid)).not.toContain("not yet in the local corpus");
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

  it("a superuser: every type offered, the confirmed ones (faculty included) checked by default, co-author inferences unchecked", async () => {
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(
      checkboxes(findByType(result, h.mockAutoSubmitForm)).filter(([name]) => name === "mtype"),
    ).toEqual([
      ["mtype", "aoc", true],
      ["mtype", "mdphd", true],
      ["mtype", "ecr", true],
      ["mtype", "thesis", true],
      ["mtype", "postdoc", true],
      ["mtype", "likely", false],
      ["mtype", "possible", false],
      ["mtype", "faculty", true],
    ]);
    const confirmed = ["aoc", "mdphd", "ecr", "thesis", "postdoc", "faculty"];
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["*"], confirmed);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["*"],
      types: confirmed,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("a superuser: the chosen types reach BOTH loaders with the '*' scope, and the popover carries the current rows with canManage=true", async () => {
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    h.mockListReportAccess.mockResolvedValue([ACCESS_ROW]);
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
    expect(h.mockListReportAccess).toHaveBeenCalledWith("mentored-publications");
    const popover = accessPopover(result);
    expect(popover.props.mode).toBe("person");
    expect(popover.props.reportKey).toBe("mentored-publications");
    expect(popover.props.canManage).toBe(true);
    expect(popover.props.initialRows).toEqual([
      expect.objectContaining({ cwid: "usr0001", scopeKey: "md", grantedAt: "2026-09-18T12:00:00.000Z" }),
    ]);
    // The `md` scope reads "MD" — the degree, from the ONE shared list.
    expect(popover.props.scopeOptions).toEqual(SCOPE_OPTIONS);
  });

  it("the hardcoded Sources disclosure is gone: the h1 and description ride ReportHeader (report_meta row 7)", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(findByTestId(result, "mentored-pubs-sources")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-sources-frt")).toBeNull();
    expect(findByType(result, "h1")).toBeNull();
    const header = findByType(result, h.mockReportHeader);
    expect(header).not.toBeNull();
    expect(header!.props).toMatchObject({ n: "7", session: HOLDER });
    // The page's own dynamic subtitle is the header's child, pointing at the
    // disclosure by its summary text.
    expect(textOf(header!.props.children)).toContain("the sources are under “About this report”.");
  });
});
