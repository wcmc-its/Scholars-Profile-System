/**
 * components/edit/request-a-change-dialog.tsx — the "Request a change" router
 * modal (#160 UI follow-up + Phase 2 server mailer). Verifies the demoted title
 * + "Regarding" line, the per-issue action verb, the callout under the selected
 * row, the honest dead-end ("Got it", no request filed), switch-reset + discard
 * guard, the Phase-2 server POST (primary) with "Request sent.", and the
 * Phase-1 `mailto:` fallback (cc / structured body / CRLF injection guard)
 * exercised through a non-2xx response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";

function open(testId = "request-a-change-trigger") {
  fireEvent.click(screen.getByTestId(testId));
}
function pickIssue(id: string) {
  fireEvent.click(within(screen.getByTestId(`rac-issue-${id}`)).getByRole("radio"));
}
function detailBox() {
  return screen.getByLabelText("Add any detail (optional)") as HTMLTextAreaElement;
}
/** Mock `global.fetch` for the route Submit; default = server send succeeds. */
function mockFetch(response: { ok: boolean; status?: number }) {
  const fn = vi.fn().mockResolvedValue({ ok: response.ok, status: response.status ?? 200 });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// jsdom can't navigate; replace `window.location` with a capturable stub so the
// `mailto:` fallback's `window.location.href = …` is observable, not an error.
let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "" },
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

describe("RequestAChangeDialog", () => {
  it("opens a named dialog with a demoted title + Regarding line + focal question", () => {
    render(
      <RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D., Stanford" />,
    );
    expect(screen.getByTestId("request-a-change-trigger")).toBeTruthy();
    open();
    expect(screen.getByRole("dialog", { name: /request a change/i })).toBeTruthy();
    expect(screen.getByText("Regarding")).toBeTruthy();
    expect(screen.getByText("Ph.D., Stanford")).toBeTruthy();
    expect(screen.getByText("What needs to change?")).toBeTruthy();
  });

  it("honors a custom triggerTestId (read-only panels)", () => {
    render(
      <RequestAChangeDialog
        attribute="name-title"
        cwid="abc1001"
        triggerTestId="request-a-change-toggle"
      />,
    );
    expect(screen.getByTestId("request-a-change-toggle")).toBeTruthy();
  });

  it("shows the action verb as a per-row hint before selection", () => {
    render(<RequestAChangeDialog attribute="publications" cwid="abc1001" />);
    open();
    expect(
      within(screen.getByTestId("rac-issue-publication-missing-pubmed")).getByText(/Add by PMID/),
    ).toBeTruthy();
  });

  it("self-service → verb-named tool link + callout instruction (ORCID resolves {cwid})", () => {
    render(<RequestAChangeDialog attribute="name-title" cwid="abc1001" />);
    open();
    pickIssue("orcid-wrong");
    const link = screen.getByTestId("request-a-change-open");
    expect(link.textContent).toContain("Manage in ReCiter");
    expect(link.getAttribute("href")).toBe(
      "https://reciter.weill.cornell.edu/manageprofile/abc1001",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByLabelText("Add any detail (optional)")).toBeNull();
  });

  it("route → verb-named Submit button + the PubMed source caveat", () => {
    render(<RequestAChangeDialog attribute="publications" cwid="abc1001" itemLabel="My Paper" />);
    open();
    pickIssue("publication-metadata-wrong");
    expect(screen.getByText(/authoritative record at NLM/i)).toBeTruthy(); // PubMed-source caveat
    const submit = screen.getByTestId("request-a-change-submit");
    expect(submit.tagName).toBe("BUTTON"); // Phase 2: a POST trigger, not an <a href=mailto>
    expect(submit.textContent).toContain("Report correction");
  });

  it("route Submit POSTs to the server mailer and confirms 'Request sent.'", async () => {
    const fetchMock = mockFetch({ ok: true });
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" itemLabel="R01 Test Grant" />);
    open();
    pickIssue("funding-wrong");
    fireEvent.change(detailBox(), { target: { value: "Sponsor is wrong." } });
    fireEvent.click(screen.getByTestId("request-a-change-submit"));

    expect(await screen.findByText("Request sent.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/edit/request-change",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      attribute: "funding",
      issueId: "funding-wrong",
      itemId: "R01 Test Grant",
      targetCwid: "abc1001",
      detail: "Sponsor is wrong.",
    });
    // Server path must NOT touch the mailto: fallback.
    expect(window.location.href).toBe("");
  });

  it("falls back to the mailto: client on a non-2xx (no regression while the mailer is dark)", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D." />);
    open();
    pickIssue("education-wrong");
    fireEvent.click(screen.getByTestId("request-a-change-submit"));

    expect(await screen.findByText(/email client should have opened/i)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("ofa@med.cornell.edu");
    expect(window.location.href.startsWith("mailto:ofa@med.cornell.edu")).toBe(true);
  });

  it("the fallback mailto carries cc + item label (funding → OSRA)", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" itemLabel="R01 Test Grant" />);
    open();
    pickIssue("funding-wrong");
    fireEvent.click(screen.getByTestId("request-a-change-submit"));
    await screen.findByRole("status");

    expect(window.location.href).toContain("cc=scholars%40weill.cornell.edu");
    expect(decodeURIComponent(window.location.href)).toContain("Item: R01 Test Grant");
  });

  it("honest dead-end: non-PubMed explains auto-pickup and offers only 'Got it'", () => {
    render(<RequestAChangeDialog attribute="publications" cwid="abc1001" />);
    open();
    pickIssue("publication-missing-nonpubmed");
    expect(screen.getByText(/picks it up automatically/i)).toBeTruthy();
    expect(screen.queryByTestId("request-a-change-submit")).toBeNull();
    expect(screen.queryByTestId("request-a-change-open")).toBeNull();
    expect(screen.getByTestId("request-a-change-ack").textContent).toContain("Got it");
  });

  it("explain with a fallback reveals a route box (funding NCE window)", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" />);
    open();
    pickIssue("funding-active-expired");
    expect(screen.getByText(/grace/i)).toBeTruthy();
    expect(screen.getByTestId("request-a-change-ack")).toBeTruthy();
    fireEvent.click(screen.getByText("Still wrong? Email us"));
    expect(screen.getByTestId("request-a-change-submit")).toBeTruthy();
    expect(screen.queryByTestId("request-a-change-ack")).toBeNull();
  });

  it("discards typed detail when the issue is switched (edge 2)", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" />);
    open();
    pickIssue("funding-wrong");
    fireEvent.change(detailBox(), { target: { value: "typed text" } });
    pickIssue("funding-missing");
    expect(detailBox().value).toBe("");
  });

  it("Cancel with unsaved text triggers the discard guard (edge 3)", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" />);
    open();
    pickIssue("funding-wrong");
    fireEvent.change(detailBox(), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard your request?")).toBeTruthy();
  });

  it("strips CRLF from detail in the fallback mailto (edge 9 — injection guard)", async () => {
    mockFetch({ ok: false, status: 503 });
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D." />);
    open();
    pickIssue("education-wrong");
    fireEvent.change(detailBox(), { target: { value: "line1\r\nBcc: evil@example.com" } });
    fireEvent.click(screen.getByTestId("request-a-change-submit"));
    await screen.findByRole("status");

    expect(window.location.href).not.toContain("%0A%0ABcc");
    expect(decodeURIComponent(window.location.href)).toContain("line1 Bcc: evil@example.com");
  });
});
