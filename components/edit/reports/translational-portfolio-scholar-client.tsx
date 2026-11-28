"use client";

/**
 * The research area definition card on a scholar's translational portfolio
 * page. A Popover, not a HoverCard: a HoverCard never opens on touch, so the
 * card opens on mouse hover (after a short delay), on keyboard focus, and on
 * tap or click, which also pins it until dismissed. The content renders right
 * after the trigger (no portal), so Tab moves from the name into the card's
 * link. Nothing here reaches `@/lib/db`.
 */
import { useEffect, useRef, useState } from "react";
import { Popover as P } from "radix-ui";

export function AreaTerm({
  label,
  description,
  count,
  countNote,
  href,
}: {
  label: string;
  description: string | null;
  count: number;
  /** "papers in scope score 0.3 or higher in this area." */
  countNote: string;
  /** The area's public page. */
  href: string;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hoverOff = () => {
    if (!pinned.current) later(() => setOpen(false), 200);
  };

  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        window.clearTimeout(timer.current);
        pinned.current = o;
        setOpen(o);
      }}
    >
      <P.Trigger asChild>
        <button
          type="button"
          className="text-apollo-slate cursor-help text-left text-sm underline decoration-dotted underline-offset-[3px]"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") later(() => setOpen(true), 300);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") hoverOff();
          }}
          onFocus={(e) => {
            // Keyboard focus only: a click focuses too, and then toggles.
            let keyboard = false;
            try {
              keyboard = e.currentTarget.matches(":focus-visible");
            } catch {
              keyboard = false;
            }
            if (keyboard) setOpen(true);
          }}
          data-testid="area-term"
        >
          {label}
        </button>
      </P.Trigger>
      <P.Content
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={() => window.clearTimeout(timer.current)}
        onPointerLeave={hoverOff}
        className="bg-apollo-surface border-apollo-border-strong z-50 flex w-80 max-w-[calc(100vw-32px)] flex-col gap-2 rounded-[10px] border p-4 shadow-md"
        data-testid="area-card"
      >
        <span className="text-apollo-slate text-xs font-medium tracking-[0.08em] uppercase">
          Research area
        </span>
        <span className="text-base font-semibold">{label}</span>
        {description && (
          <span className="text-apollo-ink-2 text-[13px] leading-[1.55]">{description}</span>
        )}
        <span className="text-muted-foreground text-xs">
          {count.toLocaleString()} {countNote}
        </span>
        <a href={href} className="text-apollo-slate text-[13px] hover:underline">
          Open the {label} page
        </a>
      </P.Content>
    </P.Root>
  );
}
