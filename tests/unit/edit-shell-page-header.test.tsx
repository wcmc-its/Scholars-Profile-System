/**
 * `EditShell`'s page header (Meyer Cancer Center mockup, 2026-09-30): one
 * block above the rail + detail body — breadcrumb, the page `<h1>` with the
 * actions on the right, and a meta line (role pill + "Changes are logged to
 * your account · Change history"). It replaced the full-width
 * Superuser/Proxy/UnitAdmin banners, so the role copy lives in the pill.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";

const base = {
  scholarName: "Jane Doe",
  railItems: [],
  activeAttr: "overview",
  basePath: "/edit/scholar/abc1001",
  historyHref: "/edit/scholar/abc1001/history",
  previewHref: "https://example.test/jane",
  identity: { cwid: "abc1001", name: "Jane Doe, PhD", title: "Professor", institution: null },
};

const pill = () => document.querySelector('[data-slot="edit-role-pill"]');

describe("EditShell — page header role pill", () => {
  it.each([
    ["superuser", undefined, "Editing as administrator"],
    ["proxy", undefined, "Editing as proxy"],
    [
      "unit-admin",
      { unitKind: "department" as const, unitName: "Medicine" },
      "Editing as Medicine administrator",
    ],
  ] as const)("%s mode reads '%s'", (mode, unitAdmin, text) => {
    render(
      <EditShell {...base} mode={mode} unitAdmin={unitAdmin}>
        <div>panel</div>
      </EditShell>,
    );
    expect(pill()?.textContent).toBe(text);
    const meta = pill()!.parentElement!;
    expect(meta.textContent).toContain("Changes are logged to your account");
    expect(meta.textContent).toContain("·");
    expect(screen.getByTestId("edit-history-link").getAttribute("href")).toBe(
      "/edit/scholar/abc1001/history",
    );
  });

  it("readOnly (cv_generator) reads 'View only' with no 'Changes are logged'", () => {
    render(
      <EditShell {...base} mode="superuser" readOnly>
        <div>panel</div>
      </EditShell>,
    );
    expect(pill()?.textContent).toBe("View only");
    expect(document.body.textContent).not.toContain("Changes are logged");
  });

  it("omits the separator + history link when there is no historyHref", () => {
    render(
      <EditShell {...base} historyHref={undefined} mode="proxy">
        <div>panel</div>
      </EditShell>,
    );
    const meta = pill()!.parentElement!;
    expect(meta.textContent).toContain("Changes are logged to your account");
    expect(meta.textContent).not.toContain("·");
    expect(screen.queryByTestId("edit-history-link")).toBeNull();
  });

  it("unit-admin mode adds the what-you-can-edit note; other modes don't", () => {
    const { unmount } = render(
      <EditShell
        {...base}
        mode="unit-admin"
        unitAdmin={{ unitKind: "division", unitName: "Cardiology" }}
      >
        <div>panel</div>
      </EditShell>,
    );
    expect(document.querySelector('[data-slot="edit-unit-admin-note"]')?.textContent).toContain(
      "profile URL is set by a Scholars administrator",
    );
    unmount();
    render(
      <EditShell {...base} mode="proxy">
        <div>panel</div>
      </EditShell>,
    );
    expect(document.querySelector('[data-slot="edit-unit-admin-note"]')).toBeNull();
  });

  it("no longer renders any full-width alert banner", () => {
    render(
      <EditShell {...base} mode="superuser">
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("EditShell — page header h1", () => {
  it("edit-for-others: the published name is the page's ONLY h1 (top-bar brand is not a heading)", () => {
    render(
      <EditShell {...base} mode="superuser">
        <div>panel</div>
      </EditShell>,
    );
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Jane Doe, PhD");
    expect(h1s[0].closest('[data-testid="edit-identity-header"]')).not.toBeNull();
  });

  it("self mode: h1 'Your profile', no pill, meta line is just the history link", () => {
    render(
      <EditShell {...base} mode="self" basePath="/edit">
        <div>panel</div>
      </EditShell>,
    );
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Your profile");
    expect(pill()).toBeNull();
    expect(document.body.textContent).not.toContain("Changes are logged");
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
    // The self tab strip is unchanged, and there is no breadcrumb.
    expect(screen.getByText("My Profile")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("self mode with consoleNav: no tab strip, still one h1", () => {
    render(
      <EditShell {...base} mode="self" basePath="/edit" consoleNav={<nav aria-label="Console" />}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByText("My Profile")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("actions sit in the title row beside the h1", () => {
    render(
      <EditShell {...base} mode="superuser" reportsHref="/edit/reports?center=C1">
        <div>panel</div>
      </EditShell>,
    );
    const header = document.querySelector('[data-slot="edit-page-header"]')!;
    expect(header.contains(screen.getByTestId("edit-reports-link"))).toBe(true);
    expect(header.contains(screen.getByRole("link", { name: /Preview profile/ }))).toBe(true);
  });
});
