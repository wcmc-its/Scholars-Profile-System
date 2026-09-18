/**
 * #2650 — `OrcidValue` (`components/edit/orcid-value.tsx`): the Name & Title ORCID row.
 * Present → orcid.org link; absent → "Not on file" + ReCiter fix-it link + the NIH note.
 * Assertions are scoped to the component's own root, not `document.body`.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { OrcidValue } from "@/components/edit/orcid-value";

describe("OrcidValue", () => {
  it("links a present iD to its orcid.org record", () => {
    const { container } = render(<OrcidValue orcid="0000-0002-1825-0097" cwid="abc1234" />);
    const a = container.querySelector('[data-testid="orcid-link"]') as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://orcid.org/0000-0002-1825-0097");
    expect(a.textContent).toBe("0000-0002-1825-0097");
    expect(container.querySelector('[data-testid="orcid-missing"]')).toBeNull();
  });

  it("renders Not on file + the ReCiter link + the NIH note when absent", () => {
    const { container } = render(<OrcidValue orcid={null} cwid="abc1234" />);
    const root = container.querySelector('[data-testid="orcid-missing"]') as HTMLElement;
    expect(root.textContent).toContain("Not on file");
    expect(root.textContent).toContain("NIH requires an ORCID iD linked to eRA Commons");
    const a = root.querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://reciter.weill.cornell.edu/manageprofile/abc1234");
    expect(container.querySelector('[data-testid="orcid-link"]')).toBeNull();
  });
});
