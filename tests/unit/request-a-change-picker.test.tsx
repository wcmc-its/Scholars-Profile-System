/**
 * `components/edit/request-a-change-picker.tsx` — the per-item "Request a
 * change" picker + popover menu (#160 UI follow-up). Verifies each action shape
 * renders its link/text, ORCID resolves `{cwid}`, and the route mailto carries
 * the item label.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RequestAChangePicker, RequestAChangeMenu } from "@/components/edit/request-a-change-picker";

describe("RequestAChangePicker", () => {
  it("renders every issue for an attribute under the heading", () => {
    render(<RequestAChangePicker attribute="name-title" cwid="abc1001" />);
    expect(screen.getByText("What needs to change?")).toBeTruthy();
    expect(screen.getByTestId("rac-issue-name-wrong")).toBeTruthy();
    expect(screen.getByTestId("rac-issue-degrees-wrong")).toBeTruthy();
    expect(screen.getByTestId("rac-issue-orcid-wrong")).toBeTruthy();
  });

  it("self-service issues link to the tool; ORCID resolves {cwid}", () => {
    render(<RequestAChangePicker attribute="name-title" cwid="abc1001" />);
    const nameLink = screen.getByTestId("rac-issue-name-wrong").querySelector("a")!;
    expect(nameLink.getAttribute("href")).toBe("https://directory.weill.cornell.edu/update/profile/index");
    const orcidLink = screen.getByTestId("rac-issue-orcid-wrong").querySelector("a")!;
    expect(orcidLink.getAttribute("href")).toBe("https://reciter.weill.cornell.edu/manageprofile/abc1001");
  });

  it("route issues build a mailto with cc and the item label in the body", () => {
    render(<RequestAChangePicker attribute="funding" cwid="abc1001" itemLabel="R01 Test Grant" />);
    const link = screen.getByTestId("rac-issue-funding-wrong").querySelector("a")!;
    const href = link.getAttribute("href")!;
    expect(href.startsWith("mailto:osra-operations@med.cornell.edu")).toBe(true);
    expect(href).toContain("cc=scholars%40weill.cornell.edu");
    expect(href).toContain("body=Regarding");
    expect(decodeURIComponent(href)).toContain("R01 Test Grant");
  });

  it("explain issues show the detail text", () => {
    render(<RequestAChangePicker attribute="funding" cwid="abc1001" />);
    const row = screen.getByTestId("rac-issue-funding-active-expired");
    expect(row.textContent?.toLowerCase()).toContain("grace");
  });

  it("publication 'not mine' is a self-service Publication Manager link", () => {
    render(<RequestAChangePicker attribute="publications" cwid="abc1001" />);
    const link = screen.getByTestId("rac-issue-publication-not-mine").querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://reciter.weill.cornell.edu/");
  });
});

describe("RequestAChangeMenu", () => {
  it("renders a trigger button (the per-row affordance)", () => {
    render(<RequestAChangeMenu attribute="funding" cwid="abc1001" itemLabel="R01 Test" />);
    expect(screen.getByTestId("request-a-change-trigger")).toBeTruthy();
  });
});
