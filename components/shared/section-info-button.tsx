"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  METHODOLOGY_ANCHORS,
  methodologyHref,
} from "@/lib/methodology-anchors";

type AnchorKey = keyof typeof METHODOLOGY_ANCHORS;

interface SectionInfoButtonProps {
  /** What this surface is called in the UI — used for the aria-label. */
  label: string;
  /** Body copy explaining ReCiterAI's role in this section. */
  children: React.ReactNode;
  /** Methodology anchor key to deep-link to. */
  anchor: AnchorKey;
}

/**
 * Small (i) info button placed next to a section heading wherever ReCiterAI
 * or LLM-generated content is on display. Click toggles a popover with a
 * brief explanation and a link to the matching anchor on /about/methodology.
 *
 * Click outside or Escape closes; Escape returns focus to the trigger.
 * Tooltip primitives don't host interactive content (links) reliably, so
 * we use a click-toggled popover.
 */
export function SectionInfoButton({
  label,
  children,
  anchor,
}: SectionInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ariaLabel = `About ${label}`;

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-5 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
      >
        <Info className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-label={ariaLabel}
          className="absolute left-0 top-full z-20 mt-1 w-[320px] rounded-md border border-border bg-popover p-3 text-[13px] font-normal leading-[1.55] tracking-normal text-popover-foreground shadow-md"
        >
          <p className="m-0">
            {children}{" "}
            <Link
              href={methodologyHref(anchor)}
              className="font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
            >
              Read the methodology &rarr;
            </Link>
          </p>
        </div>
      )}
    </span>
  );
}
