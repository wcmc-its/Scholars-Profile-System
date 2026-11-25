/**
 * The program roster has no console tab. Its one link is in the header of its
 * center's editor page, for a viewer the roster will open for, and on no other
 * center.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ session: vi.fn(), page: vi.fn(() => null) }));

vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/auth/partner-login", () => ({ getPartnerEditSession: vi.fn(), PARTNER_HOME: "/edit/cornell" }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: vi.fn(async () => ({ unit: {} })) }));
vi.mock("@/components/edit/unit-edit-page", () => ({ UnitEditPage: h.page, renderRoster: vi.fn() }));
vi.mock("@/components/edit/console-top-bar", () => ({ ConsoleTopBar: () => null }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: () => null }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/console-tabs.server", () => ({ loadConsoleTabs: vi.fn(async () => ({ units: true })) }));
vi.mock("@/lib/auth/observer-view", () => ({ stripObserverView: (s: unknown) => s }));

import EditCenterPage from "@/app/edit/center/[code]/page";
import { UnitEditSections } from "@/components/edit/unit-edit-sections";

const CURATOR = { cwid: "cur001", isSuperuser: false, isCommsSteward: false };
const EDITOR = { ...CURATOR, isProgramRosterEditor: true };
const href = async (session: object, code = "meyer_cancer_center") => {
  h.session.mockResolvedValue(session);
  const tree = (await EditCenterPage({ params: Promise.resolve({ code }) })) as React.ReactElement<{
    programRosterHref?: string;
  }>;
  return tree.props.programRosterHref;
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("EDIT_PROGRAM_ROSTER", "on");
});

describe("the program roster link", () => {
  it("shows for a roster editor and a superuser on the Meyer page", async () => {
    expect(await href(EDITOR)).toBe("/edit/program-roster");
    expect(await href({ ...CURATOR, isSuperuser: true })).toBe("/edit/program-roster");
  });

  it("not for a Meyer curator, an observer, a blocked View as, another center, or with the flag off", async () => {
    expect(await href(CURATOR)).toBeUndefined();
    expect(await href({ ...CURATOR, isCommsSteward: true, isObserver: true })).toBeUndefined();
    expect(await href({ ...EDITOR, sensitiveDashboardsBlocked: true })).toBeUndefined();
    expect(await href(EDITOR, "other_center")).toBeUndefined();
    vi.stubEnv("EDIT_PROGRAM_ROSTER", "off");
    expect(await href(EDITOR)).toBeUndefined();
  });

  it("renders in the header only when there is one", () => {
    const props = { name: "Center", kindLabel: "Center", orgUnitsNavVisible: true, actorRole: "curator" as const, sections: [] };
    const { unmount } = render(<UnitEditSections {...props} programRosterHref="/edit/program-roster" />);
    expect(screen.getByTestId("edit-program-roster-link").getAttribute("href")).toBe("/edit/program-roster");
    unmount();
    render(<UnitEditSections {...props} reportsHref="/edit/reports" />);
    expect(screen.queryByTestId("edit-program-roster-link")).toBeNull();
  });
});
