import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Inline feedback used on the `/edit/*` surfaces (UI-SPEC § Components used →
 * `alert.tsx`). Two variants:
 *
 *   - `info` — the superuser banner and the "hidden" notice (neutral).
 *   - `destructive` — save failures and validation errors.
 *
 * No icon by default — callers compose one if they want it (e.g. an Info /
 * Triangle Lucide icon). No close button — the alerts in this SPEC are not
 * dismissible. Layout: a `[role="alert"]` block with a Title and a Description
 * row; both children are optional. `aria-live` is `polite` for `info` and
 * `assertive` for `destructive` so a screen reader picks up a save-failure
 * mid-form without waiting on a quiet moment.
 */
const alertVariants = cva(
  "relative w-full rounded-md border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        info: "bg-card text-card-foreground border-border",
        // The description used to render at `text-destructive/90` — red-600 dimmed a
        // further 10% over the card fill, which lands under 4.5:1 and made the longest,
        // most important copy on the surface (the NIH rewrite caution) the hardest to
        // read. Full-strength destructive clears 4.5:1 on the card in both themes.
        destructive:
          "text-destructive bg-card border-destructive/30 [&>svg]:text-current *:data-[slot=alert-description]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "info"}
      role="alert"
      aria-live={variant === "destructive" ? "assertive" : "polite"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
