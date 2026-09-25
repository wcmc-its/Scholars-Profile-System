/**
 * `components/edit/unit-edit-page.tsx` — which sections the single-scroll unit
 * editor renders for a given `(unitType, actorRole, source)` (Edit Center /
 * Edit Org Unit mockups, 2026-09-25; the section gates are the #540 Phase 7
 * attribute predicates the old rail used), plus the full-width `?attr=roster`
 * Members page. The live cards are mocked to lightweight stubs so the test
 * isolates the router's logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockRosterExportEnabled, mockBasics, mockSectionNav, mockFacultyExport } = vi.hoisted(
  () => ({
    mockRosterExportEnabled: vi.fn(),
    mockBasics: vi.fn(),
    mockSectionNav: vi.fn(),
    mockFacultyExport: vi.fn(),
  }),
);

// EditShell's account menu / rail children read the app-router context;
// stub it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The roster-export flag gates the dept/division "Members" section; drive it per-test.
vi.mock("@/lib/edit/unit-roster-export", () => ({
  isUnitRosterExportEnabled: mockRosterExportEnabled,
}));
// Async server component (reads db.read) — stub to a sync panel in the router test.
vi.mock("@/components/edit/unit-faculty-export-card", () => ({
  UnitFacultyExportCard: (props: Record<string, unknown>) => {
    mockFacultyExport(props);
    return <div data-testid="panel-faculty-export" />;
  },
}));
// Async server loader (reads db.read) — stub.
vi.mock("@/components/edit/ctsc-feed-issues-panel", () => ({
  CtscFeedIssuesPanel: () => <div data-testid="panel-feed-issues" />,
}));

beforeEach(() => {
  mockRosterExportEnabled.mockReturnValue(false);
  mockBasics.mockClear();
  mockSectionNav.mockClear();
  mockFacultyExport.mockClear();
});

vi.mock("@/components/edit/unit-basics-section", () => ({
  UnitBasicsSection: (props: Record<string, unknown>) => {
    mockBasics(props);
    return <div data-testid="panel-basics" />;
  },
}));
vi.mock("@/components/edit/unit-section-nav", () => ({
  UnitSectionNav: (props: {
    items: Array<{ id: string; label: string; stat?: string; warn?: boolean }>;
    initialSection?: string;
  }) => {
    mockSectionNav(props);
    return (
      <nav aria-label="Sections">
        {props.items.map((i) => (
          <a key={i.id} href={`#${i.id}`} data-testid={`section-nav-${i.id}`}>
            {i.label} {i.stat}
          </a>
        ))}
      </nav>
    );
  },
}));
vi.mock("@/components/edit/unit-leader-card", () => ({
  UnitLeaderCard: () => <div data-testid="panel-leader" />,
}));
vi.mock("@/components/edit/center-leadership-card", () => ({
  CenterLeadershipCard: () => <div data-testid="panel-center-leadership" />,
}));
vi.mock("@/components/edit/unit-access-card", () => ({
  UnitAccessCard: () => <div data-testid="panel-access" />,
}));
vi.mock("@/components/edit/unit-retire-card", () => ({
  UnitRetireCard: () => <div data-testid="panel-retire" />,
}));
vi.mock("@/components/edit/unit-roster-card", () => ({
  UnitRosterCard: () => <div data-testid="panel-roster" />,
}));
vi.mock("@/components/edit/center-roster-card", () => ({
  CenterRosterCard: () => <div data-testid="panel-center-roster" />,
}));
vi.mock("@/components/edit/center-program-card", () => ({
  CenterProgramCard: () => <div data-testid="panel-center-program" />,
}));

import { UnitEditPage } from "@/components/edit/unit-edit-page";
import type { UnitActorRole, UnitEditContext } from "@/lib/api/unit-edit-context";

function ctx(over: {
  unitType?: UnitEditContext["unit"]["unitType"];
  actorRole?: UnitActorRole;
  source?: "ED" | "manual";
  siblings?: UnitEditContext["siblingDivisions"];
  access?: UnitEditContext["access"];
  suppression?: UnitEditContext["unit"]["suppression"];
  programs?: UnitEditContext["programs"];
  roster?: UnitEditContext["roster"];
  centerLeadership?: UnitEditContext["centerLeadership"];
  description?: string | null;
  leader?: Partial<UnitEditContext["unit"]["leader"]>;
}): UnitEditContext {
  const unitType = over.unitType ?? "department";
  return {
    unit: {
      unitType,
      code: "N1280",
      name: "Medicine",
      description: over.description === undefined ? "blurb" : over.description,
      url: null,
      slug: "medicine",
      slugOverride: null,
      deptCode: unitType === "division" ? "N1000" : null,
      deptName: unitType === "division" ? "Parent" : null,
      deptSlug: unitType === "division" ? "parent" : null,
      source: over.source ?? "ED",
      centerType: unitType === "center" ? "center" : null,
      overriddenFields: [],
      leader: {
        cwid: null,
        explicitVacancy: false,
        interim: false,
        name: null,
        title: null,
        ...over.leader,
      },
      suppression: over.suppression ?? null,
    },
    access: over.access ?? null,
    roster: over.roster ?? null,
    programs: over.programs ?? (unitType === "center" ? [] : null),
    centerLeadership: over.centerLeadership ?? (unitType === "center" ? [] : null),
    centerMembershipRoles: unitType === "center" ? [] : null,
    siblingDivisions: over.siblings ?? null,
    diseaseOptions: unitType === "center" ? [] : null,
    actorRole: over.actorRole ?? "curator",
    actorCwid: "act001",
  };
}

function sectionIds(): string[] {
  return screen
    .getAllByTestId(/^unit-section-/)
    .map((el) => el.getAttribute("id"))
    .filter((id): id is string => !!id);
}

function navItems(): Record<string, { stat?: string; warn?: boolean }> {
  const items = mockSectionNav.mock.calls.at(-1)?.[0].items as Array<{
    id: string;
    stat?: string;
    warn?: boolean;
  }>;
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

function member(
  cwid: string,
  over: Partial<NonNullable<UnitEditContext["roster"]>[number]> = {},
): NonNullable<UnitEditContext["roster"]>[number] {
  return {
    cwid,
    name: `Test Person ${cwid}`,
    title: null,
    source: "manual-ui",
    membershipType: "research",
    membershipRoleKey: "member",
    programCode: null,
    startDate: null,
    endDate: null,
    scholarState: "active",
    ...over,
  };
}

describe("UnitEditPage — section gating", () => {
  it("a Curator on a department sees Basics + Leadership only", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator" })} />);
    expect(sectionIds()).toEqual(["basics", "leadership"]);
    // A department's name is the directory's — locked in Basics.
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({
      unitType: "department",
      nameEditable: false,
      canEditSuperuserFields: false,
      urlPrefix: "/departments/",
    });
    expect(screen.getByTestId("panel-leader")).toBeTruthy();
  });

  it("an Owner on a department adds Access", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "owner", access: [] })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "access"]);
  });

  // 2026-08-26 policy widening (decision #3) — a comms_steward with no
  // unit_admin row of their own still gets Access: `actorRole` floors at
  // "curator" for them (unit-edit-context.ts), so visibility must key off
  // `ctx.access !== null` directly, not off `actorRole === "owner"`.
  it("a comms_steward (actorRole curator, access populated) still sees Access", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator", access: [] })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "access"]);
  });

  it("a Superuser on a department adds Retire and the superuser Basics fields", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "access", "retire"]);
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({
      canEditSuperuserFields: true,
      centerType: null,
    });
  });

  it("a Superuser on a center gets Members + Retire, and Center type inside Basics", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "members", "access", "retire"]);
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({
      unitType: "center",
      nameEditable: true,
      canEditSuperuserFields: true,
      centerType: "center",
      urlPrefix: "/centers/",
    });
    expect(screen.getByTestId("panel-center-leadership")).toBeTruthy();
    expect(screen.queryByTestId("panel-leader")).toBeNull();
  });

  it("a manual division gets Members (its roster) and an editable name; an ED division neither", () => {
    const { unmount } = render(
      <UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual" })} />,
    );
    expect(sectionIds()).toContain("members");
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({
      nameEditable: true,
      urlPrefix: "/departments/parent/divisions/",
    });
    unmount();
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "ED" })} />);
    expect(sectionIds()).not.toContain("members");
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({ nameEditable: false });
  });

  it("a center with a program taxonomy shows Programs (#1117); none hides it", () => {
    const withPrograms = ctx({
      unitType: "center",
      actorRole: "curator",
      programs: [{ code: "CB", label: "Cancer Biology", sortOrder: 10, description: null, leaders: [] }],
    });
    const { unmount } = render(<UnitEditPage ctx={withPrograms} />);
    expect(sectionIds()).toContain("programs");
    expect(screen.getByTestId("panel-center-program")).toBeTruthy();
    unmount();
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(sectionIds()).not.toContain("programs");
  });

  it("a department with divisions lists them in a Divisions section linking to each editor", () => {
    render(
      <UnitEditPage
        ctx={ctx({ siblings: [{ code: "N2856", name: "Test Division", slug: "test-division" }] })}
      />,
    );
    expect(sectionIds()).toEqual(["basics", "leadership", "divisions"]);
    expect(screen.getByTestId("sibling-division-N2856").getAttribute("href")).toBe(
      "/edit/division/N2856",
    );
    expect(navItems().divisions).toMatchObject({ stat: "1" });
  });
});

describe("UnitEditPage — Members", () => {
  it("a department gets a Members section (faculty count + export) when the export flag is on", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(<UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "members"]);
    expect(mockFacultyExport.mock.calls.at(-1)?.[0]).toMatchObject({
      unitType: "department",
      code: "N1280",
      manageHref: undefined,
    });
  });

  it("a department has NO Members section when the export flag is off", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} />);
    expect(sectionIds()).not.toContain("members");
  });

  it("a manual division with the flag on links its export section to the editable roster", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual" })} />);
    expect(mockFacultyExport.mock.calls.at(-1)?.[0]).toMatchObject({
      unitType: "division",
      manageHref: "/edit/division/N1280?attr=roster",
    });
  });

  it("a manual division with the flag off summarises its roster and links to it", () => {
    render(
      <UnitEditPage
        ctx={ctx({
          unitType: "division",
          actorRole: "curator",
          source: "manual",
          roster: [member("m1"), member("m2")],
        })}
      />,
    );
    expect(screen.getByTestId("unit-members-count").textContent).toBe("2");
    expect(screen.getByTestId("unit-members-manage").getAttribute("href")).toBe(
      "/edit/division/N1280?attr=roster",
    );
    expect(screen.queryByTestId("unit-members-export")).toBeNull();
  });

  it("a center's Members section counts active members and links to the roster + export", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage
        ctx={ctx({
          unitType: "center",
          actorRole: "curator",
          roster: [
            member("m1"),
            member("m2", { endDate: "2000-01-01" }), // ended
            member("m3", { membershipRoleKey: "invited" }), // invitee
            member("m4", { startDate: "2999-01-01" }), // pending
          ],
        })}
      />,
    );
    expect(screen.getByTestId("unit-members-count").textContent).toBe("1");
    expect(navItems().members).toMatchObject({ stat: "1" });
    expect(screen.getByTestId("unit-members-manage").getAttribute("href")).toBe(
      "/edit/center/N1280?attr=roster",
    );
    expect(screen.getByTestId("unit-members-export").getAttribute("href")).toBe(
      "/edit/center/N1280/export",
    );
  });

  it("the ?attr=roster page has no rail — just the panel and a way back", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} attr="roster" />,
    );
    expect(screen.queryByTestId("unit-section-basics")).toBeNull();
    expect(screen.getByTestId("edit-rail-back").getAttribute("href")).toBe("/edit/department/N1280");
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
  });

  it("an ED division's roster page is the faculty export only", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "division", actorRole: "curator", source: "ED" })}
        attr="roster"
      />,
    );
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
    expect(screen.queryByTestId("panel-roster")).toBeNull();
  });

  it("a manual division's roster page shows BOTH the editable roster and the export when on", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual", roster: [member("m1")] })}
        attr="roster"
      />,
    );
    expect(screen.getByTestId("panel-roster")).toBeTruthy();
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
  });

  it("a center renders the rich roster table on ?attr=roster", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })}
        attr="roster"
      />,
    );
    expect(screen.getByTestId("panel-center-roster")).toBeTruthy();
  });
});

describe("UnitEditPage — header, breadcrumb and nav", () => {
  it("renders the unit name as h1, the kind chip, and the actor role note", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "owner", access: [] })} />);
    expect(screen.getByRole("heading", { level: 1, name: "Medicine" })).toBeTruthy();
    expect(screen.getByTestId("unit-edit-kind").textContent).toBe("Department");
    expect(screen.getByTestId("unit-edit-actor-note").textContent).toMatch(
      /Editing as administrator \(Owner\)\. Changes are logged against your account\./,
    );
  });

  it("the crumb names the kind — or a division's parent department", () => {
    const { unmount } = render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.getByTestId("unit-edit-crumb").textContent).toBe("Departments");
    unmount();
    render(<UnitEditPage ctx={ctx({ unitType: "division" })} />);
    expect(screen.getByTestId("unit-edit-crumb").textContent).toBe("Parent");
    expect(screen.getByTestId("unit-edit-kind").textContent).toBe("Division");
  });

  it("'Org units' links back to /edit/units when the units-tab grant allows (dwd2001 bug #7)", () => {
    render(<UnitEditPage ctx={ctx({})} orgUnitsNavVisible />);
    expect(screen.getByTestId("edit-subnav-units").getAttribute("href")).toBe("/edit/units");
  });

  it("'Org units' is plain text without the grant", () => {
    render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.queryByTestId("edit-subnav-units")).toBeNull();
  });

  it("a center with a program taxonomy shows the header Reports link", () => {
    const withPrograms = ctx({
      unitType: "center",
      actorRole: "curator",
      programs: [{ code: "CB", label: "Cancer Biology", sortOrder: 10, description: null, leaders: [] }],
    });
    render(<UnitEditPage ctx={withPrograms} />);
    expect(screen.getByTestId("edit-reports-link").getAttribute("href")).toBe(
      "/edit/reports?center=N1280",
    );
  });

  it("a center with NO program taxonomy shows no Reports link", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(screen.queryByTestId("edit-reports-link")).toBeNull();
  });

  it("a department's Reports link carries its kind", () => {
    render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.getByTestId("edit-reports-link").getAttribute("href")).toBe(
      "/edit/reports?center=N1280&kind=department",
    );
  });

  it("nav stats: amber 'No description', leader count, vacancy", () => {
    const { unmount } = render(<UnitEditPage ctx={ctx({ description: "" })} />);
    expect(navItems().basics).toMatchObject({ stat: "No description", warn: true });
    expect(navItems().leadership).toMatchObject({ stat: "0", warn: true });
    unmount();
    render(<UnitEditPage ctx={ctx({ leader: { cwid: "l1", name: "Test Chair" } })} />);
    expect(navItems().basics.warn).toBe(false);
    expect(navItems().leadership).toMatchObject({ stat: "1", warn: false });
  });

  it("legacy ?attr= deep links scroll to the section that now holds them", () => {
    const { unmount } = render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="slug" />);
    expect(mockSectionNav.mock.calls.at(-1)?.[0].initialSection).toBe("basics");
    unmount();
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="access" />);
    expect(mockSectionNav.mock.calls.at(-1)?.[0].initialSection).toBe("access");
  });

  it("a retired ?attr=reports value still renders the sections page", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator" })} attr="reports" />);
    expect(screen.getByTestId("panel-basics")).toBeTruthy();
    expect(mockSectionNav.mock.calls.at(-1)?.[0].initialSection).toBeUndefined();
  });

  it("every section is labelled by a heading id of its own", () => {
    render(
      <UnitEditPage
        ctx={ctx({
          actorRole: "superuser",
          access: [],
          siblings: [{ code: "N2856", name: "Test Division", slug: "test-division" }],
        })}
      />,
    );
    const labels = screen
      .getAllByTestId(/^unit-section-/)
      .map((el) => el.getAttribute("aria-labelledby"));
    expect(labels).toEqual([
      "basics-heading",
      "leadership-heading",
      "divisions-heading",
      "access-heading",
      "retire-heading",
    ]);
  });
});

describe("UnitEditPage — retired read-through (edge 11)", () => {
  const retired = {
    suppression: { id: "sup1", suppressedAt: new Date("2026-05-01"), actorCwid: "su001" },
    actorRole: "superuser" as const,
    access: [],
  };

  it("a retired department shows the notice and ONLY the Retire section", () => {
    render(<UnitEditPage ctx={ctx({ ...retired })} attr="description" />);
    expect(screen.getByTestId("retired-notice")).toBeTruthy();
    expect(sectionIds()).toEqual(["retire"]);
    expect(screen.queryByTestId("panel-basics")).toBeNull();
    expect(screen.getByTestId("panel-retire")).toBeTruthy();
  });

  it("a retired center shows the notice and ONLY the Retire section", () => {
    render(<UnitEditPage ctx={ctx({ ...retired, unitType: "center" })} />);
    expect(screen.getByTestId("retired-notice")).toBeTruthy();
    expect(sectionIds()).toEqual(["retire"]);
  });

  it("a retired unit's roster page is read-only", () => {
    render(<UnitEditPage ctx={ctx({ ...retired, unitType: "center" })} attr="roster" />);
    expect(screen.getByTestId("retired-notice")).toBeTruthy();
    expect(screen.queryByTestId("panel-center-roster")).toBeNull();
  });
});
