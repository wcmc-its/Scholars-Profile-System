"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A 42×24 sliding toggle (apollo-maroon track when on, grey when off). Built on
 * Radix `Switch` so it gets `role="switch"`, keyboard, and `aria-checked` for
 * free. Fixed track/thumb dimensions (no flex-basis on the cross axis) so it
 * always renders as a pill, never a distorted circle.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "focus-visible:ring-ring/50 peer inline-flex h-6 w-[42px] shrink-0 cursor-pointer items-center rounded-full border-0 p-0.5 transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-apollo-maroon data-[state=unchecked]:bg-[#c9c7c3]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform",
          "data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
