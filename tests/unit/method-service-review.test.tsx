/**
 * The editor's review half of Method services:
 *   - `loadServiceReview`: the numbers under a saved service and its review
 *     list, by the public page's own rule;
 *   - the section: the line from the mockup with real numbers, "Review
 *     publications", "Not ours" and its "Undo".
 * DB and fetch mocked; made-up units, people and PMIDs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const m = vi.hoisted(() => ({
  collectFamilyPmids: vi.fn(),
  loadPagePublicationSets: vi.fn(),
  loadStaffPmidsByUnit: vi.fn(),
  loadCoreConfirmedPmidsByUnit: vi.fn(),
  publicationFindMany: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const read = { publication: { findMany: m.publicationFindMany } };
  return { prisma: read, db: { read } };
});
vi.mock("@/lib/api/methods", () => ({ collectFamilyPmids: m.collectFamilyPmids }));
vi.mock("@/lib/api/methods-overlay", () => ({ loadFamilyOverlayGate: async () => ({}) }));
vi.mock("@/lib/api/method-service-collaborations", () => ({
  loadPagePublicationSets: m.loadPagePublicationSets,
  loadStaffPmidsByUnit: m.loadStaffPmidsByUnit,
  loadCoreConfirmedPmidsByUnit: m.loadCoreConfirmedPmidsByUnit,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: m.refresh }),
}));
vi.mock("@/components/edit/unsaved-changes-guard", () => ({ UnsavedChangesGuard: () => null }));

import { MethodServicesSection } from "@/components/edit/method-services-section";
import {
  loadServiceReview,
  type ServiceReview,
  type ServiceReviewPublication,
} from "@/lib/api/method-service-review";
import type { MethodServiceView } from "@/lib/method-services/validation";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };
const FAM_2 = { supercategory: "evidence_synthesis", familyLabel: "Example search methods" };

const SERVICE: MethodServiceView = {
  id: 5,
  entityType: "department",
  entityId: "DEPTA",
  name: "Example review service",
  url: "https://example.org/reviews",
  families: [FAM],
  supportedPmids: ["101", "103", "999"],
  excludedPmids: ["104"],
  countStaffPapers: true,
  affiliationPhrases: [],
  coauthoredPmids: [], authorNames: [], nameMatchedPmids: [],
};

describe("loadServiceReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("METHODS_LENS_ENABLED", "on");
    m.collectFamilyPmids.mockResolvedValue(["101", "102", "103", "104", "105"]);
    // 103 is on the page only under "Show all publication types".
    m.loadPagePublicationSets.mockResolvedValue({
      all: new Set(["101", "102", "103", "104", "105"]),
      research: new Set(["101", "102", "104", "105"]),
    });
    m.loadStaffPmidsByUnit.mockResolvedValue(new Map([["department:DEPTA", new Set(["102", "104"])]]));
    m.loadCoreConfirmedPmidsByUnit.mockResolvedValue(new Map());
    m.publicationFindMany.mockImplementation(async (args: { where: { pmid: { in: string[] } } }) =>
      args.where.pmid.in.map((pmid) => ({
        pmid,
        title: `Example paper ${pmid}`,
        journal: "Example Journal",
        year: 2020 + (Number(pmid) % 5),
      })),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("counts by the page's default view and lists every marked publication with its reason", async () => {
    const r = await loadServiceReview(SERVICE);
    // Counted: 101 (supported: support), 102 (staff: a collaboration), 103
    // (supported, all types only). 104 is staff-authored but excluded; 999 is
    // not on the page.
    expect(r.collaborations).toBe(1);
    expect(r.support).toBe(1);
    expect(r.supportedListed).toBe(3);
    expect(r.supportedOnPage).toBe(1);
    expect(r.perMethod).toEqual([]);
    expect(r.marked.map((p) => [p.pmid, p.kind, p.reason, p.inDefaultView])).toEqual([
      ["103", "support", "supported", false],
      ["102", "collaboration", "staff", true],
      ["101", "support", "supported", true],
    ]);
    expect(r.marked[0]).toMatchObject({ title: "Example paper 103", journal: "Example Journal" });
    expect(r.excluded.map((p) => p.pmid)).toEqual(["104"]);
    expect(r.excluded[0]).toMatchObject({ kind: null, reason: null, methods: ["Example review methods"] });
  });

  it("a supported publication with a matching PubMed author is a collaboration by affiliation", async () => {
    const r = await loadServiceReview({ ...SERVICE, coauthoredPmids: ["101", "103"] });
    expect(r.collaborations).toBe(2);
    expect(r.support).toBe(0);
    expect(r.marked.map((p) => [p.pmid, p.kind, p.reason])).toEqual([
      ["103", "collaboration", "affiliation"],
      ["102", "collaboration", "staff"],
      ["101", "collaboration", "affiliation"],
    ]);
  });

  it("a match by a named author says so; the other matches stay by affiliation", async () => {
    const r = await loadServiceReview({
      ...SERVICE,
      coauthoredPmids: ["101", "103"],
      nameMatchedPmids: ["103"],
    });
    expect(r.collaborations).toBe(2);
    expect(r.marked.map((p) => [p.pmid, p.kind, p.reason])).toEqual([
      ["103", "collaboration", "author_name"],
      ["102", "collaboration", "staff"],
      ["101", "collaboration", "affiliation"],
    ]);
  });

  it("a core's confirmed publication is marked with its own reason, with automatic counting off", async () => {
    m.loadStaffPmidsByUnit.mockResolvedValue(new Map());
    m.loadCoreConfirmedPmidsByUnit.mockResolvedValue(new Map([["core:77", new Set(["105"])]]));
    const core = {
      ...SERVICE,
      entityType: "core" as const,
      entityId: "77",
      supportedPmids: [],
      excludedPmids: [],
      countStaffPapers: false,
    };
    const r = await loadServiceReview(core);
    expect(m.loadCoreConfirmedPmidsByUnit.mock.calls[0][0][0]).toMatchObject({
      entityType: "core",
      entityId: "77",
    });
    expect(r.collaborations).toBe(0);
    expect(r.support).toBe(1);
    expect(r.marked.map((p) => [p.pmid, p.kind, p.reason])).toEqual([["105", "support", "confirmed"]]);
  });

  it("asks for the unit's people with the service's own toggle", async () => {
    await loadServiceReview({ ...SERVICE, countStaffPapers: false });
    expect(m.loadStaffPmidsByUnit.mock.calls[0][0][0]).toMatchObject({
      entityType: "department",
      entityId: "DEPTA",
      countStaffPapers: false,
    });
  });

  it("sums a service attached to two methods, with a line per method", async () => {
    m.collectFamilyPmids.mockImplementation(async (_sc: string, label: string) =>
      label === FAM.familyLabel ? ["101", "102"] : ["102", "103"],
    );
    m.loadPagePublicationSets.mockImplementation(async (pmids: string[]) => ({
      all: new Set(pmids),
      research: new Set(pmids),
    }));
    m.loadStaffPmidsByUnit.mockResolvedValue(new Map([["department:DEPTA", new Set(["102"])]]));
    const r = await loadServiceReview({ ...SERVICE, families: [FAM, FAM_2], excludedPmids: [] });
    // 101 and 103 are on the supported list (support); 102 has a unit author.
    expect(r.collaborations).toBe(1);
    expect(r.support).toBe(2);
    expect(r.perMethod).toEqual([
      { familyLabel: "Example review methods", collaborations: 1, support: 1, supportedOnPage: 1 },
      { familyLabel: "Example search methods", collaborations: 1, support: 1, supportedOnPage: 1 },
    ]);
    expect(r.marked.find((p) => p.pmid === "102")!.methods).toEqual([
      "Example review methods",
      "Example search methods",
    ]);
  });

  it("an excluded PMID Scholars has no record of is still listed, so it can be undone", async () => {
    m.publicationFindMany.mockResolvedValue([]);
    const r = await loadServiceReview({ ...SERVICE, supportedPmids: [], countStaffPapers: false, excludedPmids: ["777"] });
    expect(r.excluded).toEqual([
      { pmid: "777", title: null, journal: null, year: null, kind: null, reason: null, methods: [], inDefaultView: false },
    ]);
  });
});

describe("MethodServicesSection: review", () => {
  const pub = (
    pmid: string,
    over: Partial<ServiceReviewPublication> = {},
  ): ServiceReviewPublication => ({
    pmid,
    title: `Example paper ${pmid}`,
    journal: "Example Journal",
    year: 2024,
    kind: "support",
    reason: "supported",
    methods: ["Example review methods"],
    inDefaultView: true,
    ...over,
  });
  let review: ServiceReview;
  let stored: MethodServiceView;
  const fetchMock = vi.fn();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    stored = { ...SERVICE, supportedPmids: Array.from({ length: 231 }, (_, i) => String(1000 + i)) };
    review = {
      collaborations: 120,
      support: 68,
      supportedListed: 231,
      supportedOnPage: 167,
      perMethod: [],
      marked: [
        pub("101"),
        pub("102", { kind: "collaboration", reason: "staff" }),
        pub("103", { kind: "collaboration", reason: "affiliation" }),
        pub("104", { reason: "confirmed" }),
        pub("105", { kind: "collaboration", reason: "author_name" }),
      ],
      excluded: [],
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/edit/method-service?id=")) return json({ ok: true, review });
      const body = JSON.parse(String(init?.body)) as { op: string; pmid: string };
      // The server moves the PMID; the next review read reflects it.
      if (body.op === "exclude") {
        stored = { ...stored, excludedPmids: [...stored.excludedPmids, body.pmid] };
        const moved = review.marked.find((p) => p.pmid === body.pmid)!;
        review = {
          ...review,
          support: review.support - 1,
          marked: review.marked.filter((p) => p.pmid !== body.pmid),
          excluded: [...review.excluded, { ...moved, kind: null, reason: null }],
        };
      } else {
        stored = { ...stored, excludedPmids: stored.excludedPmids.filter((p) => p !== body.pmid) };
        const moved = review.excluded.find((p) => p.pmid === body.pmid)!;
        review = {
          ...review,
          support: review.support + 1,
          marked: [...review.marked, { ...moved, kind: "support", reason: "supported" }],
          excluded: review.excluded.filter((p) => p.pmid !== body.pmid),
        };
      }
      return json({ ok: true, op: body.op, changed: true, service: stored });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderSection = () =>
    render(
      <MethodServicesSection
        entityType="department"
        entityId="DEPTA"
        unitName="Example Library"
        services={[stored]}
      />,
    );
  const line = () => screen.findByTestId("method-service-review-line-5");
  const writes = () =>
    fetchMock.mock.calls
      .filter(([url]) => url === "/api/edit/method-service")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));

  it("shows the mockup's line with real numbers", async () => {
    renderSection();
    expect((await line()).textContent).toBe(
      "120 collaborations and 68 supported on the method page · 231 on the supported list, 167 of them on the page · Review publications",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/edit/method-service?id=5", expect.anything());
  });

  it("says '1 collaboration' and leaves the supported part out for an empty list", async () => {
    review = { ...review, collaborations: 1, support: 0, supportedListed: 0, supportedOnPage: 0 };
    renderSection();
    expect((await line()).textContent).toBe(
      "1 collaboration and 0 supported on the method page · Review publications",
    );
  });

  it("keeps the plain supported-list count when the numbers cannot be read", async () => {
    fetchMock.mockImplementation(async () => json({ ok: false, error: "not_superuser" }, 403));
    renderSection();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText("231 publications on the supported list")).toBeTruthy();
    expect(screen.queryByTestId("method-service-review-line-5")).toBeNull();
  });

  it("Review publications is a real button that opens a labelled list of the marked publications", async () => {
    renderSection();
    await line();
    const toggle = screen.getByRole("button", { name: "Review publications for Example review service" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("method-service-review-5")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Publications for Example review service" });
    expect(panel.id).toBe(toggle.getAttribute("aria-controls"));
    const marked = within(screen.getByTestId("method-service-marked-5"));
    expect(marked.getByText("Example paper 101")).toBeTruthy();
    // Each row says which it is, and why.
    const says = (pmid: string) =>
      marked.getByText(`Example paper ${pmid}`).closest("li")!.textContent ?? "";
    expect(says("101")).toContain("Support: supported list");
    expect(says("102")).toContain("Collaboration: unit member in Scholars");
    expect(says("103")).toContain("Collaboration: affiliation in PubMed");
    expect(says("104")).toContain("Support: confirmed core publication");
    expect(says("105")).toContain("Collaboration: named author in PubMed");
    expect(screen.getByText("Counted as collaboration or support (5)")).toBeTruthy();
    expect(marked.getAllByText(/Example Journal · 2024 · PMID 10[1-5]/)).toHaveLength(5);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("method-service-review-5")).toBeNull();
  });

  it("Not ours posts an exclude for that PMID, re-reads the numbers and moves it under Undo", async () => {
    renderSection();
    await line();
    fireEvent.click(screen.getByRole("button", { name: /^Review publications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Not ours: Example paper 101" }));

    const undo = await screen.findByRole("button", { name: "Undo, count it again: Example paper 101" });
    expect(writes()).toEqual([{ op: "exclude", id: 5, pmid: "101" }]);
    expect((await line()).textContent).toContain("120 collaborations and 67 supported on the method page");
    expect(within(screen.getByTestId("method-service-marked-5")).queryByText("Example paper 101")).toBeNull();
    expect(screen.getByText("Removed from the count (1)")).toBeTruthy();
    expect(screen.getByText("PMID 101 no longer counts for the Example Library.")).toBeTruthy();
    // Focus follows the publication to its Undo.
    await waitFor(() => expect(document.activeElement).toBe(undo));
  });

  it("Undo posts a restore and puts the publication back", async () => {
    renderSection();
    await line();
    fireEvent.click(screen.getByRole("button", { name: /^Review publications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Not ours: Example paper 101" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Undo, count it again/ }));

    const notOurs = await screen.findByRole("button", { name: "Not ours: Example paper 101" });
    expect(writes()).toEqual([
      { op: "exclude", id: 5, pmid: "101" },
      { op: "restore", id: 5, pmid: "101" },
    ]);
    expect((await line()).textContent).toContain("120 collaborations and 68 supported on the method page");
    expect(screen.queryByText(/Removed from the count/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notOurs));
  });

  it("a refused Not ours changes nothing and says so", async () => {
    renderSection();
    await line();
    fireEvent.click(screen.getByRole("button", { name: /^Review publications/ }));
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("?id=")
        ? json({ ok: true, review })
        : json({ ok: false, error: "not_superuser" }, 403),
    );
    fireEvent.click(screen.getByRole("button", { name: "Not ours: Example paper 101" }));
    expect(await screen.findByText(/Only a superuser can change method services/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not ours: Example paper 101" })).toBeTruthy();
    expect(screen.queryByText(/Removed from the count/)).toBeNull();
  });
});
