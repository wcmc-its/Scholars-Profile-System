/**
 * `components/edit/superuser-banner.tsx` — the read-only administrator banner
 * (#356 Phase 7 C2). Server Component: no interactivity, no state — only the
 * rendered output is under test.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SuperuserBanner } from "@/components/edit/superuser-banner";

describe("SuperuserBanner", () => {
  it("renders the profile copy with the scholar's name in <strong>", () => {
    render(<SuperuserBanner targetLabel="Alex Other" />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("editing");
    expect(banner.textContent).toContain("Alex Other");
    expect(banner.textContent).toContain("as an administrator");
    // Name is in <strong> for visual emphasis.
    expect(banner.querySelector("strong")?.textContent).toBe("Alex Other");
  });

  it("uses the `info` variant (data-variant attribute)", () => {
    render(<SuperuserBanner targetLabel="Jane" />);
    expect(screen.getByRole("alert").getAttribute("data-variant")).toBe("info");
  });

  it("carries the `superuser-banner` data-slot for downstream selection / styling", () => {
    render(<SuperuserBanner targetLabel="Jane" />);
    expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("superuser-banner");
  });

  it("renders a ShieldAlert icon (an svg child of the alert)", () => {
    render(<SuperuserBanner targetLabel="Jane" />);
    const svg = screen.getByRole("alert").querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("uses the publication copy when targetKind='publication'", () => {
    render(<SuperuserBanner targetLabel="A landmark study" targetKind="publication" />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("managing the publication");
    expect(banner.textContent).toContain("A landmark study");
    expect(banner.querySelector("strong")?.textContent).toBe("A landmark study");
  });
});
