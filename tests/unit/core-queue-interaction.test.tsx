/**
 * The To review interaction helpers (Core publication queue mockup refresh):
 * where the pane lands once a decided paper leaves the list, the undo toast's
 * line, and the inline key hint.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { decisionToastText, resolveFocusIndex } from "@/components/edit/core-claim-queue";
import { KEYS_HINT, SHORTCUTS, UndoToast } from "@/components/edit/core-queue-panels";

const rows = (...pmids: string[]) => pmids.map((pmid) => ({ pmid }));

describe("resolveFocusIndex", () => {
  it("is -1 on an empty list, whatever the focus", () => {
    expect(resolveFocusIndex([], null, 0)).toBe(-1);
    expect(resolveFocusIndex([], "1", 3)).toBe(-1);
  });

  it("opens on the first row when nothing is focused", () => {
    expect(resolveFocusIndex(rows("1", "2"), null, 1)).toBe(0);
  });

  it("follows a focused row that is still listed, wherever it moved", () => {
    expect(resolveFocusIndex(rows("1", "2", "3"), "3", 0)).toBe(2);
    // a row above it left: same paper, new index
    expect(resolveFocusIndex(rows("2", "3"), "3", 2)).toBe(1);
  });

  it("falls to the row now at a departed row's place: the next one down", () => {
    // "2" was at index 1 and was decided; "3" slid up into index 1
    expect(resolveFocusIndex(rows("1", "3"), "2", 1)).toBe(1);
  });

  it("falls to the new last row when the departed row was at the bottom", () => {
    expect(resolveFocusIndex(rows("1", "2"), "3", 2)).toBe(1);
  });

  it("never goes below 0 on a bad last index", () => {
    expect(resolveFocusIndex(rows("1"), "gone", -5)).toBe(0);
  });
});

describe("decisionToastText", () => {
  it("names a single decision, with its reason when one was given", () => {
    expect(decisionToastText("claimed", 1)).toBe("Confirmed");
    expect(decisionToastText("rejected", 1)).toBe("Rejected");
    expect(decisionToastText("rejected", 1, "Method match only")).toBe(
      "Rejected · Method match only",
    );
  });

  it("counts a bulk batch and drops any reason", () => {
    expect(decisionToastText("claimed", 12)).toBe("Confirmed 12 papers");
    expect(decisionToastText("rejected", 2, "ignored")).toBe("Rejected 2 papers");
  });
});

describe("KEYS_HINT", () => {
  it("names the keys the queue listens for, not the mockup's C/X", () => {
    expect(KEYS_HINT).toBe("J / K move · A confirm · R reject");
    const keyOf = (label: string) => SHORTCUTS.find((s) => s.label === label)?.keys[0];
    expect(keyOf("Confirm")).toBe("a");
    expect(keyOf("Reject")).toBe("r");
  });
});

describe("UndoToast", () => {
  it("has no live region of its own (the queue's announcement speaks the outcome)", () => {
    const { container } = render(
      <UndoToast text="Confirmed" tone="claimed" undoing={false} onUndo={() => {}} />,
    );
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(container.textContent).toBe("ConfirmedUndo");
  });

  it("disables its Undo while an undo is in flight", () => {
    const { getByRole } = render(
      <UndoToast text="Confirmed" tone="claimed" undoing onUndo={() => {}} />,
    );
    expect((getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
