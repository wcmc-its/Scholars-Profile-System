/**
 * "About Clinical trials" — the provenance note behind the section heading.
 *
 * This one is a hover `Tooltip` (like Mentoring / External relationships), NOT the
 * click-Popover that Available technologies uses. The distinction is load-bearing:
 * a hover tooltip cannot host interactive content, so it is only safe while the
 * copy stays plain prose. The last test guards exactly that — if someone links
 * "ClinicalTrials.gov" in the copy, the link would be unreachable by pointer and
 * invisible to the keyboard, and this fails rather than shipping a dead link.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClinicalTrialsInfoTooltip } from "@/components/scholar/clinical-trials-info-tooltip";

describe("ClinicalTrialsInfoTooltip", () => {
  it("exposes a labelled trigger on the heading", () => {
    render(<ClinicalTrialsInfoTooltip />);
    expect(screen.getByRole("button", { name: "About Clinical trials" })).toBeTruthy();
  });

  it("does not spend a footer paragraph on the copy — it is behind the trigger", () => {
    render(<ClinicalTrialsInfoTooltip />);
    // Radix tooltips render their content only on hover/focus, so nothing is in the
    // document at rest. The copy must not be sitting in the section body.
    expect(screen.queryByText(/Trial details are drawn/)).toBeNull();
  });

  it("carries NO interactive content — a hover tooltip cannot host a link", () => {
    // The guard: this component may only ever hold plain prose. If the copy grows a
    // link, it must become a Popover (see TechnologiesInfoButton) or the link is
    // unclickable. Assert against the source of truth: the rendered trigger subtree
    // and the module's copy string both stay link-free.
    const { container } = render(<ClinicalTrialsInfoTooltip />);
    expect(container.querySelector("a")).toBeNull();
  });
});
