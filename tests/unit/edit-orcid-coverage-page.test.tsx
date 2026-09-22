/**
 * `app/edit/orcid-coverage/page.tsx` — gate (`canViewUsage`, like `/edit/usage`)
 * and a render scoped to the page root, not `document.body`.
 */
import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCanViewUsage: vi.fn(),
  mockLoad: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: h.mockRedirect, notFound: vi.fn() }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockGetEditSession }));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: h.mockCanViewUsage }));
vi.mock("@/lib/edit/orcid-coverage", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/edit/orcid-coverage")>()),
  loadOrcidCoverage: h.mockLoad,
}));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <div data-testid="forbidden" />,
}));
vi.mock("@/components/edit/auto-submit-form", () => ({
  AutoSubmitForm: ({ children, ...rest }: { children: React.ReactNode }) => (
    <form {...rest}>{children}</form>
  ),
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn(),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn(),
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import EditOrcidCoveragePage from "@/app/edit/orcid-coverage/page";
import { buildOrcidCoverage, parseOrcidCoverageParams } from "@/lib/edit/orcid-coverage";

const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const TODAY = new Date("2026-09-18T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.mockGetEditSession.mockResolvedValue(ADMIN);
  h.mockCanViewUsage.mockResolvedValue(true);
  h.mockLoad.mockImplementation(
    async (_db: unknown, params: ReturnType<typeof parseOrcidCoverageParams>) =>
      buildOrcidCoverage(
        [
          {
            cwid: "f1",
            roleCategory: "full_time_faculty",
            primaryDepartment: "Dept A",
            orcid: "0000-0002-1825-0097",
            orcidConfirmedAt: new Date("2026-09-20T00:00:00Z"),
          },
          {
            cwid: "f2",
            roleCategory: "full_time_faculty",
            primaryDepartment: "Dept A",
            orcid: null,
            orcidConfirmedAt: null,
          },
          {
            cwid: "p1",
            roleCategory: "postdoc",
            primaryDepartment: "Dept B",
            orcid: null,
            orcidConfirmedAt: null,
          },
        ],
        [{ cwid: "f2", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: true }],
        ["f2"],
        params,
        TODAY,
        [
          {
            cwid: "p1",
            orcid: "iD-a",
            source: "rpm_inferred",
            articlesAccepted: 5,
            articlesRejected: 0,
          },
        ],
      ),
  );
});

describe("/edit/orcid-coverage", () => {
  it("signed-out → SAML redirect", async () => {
    h.mockGetEditSession.mockResolvedValue(null);
    await expect(EditOrcidCoveragePage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/orcid-coverage",
    );
    expect(h.mockLoad).not.toHaveBeenCalled();
  });

  it("not canViewUsage → forbidden page, no data read", async () => {
    h.mockCanViewUsage.mockResolvedValue(false);
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    expect(getByTestId("forbidden")).toBeTruthy();
    expect(h.mockLoad).not.toHaveBeenCalled();
  });

  it("renders tiles, both tables and the filtered CSV link inside the page root", async () => {
    const { getByTestId } = render(
      await EditOrcidCoveragePage({ searchParams: sp({ nih: "ever", role: "all" }) }),
    );
    const page = within(getByTestId("orcid-coverage-page"));
    expect(h.mockLoad).toHaveBeenCalledWith({}, { role: null, nih: "ever", dept: null });
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "1 of 3 with an asserted ORCID iD",
    );
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "+1 strong inference (66.7% incl.)",
    );
    // The asserted split: f1 confirmed its iD here.
    expect(page.getByTestId("orcid-coverage-tiles").textContent).toContain(
      "1 confirmed here · 0 from Identity or RPM admin",
    );
    const byRole = within(page.getByTestId("orcid-coverage-by-role"));
    expect(byRole.getByText("Full-time faculty")).toBeTruthy();
    expect(byRole.queryByText("Postdoc")).toBeNull(); // nih=ever drops p1
    const byDept = within(page.getByTestId("orcid-coverage-by-dept"));
    expect(byDept.getByText("Dept A")).toBeTruthy();
    expect(page.getByTestId("orcid-coverage-download").getAttribute("href")).toBe(
      "/edit/orcid-coverage/export?role=all&nih=ever",
    );
    const form = page.getByTestId("orcid-coverage-filters") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/edit/orcid-coverage");
    expect((form.elements.namedItem("nih") as HTMLSelectElement).value).toBe("ever");
    // Never a per-person cell.
    expect(getByTestId("orcid-coverage-page").textContent).not.toMatch(/f1|0000-0002/);
    // The weak definition must match the fold: a second candidate demotes only when it is
    // itself strong-eligible (orcidTiers r6), so the copy must not say "several candidates".
    expect(getByTestId("orcid-coverage-page").textContent).toContain(
      "weak = no single strong candidate (a name-only registry match, thin support, a contradiction, or two or more strong candidate ORCIDs)",
    );
    expect(getByTestId("orcid-coverage-page").textContent).not.toContain("several candidate");
  });

  it("loader failure → unavailable notice, page root still renders", async () => {
    h.mockLoad.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(await EditOrcidCoveragePage({ searchParams: sp() }));
    expect(
      within(getByTestId("orcid-coverage-page")).getByTestId("orcid-coverage-unavailable"),
    ).toBeTruthy();
  });
});
