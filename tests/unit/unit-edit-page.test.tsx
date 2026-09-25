/**
 * `components/edit/unit-edit-page.tsx` — the attribute-rail filtering + active
 * panel selection (#540 Phase 7). The three live cards are mocked to lightweight
 * stubs so the test isolates the router's `(unitType, actorRole, source)` logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockRosterExportEnabled } = vi.hoisted(() => ({ mockRosterExportEnabled: vi.fn() }));

// EditShell's account menu / rail children read the app-router context;
// stub it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The roster-export flag gates the dept/division "Members" tab; drive it per-test.
vi.mock("@/lib/edit/unit-roster-export", () => ({
  isUnitRosterExportEnabled: mockRosterExportEnabled,
}));
// Async server component (reads db.read) — stub to a sync panel in the router test.
vi.mock("@/components/edit/unit-faculty-export-card", () => ({
  UnitFacultyExportCard: () => <div data-testid="panel-faculty-export" />,
}));

beforeEach(() => {
  mockRosterExportEnabled.mockReturnValue(false);
});

vi.mock("@/components/edit/unit-description-card", () => ({
  UnitDescriptionCard: () => <div data-testid="panel-description" />,
}));
vi.mock("@/components/edit/unit-url-card", () => ({
  UnitUrlCard: () => <div data-testid="panel-url" />,
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
vi.mock("@/components/edit/unit-slug-card", () => ({
  UnitSlugCard: () => <div data-testid="panel-slug" />,
}));
vi.mock("@/components/edit/center-type-card", () => ({
  CenterTypeCard: () => <div data-testid="panel-center-type" />,
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
// The single-scroll center editor (Edit Center mockup, 2026-09-25).
const { mockBasics, mockSectionNav } = vi.hoisted(() => ({
  mockBasics: vi.fn(),
  mockSectionNav: vi.fn(),
}));
vi.mock("@/components/edit/center-basics-section", () => ({
  CenterBasicsSection: (props: Record<string, unknown>) => {
    mockBasics(props);
    return <div data-testid="panel-center-basics" />;
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
// Async server loader (reads db.read) — stub.
vi.mock("@/components/edit/ctsc-feed-issues-panel", () => ({
  CtscFeedIssuesPanel: () => <div data-testid="panel-feed-issues" />,
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
}): UnitEditContext {
  const unitType = over.unitType ?? "department";
  return {
    unit: {
      unitType,
      code: "N1280",
      name: "Medicine",
      description: "blurb",
      url: null,
      slug: "medicine",
      slugOverride: null,
      deptCode: unitType === "division" ? "N1000" : null,
      deptName: unitType === "division" ? "Parent" : null,
      deptSlug: unitType === "division" ? "parent" : null,
      source: over.source ?? "ED",
      centerType: unitType === "center" ? "center" : null,
      overriddenFields: [],
      leader: { cwid: null, explicitVacancy: false, interim: false, name: null, title: null },
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

function railKeys(): string[] {
  return screen
    .getAllByRole("link")
    .map((el) => el.getAttribute("data-testid"))
    .filter((id): id is string => !!id && id.startsWith("rail-"))
    .map((id) => id.replace("rail-", ""));
}

function sectionIds(): string[] {
  return screen
    .getAllByTestId(/^unit-section-/)
    .map((el) => el.getAttribute("id"))
    .filter((id): id is string => !!id);
}

describe("UnitEditPage — rail filtering", () => {
  it("a Curator on a department sees only description + url + leader", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator" })} />);
    expect(railKeys()).toEqual(["description", "url", "leader"]);
  });

  it("an Owner on a department adds access", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "owner", access: [] })} />);
    expect(railKeys()).toEqual(["description", "url", "leader", "access"]);
  });

  // 2026-08-26 policy widening (decision #3) — a comms_steward with no
  // unit_admin row of their own still gets the Access tab: `actorRole` floors
  // at "curator" for them (unit-edit-context.ts), so visibility must key off
  // `ctx.access !== null` directly, not off `actorRole === "owner"`.
  it("a comms_steward (actorRole curator, access populated) still sees Access", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator", access: [] })} />);
    expect(railKeys()).toEqual(["description", "url", "leader", "access"]);
  });

  it("a Superuser on a department adds slug + retire (but not center-type)", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} />);
    expect(railKeys()).toEqual(["description", "url", "leader", "access", "slug", "retire"]);
  });

  it("a Superuser on a center gets the single-scroll sections, Members + Retire included", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "members", "access", "retire"]);
    // Center type now lives inside Basics, editable for a Superuser.
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({ canEditSuperuserFields: true });
  });

  it("a manual division shows roster; an ED division does not", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual" })} />);
    expect(railKeys()).toContain("roster");
  });

  it("a center with a program taxonomy shows the Programs tab (#1117); empty hides it", () => {
    const withPrograms = ctx({
      unitType: "center",
      actorRole: "curator",
      programs: [{ code: "CB", label: "Cancer Biology", sortOrder: 10, description: null, leaders: [] }],
    });
    render(<UnitEditPage ctx={withPrograms} attr="programs" />);
    expect(sectionIds()).toContain("programs");
    expect(screen.getByTestId("panel-center-program")).toBeTruthy();
  });

  it("a center with NO programs hides the Programs section", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(sectionIds()).not.toContain("programs");
  });

  // Cancer Center reports consolidation — "reports" / "nci-2a" are no longer
  // in-page `?attr=` attributes; a header link carries the ONE external link
  // instead (`EditShell`'s `reportsHref`, Reports IA redesign 2026-08-14 —
  // replaced the earlier rail-mounted `CenterReportsRailLink` so the link
  // survives the roster/Members page, which hides the rail).
  it("a center with a program taxonomy shows the header Reports link, not an in-page attr", () => {
    const withPrograms = ctx({
      unitType: "center",
      actorRole: "curator",
      programs: [{ code: "CB", label: "Cancer Biology", sortOrder: 10, description: null, leaders: [] }],
    });
    render(<UnitEditPage ctx={withPrograms} />);
    // Not selectable in-page — the old two-case rail behavior is gone.
    expect(railKeys()).not.toContain("reports");
    expect(railKeys()).not.toContain("nci-2a");
    // The header link renders instead, pointing at the top-level console.
    const link = screen.getByTestId("edit-reports-link");
    expect(link.getAttribute("href")).toBe("/edit/reports?center=N1280");
  });

  it("a center with NO program taxonomy shows neither the in-page attrs nor the header Reports link", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(railKeys()).not.toContain("reports");
    expect(railKeys()).not.toContain("nci-2a");
    expect(screen.queryByTestId("edit-reports-link")).toBeNull();
  });

  it("a deep link to the retired ?attr=reports/?attr=nci-2a values falls back to the default panel", () => {
    // Neither key exists in ATTRIBUTES anymore, so `visible.find` misses and
    // `UnitEditPage` falls back to `DEFAULT_ATTR` ("description") rather than
    // rendering nothing — a stale bookmark degrades gracefully. (A department
    // still uses the one-panel rail.)
    render(<UnitEditPage ctx={ctx({ actorRole: "curator" })} attr="reports" />);
    expect(screen.getByTestId("panel-description")).toBeTruthy();
  });

  it("a center deep link to a retired attr still renders the whole sections page", () => {
    const withPrograms = ctx({
      unitType: "center",
      actorRole: "curator",
      programs: [{ code: "CB", label: "Cancer Biology", sortOrder: 10, description: null, leaders: [] }],
    });
    render(<UnitEditPage ctx={withPrograms} attr="reports" />);
    expect(screen.getByTestId("panel-center-basics")).toBeTruthy();
    expect(mockSectionNav.mock.calls.at(-1)?.[0].initialSection).toBeUndefined();
  });

  it("an ED division has no roster row", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "ED" })} />);
    expect(railKeys()).not.toContain("roster");
  });

  it("a department gets a Members tab (faculty export) when the export flag is on, reachable from the rail", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(<UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} />);
    expect(railKeys()).toContain("roster");
  });

  it("the Members page itself has no rail (hideRail) — just the panel and a way back", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} attr="roster" />,
    );
    expect(railKeys()).toEqual([]);
    expect(screen.getByTestId("edit-rail-back")).toBeTruthy();
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
  });

  it("a department has NO Members tab when the export flag is off", () => {
    mockRosterExportEnabled.mockReturnValue(false);
    render(<UnitEditPage ctx={ctx({ unitType: "department", actorRole: "curator" })} />);
    expect(railKeys()).not.toContain("roster");
  });

  it("an ED division gets the faculty-export Members tab (no editable roster) when on", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "division", actorRole: "curator", source: "ED" })}
        attr="roster"
      />,
    );
    // On the Members page itself the rail is hidden (hideRail) — a back link
    // stands in for it, not the rail.
    expect(railKeys()).toEqual([]);
    expect(screen.getByTestId("edit-rail-back")).toBeTruthy();
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
    expect(screen.queryByTestId("panel-roster")).toBeNull();
  });

  it("a manual division shows BOTH the editable roster and the faculty export when on", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(
      <UnitEditPage
        ctx={ctx({
          unitType: "division",
          actorRole: "curator",
          source: "manual",
          roster: [
            { cwid: "m1", name: "M One", title: null, source: "manual-ui", membershipType: null, programCode: null, startDate: null, endDate: null, scholarState: "active" as const },
          ],
        })}
        attr="roster"
      />,
    );
    expect(screen.getByTestId("panel-roster")).toBeTruthy();
    expect(screen.getByTestId("panel-faculty-export")).toBeTruthy();
  });
});

describe("UnitEditPage — Org units breadcrumb (dwd2001 bug #7)", () => {
  it("forwards orgUnitsNavVisible={true} to EditShell's navigable 'Org units' crumb", () => {
    render(<UnitEditPage ctx={ctx({})} orgUnitsNavVisible={true} />);
    const link = screen.getByTestId("edit-subnav-units");
    expect(link.getAttribute("href")).toBe("/edit/units");
  });

  it("defaults to the flat, non-navigable label when orgUnitsNavVisible is omitted", () => {
    render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.queryByTestId("edit-subnav-units")).toBeNull();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb.textContent).toBe("Medicine");
  });
});

describe("UnitEditPage — active panel selection", () => {
  it("defaults to the description panel", () => {
    render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.getByTestId("panel-description")).toBeTruthy();
  });

  it("honors ?attr=url (#1021)", () => {
    render(<UnitEditPage ctx={ctx({})} attr="url" />);
    expect(screen.getByTestId("panel-url")).toBeTruthy();
  });

  it("honors ?attr=leader — a department renders the override card", () => {
    render(<UnitEditPage ctx={ctx({})} attr="leader" />);
    expect(screen.getByTestId("panel-leader")).toBeTruthy();
  });

  // #2542 Phase C — a center's "leader" rail item renders the vocabulary-
  // driven picker instead of the dept/div override card.
  it("a center's ?attr=leader renders the vocabulary-driven leadership card, not UnitLeaderCard", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "center", actorRole: "curator" })}
        attr="leader"
      />,
    );
    expect(screen.getByTestId("panel-center-leadership")).toBeTruthy();
    expect(screen.queryByTestId("panel-leader")).toBeNull();
  });

  it("a Superuser deep-linking ?attr=slug sees the slug card", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="slug" />);
    expect(screen.getByTestId("panel-slug")).toBeTruthy();
  });

  it("a Superuser on a center deep-linking ?attr=center-type lands on Basics (where center type lives now)", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })}
        attr="center-type"
      />,
    );
    expect(screen.getByTestId("panel-center-basics")).toBeTruthy();
    expect(mockSectionNav.mock.calls.at(-1)?.[0].initialSection).toBe("basics");
  });

  it("a Superuser deep-linking ?attr=retire sees the retire card", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="retire" />);
    expect(screen.getByTestId("panel-retire")).toBeTruthy();
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

  it("a manual division renders the simple roster card on ?attr=roster", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual" })}
        attr="roster"
      />,
    );
    expect(screen.getByTestId("panel-roster")).toBeTruthy();
  });

  it("the department sub-rail lists sibling divisions", () => {
    render(
      <UnitEditPage
        ctx={ctx({ siblings: [{ code: "N2856", name: "Cardiology", slug: "cardiology" }] })}
      />,
    );
    expect(screen.getByTestId("sibling-division-N2856")).toBeTruthy();
  });
});

describe("UnitEditPage — retired read-through (edge 11)", () => {
  const retired = {
    suppression: { id: "sup1", suppressedAt: new Date("2026-05-01"), actorCwid: "su001" },
    actorRole: "superuser" as const,
    access: [],
  };

  it("shows the read-only notice instead of the description editor when retired", () => {
    render(<UnitEditPage ctx={ctx({ ...retired })} attr="description" />);
    expect(screen.queryByTestId("panel-description")).toBeNull();
    expect(screen.getByTestId("retired-notice")).toBeTruthy();
  });

  it("still renders the retire card on the retire panel when retired", () => {
    render(<UnitEditPage ctx={ctx({ ...retired })} attr="retire" />);
    expect(screen.queryByTestId("retired-notice")).toBeNull();
    expect(screen.getByTestId("panel-retire")).toBeTruthy();
  });

  it("a retired center shows the notice and ONLY the Retire section", () => {
    render(<UnitEditPage ctx={ctx({ ...retired, unitType: "center" })} />);
    expect(screen.getByTestId("retired-notice")).toBeTruthy();
    expect(sectionIds()).toEqual(["retire"]);
    expect(screen.getByTestId("panel-retire")).toBeTruthy();
  });
});

// Edit Center mockup (2026-09-25) — the single-scroll center editor.
describe("UnitEditPage — center sections page", () => {
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

  it("renders the page header: unit name as h1, kind chip, actor role note", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "owner", access: [] })} />);
    expect(screen.getByRole("heading", { level: 1, name: "Medicine" })).toBeTruthy();
    expect(screen.getByTestId("unit-edit-kind").textContent).toBe("Center");
    expect(screen.getByTestId("unit-edit-actor-note").textContent).toMatch(
      /Editing as administrator \(Owner\)\. Changes are logged against your account\./,
    );
  });

  it("the breadcrumb reads 'Org units / Centers' and links back to /edit/units when allowed", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center" })} orgUnitsNavVisible />);
    expect(screen.getByTestId("edit-subnav-units").getAttribute("href")).toBe("/edit/units");
    expect(screen.getByTestId("unit-edit-crumb").textContent).toBe("Centers");
  });

  it("the breadcrumb's 'Org units' is plain text without the units-tab grant", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center" })} />);
    expect(screen.queryByTestId("edit-subnav-units")).toBeNull();
  });

  it("a curator gets Basics / Leadership / Members, but no Access or Retire", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(sectionIds()).toEqual(["basics", "leadership", "members"]);
    expect(mockBasics.mock.calls.at(-1)?.[0]).toMatchObject({ canEditSuperuserFields: false });
  });

  it("nav stats: 'No description' warns on Basics; Leadership counts holders; Members counts active only", () => {
    const base = ctx({
      unitType: "center",
      actorRole: "owner",
      access: [],
      centerLeadership: [
        {
          key: "director",
          label: "Director",
          singleHolder: true,
          sortOrder: 10,
          holders: [{ cwid: "d1", name: "Test Director", title: null, interim: false }],
        },
        { key: "co_director", label: "Co-Director", singleHolder: false, sortOrder: 20, holders: [] },
      ],
      roster: [
        member("m1"),
        member("m2", { endDate: "2000-01-01" }), // ended
        member("m3", { membershipRoleKey: "invited" }), // invitee
        member("m4", { startDate: "2999-01-01" }), // pending
      ],
    });
    const withEmptyDesc = { ...base, unit: { ...base.unit, description: "" } };
    render(<UnitEditPage ctx={withEmptyDesc} />);
    const items = mockSectionNav.mock.calls.at(-1)?.[0].items as Array<{
      id: string;
      stat?: string;
      warn?: boolean;
    }>;
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.basics).toMatchObject({ stat: "No description", warn: true });
    expect(byId.leadership).toMatchObject({ stat: "1" });
    expect(byId.members).toMatchObject({ stat: "1" });
    expect(byId.access).toMatchObject({ stat: "0" });
    expect(screen.getByTestId("center-members-count").textContent).toBe("1");
  });

  it("the Members section links to the full roster page, plus the export when the flag is on", () => {
    mockRosterExportEnabled.mockReturnValue(true);
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(screen.getByTestId("center-members-manage").getAttribute("href")).toBe(
      "/edit/center/N1280?attr=roster",
    );
    expect(screen.getByTestId("center-members-export").getAttribute("href")).toBe(
      "/edit/center/N1280/export",
    );
  });

  it("no Export CSV in the Members section when the export flag is off", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "curator" })} />);
    expect(screen.queryByTestId("center-members-export")).toBeNull();
  });

  it("every section is labelled by a heading id of its own (no shared panel-heading)", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })} />);
    const labels = screen
      .getAllByTestId(/^unit-section-/)
      .map((el) => el.getAttribute("aria-labelledby"));
    expect(labels).toEqual([
      "basics-heading",
      "leadership-heading",
      "members-heading",
      "access-heading",
      "retire-heading",
    ]);
  });
});
