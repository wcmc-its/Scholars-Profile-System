/**
 * components/edit/request-a-change-dialog.tsx — the "Request a change" router
 * modal (#160 UI follow-up). Verifies the demoted title + "Regarding" line, the
 * per-issue action verb, the callout under the selected row, the honest
 * dead-end ("Got it", no request filed), the structured `mailto:`, switch-reset
 * + discard guard, and the CRLF header-injection guard.
 */
import { describe, expect, it } from "vitest";
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

describe("RequestAChangeDialog", () => {
  it("opens a named dialog with a demoted title + Regarding line + focal question", () => {
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D., Stanford" />);
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

  it("route → verb-named Submit with the structured, specific mailto", () => {
    render(<RequestAChangeDialog attribute="publications" cwid="abc1001" itemLabel="My Paper" />);
    open();
    pickIssue("publication-metadata-wrong");
    expect(screen.getByText(/authoritative record at NLM/i)).toBeTruthy(); // PubMed-source caveat
    fireEvent.change(detailBox(), { target: { value: "Author 3 is misspelled." } });
    const submit = screen.getByTestId("request-a-change-submit");
    expect(submit.textContent).toContain("Report correction");
    const decoded = decodeURIComponent(submit.getAttribute("href")!);
    expect(submit.getAttribute("href")!.startsWith("mailto:support@med.cornell.edu")).toBe(true);
    expect(decoded).toContain("Scholars profile correction — Publications");
    expect(decoded).toContain("Item: My Paper");
    expect(decoded).toContain("Author 3 is misspelled.");
  });

  it("route carries cc + item label (funding → OSRA)", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" itemLabel="R01 Test Grant" />);
    open();
    pickIssue("funding-wrong");
    const href = screen.getByTestId("request-a-change-submit").getAttribute("href")!;
    expect(href).toContain("cc=scholars%40weill.cornell.edu");
    expect(decodeURIComponent(href)).toContain("Item: R01 Test Grant");
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

  it("strips CRLF from detail in the composed mailto (edge 9 — injection guard)", () => {
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D." />);
    open();
    pickIssue("education-wrong");
    fireEvent.change(detailBox(), { target: { value: "line1\r\nBcc: evil@example.com" } });
    const href = screen.getByTestId("request-a-change-submit").getAttribute("href")!;
    expect(href).not.toContain("%0A%0ABcc");
    expect(decodeURIComponent(href)).toContain("line1 Bcc: evil@example.com");
  });

  it("Submit shows an in-dialog confirmation with a copyable address (edge 8)", () => {
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D." />);
    open();
    pickIssue("education-wrong");
    fireEvent.click(screen.getByTestId("request-a-change-submit"));
    expect(screen.getByRole("status").textContent).toContain("ofa@med.cornell.edu");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});
