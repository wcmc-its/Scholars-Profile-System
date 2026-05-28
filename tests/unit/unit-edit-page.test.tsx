/**
 * `components/edit/unit-edit-page.tsx` — the attribute-rail filtering + active
 * panel selection (#540 Phase 7). The three live cards are mocked to lightweight
 * stubs so the test isolates the router's `(unitType, actorRole, source)` logic.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/edit/unit-description-card", () => ({
  UnitDescriptionCard: () => <div data-testid="panel-description" />,
}));
vi.mock("@/components/edit/unit-leader-card", () => ({
  UnitLeaderCard: () => <div data-testid="panel-leader" />,
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

import { UnitEditPage } from "@/components/edit/unit-edit-page";
import type { UnitActorRole, UnitEditContext } from "@/lib/api/unit-edit-context";

function ctx(over: {
  unitType?: UnitEditContext["unit"]["unitType"];
  actorRole?: UnitActorRole;
  source?: "ED" | "manual";
  siblings?: UnitEditContext["siblingDivisions"];
  access?: UnitEditContext["access"];
  suppression?: UnitEditContext["unit"]["suppression"];
}): UnitEditContext {
  const unitType = over.unitType ?? "department";
  return {
    unit: {
      unitType,
      code: "N1280",
      name: "Medicine",
      description: "blurb",
      slug: "medicine",
      slugOverride: null,
      deptCode: unitType === "division" ? "N1000" : null,
      deptName: unitType === "division" ? "Parent" : null,
      source: over.source ?? "ED",
      centerType: unitType === "center" ? "center" : null,
      overriddenFields: [],
      leader: { cwid: null, explicitVacancy: false, interim: false, name: null, title: null },
      suppression: over.suppression ?? null,
    },
    access: over.access ?? null,
    roster: null,
    siblingDivisions: over.siblings ?? null,
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

describe("UnitEditPage — rail filtering", () => {
  it("a Curator on a department sees only description + leader", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "curator" })} />);
    expect(railKeys()).toEqual(["description", "leader"]);
  });

  it("an Owner on a department adds access", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "owner", access: [] })} />);
    expect(railKeys()).toEqual(["description", "leader", "access"]);
  });

  it("a Superuser on a department adds slug + retire (but not center-type)", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} />);
    expect(railKeys()).toEqual(["description", "leader", "access", "slug", "retire"]);
  });

  it("a Superuser on a center sees roster + center-type", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })} />);
    expect(railKeys()).toContain("roster");
    expect(railKeys()).toContain("center-type");
  });

  it("a manual division shows roster; an ED division does not", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "manual" })} />);
    expect(railKeys()).toContain("roster");
  });

  it("an ED division has no roster row", () => {
    render(<UnitEditPage ctx={ctx({ unitType: "division", actorRole: "curator", source: "ED" })} />);
    expect(railKeys()).not.toContain("roster");
  });
});

describe("UnitEditPage — active panel selection", () => {
  it("defaults to the description panel", () => {
    render(<UnitEditPage ctx={ctx({})} />);
    expect(screen.getByTestId("panel-description")).toBeTruthy();
  });

  it("honors ?attr=leader", () => {
    render(<UnitEditPage ctx={ctx({})} attr="leader" />);
    expect(screen.getByTestId("panel-leader")).toBeTruthy();
  });

  it("a Superuser deep-linking ?attr=slug sees the slug card", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="slug" />);
    expect(screen.getByTestId("panel-slug")).toBeTruthy();
  });

  it("a Superuser on a center deep-linking ?attr=center-type sees the center-type card", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })}
        attr="center-type"
      />,
    );
    expect(screen.getByTestId("panel-center-type")).toBeTruthy();
  });

  it("a Superuser deep-linking ?attr=retire sees the retire card", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="retire" />);
    expect(screen.getByTestId("panel-retire")).toBeTruthy();
  });

  it("the center roster panel is still an unwired placeholder (deferred to a #552 follow-up)", () => {
    render(
      <UnitEditPage
        ctx={ctx({ unitType: "center", actorRole: "superuser", access: [] })}
        attr="roster"
      />,
    );
    expect(screen.getByText(/depends on #552/i)).toBeTruthy();
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
});
