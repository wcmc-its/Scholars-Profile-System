import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RolesCatalog } from "@/components/edit/roles-catalog";
import { ROLE_CATALOG } from "@/lib/edit/role-catalog";
import { loadRoleHolderCounts, loadRoleMembers } from "@/lib/edit/role-catalog.server";

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

describe("loadRoleMembers", () => {
  it("names each ED role's members; an unreadable group is left out", async () => {
    const members = await loadRoleMembers({
      listMembers: async (cns) =>
        new Map(cns.map((cn) => [cn, cn.endsWith("observer-role") ? ["bbb2", "aaa1"] : null])),
      resolveNames: async () => new Map([["aaa1", "Zed Able"], ["bbb2", "Amy Baker"]]),
    });
    expect(members.observer).toEqual([
      { cwid: "bbb2", name: "Amy Baker" },
      { cwid: "aaa1", name: "Zed Able" },
    ]);
    expect(members.content_editor).toBeUndefined();
  });
});

describe("RolesCatalog", () => {
  it("an ED role with members lists name and CWID; unreadable stays MARIA; empty says No one", () => {
    render(
      <RolesCatalog
        counts={{}}
        members={{ observer: [{ cwid: "aaa1", name: "Amy Able" }, { cwid: "zz9", name: null }], cv_generator: [] }}
      />,
    );
    expect(screen.getByTestId("role-holders-observer").textContent).toContain("2 people");
    const list = screen.getByTestId("role-members-observer");
    expect(list.textContent).toContain("Amy Able aaa1");
    expect(list.textContent).toContain("zz9");
    expect(screen.getByTestId("role-holders-cv_generator").textContent).toBe("No one");
    expect(screen.getByTestId("role-holders-superuser").textContent).toBe("Managed in MARIA");
  });

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

describe("table-backed roles list their holders too", () => {
  const client = {
    unitAdmin: {
      findMany: async () => [
        { cwid: "own1", role: "owner", entityType: "department" },
        { cwid: "OWN1", role: "owner", entityType: "center" },
        { cwid: "cur1", role: "curator", entityType: "core" },
      ],
    },
    functionalRoleGrant: { findMany: async () => [{ cwid: "rep1" }] },
  };

  it("loadRoleMembers with a client names unit and Reporting holders", async () => {
    const members = await loadRoleMembers({
      client,
      listMembers: async (cns) => new Map(cns.map((cn) => [cn, null])),
      resolveNames: async () => new Map([["rep1", "Rae Porter"]]),
    });
    expect(members.unit_owner).toEqual([{ cwid: "own1", name: null }]);
    expect(members.unit_curator).toEqual([{ cwid: "cur1", name: null }]);
    expect(members.institution_admin).toEqual([]);
    expect(members.reporting).toEqual([{ cwid: "rep1", name: "Rae Porter" }]);
    expect(members.observer).toBeUndefined();
  });

  it("renders the list for a table role, and falls back to the count when unread", () => {
    render(
      <RolesCatalog counts={{ unit_curator: 3 }} members={{ reporting: [{ cwid: "rep1", name: "Rae Porter" }] }} />,
    );
    expect(screen.getByTestId("role-members-reporting").textContent).toContain("Rae Porter rep1");
    expect(screen.getByTestId("role-holders-unit_curator").textContent).toBe("3 people");
  });
});
