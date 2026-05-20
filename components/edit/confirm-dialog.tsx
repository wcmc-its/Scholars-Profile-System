/**
 * The destructive-action confirmation dialog (#356 Phase 6 C4, UI-SPEC §
 * Suppression and confirmation dialogs).
 *
 * One generic component, three `reasonMode`s — Phase 6 uses 'optional-preset'
 * (self-suppress) and 'none' (sole-author-pub hide); Phase 7 adds the two
 * 'required-text' superuser variants. Cancel is the default-focused element,
 * never the destructive button — the SPEC's load-bearing safety invariant.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Self-suppress reason presets (UI-SPEC § Suppression and confirmation dialogs row 1). */
const PRESET_REASONS = [
  { value: "out-of-date", label: "Information is out of date" },
  { value: "privacy", label: "Personal or privacy reasons" },
  { value: "other", label: "Other" },
] as const;

type PresetValue = (typeof PRESET_REASONS)[number]["value"];

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  reasonMode: "none" | "optional-preset" | "required-text";
  confirmLabel: string;
  confirmVariant: "default" | "destructive";
  /**
   * Fires when the user confirms. The reason argument is:
   *   - `null` for `reasonMode: 'none'`;
   *   - for `reasonMode: 'optional-preset'`: the trimmed "Other" text when
   *     the preset is "other" (or `null` if that textarea is blank — the
   *     server's `"Self-suppressed via /edit"` default then applies); the
   *     preset's display label ("Information is out of date" / "Personal or
   *     privacy reasons") when a non-"Other" preset is selected;
   *   - the non-empty trimmed text for `reasonMode: 'required-text'`.
   *
   * The handler may be async; the dialog disables Confirm and shows "Working…"
   * while the promise is pending. On rejection the dialog stays open so the
   * caller can render an inline error in the surrounding card.
   */
  onConfirm: (reason: string | null) => Promise<void> | void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  reasonMode,
  confirmLabel,
  confirmVariant,
  onConfirm,
}: ConfirmDialogProps) {
  const [preset, setPreset] = React.useState<PresetValue>("out-of-date");
  const [otherText, setOtherText] = React.useState("");
  const [requiredText, setRequiredText] = React.useState("");
  const [pending, setPending] = React.useState(false);

  // Reset internal state when the dialog opens (re-opening should start fresh).
  React.useEffect(() => {
    if (open) {
      setPreset("out-of-date");
      setOtherText("");
      setRequiredText("");
      setPending(false);
    }
  }, [open]);

  const trimmedRequired = requiredText.trim();
  const trimmedOther = otherText.trim();

  const confirmDisabled =
    pending || (reasonMode === "required-text" && trimmedRequired.length === 0);

  async function handleConfirm() {
    if (confirmDisabled) return;
    let reason: string | null;
    if (reasonMode === "none") {
      reason = null;
    } else if (reasonMode === "required-text") {
      reason = trimmedRequired;
    } else {
      // optional-preset — `self-edit-spec.md` § Suppression UX: the UI collects
      // "free text, or a preset"; a chosen preset IS the stored reason. Only
      // when the user selects "Other" and leaves the textarea blank does the
      // server's default ("Self-suppressed via /edit") apply.
      if (preset === "other") {
        reason = trimmedOther.length > 0 ? trimmedOther : null;
      } else {
        reason = PRESET_REASONS.find((r) => r.value === preset)?.label ?? null;
      }
    }
    setPending(true);
    try {
      await onConfirm(reason);
    } catch {
      // The caller renders the error; we just re-enable the button so the user
      // can retry or cancel.
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {reasonMode === "optional-preset" && (
          <div className="flex flex-col gap-3">
            <label htmlFor="confirm-dialog-reason-preset" className="text-sm font-medium">
              Reason (optional)
            </label>
            <Select
              value={preset}
              onValueChange={(v) => setPreset(v as PresetValue)}
            >
              <SelectTrigger id="confirm-dialog-reason-preset">
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {PRESET_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {preset === "other" && (
              <Textarea
                aria-label="Other reason"
                placeholder="Tell us more (optional)"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                rows={3}
              />
            )}
          </div>
        )}

        {reasonMode === "required-text" && (
          <div className="flex flex-col gap-2">
            <label htmlFor="confirm-dialog-reason-required" className="text-sm font-medium">
              Reason
            </label>
            <Textarea
              id="confirm-dialog-reason-required"
              aria-required="true"
              placeholder="Required — a retraction notice, compliance reference, or ticket link"
              value={requiredText}
              onChange={(e) => setRequiredText(e.target.value)}
              rows={3}
            />
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            autoFocus
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={confirmDisabled}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
