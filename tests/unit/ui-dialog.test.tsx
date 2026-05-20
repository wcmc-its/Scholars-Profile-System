import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

describe("Dialog primitive", () => {
  it("renders nothing visible until the trigger is activated", () => {
    render(
      <Dialog>
        <DialogTrigger data-testid="open">Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByTestId("open")).toBeTruthy();
  });

  it("opens on trigger click and renders the title + a default close button", () => {
    render(
      <Dialog>
        <DialogTrigger data-testid="open">Open</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hello</DialogTitle>
            <DialogDescription>World</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button>Cancel</button>
            <button>Confirm</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByTestId("open"));

    // Radix portals to document.body; title + description are now in the DOM.
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("World")).toBeTruthy();

    // The default close button carries an sr-only label "Close".
    const closeButtons = screen.getAllByText("Close");
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);

    // role="dialog" set by Radix on the content; aria-labelledby points at the title.
    const dlg = document.querySelector('[role="dialog"]');
    expect(dlg).toBeTruthy();
    const labelledBy = dlg!.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Hello");
  });

  it("data-slot attributes are stable for downstream selectors", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>T</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button>OK</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-header"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-footer"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-title"]')).toBeTruthy();
  });
});
