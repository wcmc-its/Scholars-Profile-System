/**
 * UnitLeadershipCard — a department's Vice Chairs on /edit/department/[code].
 *
 *  - rows render the published title, the derived tier / areas, and a marker
 *    for a holder who is not full-time faculty;
 *  - typing a title suggests tier and areas until the steward sets one by hand;
 *  - a `note_required` answer opens the reason dialog, and confirming resubmits
 *    the same payload with the note;
 *  - Remove goes through ConfirmDialog before POSTing.
 *
 * The directory typeahead is stubbed; fetch is mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
  }) => (
    <button type="button" data-testid="pick" onClick={() => onChange({ cwid: "new001", name: "New Person", title: null })}>
      pick
    </button>
  ),
}));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { UnitLeadershipCard } from "@/components/edit/unit-leadership-card";
import type { UnitLeadershipRoleView } from "@/lib/unit-leadership";

const role = (over: Partial<UnitLeadershipRoleView>): UnitLeadershipRoleView => ({
  id: "r1",
  cwid: "aex1001",
  name: "Ann Example",
  title: "Professor of Medicine",
  fullTimeFaculty: true,
  displayTitle: "Vice Chair for Research",
  tier: "vice",
  functions: ["research"],
  areaText: null,
  site: null,
  startDate: null,
  source: "steward",
  sourceUrl: null,
  note: null,
  ...over,
});

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
const respond = (status: number, json: Record<string, unknown>) => ({ ok: status < 400, json: async () => json });

function renderCard(roles: UnitLeadershipRoleView[] = []) {
  return render(<UnitLeadershipCard departmentCode="N1280" departmentName="Medicine" roles={roles} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UnitLeadershipCard", () => {
  it("renders the published title, derived fields, source link and the not-full-time marker", () => {
    renderCard([
      role({}),
      role({
        id: "r2",
        name: "Pat Part",
        fullTimeFaculty: false,
        displayTitle: "Vice Chair for Hematopathology",
        functions: ["clinical_area"],
        areaText: "Hematopathology",
        site: "nyp_queens",
        source: "audit_seed",
        sourceUrl: "https://example.org/leadership",
        note: "Voluntary faculty",
      }),
    ]);
    expect(screen.getByText("Vice Chair for Research")).toBeTruthy();
    expect(screen.getByText("Vice Chair · Research")).toBeTruthy();
    const second = screen.getByTestId("vice-chair-r2");
    expect(second.textContent).toContain("Vice Chair · Hematopathology · NewYork-Presbyterian Queens");
    expect(second.querySelector("a")?.getAttribute("href")).toBe("https://example.org/leadership");
    expect(screen.getByTestId("vice-chair-not-ft-r2")).toBeTruthy();
    expect(screen.queryByTestId("vice-chair-not-ft-r1")).toBeNull();
  });

  it("suggests areas from the title, then stops once the steward sets one; there is no tier menu", () => {
    renderCard();
    const title = screen.getByTestId("vc-add-title");
    fireEvent.change(title, { target: { value: "Deputy Vice Chair of Education and Faculty Development" } });
    expect(screen.queryByTestId("vc-add-tier")).toBeNull();
    expect(screen.getByTestId("vc-add-fn-education").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("vc-add-fn-faculty_affairs").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("vc-add-fn-education"));
    fireEvent.change(title, { target: { value: "Executive Vice Chair of Research" } });
    expect(screen.getByTestId("vc-add-fn-research").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("vc-add-fn-faculty_affairs").getAttribute("aria-checked")).toBe("true");
  });

  it("labels a row with whatever modifier its title carries", () => {
    renderCard([role({ displayTitle: "Interim Deputy Vice Chair for Research", tier: "interim deputy" })]);
    expect(screen.getByText("Interim Deputy Vice Chair · Research")).toBeTruthy();
  });

  it("adds a row and lists it", async () => {
    const added = role({ id: "n1", cwid: "new001", name: "New Person", displayTitle: "Executive Vice Chair", tier: "executive", functions: [] });
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true, role: added }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard([role({})]);
    fireEvent.click(screen.getByTestId("pick"));
    fireEvent.change(screen.getByTestId("vc-add-title"), { target: { value: "Executive Vice Chair" } });
    fireEvent.click(screen.getByTestId("vice-chair-add"));
    await waitFor(() => expect(screen.getByTestId("vice-chair-n1")).toBeTruthy());
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
      departmentCode: "N1280",
      action: "add",
      cwid: "new001",
      displayTitle: "Executive Vice Chair",
      functions: [],
      areaText: null,
      site: null,
      startDate: null,
      note: null,
    });
    // Executive sorts above the existing Vice Chair.
    const ids = [...screen.getByTestId("unit-leadership-holders").children].map((li) => li.getAttribute("data-testid"));
    expect(ids).toEqual(["vice-chair-n1", "vice-chair-r1"]);
  });

  it("asks why for a holder who is not full-time faculty, then resubmits with the note", async () => {
    const added = role({ id: "n1", cwid: "new001", name: "New Person", fullTimeFaculty: false, note: "Named by the chair" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(400, { ok: false, error: "note_required", field: "note" }))
      .mockResolvedValueOnce(respond(200, { ok: true, role: added }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.click(screen.getByTestId("pick"));
    fireEvent.change(screen.getByTestId("vc-add-title"), { target: { value: "Vice Chair for Research" } });
    fireEvent.click(screen.getByTestId("vice-chair-add"));

    const dialogText = await screen.findByText(/New Person is not full-time faculty/);
    expect(dialogText.textContent).toContain("will not be removed automatically");
    const confirm = screen.getByRole("button", { name: "Save anyway" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Named by the chair" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock.mock.calls[1])).toMatchObject({ action: "add", cwid: "new001", note: "Named by the chair" });
    await waitFor(() => expect(screen.getByTestId("vice-chair-not-ft-n1")).toBeTruthy());
  });

  it("removes a row only after the confirm dialog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard([role({})]);
    fireEvent.click(screen.getByTestId("vice-chair-remove-r1"));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByTestId("vice-chair-r1")).toBeNull());
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ departmentCode: "N1280", action: "remove", id: "r1" });
  });

  it("shows a message for a refused save", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(409, { ok: false, error: "duplicate_role" })));
    renderCard();
    fireEvent.click(screen.getByTestId("pick"));
    fireEvent.change(screen.getByTestId("vc-add-title"), { target: { value: "Vice Chair for Research" } });
    fireEvent.click(screen.getByTestId("vice-chair-add"));
    expect(await screen.findByText(/already holds this role with these areas/)).toBeTruthy();
  });
});
