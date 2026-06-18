/**
 * #1105 — `CenterProgramPage` server component gates + render.
 *
 *  - flag off → notFound (no loader call);
 *  - loader returns null (ZY / unknown / suppressed) → notFound;
 *  - valid program → renders the hero (label, description) + leader + members.
 *
 * Child components (LeaderCard, PersonRow, Breadcrumb) are mocked — they have
 * their own tests — so this file asserts the page's gating + composition.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockNotFound, mockGetCenterProgram, mockFlag } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockGetCenterProgram: vi.fn(),
  mockFlag: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));
vi.mock("@/lib/api/centers", () => ({ getCenterProgram: mockGetCenterProgram }));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isCenterProgramPagesEnabled: mockFlag,
}));
vi.mock("@/components/scholar/leader-card", () => ({
  LeaderCard: ({ role }: { role: string }) => <div data-testid="leader-card">{role}</div>,
}));
// #1105 — the roster is delegated to the center's facet client (reused with
// `singleProgram`); mock it and assert composition. Its internals (facets,
// header-hiding) are covered by center-members-grouped.test.tsx.
vi.mock("@/components/center/center-members-client", () => ({
  CenterMembersClient: ({
    result,
    singleProgram,
  }: {
    result: { groups: { members: { cwid: string }[] }[] };
    singleProgram?: boolean;
  }) => (
    <div data-testid="members-client" data-single={String(!!singleProgram)}>
      {result.groups[0].members.map((m) => (
        <span key={m.cwid} data-testid="member">
          {m.cwid}
        </span>
      ))}
    </div>
  ),
}));
vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
  BreadcrumbList: ({ children }: { children: React.ReactNode }) => <ol>{children}</ol>,
  BreadcrumbItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  BreadcrumbLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  BreadcrumbPage: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  BreadcrumbSeparator: () => <span>/</span>,
}));

import { CenterProgramPage } from "@/components/center-program/program-page";

const DETAIL = {
  center: { code: "MEYER", name: "Meyer Cancer Center", slug: "meyer-cancer-center" },
  program: { code: "CB", label: "Cancer Biology", description: "Studies cancer biology." },
  leader: {
    cwid: "lead001",
    preferredName: "Dana Leader",
    slug: "dana-leader",
    primaryTitle: "Professor",
    identityImageEndpoint: "/img",
    isInterim: false,
  },
  members: [
    { cwid: "a", preferredName: "A", slug: "a", primaryTitle: null, divisionName: null, departmentName: "Medicine", identityImageEndpoint: "/i", roleCategory: "Faculty", overview: null, pubCount: 0, grantCount: 0, membershipType: "research" as const },
  ],
  scholarCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFlag.mockReturnValue(true);
  mockGetCenterProgram.mockResolvedValue(DETAIL);
});

describe("CenterProgramPage (#1105)", () => {
  it("notFound when the flag is off (no loader call)", async () => {
    mockFlag.mockReturnValue(false);
    await expect(CenterProgramPage({ centerSlug: "meyer-cancer-center", code: "CB" })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockGetCenterProgram).not.toHaveBeenCalled();
  });

  it("notFound when the loader returns null (ZY / unknown / suppressed)", async () => {
    mockGetCenterProgram.mockResolvedValueOnce(null);
    await expect(CenterProgramPage({ centerSlug: "meyer-cancer-center", code: "ZY" })).rejects.toThrow(
      "__NOTFOUND__",
    );
  });

  it("renders the program hero, leader, and members (via the singleProgram facet client)", async () => {
    const ui = await CenterProgramPage({ centerSlug: "meyer-cancer-center", code: "CB" });
    render(ui);
    // getBy* throws when absent, so these are existence assertions.
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
    expect(screen.getByText("Studies cancer biology.")).toBeTruthy();
    expect(screen.getByTestId("leader-card").textContent).toBe("Leader");
    // roster delegated to CenterMembersClient in single-program mode.
    expect(screen.getByTestId("members-client").getAttribute("data-single")).toBe("true");
    expect(screen.getByTestId("member").textContent).toBe("a");
  });

  it("renders the empty state (not the facet client) when the program has no members", async () => {
    mockGetCenterProgram.mockResolvedValueOnce({ ...DETAIL, members: [], scholarCount: 0 });
    const ui = await CenterProgramPage({ centerSlug: "meyer-cancer-center", code: "CB" });
    render(ui);
    expect(screen.getByText("No members listed for this program.")).toBeTruthy();
    expect(screen.queryByTestId("members-client")).toBeNull();
  });

  it("labels the leader as Interim Leader when isInterim", async () => {
    mockGetCenterProgram.mockResolvedValueOnce({
      ...DETAIL,
      leader: { ...DETAIL.leader, isInterim: true },
    });
    const ui = await CenterProgramPage({ centerSlug: "meyer-cancer-center", code: "CB" });
    render(ui);
    expect(screen.getByTestId("leader-card").textContent).toBe("Interim Leader");
  });
});
