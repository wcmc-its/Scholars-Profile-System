/**
 * `components/edit/auto-submit-form.tsx` — the `/edit/reports/7` filter
 * island. A change on any control inside calls the form's native
 * `requestSubmit()`; the form renders as a GET form to its `action`; after
 * hydration it carries `data-hydrated` (the CSS hook that hides the no-JS
 * Apply button). Assertions are scoped to the form's own testid.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";

describe("AutoSubmitForm", () => {
  it("renders a GET form to its action and submits itself when a control changes", () => {
    const requestSubmit = vi.fn();
    HTMLFormElement.prototype.requestSubmit = requestSubmit;
    render(
      <AutoSubmitForm action="/edit/reports/7" data-testid="filters">
        <select name="tail" defaultValue="1">
          <option value="0">0</option>
          <option value="1">1</option>
        </select>
        <input type="checkbox" name="years" value="2025" />
        <button type="submit">Apply</button>
      </AutoSubmitForm>,
    );
    const form = screen.getByTestId("filters") as HTMLFormElement;
    expect(form.tagName).toBe("FORM");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/edit/reports/7");
    expect(form.getAttribute("data-hydrated")).toBe("true");

    fireEvent.change(form.querySelector("select")!, { target: { value: "0" } });
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(form.querySelector("input[type=checkbox]")!);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });
});
