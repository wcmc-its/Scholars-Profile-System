import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { Textarea } from "@/components/ui/textarea";

describe("Textarea primitive", () => {
  it("renders a native textarea with the data-slot attribute", () => {
    const { container } = render(<Textarea placeholder="Reason" />);
    const ta = container.querySelector("textarea");
    expect(ta).toBeTruthy();
    expect(ta!.getAttribute("data-slot")).toBe("textarea");
    expect(ta!.getAttribute("placeholder")).toBe("Reason");
  });

  it("passes through standard textarea props (id, name, rows, disabled)", () => {
    render(<Textarea id="reason" name="reason" rows={4} disabled aria-label="Reason" />);
    const ta = screen.getByLabelText("Reason") as HTMLTextAreaElement;
    expect(ta.id).toBe("reason");
    expect(ta.name).toBe("reason");
    expect(ta.rows).toBe(4);
    expect(ta.disabled).toBe(true);
  });

  it("fires onChange with the typed value (controlled use)", () => {
    let observed = "";
    render(
      <Textarea
        aria-label="Reason"
        onChange={(e) => {
          observed = e.target.value;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "off-topic" },
    });
    expect(observed).toBe("off-topic");
  });

  it("merges a custom className with the base classes", () => {
    const { container } = render(<Textarea className="bespoke-class" />);
    const ta = container.querySelector("textarea")!;
    expect(ta.className).toContain("bespoke-class");
    // A signature class from the base stylelist should still be present.
    expect(ta.className).toContain("rounded-md");
  });
});
