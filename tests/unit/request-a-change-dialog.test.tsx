/**
 * components/edit/request-a-change-dialog.tsx — the Apollo-style "Request a
 * change" modal (#160 UI follow-up). Verifies the trigger, the named dialog,
 * the three action shapes, the structured `mailto:`, switch-reset + the
 * discard guard, the CRLF header-injection guard, and the confirmation step.
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
  it("renders a trigger that opens a named dialog", () => {
    render(<RequestAChangeDialog attribute="education" cwid="abc1001" itemLabel="Ph.D." />);
    expect(screen.getByTestId("request-a-change-trigger")).toBeTruthy();
    open();
    expect(screen.getByText("Request a change — Ph.D.")).toBeTruthy();
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

  it("self-service issue → tool link (ORCID resolves {cwid}); no textarea", () => {
    render(<RequestAChangeDialog attribute="name-title" cwid="abc1001" />);
    open();
    pickIssue("orcid-wrong");
    const link = screen.getByRole("link", { name: /Fix it in ReCiter/ });
    expect(link.getAttribute("href")).toBe(
      "https://reciter.weill.cornell.edu/manageprofile/abc1001",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByLabelText("Add any detail (optional)")).toBeNull();
  });

  it("route issue → textarea + Submit with cc, specific subject, structured body", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" itemLabel="R01 Test Grant" />);
    open();
    pickIssue("funding-wrong");
    fireEvent.change(detailBox(), { target: { value: "The end date is wrong." } });
    const href = screen.getByTestId("request-a-change-submit").getAttribute("href")!;
    expect(href.startsWith("mailto:osra-operations@med.cornell.edu")).toBe(true);
    expect(href).toContain("cc=scholars%40weill.cornell.edu");
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain("Scholars profile correction — Funding");
    expect(decoded).toContain("Issue: A grant's title, sponsor, dates, or role is wrong");
    expect(decoded).toContain("Item: R01 Test Grant");
    expect(decoded).toContain("The end date is wrong.");
  });

  it("explain issue shows the detail and reveals a route box on the fallback", () => {
    render(<RequestAChangeDialog attribute="funding" cwid="abc1001" />);
    open();
    pickIssue("funding-active-expired");
    expect(screen.getByText(/grace/i)).toBeTruthy();
    expect(screen.queryByTestId("request-a-change-submit")).toBeNull();
    fireEvent.click(screen.getByText("Still wrong? Email us"));
    expect(screen.getByTestId("request-a-change-submit")).toBeTruthy();
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
