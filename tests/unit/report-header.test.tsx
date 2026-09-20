/**
 * `components/edit/report-header.tsx` — the shared `<h1>` block of every
 * `/edit/reports/[n]` page. An async Server Component: each test awaits the
 * element and renders it. Protects: the numbered label from `report_meta`;
 * the pencil (`ReportMetaEditor`, mocked to a marker) for a superuser ONLY
 * and with the loaded meta as props; the page's subtitle (`children`)
 * rendered between the h1 and the disclosure; the "About this report"
 * `<details>` rendered closed (no `open` attribute) with the sanitized HTML
 * inside when a description exists, and not at all when it is null; a
 * hostile stored body is re-sanitized on read. Assertions are scoped to the
 * rendered container, never `document.body`.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockReportMetaFor: vi.fn(),
  mockEditor: vi.fn((props: { n: string; meta: { name: string } }) => (
    <span data-testid="report-meta-edit" data-n={props.n} data-name={props.meta.name} />
  )),
}));

vi.mock("@/lib/edit/report-meta", () => ({
  reportMetaFor: h.mockReportMetaFor,
  reportLabel: (m: { key: string; name: string }) => `${m.key}. ${m.name}`,
}));
vi.mock("@/components/edit/report-meta-editor", () => ({ ReportMetaEditor: h.mockEditor }));

import { ReportHeader } from "@/components/edit/report-header";

const SUPERUSER = { isSuperuser: true };
const PLAIN = { isSuperuser: false };

const META = {
  key: "3" as const,
  name: "Publications",
  summary: "This unit's publications.",
  descriptionHtml: "<p>Joined to <strong>JIF</strong>.</p><ul><li>one</li></ul>",
};

async function renderHeader(props: Parameters<typeof ReportHeader>[0]) {
  const el = await ReportHeader(props);
  const { container } = render(el);
  return within(container);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockReportMetaFor.mockResolvedValue(META);
});
afterEach(cleanup);

describe("ReportHeader", () => {
  it("renders the numbered label from report_meta as the h1", async () => {
    const q = await renderHeader({ n: "3", session: PLAIN });
    expect(h.mockReportMetaFor).toHaveBeenCalledWith("3");
    expect(q.getByRole("heading", { level: 1 }).textContent).toBe("3. Publications");
  });

  it("superuser → the pencil, handed the loaded meta", async () => {
    const q = await renderHeader({ n: "3", session: SUPERUSER });
    const pencil = q.getByTestId("report-meta-edit");
    expect(pencil.getAttribute("data-n")).toBe("3");
    expect(pencil.getAttribute("data-name")).toBe("Publications");
    expect(h.mockEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        n: "3",
        meta: { name: META.name, summary: META.summary, descriptionHtml: META.descriptionHtml },
      }),
      undefined,
    );
  });

  it("non-superuser → no pencil", async () => {
    const q = await renderHeader({ n: "3", session: PLAIN });
    expect(q.queryByTestId("report-meta-edit")).toBeNull();
    expect(h.mockEditor).not.toHaveBeenCalled();
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
    // Order: h1, then the page's subtitle, then the disclosure.
    const h1 = q.getByRole("heading", { level: 1 });
    const subtitle = q.getByTestId("subtitle");
    expect(h1.compareDocumentPosition(subtitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(subtitle.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
