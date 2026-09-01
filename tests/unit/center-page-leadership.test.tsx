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
import { render } from "@testing-library/react";

const {
  mockGetCenter,
  mockGetCenterMembers,
  mockGetCenterPrograms,
  mockGetCenterPublicationsList,
  mockGetCenterTopResearchAreas,
  mockCenterHasPrograms,
  mockGetSpotlightCardsForCenter,
} = vi.hoisted(() => ({
  mockGetCenter: vi.fn(),
  mockGetCenterMembers: vi.fn(),
  mockGetCenterPrograms: vi.fn(),
  mockGetCenterPublicationsList: vi.fn(),
  mockGetCenterTopResearchAreas: vi.fn(),
  mockCenterHasPrograms: vi.fn(),
  mockGetSpotlightCardsForCenter: vi.fn(),
}));

vi.mock("@/lib/api/centers", () => ({
  getCenter: mockGetCenter,
  getCenterMembers: mockGetCenterMembers,
  getCenterPrograms: mockGetCenterPrograms,
  getCenterPublicationsList: mockGetCenterPublicationsList,
  getCenterTopResearchAreas: mockGetCenterTopResearchAreas,
  centerHasPrograms: mockCenterHasPrograms,
}));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForCenter: mockGetSpotlightCardsForCenter,
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isCenterProgramPagesEnabled: () => false,
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
  mockGetCenterMembers.mockResolvedValue(FACULTY_PAGE);
  mockGetCenterPrograms.mockResolvedValue([]);
  mockCenterHasPrograms.mockResolvedValue(false);
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
    // Each LeaderCard's own wrapper div carries mt-0/max-w-none (the override),
    // not the default mt-6/max-w-[460px] — confirms the grid's direct children
    // are the four overridden cards.
    const cards = grid!.querySelectorAll(":scope > div.mt-0.max-w-none");
    expect(cards.length).toBe(4);
  });

  it("2 leaders: no grid wrapper — cards render stacked, keeping default mt-6/max-w-[460px]", async () => {
    mockGetCenter.mockResolvedValue(
      baseDetail([leader("ldr001", "Director"), leader("ldr002", "Co-Director")]),
    );
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector(".grid.sm\\:grid-cols-2")).toBeNull();
    const cards = container.querySelectorAll("div.mt-6.max-w-\\[460px\\]");
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
    const cards = container.querySelectorAll("div.mt-6.max-w-\\[460px\\]");
    expect(cards.length).toBe(3);
  });

  it("renders no leadership cards or grid wrapper at all when leadership is empty", async () => {
    mockGetCenter.mockResolvedValue(baseDetail([]));
    const { container } = render(
      await CenterPage({ centerSlug: "meyer-cancer-center", page: 1 }),
    );
    expect(container.querySelector(".grid.sm\\:grid-cols-2")).toBeNull();
    expect(container.querySelectorAll("div.mt-6.max-w-\\[460px\\]").length).toBe(0);
  });
});
