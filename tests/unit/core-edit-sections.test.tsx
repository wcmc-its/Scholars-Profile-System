/**
 * `components/edit/core-edit-sections.tsx` — the single-scroll core editor's
 * page shape (Edit Org Unit mockup, Core variant): which sections render, the
 * rail stats and their amber states, the "Cores" breadcrumb, the Hidden pill,
 * the review banner, and legacy `?attr=` mapping. The live cards are stubbed so
 * the test isolates the layout. Every query is scoped to the rendered
 * component, never `document.body`. Fake cores and people only.
 */
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

const { mockLeaderCard, mockAccessCard } = vi.hoisted(() => ({
  mockLeaderCard: vi.fn(),
  mockAccessCard: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/edit/console-top-bar", () => ({ ConsoleTopBar: () => null }));
vi.mock("@/components/edit/core-basics-section", () => ({
  CoreBasicsSection: () => <div data-testid="panel-core-basics" />,
}));
vi.mock("@/components/edit/core-leader-card", () => ({
  CoreLeaderCard: (props: Record<string, unknown>) => {
    mockLeaderCard(props);
    return <div data-testid="panel-core-leaders" />;
  },
}));
vi.mock("@/components/edit/unit-access-card", () => ({
  UnitAccessCard: (props: Record<string, unknown>) => {
    mockAccessCard(props);
    return <div data-testid="panel-access" />;
  },
}));

import { CoreEditSections, type CoreEditSectionsProps } from "@/components/edit/core-edit-sections";

const LEADER = {
  cwid: "fak0001",
  name: "Test Leader",
  title: null,
  role: "director",
  interim: false,
  sortOrder: 0,
};

function props(over: Partial<CoreEditSectionsProps> = {}): CoreEditSectionsProps {
  return {
    core: {
      id: "99",
      name: "Example Imaging Core",
      description: "Imaging services.",
      url: null,
      visible: true,
      staffCount: 4,
      staffTrackedCount: 3,
    },
    leaders: [LEADER],
    roleLabels: { director: "Director" },
    access: [],
    actorCwid: "fak0002",
    actorRole: "owner",
    pending: { total: 2323, strong: 418 },
    coresNavVisible: true,
    ...over,
  };
}

function renderSections(over: Partial<CoreEditSectionsProps> = {}) {
  const { container } = render(<CoreEditSections {...props(over)} />);
  return within(container);
}

const sectionIds = (view: ReturnType<typeof renderSections>) =>
  view
    .getAllByTestId(/^unit-section-/)
    .filter((el) => el.tagName === "SECTION")
    .map((el) => el.id);

const navStat = (view: ReturnType<typeof renderSections>, id: string) =>
  view.getByTestId(`section-nav-${id}`).querySelector("span:last-child");

describe("CoreEditSections — page shape", () => {
  it("renders Basics, Leadership, Staff, Access in order — no Members, Retire or Profile URL", () => {
    const view = renderSections();
    expect(sectionIds(view)).toEqual(["basics", "leadership", "staff", "access"]);
    expect(view.queryByTestId("unit-section-members")).toBeNull();
    expect(view.queryByTestId("unit-section-retire")).toBeNull();
    expect(view.queryByText("Profile URL")).toBeNull();
  });

  it("omits Access when the viewer can't manage it (access null)", () => {
    mockAccessCard.mockClear();
    const view = renderSections({ access: null });
    expect(sectionIds(view)).toEqual(["basics", "leadership", "staff"]);
    expect(mockAccessCard).not.toHaveBeenCalled();
  });

  it("wires the leader card and the core access card", () => {
    mockAccessCard.mockClear();
    renderSections();
    expect(mockLeaderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        coreId: "99",
        leaders: [LEADER],
        roleLabels: { director: "Director" },
      }),
    );
    expect(mockAccessCard).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "core", entityId: "99", headingId: "access-heading" }),
    );
  });

  it("heading: core name, Core chip, role note, and a Cores crumb back to /edit/core", () => {
    const view = renderSections();
    expect(view.getByTestId("unit-edit-title").textContent).toBe("Example Imaging Core");
    expect(view.getByTestId("unit-edit-kind").textContent).toBe("Core");
    expect(view.getByTestId("unit-edit-actor-note").textContent).toContain(
      "Editing as administrator (Owner)",
    );
    const crumb = view.getByTestId("edit-subnav-units");
    expect(crumb.textContent).toBe("Cores");
    expect(crumb.getAttribute("href")).toBe("/edit/core");
    expect(view.queryByText("Org units")).toBeNull();
    expect(view.queryByTestId("unit-edit-crumb")).toBeNull();
  });

  it("the Cores crumb is plain text without the cores-tab grant", () => {
    const view = renderSections({ coresNavVisible: false });
    expect(view.queryByTestId("edit-subnav-units")).toBeNull();
    expect(view.getByText("Cores").tagName).toBe("SPAN");
  });

  it("the Hidden pill shows only while the core isn't listed", () => {
    expect(renderSections().queryByTestId("core-hidden-pill")).toBeNull();
    const hidden = renderSections({ core: { ...props().core, visible: false } });
    expect(hidden.getByTestId("core-hidden-pill").textContent).toBe("Hidden from public pages");
  });

  it("Preview profile shows only when the page passes an href; no View reports", () => {
    expect(renderSections().queryByTestId("edit-preview-link")).toBeNull();
    const view = renderSections({ previewHref: "/cores/99" });
    expect(view.getByTestId("edit-preview-link").getAttribute("href")).toBe("/cores/99");
    expect(view.queryByTestId("edit-reports-link")).toBeNull();
  });

  it("the review banner links to /review with strong + total counts", () => {
    const view = renderSections();
    const banner = view.getByTestId("core-review-link");
    expect(banner.getAttribute("href")).toBe("/edit/core/99/review");
    expect(within(banner).getByTestId("core-review-strong").textContent).toBe("418");
    expect(within(banner).getByTestId("core-review-total").textContent).toBe("2,323");
  });

  it("an empty queue says so and shows no counts", () => {
    const view = renderSections({ pending: { total: 0, strong: 0 } });
    const banner = view.getByTestId("core-review-link");
    expect(banner.textContent).toContain("No publications pending review");
    expect(within(banner).queryByTestId("core-review-strong")).toBeNull();
  });

  it("legacy ?attr= links map to the section that now holds them", () => {
    // `details` was the old Basics panel; an unknown value maps to nothing.
    for (const [attr, id] of [
      ["details", "basics"],
      ["leadership", "leadership"],
      ["access", "access"],
    ]) {
      const view = renderSections({ attr });
      expect(view.getByTestId(`section-nav-${id}`).getAttribute("aria-current")).toBe("location");
    }
  });
});

describe("CoreEditSections — rail stats", () => {
  it("counts: leaders, staff listed, access rows; no Basics nudge with a description", () => {
    const view = renderSections({
      access: [
        {
          cwid: "fak0003",
          name: "Test Admin",
          title: null,
          role: "curator",
          grantedBy: null,
          grantedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    expect(navStat(view, "basics")?.textContent).toBe("Basics");
    expect(navStat(view, "leadership")?.textContent).toBe("1");
    expect(navStat(view, "staff")?.textContent).toBe("4");
    expect(navStat(view, "access")?.textContent).toBe("1");
    expect(navStat(view, "leadership")?.className).not.toContain("text-apollo-amber");
  });

  it("amber 'No description' and amber leadership 'None'", () => {
    const view = renderSections({ core: { ...props().core, description: "  " }, leaders: [] });
    const basics = navStat(view, "basics");
    expect(basics?.textContent).toBe("No description");
    expect(basics?.className).toContain("text-apollo-amber");
    const leadership = navStat(view, "leadership");
    expect(leadership?.textContent).toBe("None");
    expect(leadership?.className).toContain("text-apollo-amber");
  });
});

describe("CoreEditSections — Staff summary", () => {
  const staff = (staffCount: number | null, staffTrackedCount: number | null) => {
    const view = renderSections({ core: { ...props().core, staffCount, staffTrackedCount } });
    const section = within(view.getByTestId("unit-section-staff"));
    return { view, section };
  };

  it("N listed · M tracked, with the untracked gap noted", () => {
    const { section } = staff(4, 3);
    expect(section.getByText(/People who run the core’s services/)).toBeTruthy();
    expect(section.getByTestId("core-staff-counts").textContent).toBe("4 listed · 3 tracked");
    expect(section.getByTestId("core-staff-note").textContent).toContain("1 untracked");
  });

  it("no staff feed (null) is amber 'Not listed', not zero", () => {
    const { view, section } = staff(null, null);
    expect(section.getByTestId("core-staff-counts").textContent).toBe("Not listed");
    expect(section.getByTestId("core-staff-note").textContent).toContain("No staff feed");
    expect(navStat(view, "staff")?.textContent).toBe("Not listed");
    expect(navStat(view, "staff")?.className).toContain("text-apollo-amber");
  });

  it("listed but none tracked warns the co-author signal can't fire", () => {
    const { view, section } = staff(5, 0);
    expect(section.getByTestId("core-staff-counts").textContent).toBe("5 listed · 0 tracked");
    expect(section.getByTestId("core-staff-note").textContent).toContain(
      "Co-author signal can’t fire",
    );
    expect(navStat(view, "staff")?.className).toContain("text-apollo-amber");
  });

  it("fully tracked has no note", () => {
    const { section } = staff(3, 3);
    expect(section.queryByTestId("core-staff-note")).toBeNull();
  });
});
