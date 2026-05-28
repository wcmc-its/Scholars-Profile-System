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

import { UnitEditPage } from "@/components/edit/unit-edit-page";
import type { UnitActorRole, UnitEditContext } from "@/lib/api/unit-edit-context";

function ctx(over: {
  unitType?: UnitEditContext["unit"]["unitType"];
  actorRole?: UnitActorRole;
  source?: "ED" | "manual";
  siblings?: UnitEditContext["siblingDivisions"];
  access?: UnitEditContext["access"];
}): UnitEditContext {
  const unitType = over.unitType ?? "department";
  return {
    unit: {
      unitType,
      code: "N1280",
      name: "Medicine",
      description: "blurb",
      slug: "medicine",
      deptCode: unitType === "division" ? "N1000" : null,
      deptName: unitType === "division" ? "Parent" : null,
      source: over.source ?? "ED",
      centerType: unitType === "center" ? "center" : null,
      overriddenFields: [],
      leader: { cwid: null, explicitVacancy: false, interim: false, name: null, title: null },
      suppression: null,
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

  it("a Superuser deep-linking ?attr=slug sees the unwired placeholder", () => {
    render(<UnitEditPage ctx={ctx({ actorRole: "superuser", access: [] })} attr="slug" />);
    expect(screen.getByText(/coming in PR-7b/i)).toBeTruthy();
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
