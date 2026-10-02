import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RolesCatalog } from "@/components/edit/roles-catalog";
import { ROLE_CATALOG } from "@/lib/edit/role-catalog";
import { loadRoleHolderCounts } from "@/lib/edit/role-catalog.server";

describe("loadRoleHolderCounts", () => {
  it("counts distinct people per unit role and reporting; institutions apart", async () => {
    const counts = await loadRoleHolderCounts({
      unitAdmin: {
        findMany: async () => [
          { cwid: "a1", role: "owner", entityType: "department" },
          { cwid: "A1", role: "owner", entityType: "center" },
          { cwid: "b2", role: "curator", entityType: "core" },
          { cwid: "c3", role: "owner", entityType: "institution" },
        ],
      },
      functionalRoleGrant: { findMany: async () => [{ cwid: "r1" }, { cwid: "r1" }, { cwid: "r2" }] },
    });
    expect(counts).toEqual({ unit_owner: 1, unit_curator: 1, institution_admin: 1, reporting: 2 });
  });

  it("a failed read leaves that count out instead of guessing", async () => {
    const counts = await loadRoleHolderCounts({
      unitAdmin: { findMany: () => Promise.reject(new Error("down")) },
      functionalRoleGrant: { findMany: async () => [] },
    });
    expect(counts).toEqual({ reporting: 0 });
  });
});

describe("RolesCatalog", () => {
  it("lists every role; ED groups say MARIA, counted roles show people", () => {
    render(<RolesCatalog counts={{ unit_owner: 3, reporting: 1 }} />);
    for (const r of ROLE_CATALOG) expect(screen.getByTestId(`role-row-${r.key}`)).toBeTruthy();
    expect(screen.getByTestId("role-holders-content_editor").textContent).toBe("Managed in MARIA");
    expect(screen.getByTestId("role-holders-unit_owner").textContent).toBe("3 people");
    expect(screen.getByTestId("role-holders-reporting").textContent).toBe("1 person");
    expect(screen.getByTestId("role-holders-unit_curator").textContent).toBe("—");
    const ce = within(screen.getByTestId("role-row-content_editor"));
    expect(ce.getByText("Hide items and sections")).toBeTruthy();
    expect(ce.getByText("Pin titles")).toBeTruthy();
  });
});
