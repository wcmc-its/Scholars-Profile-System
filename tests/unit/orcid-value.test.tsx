/**
 * `OrcidValue` (`components/edit/orcid-value.tsx`): the Name & Title ORCID row is a
 * pointer into the Identifiers & Profiles tab. Present → orcid.org link + Edit;
 * absent → "Not on file" + Add + the one-line reason. Assertions are scoped to
 * the component's own root, not `document.body`.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { OrcidValue } from "@/components/edit/orcid-value";

const HREF = "/edit?attr=identifiers-profiles";

describe("OrcidValue", () => {
  it("links a present iD to its orcid.org record, with Edit into the tab", () => {
    const { container } = render(<OrcidValue orcid="0000-0002-1825-0097" editHref={HREF} />);
    const a = container.querySelector('[data-testid="orcid-link"]') as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://orcid.org/0000-0002-1825-0097");
    expect(a.textContent).toBe("0000-0002-1825-0097");
    expect((container.querySelector('[data-testid="orcid-edit"]') as HTMLAnchorElement).getAttribute("href")).toBe(HREF);
    expect(container.querySelector('[data-testid="orcid-missing"]')).toBeNull();
  });

  it("renders Not on file + Add into the tab + the reason when absent", () => {
    const { container } = render(<OrcidValue orcid={null} editHref={HREF} />);
    const root = container.querySelector('[data-testid="orcid-missing"]') as HTMLElement;
    expect(root.textContent).toContain("Not on file");
    expect(root.textContent).toContain("Needed for NIH SciENcv biosketches");
    const a = root.querySelector('[data-testid="orcid-edit"]') as HTMLAnchorElement;
    expect(a.textContent).toBe("Add it");
    expect(a.getAttribute("href")).toBe(HREF);
    expect(container.querySelector('[data-testid="orcid-link"]')).toBeNull();
  });
});
