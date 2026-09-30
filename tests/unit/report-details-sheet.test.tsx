/**
 * `components/edit/report-details-sheet.tsx` — "Edit details" on a report
 * page. `OverviewEditor` (Tiptap) is mocked to a textarea that forwards
 * `onChange`, `DirectoryPeopleTypeahead` to a button that picks one person,
 * `next/navigation` to a `refresh` spy. The sheet renders in a portal, so
 * queries are scoped to the sheet element (`report-details-sheet`), never
 * `document.body` at large. Protects: the button opens the sheet prefilled
 * from props, and the badge's `REPORT_DETAILS_OPEN_EVENT` opens it too; Save
 * PUTs `/api/edit/report-meta/[n]` with the meta AND the request record, then
 * closes and refreshes; an error code maps to the alert and the sheet stays
 * open; Save is disabled while the name is blank or the slug invalid; Cancel
 * discards edits; a comms steward (no `canEditMeta`) sees only Access and a
 * Done button; Add / Remove POST `/api/edit/report-access` at once and
 * refresh the page; a unit report's Access only links to the administrators
 * page.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/edit/overview-editor", () => ({
  OverviewEditor: ({ initialHtml, onChange }: { initialHtml: string; onChange: (v: string) => void }) => (
    <textarea data-testid="overview-editor" defaultValue={initialHtml} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" data-testid="pick-person" onClick={() => onChange({ cwid: "abc1234", name: "Ada Byron", title: null })}>
      pick
    </button>
  ),
}));

import { REPORT_DETAILS_OPEN_EVENT } from "@/components/edit/report-access-popover";
import { ReportDetailsSheet, type ReportDetailsSheetProps } from "@/components/edit/report-details-sheet";

const META = {
  slug: "publications",
  name: "Publications",
  summary: "This unit's publications.",
  descriptionHtml: "<p>About.</p>",
};
const REQUEST = {
  requestedBy: "Radiology office",
  requestedOn: "2026-09-01",
  requestMemo: "Quarterly.",
  updatedAt: "2026-09-20T12:00:00.000Z",
};
const ROW = {
  reportKey: "high-impact-publications",
  scopeKey: "*",
  cwid: "xyz9999",
  granteeName: "Grace Hopper",
  name: "Grace Hopper",
  grantedBy: "paa2013",
  grantedAt: "2026-09-18T12:00:00.000Z",
};
const PERSON_ACCESS = {
  mode: "person" as const,
  reportKey: "high-impact-publications",
  initialRows: [ROW],
  scopeOptions: [["*", "All"] as const],
  canManage: true,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(props: Partial<ReportDetailsSheetProps> = {}) {
  const { container } = render(
    <ReportDetailsSheet n="3" meta={META} canEditMeta request={REQUEST} access={{ mode: "unit" }} {...props} />,
  );
  return within(container);
}

function openSheet(q: ReturnType<typeof setup>) {
  fireEvent.click(q.getByTestId("report-details-edit"));
  return within(screen.getByTestId("report-details-sheet"));
}

describe("ReportDetailsSheet", () => {
  it("closed: only the Edit details button", () => {
    const q = setup();
    expect(q.getByTestId("report-details-edit").textContent).toContain("Edit details");
    expect(screen.queryByTestId("report-details-sheet")).toBeNull();
  });

  it("the button opens the sheet prefilled from meta and the request record", () => {
    const s = openSheet(setup());
    expect((s.getByTestId("report-details-name") as HTMLInputElement).value).toBe("Publications");
    expect((s.getByTestId("report-details-slug") as HTMLInputElement).value).toBe("publications");
    expect((s.getByTestId("report-details-summary") as HTMLTextAreaElement).value).toBe(META.summary);
    expect((s.getByTestId("report-details-requested-by") as HTMLInputElement).value).toBe("Radiology office");
    expect((s.getByTestId("report-details-requested-on") as HTMLInputElement).value).toBe("2026-09-01");
    expect((s.getByTestId("report-details-memo") as HTMLTextAreaElement).value).toBe("Quarterly.");
    expect(s.getByTestId("report-details-request").textContent).toContain("Report 3 · Last edited Sep 20, 2026");
  });

  it("the badge's open event opens it too", () => {
    setup();
    act(() => {
      window.dispatchEvent(new Event(REPORT_DETAILS_OPEN_EVENT));
    });
    expect(screen.getByTestId("report-details-sheet")).toBeTruthy();
  });

  it("Save PUTs the meta and the request record, then closes and refreshes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, meta: {} }));
    const s = openSheet(setup());
    fireEvent.change(s.getByTestId("report-details-slug"), { target: { value: " papers " } });
    fireEvent.change(s.getByTestId("report-details-name"), { target: { value: "  Papers " } });
    fireEvent.change(s.getByTestId("overview-editor"), { target: { value: "<p>New.</p>" } });
    fireEvent.change(s.getByTestId("report-details-requested-by"), { target: { value: " Pathology " } });
    fireEvent.change(s.getByTestId("report-details-requested-on"), { target: { value: "2026-09-24" } });
    fireEvent.change(s.getByTestId("report-details-memo"), { target: { value: "" } });
    fireEvent.click(s.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/report-meta/3");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "papers",
      name: "Papers",
      summary: META.summary,
      descriptionHtml: "<p>New.</p>",
      requestedBy: "Pathology",
      requestedOn: "2026-09-24",
      requestMemo: "",
    });
    await waitFor(() => expect(screen.queryByTestId("report-details-sheet")).toBeNull());
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed save shows the mapped alert and stays open", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { ok: false, error: "slug_taken" }));
    const s = openSheet(setup());
    fireEvent.click(s.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(s.getByTestId("report-details-error").textContent).toBe("Another report already uses that address."),
    );
    expect(screen.getByTestId("report-details-sheet")).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("Save is disabled while the name is blank or the slug invalid", () => {
    const s = openSheet(setup());
    const save = s.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(s.getByTestId("report-details-name"), { target: { value: "  " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(s.getByTestId("report-details-name"), { target: { value: "Papers" } });
    fireEvent.change(s.getByTestId("report-details-slug"), { target: { value: "123" } });
    expect(save.disabled).toBe(true);
  });

  it("Cancel closes without a request; reopening discards the edits", () => {
    const q = setup();
    let s = openSheet(q);
    fireEvent.change(s.getByTestId("report-details-name"), { target: { value: "Changed" } });
    fireEvent.click(s.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    s = openSheet(q);
    expect((s.getByTestId("report-details-name") as HTMLInputElement).value).toBe("Publications");
  });

  it("a unit report's Access states the rule and links to the administrators page, with no add form", () => {
    const s = openSheet(setup());
    const access = within(s.getByTestId("report-details-access"));
    expect(access.getByText("Unit owners and curators")).toBeTruthy();
    expect(access.getByRole("link", { name: "Manage unit administrators" }).getAttribute("href")).toBe(
      "/edit/administrators",
    );
    expect(s.queryByTestId("report-details-add")).toBeNull();
  });

  it("a comms steward sees only Access, a Manage access button and Done — no meta fields, no request record", () => {
    const q = setup({ n: "9", canEditMeta: false, request: null, access: PERSON_ACCESS });
    expect(q.getByTestId("report-details-edit").textContent).toContain("Manage access");
    const s = openSheet(q);
    expect(s.queryByTestId("report-details-name")).toBeNull();
    expect(s.queryByTestId("report-details-request")).toBeNull();
    expect(s.queryByRole("button", { name: "Save" })).toBeNull();
    expect(s.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(s.getByTestId(`report-details-grant-*-${ROW.cwid}`).textContent).toContain("Grace Hopper");
  });

  it("Add and Remove POST report-access at once and refresh the page", async () => {
    // A fresh Response per call — a body can be read once.
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, rows: [ROW] }));
    const s = openSheet(setup({ n: "9", access: PERSON_ACCESS }));
    fireEvent.click(s.getByTestId("pick-person"));
    fireEvent.click(s.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/report-access");
    expect(JSON.parse(init.body as string)).toEqual({
      op: "grant",
      reportKey: "high-impact-publications",
      scopeKey: "*",
      cwid: "abc1234",
      name: "Ada Byron",
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));

    fireEvent.click(s.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toMatchObject({
      op: "revoke",
      cwid: ROW.cwid,
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(2));
  });
});
