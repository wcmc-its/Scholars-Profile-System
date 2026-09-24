/**
 * `components/edit/report-header.tsx` — the shared header of every
 * `/edit/reports/[report]` page. An async Server Component: each test awaits
 * the element and renders it. Protects: the "Report N" eyebrow and the plain
 * name from `report_meta` as the h1; the access badge (`ReportAccessPopover`,
 * mocked to a marker) handed the page's props with `variant="badge"`, in the
 * heading row; "Edit details" (`ReportDetailsSheet`, mocked) for a superuser
 * with the meta and the request record, for a comms steward who manages a
 * row-granted report's grants (no request record), and for no one else; the
 * page's subtitle (`children`) then the "About this report" `<details>`
 * (closed, sanitized HTML inside) when a description exists and not at all
 * when it is null; a hostile stored body is re-sanitized on read. Assertions
 * are scoped to the rendered container, never `document.body`.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockReportMetaFor: vi.fn(),
  mockLoadRequest: vi.fn(),
  mockSheet: vi.fn((props: { n: string; canEditMeta: boolean }) => (
    <span data-testid="details-sheet" data-n={props.n} data-edit-meta={String(props.canEditMeta)} />
  )),
  mockBadge: vi.fn((props: { mode: string; variant?: string }) => (
    <span data-testid="badge" data-mode={props.mode} data-variant={props.variant} />
  )),
}));

vi.mock("@/lib/edit/report-meta", () => ({
  reportMetaFor: h.mockReportMetaFor,
  loadReportRequestRecord: h.mockLoadRequest,
}));
vi.mock("@/components/edit/report-details-sheet", () => ({ ReportDetailsSheet: h.mockSheet }));
vi.mock("@/components/edit/report-access-popover", () => ({ ReportAccessPopover: h.mockBadge }));

import { ReportHeader } from "@/components/edit/report-header";

const SUPERUSER = { isSuperuser: true };
const PLAIN = { isSuperuser: false };

const META = {
  key: "3" as const,
  slug: "publications",
  name: "Publications",
  summary: "This unit's publications.",
  descriptionHtml: "<p>Joined to <strong>JIF</strong>.</p><ul><li>one</li></ul>",
};

const REQUEST = { requestedBy: "Radiology", requestedOn: "2026-09-01", requestMemo: "Quarterly", updatedAt: null };

const PERSON_ACCESS = {
  mode: "person" as const,
  reportKey: "high-impact-publications",
  initialRows: [],
  scopeOptions: [["*", "All"] as const],
  canManage: true,
};

async function renderHeader(props: Parameters<typeof ReportHeader>[0]) {
  const el = await ReportHeader(props);
  const { container } = render(el);
  return within(container);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockReportMetaFor.mockResolvedValue(META);
  h.mockLoadRequest.mockResolvedValue(REQUEST);
});
afterEach(cleanup);

describe("ReportHeader", () => {
  it("the eyebrow names the report number; the h1 is the plain name from report_meta", async () => {
    const q = await renderHeader({ n: "3", session: PLAIN });
    expect(h.mockReportMetaFor).toHaveBeenCalledWith("3");
    expect(q.getByRole("heading", { level: 1 }).textContent).toBe("Publications");
    expect(q.getByText("Report 3")).toBeTruthy();
  });

  it("access props → the badge variant in the heading row, before the subtitle", async () => {
    const q = await renderHeader({
      n: "3",
      session: PLAIN,
      access: { mode: "unit" },
      children: <p data-testid="subtitle">Subtitle</p>,
    });
    const h1 = q.getByRole("heading", { level: 1 });
    const wrap = q.getByTestId("report-header-access");
    const badge = q.getByTestId("badge");
    expect(wrap.contains(badge)).toBe(true);
    expect(badge.getAttribute("data-mode")).toBe("unit");
    expect(badge.getAttribute("data-variant")).toBe("badge");
    expect(wrap.parentElement).toBe(h1.parentElement);
    expect(
      wrap.compareDocumentPosition(q.getByTestId("subtitle")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("no access → no badge, no Edit details", async () => {
    const q = await renderHeader({ n: "3", session: SUPERUSER });
    expect(q.queryByTestId("report-header-access")).toBeNull();
    expect(q.queryByTestId("details-sheet")).toBeNull();
  });

  it("superuser → Edit details with the meta and the request record", async () => {
    const q = await renderHeader({ n: "3", session: SUPERUSER, access: { mode: "unit" } });
    expect(q.getByTestId("details-sheet").getAttribute("data-edit-meta")).toBe("true");
    expect(h.mockLoadRequest).toHaveBeenCalledWith("3");
    expect(h.mockSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        n: "3",
        canEditMeta: true,
        request: REQUEST,
        access: { mode: "unit" },
        meta: {
          slug: META.slug,
          name: META.name,
          summary: META.summary,
          descriptionHtml: META.descriptionHtml,
        },
      }),
      undefined,
    );
  });

  it("a comms steward managing a row-granted report → the sheet for access only; the request record is never read", async () => {
    const q = await renderHeader({ n: "9", session: PLAIN, access: PERSON_ACCESS });
    expect(q.getByTestId("details-sheet").getAttribute("data-edit-meta")).toBe("false");
    expect(h.mockLoadRequest).not.toHaveBeenCalled();
    expect(h.mockSheet).toHaveBeenCalledWith(expect.objectContaining({ request: null }), undefined);
  });

  it("a viewer who can neither edit nor manage → no sheet, no request record read", async () => {
    const q = await renderHeader({ n: "9", session: PLAIN, access: { ...PERSON_ACCESS, canManage: false } });
    expect(q.queryByTestId("details-sheet")).toBeNull();
    const unit = await renderHeader({ n: "3", session: PLAIN, access: { mode: "unit" } });
    expect(unit.queryByTestId("details-sheet")).toBeNull();
    expect(h.mockLoadRequest).not.toHaveBeenCalled();
  });

  it("description present → a CLOSED <details> with the HTML inside, after the children", async () => {
    const q = await renderHeader({
      n: "3",
      session: PLAIN,
      children: <p data-testid="subtitle">Every publication with a confirmed author.</p>,
    });
    const details = q.getByTestId("report-description");
    expect(details.tagName).toBe("DETAILS");
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("About this report");
    expect(details.querySelector("strong")?.textContent).toBe("JIF");
    expect(details.querySelector("ul > li")?.textContent).toBe("one");
    const h1 = q.getByRole("heading", { level: 1 });
    const subtitle = q.getByTestId("subtitle");
    expect(h1.compareDocumentPosition(subtitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      subtitle.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("description null → no <details> at all; children still render", async () => {
    h.mockReportMetaFor.mockResolvedValue({ ...META, descriptionHtml: null });
    const q = await renderHeader({
      n: "3",
      session: SUPERUSER,
      children: <p data-testid="subtitle">Subtitle</p>,
    });
    expect(q.queryByTestId("report-description")).toBeNull();
    expect(q.getByTestId("subtitle")).toBeTruthy();
  });

  it("re-sanitizes the stored description on read (defense in depth)", async () => {
    h.mockReportMetaFor.mockResolvedValue({
      ...META,
      descriptionHtml: '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><h2>t</h2>',
    });
    const q = await renderHeader({ n: "3", session: PLAIN });
    const details = q.getByTestId("report-description");
    expect(details.querySelector("script")).toBeNull();
    expect(details.querySelector("img")).toBeNull();
    expect(details.querySelector("h2")).toBeNull();
    expect(details.textContent).toContain("ok");
    expect(details.textContent).toContain("t");
    expect(details.innerHTML).not.toContain("alert(");
  });
});
