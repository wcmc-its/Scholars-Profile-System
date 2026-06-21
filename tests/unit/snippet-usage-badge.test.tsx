import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SnippetUsageBadge } from "@/components/method/snippet-usage-badge";

describe("SnippetUsageBadge", () => {
  it("defaults to 'How it was used' (the pre-informativeness fallback)", () => {
    const { container } = render(<SnippetUsageBadge />);
    expect(container.textContent).toBe("How it was used");
  });

  it("renders 'Where it appears' for the generic-mention variant", () => {
    const { container } = render(<SnippetUsageBadge usage="appears" />);
    expect(container.textContent).toBe("Where it appears");
  });
});
