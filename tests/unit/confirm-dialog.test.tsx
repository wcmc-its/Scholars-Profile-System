/**
 * `components/edit/confirm-dialog.tsx` — the Cancel-focused destructive-confirm
 * dialog (#356 Phase 6 C4).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";

function defaults() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    title: "Hide your profile?",
    description: "Your profile will be removed from public view and search.",
    confirmLabel: "Hide my profile",
    confirmVariant: "destructive" as const,
    onConfirm: vi.fn(),
  };
}

describe("ConfirmDialog — Cancel-focused safety invariant", () => {
  it("Cancel is the default-focused element on open", () => {
    render(<ConfirmDialog {...defaults()} reasonMode="none" />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    // autoFocus → DOM activeElement after mount.
    expect(document.activeElement).toBe(cancel);
  });

  it("Cancel calls onOpenChange(false), not onConfirm", () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="none" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(d.onOpenChange).toHaveBeenCalledWith(false);
    expect(d.onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog — reasonMode='none'", () => {
  it("renders no reason field; Confirm is enabled and fires with reason=null", async () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="none" />);
    expect(screen.queryByLabelText(/Reason/i)).toBeNull();
    expect(screen.queryByLabelText("Other reason")).toBeNull();
    const confirm = screen.getByRole("button", { name: "Hide my profile" });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(d.onConfirm).toHaveBeenCalledWith(null));
  });
});

describe("ConfirmDialog — reasonMode='optional-preset'", () => {
  it("starts with the 'out-of-date' preset selected and no textarea", () => {
    render(<ConfirmDialog {...defaults()} reasonMode="optional-preset" />);
    expect(screen.getByText("Information is out of date")).toBeTruthy();
    expect(screen.queryByLabelText("Other reason")).toBeNull();
  });

  it("Confirm with a non-Other preset fires with reason=null (server defaults)", async () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="optional-preset" />);
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    await waitFor(() => expect(d.onConfirm).toHaveBeenCalledWith(null));
  });

  it("Confirm with the Other preset + blank textarea fires with reason=null", async () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="optional-preset" />);
    // Open the select. The combobox role is on the trigger.
    fireEvent.click(screen.getByRole("combobox"));
    // Click the "Other" option — appears in the rendered options list.
    fireEvent.click(await screen.findByText("Other"));
    // Confirm with no textarea content → reason is null.
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    await waitFor(() => expect(d.onConfirm).toHaveBeenCalledWith(null));
  });

  it("Confirm with the Other preset + non-empty textarea fires with the trimmed text", async () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="optional-preset" />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Other"));
    const ta = await screen.findByLabelText("Other reason");
    fireEvent.change(ta, { target: { value: "  taking a sabbatical  " } });
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    await waitFor(() => expect(d.onConfirm).toHaveBeenCalledWith("taking a sabbatical"));
  });
});

describe("ConfirmDialog — reasonMode='required-text'", () => {
  it("Confirm is disabled until the textarea has non-empty content", () => {
    render(<ConfirmDialog {...defaults()} reasonMode="required-text" />);
    const confirm = screen.getByRole("button", { name: "Hide my profile" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const ta = screen.getByLabelText("Reason");
    // Whitespace alone keeps it disabled.
    fireEvent.change(ta, { target: { value: "   " } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(ta, { target: { value: "Retraction RXX-1234" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("Confirm fires with the trimmed text", async () => {
    const d = defaults();
    render(<ConfirmDialog {...d} reasonMode="required-text" />);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  Retraction RXX-1234  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    await waitFor(() => expect(d.onConfirm).toHaveBeenCalledWith("Retraction RXX-1234"));
  });
});

describe("ConfirmDialog — async onConfirm", () => {
  it("disables Confirm while the promise is pending and shows 'Working…'", async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<ConfirmDialog {...defaults()} reasonMode="none" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    // The button label changes synchronously after the click.
    await waitFor(() => expect(screen.getByText("Working…")).toBeTruthy());
    const working = screen.getByRole("button", { name: "Working…" });
    expect(working.hasAttribute("disabled")).toBe(true);
    resolve();
  });

  it("re-enables Confirm if onConfirm rejects (caller renders the error)", async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error("boom")));
    render(<ConfirmDialog {...defaults()} reasonMode="none" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide my profile" }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: "Hide my profile" });
      expect(btn.hasAttribute("disabled")).toBe(false);
    });
  });
});
