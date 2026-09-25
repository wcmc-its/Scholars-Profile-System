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
 * `"*"` only, and its CWID-less entries get their own banner.
 *
 * Redesign (2026-09-24): the rail is `MentoredPublicationsRail` (walked — a
 * plain function over the shared `RailSection`s) with its long lists in
 * `RailChecklist` (mocked to a marker: it holds state); the phone copy rides
 * `FiltersSheet` (mocked, so the walk sees the desktop rail once). Pinned
 * here: the section order; the mtype checkboxes split program / inferred;
 * the graduation range selects + unknown checkbox; tail / pubs as radios;
 * the stats, download href + note, distinct line, chips (× only where a
 * value differs from the default), reset link; the post-load facets narrow
 * what the island receives; the one-sentence subtitle and the footnote's
 * window rule.
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
  mockChecklist: vi.fn(() => null),
  mockFiltersSheet: vi.fn(() => null),
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
vi.mock("@/components/edit/reports/rail-checklist", () => ({ RailChecklist: h.mockChecklist }));
vi.mock("@/components/edit/filters-sheet", () => ({ FiltersSheet: h.mockFiltersSheet }));
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
import { FilterChips } from "@/components/edit/reports/report-ui";
import { resolveSuspense } from "@/tests/util/resolve-suspense";

/** The dynamic page at report 7's default slug — the same call shape the
 *  numbered page used to take, plus the segment. */
const EditReportsMentoredPublicationsPage = ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) =>
  EditReportPage({ params: Promise.resolve({ report: "mentored-publications" }), searchParams }).then((t) =>
    resolveSuspense(t),
  );
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

/** What the walk descends into: a plain (non-mock, hook-free) function
 *  component's RENDERED output (which already holds whatever `children` it
 *  places — walking both would count every rail control twice per level);
 *  otherwise the element's `children`, arrays flattened (the mapped lists).
 *  A mock stays opaque apart from its `children`, and the phone
 *  `FiltersSheet` is not entered at all (its copy of the rail is asserted
 *  directly), so the walk sees the desktop rail once. */
function childrenOf(el: El): unknown[] {
  if (Array.isArray(el)) return (el as unknown[]).flat(Infinity);
  if (el.type === h.mockFiltersSheet) return [];
  if (typeof el.type === "function" && !("mock" in el.type)) {
    const out = (el.type as (p: unknown) => unknown)(el.props);
    if (!(out instanceof Promise)) return [out];
  }
  const children = el.props?.children;
  return Array.isArray(children) ? children.flat(Infinity) : [children];
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

/** The access-badge props the page hands `ReportHeader` as `access` (the
 *  header renders the badge from them). Read off the mocked header's props;
 *  wrapped as `{ props }` so the assertions read like the element they used
 *  to be. */
function accessPopover(result: unknown): { props: Record<string, unknown> } {
  const header = findByType(result, h.mockReportHeader);
  expect(header).not.toBeNull();
  const access = header!.props.access as Record<string, unknown> | undefined;
  expect(access).toBeTruthy();
  return { props: access! };
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
    expect(findByTestId(result, "report-access-panel")).toBeNull();
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      "/api/edit/reports/mentored-publications?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored",
    );
  });

  it("the rail: the spec's sections in order, inside the auto-submit form; the phone sheet gets its own copy", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    const form = findByType(result, h.mockAutoSubmitForm)!;
    expect(form.props).toMatchObject({ id: "mentored-pubs-filters", action: BASE, "data-testid": "mentored-pubs-filters" });
    const sections: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const el = asEl(node);
      const id = el.props?.["data-testid"];
      if (typeof id === "string" && id.startsWith("mentored-pubs-section-")) sections.push(id.slice(22));
      for (const c of childrenOf(el)) walk(c);
    };
    walk(form);
    expect(sections).toEqual(["mtype", "inferred", "years", "tail", "pubs", "window", "position", "pubyear", "mentor", "withpubs"]);
    // The phone copy: a second rail, its own form id.
    const sheet = findByType(result, h.mockFiltersSheet)!;
    expect(sheet.props.testId).toBe("mentored-pubs-filters-sheet-trigger");
    expect(asEl(sheet.props.children).props.idSuffix).toBe("-sheet");
  });

  it("Mentorship type / Inferred mentorship: an md holder sees MD (checked) + the confirmed non-roster types, then the two inferences; never MD-PhD / ECR; each label hovers its description", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(checkboxes(findByTestId(form, "mentored-pubs-section-mtype")).filter(([name]) => name === "mtype")).toEqual([
      ["mtype", "aoc", true],
      ["mtype", "thesis", false],
      ["mtype", "postdoc", false],
      ["mtype", "faculty", false],
    ]);
    expect(checkboxes(findByTestId(form, "mentored-pubs-section-inferred"))).toEqual([
      ["mtype", "likely", false],
      ["mtype", "possible", false],
    ]);
    const text = textOf(form);
    expect(text).toContain("Mentorship type");
    expect(text).toContain("Inferred mentorship");
    expect(text).toContain("Not included");
    expect(text).toContain("Likely mentee (from co-authorship)");
    expect(text).not.toContain("All programs");
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
      expect.stringContaining("Added by the mentor on their Scholars profile"),
      expect.stringContaining("Not on any roster"),
      expect.stringContaining("research staff or MD alumni"),
    ]);
  });

  it("Counting window and Publications are radios (segmented); graduation year is a from/to range + the unknown checkbox", async () => {
    h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024, null]);
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ tail: "2", pubs: "all" }) });
    const form = findByType(result, h.mockAutoSubmitForm);
    const radios: Array<[string, string, boolean]> = [];
    const selects: Array<[string, string, string[]]> = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const el = asEl(node);
      if (el.type === "input" && el.props.type === "radio") radios.push([String(el.props.name), String(el.props.value), !!el.props.defaultChecked]);
      if (el.type === "select") {
        const opts: string[] = [];
        const o = (n: unknown) => {
          if (n === null || n === undefined || typeof n !== "object") return;
          if (Array.isArray(n)) return n.forEach(o);
          const e = asEl(n);
          if (e.type === "option") opts.push(String(e.props.value));
          for (const c of childrenOf(e)) o(c);
        };
        o(el);
        selects.push([String(el.props.name), String(el.props.defaultValue), opts]);
      }
      for (const c of childrenOf(el)) walk(c);
    };
    walk(form);
    expect(radios).toEqual([
      ["tail", "0", false],
      ["tail", "1", false],
      ["tail", "2", true],
      ["tail", "3", false],
      ["pubs", "mentored", false],
      ["pubs", "all", true],
    ]);
    // Default years 2026, 2025 + unknown: the range 2025–2026, the box ticked.
    expect(selects).toEqual([
      ["grad_from", "2025", ["", "2024", "2025", "2026"]],
      ["grad_to", "2026", ["", "2024", "2025", "2026"]],
    ]);
    expect(checkboxes(findByTestId(form, "mentored-pubs-section-years"))).toEqual([["grad_unknown", "1", true]]);
    expect(textOf(findByTestId(form, "mentored-pubs-section-years"))).toContain("2025–2026 + unknown");
    expect(textOf(findByTestId(form, "mentored-pubs-section-tail"))).toContain("Entry year → graduation + 2 years");
  });

  it("an old non-contiguous years= link keeps its meaning; the rail says what the range will do", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ years: "2024,2026" }) });
    expect(h.mockLoadReport).toHaveBeenCalledWith(expect.objectContaining({ gradYears: [2024, 2026] }));
    const form = findByType(result, h.mockAutoSubmitForm);
    expect(textOf(findByTestId(form, "mentored-pubs-years-gappy"))).toContain("This link picks 2024, 2026");
  });

  it("the range fields reach the loader as the same years list; every link the page writes speaks years=", async () => {
    h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024, null]);
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ grad_from: "2024", grad_to: "2025", grad_unknown: "1" }),
    });
    expect(h.mockLoadReport).toHaveBeenCalledWith(expect.objectContaining({ gradYears: [2024, 2025, null] }));
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      "/api/edit/reports/mentored-publications?years=2024%2C2025%2Cunknown&mtype=aoc&tail=1&pubs=mentored",
    );
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
    ]);
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      "/api/edit/reports/mentored-publications?years=2025&mtype=aoc%2Clikely&tail=2&pubs=mentored",
    );

    await EditReportsMentoredPublicationsPage({ searchParams: sp({ types: "mdphd,thesis", years: "2025" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      types: ["thesis"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ types: "mdphd", years: "2025" }) });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    // A legacy program=<scope> link reads as that roster type.
    await EditReportsMentoredPublicationsPage({ searchParams: sp({ program: "md", years: "2025" }) });
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
      searchParams: sp({ pubs: "everything", view: "raw", types: "nope", position: "any" }),
    });
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("year-less learners in scope: the default adds 'unknown' and the download carries it", async () => {
    h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024, null]);
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2026, 2025, null],
      tail: 1,
      ...MENTORED,
    });
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
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

  it("view tabs keep every param; the download carries pubs but never view or q; the island binds both rail forms", async () => {
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2025", tail: "2", pubs: "all", view: "publications", q: "ada" }),
    });
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md"],
      ...AOC,
      gradYears: [2025],
      tail: 2,
      pubs: "all",
    });
    const base = "years=2025&mtype=aoc&tail=2";
    expect(findByType(result, h.mockTable)?.props).toMatchObject({
      view: "publications",
      pubsMode: "all",
      tail: 2,
      initialQuery: "ada",
      formIds: ["mentored-pubs-filters", "mentored-pubs-filters-sheet"],
      viewHrefs: {
        summary: `${BASE}?${base}&pubs=all`,
        publications: `${BASE}?${base}&pubs=all&view=publications`,
      },
    });
    expect(findByTestId(result, "mentored-pubs-download")?.props.href).toBe(
      `/api/edit/reports/mentored-publications?${base}&pubs=all`,
    );
    expect(textOf(findByTestId(result, "mentored-pubs-download-note"))).toContain(
      "Raw Data (one row per learner and publication)",
    );
    expect(findByTestId(result, "mentored-pubs-all-missing")).toBeNull();
  });

  it("with data: stats, the distinct line, the island's rows; the one-sentence subtitle; the window rule and dropped counts below", async () => {
    const summaryRow = {
      gradYear: 2025, entryYear: 2021, entryYearSource: "bridge", cwid: "stu0001",
      firstName: "Ada", lastName: "Learner", program: "MD",
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorship: { program: "md", source: "roster", tier: "confirmed" } }],
      pubsInWindow: 1, withMentorInWindow: 1, pubsAllTime: 3, highImpactInWindow: 0, firstAuthorInWindow: 1,
    };
    const pub = {
      pmid: "12345678", title: "A paper", journal: "J Test", year: 2024, citation: "Learner A, Mentor G. A paper. J Test. 2024.",
      jif: 3.2, citations: 4, dateAdded: null, authorCount: 2,
      learners: [{ cwid: "stu0001", firstName: "Ada", lastName: "Learner", firstAuthor: true, authorPosition: 1, inWindow: true }],
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorships: [{ program: "md", source: "roster", tier: "confirmed" }] }],
      withMentor: true,
    };
    const reportWith = (extra: Record<string, unknown>) =>
      h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
        summary: [summaryRow], detail: [], publications: [pub],
        generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null,
        droppedUnresolved: 0, droppedNoCwid: 0, ...extra,
      }));
    reportWith({});

    const summary = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(findByType(summary, h.mockTable)?.props).toEqual({
      view: "summary",
      viewHrefs: {
        summary: `${BASE}?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored`,
        publications: `${BASE}?years=2026%2C2025&mtype=aoc&tail=1&pubs=mentored&view=publications`,
      },
      summary: [summaryRow],
      publications: [pub],
      pubsMode: "mentored",
      highImpactThreshold: 10,
      tail: 1,
      initialQuery: "",
      formIds: ["mentored-pubs-filters", "mentored-pubs-filters-sheet"],
    });
    expect(textOf(findByTestId(summary, "mentored-pubs-stats"))).toContain("learner1publications in window1all years3");
    expect(textOf(findByTestId(summary, "mentored-pubs-download-note"))).toBe(
      "Includes the Summary (one row per learner), Raw Data (one row per learner, mentor and publication) and Query & Assumptions sheets, with these filters applied.",
    );
    expect(textOf(findByTestId(summary, "mentored-pubs-distinct"))).toBe(
      "1 distinct publication. A publication shared by two learners counts once here and once per learner above.",
    );
    // The subtitle is one sentence; the rule moved to the footnote.
    const header = findByType(summary, h.mockReportHeader)!;
    expect(textOf(header.props.children)).toBe(
      "Publications each learner co-authored with one of their mentors, with Journal Impact Factor and NIH iCite citations.",
    );
    expect(textOf(findByTestId(summary, "mentored-pubs-footnote"))).toContain(
      "“In window” means entry year ≤ publication year ≤ graduation year + 1; an MD learner with no entry year on the pairing sheet is assumed to have entered four years before graduating.",
    );
    expect(textOf(summary)).not.toContain("presumptive");
    expect(textOf(summary)).not.toContain("not yet in the local corpus");
    expect(findByTestId(summary, "mentored-pubs-no-cwid")).toBeNull();

    // Suggestion-evidence pubs with no local row yet: one sentence in the footnote.
    reportWith({ droppedUnresolved: 1 });
    const dropped = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(textOf(findByTestId(dropped, "mentored-pubs-footnote"))).toContain(
      "1 co-publications not yet in the local corpus are not shown.",
    );

    // Faculty-asserted entries with no CWID: the banner (no View list — the names are not loaded).
    reportWith({ droppedNoCwid: 2 });
    const noCwid = await EditReportsMentoredPublicationsPage({ searchParams: sp({}) });
    expect(textOf(findByTestId(noCwid, "mentored-pubs-no-cwid"))).toBe(
      "2 faculty-asserted mentees have no CWID, so they can’t be matched to publications and aren’t shown.",
    );
    expect(textOf(noCwid)).not.toContain("View list");
  });

  it("chips: the four standing values without ×, until one differs from the default; each facet a removable chip; the reset link", async () => {
    const chipsOf = (result: unknown) =>
      (findByType(result, FilterChips)?.props.chips as Array<{ group: string; value: string; removeHref: string | null }>);
    const bare = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(chipsOf(bare)).toEqual([
      { group: "Graduation", value: "2025–2026", removeHref: null },
      { group: "Mentorship", value: "MD", removeHref: null },
      { group: "Window", value: "Entry → grad + 1", removeHref: null },
      { group: "Publications", value: "Co-authored with a mentor", removeHref: null },
    ]);
    // Nothing to reset on a bare URL.
    const rail = findByType(bare, h.mockAutoSubmitForm)!;
    expect(textOf(rail)).toContain("Reset to defaults");

    const busy = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ years: "2024", tail: "2", window: "yes", position: "first", pubyear: "2023", withpubs: "1", mentor: "men0009" }),
    });
    const chips = chipsOf(busy);
    expect(chips).toEqual([
      { group: "Graduation", value: "2024", removeHref: `${BASE}?mtype=aoc&tail=2&pubs=mentored&window=yes&position=first&pubyear=2023&mentor=men0009&withpubs=1` },
      { group: "Mentorship", value: "MD", removeHref: null },
      { group: "Window", value: "Entry → grad + 2", removeHref: `${BASE}?years=2024&mtype=aoc&tail=1&pubs=mentored&window=yes&position=first&pubyear=2023&mentor=men0009&withpubs=1` },
      { group: "Publications", value: "Co-authored with a mentor", removeHref: null },
      { group: "In window", value: "In window", removeHref: `${BASE}?years=2024&mtype=aoc&tail=2&pubs=mentored&position=first&pubyear=2023&mentor=men0009&withpubs=1` },
      { group: "Author position", value: "First author", removeHref: `${BASE}?years=2024&mtype=aoc&tail=2&pubs=mentored&window=yes&pubyear=2023&mentor=men0009&withpubs=1` },
      { group: "Publication year", value: "2023", removeHref: `${BASE}?years=2024&mtype=aoc&tail=2&pubs=mentored&window=yes&position=first&mentor=men0009&withpubs=1` },
      { group: "Mentor", value: "men0009", removeHref: `${BASE}?years=2024&mtype=aoc&tail=2&pubs=mentored&window=yes&position=first&pubyear=2023&withpubs=1` },
      { group: "Learners", value: "With publications only", removeHref: `${BASE}?years=2024&mtype=aoc&tail=2&pubs=mentored&window=yes&position=first&pubyear=2023&mentor=men0009` },
    ]);
    // The reset link goes to the bare report; the phone trigger counts the six changes.
    const reset = findByTestId(findByType(busy, h.mockAutoSubmitForm), "mentored-pubs-rail");
    const links: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const el = asEl(node);
      if (typeof el.props?.href === "string") links.push(el.props.href as string);
      for (const c of childrenOf(el)) walk(c);
    };
    walk(reset);
    expect(links).toEqual([BASE]);
    expect(findByType(busy, h.mockFiltersSheet)?.props.activeCount).toBe(7);
  });

  it("the post-load facets narrow what the island receives, and the rail's lists get their counts", async () => {
    const MDT = { program: "md", source: "roster", tier: "confirmed" };
    const learner = (cwid: string) => ({
      gradYear: 2025, entryYear: 2021, entryYearSource: "bridge", cwid, firstName: "Ada", lastName: cwid, program: "MD",
      mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorship: MDT }],
      pubsInWindow: 1, withMentorInWindow: 1, pubsAllTime: 2, highImpactInWindow: 0, firstAuthorInWindow: 0,
    });
    const detail = (learnerCwid: string, pmid: string, inWindow: boolean, year: number) => ({
      learnerCwid, mentorCwid: "men0001", mentorName: "Grace Mentor", paperMentors: [], withMentor: true, pmid, year,
      inWindow, learnerAuthorPosition: 2, authorCount: 3, jif: null,
    });
    const onPub = (cwid: string, inWindow: boolean) => ({ cwid, firstName: "Ada", lastName: cwid, firstAuthor: false, authorPosition: 2, inWindow });
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [learner("stu0001"), { ...learner("stu0002"), pubsAllTime: 0, pubsInWindow: 0 }],
      detail: [detail("stu0001", "1", true, 2024), detail("stu0001", "2", false, 2019)],
      publications: [
        { pmid: "1", year: 2024, learners: [onPub("stu0001", true)], mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorships: [MDT] }] },
        { pmid: "2", year: 2019, learners: [onPub("stu0001", false)], mentors: [{ cwid: "men0001", name: "Grace Mentor", mentorships: [MDT] }] },
      ],
      generatedAt: new Date("2026-09-18T00:00:00Z"), filters: { ...args }, allPubsLoaded: null, droppedUnresolved: 0, droppedNoCwid: 0,
    }));
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ window: "yes", withpubs: "1" }) });
    const island = findByType(result, h.mockTable)!.props as { summary: Array<{ cwid: string; pubsAllTime: number }>; publications: Array<{ pmid: string }> };
    expect(island.summary.map((r) => [r.cwid, r.pubsAllTime])).toEqual([["stu0001", 1]]);
    expect(island.publications.map((p) => p.pmid)).toEqual(["1"]);
    expect(textOf(findByTestId(result, "mentored-pubs-stats"))).toContain("learner1publications in window1all years1");
    // Counts on the rail: window over every pair (its own selection ignored).
    const windowSection = findByTestId(findByType(result, h.mockAutoSubmitForm), "mentored-pubs-section-window");
    expect(textOf(windowSection)).toContain("In window1Outside window1Window unknown0");
    const lists: Array<Record<string, unknown>> = [];
    const collect = (node: unknown) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(collect);
      const el = asEl(node);
      if (el.type === h.mockChecklist) lists.push(el.props);
      for (const c of childrenOf(el)) collect(c);
    };
    collect(findByType(result, h.mockAutoSubmitForm));
    expect(lists.map((p) => p.name)).toEqual(["pubyear", "mentor"]);
    expect(lists[1].options).toEqual([{ value: "men0001", label: "Grace Mentor", count: 1 }]);
  });

  it("all mode with an unloaded bridge renders the notice and no island", async () => {
    h.mockLoadReport.mockImplementation(async (args: Record<string, unknown>) => ({
      summary: [],
      detail: [],
      publications: [],
      generatedAt: new Date("2026-09-18T00:00:00Z"),
      filters: { ...args },
      allPubsLoaded: false,
    }));
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp({ pubs: "all" }) });
    expect(findByTestId(result, "mentored-pubs-all-missing")).not.toBeNull();
    expect(findByType(result, h.mockTable)).toBeNull();
    // The rail stays, so "Publications" can be switched back.
    expect(findByType(result, h.mockAutoSubmitForm)).not.toBeNull();
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
      ["mtype", "faculty", true],
      ["mtype", "likely", false],
      ["mtype", "possible", false],
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
    expect(textOf(findByTestId(findByType(result, h.mockAutoSubmitForm), "mentored-pubs-section-mtype"))).toContain(
      "All 6 program pairings",
    );
    const chips = findByType(result, FilterChips)?.props.chips as Array<{ group: string; value: string }>;
    expect(chips[1]).toMatchObject({ group: "Mentorship", value: "Program pairings (6)" });
  });

  it("a superuser: the chosen types reach BOTH loaders with the '*' scope, and the popover carries the current rows with canManage=true", async () => {
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    h.mockListReportAccess.mockResolvedValue([ACCESS_ROW]);
    const result = await EditReportsMentoredPublicationsPage({
      searchParams: sp({ types: "ecr" }),
    });
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
    expect(popover.props.scopeOptions).toEqual(SCOPE_OPTIONS);
  });

  it("the h1 and description ride ReportHeader (report_meta row 7); no hardcoded Sources disclosure", async () => {
    const result = await EditReportsMentoredPublicationsPage({ searchParams: sp() });
    expect(findByTestId(result, "mentored-pubs-sources")).toBeNull();
    expect(findByType(result, "h1")).toBeNull();
    const header = findByType(result, h.mockReportHeader);
    expect(header).not.toBeNull();
    expect(header!.props).toMatchObject({ n: "7", session: HOLDER });
  });
});
