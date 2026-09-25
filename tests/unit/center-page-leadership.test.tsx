/**
 * `components/center/center-page.tsx` — the leadership block lays out
 * `LeaderCard`s in a 2-column grid once there are 4+ leaders (a center with a
 * full 6-member leadership group otherwise pushes the roster far down the
 * page); with 1-3 leaders it renders exactly as master did — a plain stacked
 * map, each card keeping its own default `mt-6`/`max-w-[460px]`, no wrapper
 * div. `getCenter` and every other data loader are mocked — this file only
 * proves the render-layer wrapper/className wiring, mirroring how
 * `department-page-leader-render.test.tsx` stubs heavy client children.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockGetCenter,
  mockGetCenterMembers,
  mockGetCenterPrograms,
  mockGetCenterPublicationsList,
  mockGetCenterGrantsList,
  mockGetCenterPublicationCount,
  mockGetCenterGrantCount,
  mockGetUnitAreaPreviews,
  mockGetCenterTopResearchAreas,
  mockCenterHasPrograms,
  mockGetSpotlightCardsForCenter,
  mockProgramPagesEnabled,
} = vi.hoisted(() => ({
  mockGetCenterPublicationCount: vi.fn(),
  mockGetCenterGrantCount: vi.fn(),
  mockGetUnitAreaPreviews: vi.fn(),
  mockProgramPagesEnabled: vi.fn(),
  mockGetCenter: vi.fn(),
  mockGetCenterMembers: vi.fn(),
  mockGetCenterPrograms: vi.fn(),
  mockGetCenterPublicationsList: vi.fn(),
  mockGetCenterGrantsList: vi.fn(),
  mockGetCenterTopResearchAreas: vi.fn(),
  mockCenterHasPrograms: vi.fn(),
  mockGetSpotlightCardsForCenter: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  getCenter: mockGetCenter,
  getCenterMembers: mockGetCenterMembers,
  getCenterPrograms: mockGetCenterPrograms,
  getCenterPublicationsList: mockGetCenterPublicationsList,
  getCenterGrantsList: mockGetCenterGrantsList,
  getCenterPublicationCount: mockGetCenterPublicationCount,
  getCenterGrantCount: mockGetCenterGrantCount,
  getCenterTopResearchAreas: mockGetCenterTopResearchAreas,
  centerHasPrograms: mockCenterHasPrograms,
}));
vi.mock("@/lib/api/unit-area-previews", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/unit-area-previews")>(
    "@/lib/api/unit-area-previews",
  );
  return { ...actual, getUnitAreaPreviews: mockGetUnitAreaPreviews };
});
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForCenter: mockGetSpotlightCardsForCenter,
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isCenterProgramPagesEnabled: () => mockProgramPagesEnabled(),
}));
vi.mock("@/lib/center-collaboration/flags", () => ({
  isCenterCollaborationNetworkEnabled: () => false,
}));
// Heavy client components — irrelevant to the leadership grid under test,
// stubbed exactly as `department-page-leader-render.test.tsx` stubs its own.
vi.mock("@/components/center/center-members-client", () => ({
  CenterMembersClient: () => <div data-testid="mock-members-client" />,
}));
vi.mock("@/components/center/center-collaboration-tab", () => ({
  CenterCollaborationTab: () => <div data-testid="mock-collaboration-tab" />,
}));
vi.mock("@/components/center/center-tabs", () => ({
  CenterTabs: () => <div data-testid="mock-center-tabs" />,
}));
vi.mock("@/components/department/dept-publications-list", () => ({
  DeptPublicationsList: () => <div data-testid="mock-pubs-list" />,
}));
vi.mock("@/components/department/dept-grants-list", () => ({
  DeptGrantsList: () => <div data-testid="mock-grants-list" />,
}));
vi.mock("@/components/shared/spotlight", () => ({
  Spotlight: () => <div data-testid="mock-spotlight" />,
}));

import { CenterPage } from "@/components/center/center-page";

const FACULTY_PAGE = {
  hits: [],
  total: 0,
  page: 0,
  pageSize: 20,
};

function leader(cwid: string, roleLabel: string) {
  return {
    cwid,
    preferredName: `Leader ${cwid}`,
    primaryTitle: "Professor of Medicine",
    slug: `leader-${cwid}`,
    identityImageEndpoint: `https://example.test/${cwid}.png`,
    roleLabel,
    isInterim: false,
  };
}

function baseDetail(leadership: ReturnType<typeof leader>[]) {
  return {
    code: "meyer_cancer_center",
    name: "Meyer Cancer Center",
    slug: "meyer-cancer-center",
    description: null,
    url: null,
    leadership,
    scholarCount: 42,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCenterTopResearchAreas.mockResolvedValue([]);
  mockGetSpotlightCardsForCenter.mockResolvedValue(null);
  mockGetCenterPublicationsList.mockResolvedValue(FACULTY_PAGE);
  mockGetCenterGrantsList.mockResolvedValue(FACULTY_PAGE);
  mockGetCenterPublicationCount.mockResolvedValue(0);
  mockGetCenterGrantCount.mockResolvedValue(0);
  mockGetUnitAreaPreviews.mockResolvedValue({});
  mockGetCenterMembers.mockResolvedValue(FACULTY_PAGE);
  mockGetCenterPrograms.mockResolvedValue([]);
  mockCenterHasPrograms.mockResolvedValue(false);
  mockProgramPagesEnabled.mockReturnValue(false);
});

describe("CenterPage — leadership grid layout (4+ leaders only)", () => {
  it("4 leaders: wraps in a 2-column grid, all 4 cards carry the mt-0/max-w-none override", async () => {
    mockGetCenter.mockResolvedValue(
      baseDetail([
        leader("ldr001", "Director"),
        leader("ldr002", "Co-Director"),
        leader("ldr003", "Associate Director"),
        leader("ldr004", "Associate Director"),
      ]),
    );
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    const grid = container.querySelector(".grid.sm\\:grid-cols-2");
    expect(grid).not.toBeNull();
    // Each LeaderCard's own wrapper (the whole-card profile link, Unit Page v2)
    // carries mt-0/max-w-none (the override), not the default
    // mt-[22px]/max-w-[460px] — confirms the grid's direct children are the
    // four overridden cards. (Walk `children` rather than a `:scope >`
    // selector: nwsapi expands `:scope` from the grid's own class string, and
    // its `mt-[22px]` brackets make that an invalid selector.)
    const children = Array.from(grid!.children);
    expect(children.length).toBe(4);
    const cards = children.filter(
      (el) => el.classList.contains("mt-0") && el.classList.contains("max-w-none"),
    );
    expect(cards.length).toBe(4);
  });

  it("2 leaders: no grid wrapper — cards render stacked, keeping default mt-[22px]/max-w-[460px]", async () => {
    mockGetCenter.mockResolvedValue(
      baseDetail([leader("ldr001", "Director"), leader("ldr002", "Co-Director")]),
    );
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector(".grid.sm\\:grid-cols-2")).toBeNull();
    const cards = container.querySelectorAll(".mt-\\[22px\\].max-w-\\[460px\\]");
    expect(cards.length).toBe(2);
  });

  it("3 leaders: still below the threshold — no grid wrapper", async () => {
    mockGetCenter.mockResolvedValue(
      baseDetail([
        leader("ldr001", "Director"),
        leader("ldr002", "Co-Director"),
        leader("ldr003", "Associate Director"),
      ]),
    );
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector(".grid.sm\\:grid-cols-2")).toBeNull();
    const cards = container.querySelectorAll(".mt-\\[22px\\].max-w-\\[460px\\]");
    expect(cards.length).toBe(3);
  });

  it("renders no leadership cards or grid wrapper at all when leadership is empty", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector(".grid.sm\\:grid-cols-2")).toBeNull();
    expect(container.querySelectorAll(".mt-\\[22px\\].max-w-\\[460px\\]").length).toBe(0);
  });
});

describe("CenterPage — Unit Page v2 hero", () => {
  it("breadcrumb reads Departments & Centers → /browse#centers", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    render(await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }));
    expect(
      screen.getByRole("link", { name: "Departments & Centers" }).getAttribute("href"),
    ).toBe("/browse#centers");
  });

  it("program chips sit in the hero with roster member counts + a 'N programs' stat", async () => {
    mockProgramPagesEnabled.mockReturnValue(true);
    mockGetCenter.mockResolvedValue(baseDetail([]));
    mockGetCenterPrograms.mockResolvedValue([
      { code: "CB", label: "Cancer Biology" },
      { code: "CT", label: "Cancer Therapeutics" },
    ]);
    mockGetCenterMembers.mockResolvedValue({
      mode: "grouped",
      total: 3,
      groups: [
        { code: "CB", label: "Cancer Biology", members: [{ cwid: "a" }, { cwid: "b" }] },
        { code: "CT", label: "Cancer Therapeutics", members: [{ cwid: "c" }] },
      ],
    });
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    const section = container.querySelector("section")!;
    const chip = screen.getByRole("link", { name: /Cancer Biology/ });
    expect(section.contains(chip)).toBe(true);
    expect(chip.getAttribute("href")).toBe("/centers/meyer-cancer-center/programs/CB");
    expect(chip.textContent).toContain("2");
    expect(screen.getByRole("link", { name: "2 programs" }).getAttribute("href")).toBe(
      "#subunits",
    );
    expect(screen.getByRole("link", { name: "42 scholars" }).getAttribute("href")).toBe(
      "/centers/meyer-cancer-center#people",
    );
  });

  it("keeps the 'Membership data pending' fallback when both counts are 0", async () => {
    mockGetCenter.mockResolvedValue({ ...baseDetail([]), scholarCount: 0 });
    render(await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }));
    expect(screen.getByText("Membership data pending")).toBeTruthy();
  });
});


describe("CenterPage — Grants tab", () => {
  it("tab=grants renders the grants list and loads the requested page + sort", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    const { container } = render(
      await CenterPage({
        centerSlug: "meyer-cancer-center",
        page: 3,
        tab: "grants",
        sort: "end_date",
      }),
    );
    expect(container.querySelector('[data-testid="mock-grants-list"]')).not.toBeNull();
    expect(mockGetCenterGrantsList).toHaveBeenCalledWith("meyer_cancer_center", {
      page: 2,
      sort: "end_date",
    });
  });

  it("scholars tab loads only the count loaders — no page of publication or grant cards", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    mockGetCenterPublicationCount.mockResolvedValue(7);
    mockGetCenterGrantCount.mockResolvedValue(3);
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector('[data-testid="mock-grants-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="mock-pubs-list"]')).toBeNull();
    expect(mockGetCenterGrantsList).not.toHaveBeenCalled();
    expect(mockGetCenterPublicationsList).not.toHaveBeenCalled();
    expect(mockGetCenterPublicationCount).toHaveBeenCalledWith("meyer_cancer_center");
    expect(mockGetCenterGrantCount).toHaveBeenCalledWith("meyer_cancer_center");
    // The hero stat reads the count loader.
    expect(container.textContent).toContain("7");
  });

  it("tab=publications loads the requested page; the stat still reads the unfiltered count", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    mockGetCenterPublicationCount.mockResolvedValue(9);
    render(
      await CenterPage({
        centerSlug: "meyer-cancer-center",
        page: 2,
        tab: "publications",
        sort: "most_cited",
        area: { id: "topic_a", label: "Topic A" },
      }),
    );
    expect(mockGetCenterPublicationsList).toHaveBeenCalledTimes(1);
    expect(mockGetCenterPublicationsList).toHaveBeenCalledWith("meyer_cancer_center", {
      page: 1,
      sort: "most_cited",
      area: "topic_a",
    });
    expect(mockGetCenterPublicationCount).toHaveBeenCalledTimes(1);
  });
});

describe("CenterPage — research-area previews", () => {
  it("starts the previews as soon as the area rollup resolves, not after every other loader", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    mockGetCenterTopResearchAreas.mockResolvedValue([
      { topicId: "topic_a", topicLabel: "Topic A", topicSlug: "topic_a", pubCount: 5 },
    ]);
    // A slow sibling loader: the previews must be requested before it settles.
    let releaseSpotlight: (v: null) => void = () => {};
    mockGetSpotlightCardsForCenter.mockReturnValue(
      new Promise<null>((resolve) => {
        releaseSpotlight = resolve;
      }),
    );
    const pagePromise = CenterPage({ centerSlug: "meyer-cancer-center", page: 1 });
    await vi.waitFor(() => expect(mockGetUnitAreaPreviews).toHaveBeenCalled());
    expect(mockGetUnitAreaPreviews).toHaveBeenCalledWith("center", "meyer_cancer_center", [
      "topic_a",
    ]);
    releaseSpotlight(null);
    await pagePromise;
  });
});
