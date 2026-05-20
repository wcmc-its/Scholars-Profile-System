import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native `<textarea>` styled to match `input.tsx` — same border, focus ring,
 * radius, disabled state, and ARIA-invalid styling. Used by the suppression
 * `reason` field on the `/edit/*` confirmation dialogs (UI-SPEC § Components
 * used → `textarea.tsx`). No auto-resize; the dialog reason field is a fixed
 * height. Full `React.ComponentProps<"textarea">` pass-through.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
