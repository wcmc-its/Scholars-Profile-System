/**
 * `SegmentedTabs` — a VIEW switcher that looks exactly like {@link SegmentedField}
 * but carries tab semantics instead of radio semantics.
 *
 * The distinction is the point. A segmented control that sets a FORM VALUE
 * (biosketch artifact, maximum contributions) is a radio group, and
 * `SegmentedField` stays the control for those. A segmented control that swaps
 * which PANEL is on screen (Generate a draft / Suggest publications) is a
 * tablist: `role="tablist"` + `role="tab"` + `aria-selected`, roving tabindex,
 * and ←/→/Home/End to move between tabs, with each panel labelled by its tab.
 *
 * Before this the tool-mode switch was two `<Button variant="apollo|outline">`s
 * with `aria-pressed` — they read as actions that would DO something when
 * clicked rather than as a view switch, and they were a third visual idiom on a
 * page that already had two. Both controls now share
 * {@link segmentPillClass}, so the page has one segmented look with the right
 * semantics under each instance.
 *
 * Panels are rendered by the caller; pass {@link tabPanelProps} to the element
 * that holds the active tab's content so the `aria-controls` / `aria-labelledby`
 * pair resolves.
 */
"use client";

import * as React from "react";

import { segmentPillClass } from "@/components/edit/segmented-field";
import { cn } from "@/lib/utils";

export type SegmentedTabOption<T extends string> = {
  value: T;
  label: string;
  /** Optional leading icon, already sized by the caller (e.g. `<Search className="size-4" />`). */
  icon?: React.ReactNode;
  /** `data-testid` for the tab button. */
  testId?: string;
};

/** The id of a tab button, derived from the group name + value. */
export function tabId(name: string, value: string): string {
  return `${name}-tab-${value}`;
}

/** The id of a tab's panel, derived from the group name + value. */
export function tabPanelId(name: string, value: string): string {
  return `${name}-panel-${value}`;
}

/**
 * Props for the element holding the active panel's content — spread this onto
 * the wrapper so the panel is exposed as a `tabpanel` labelled by its tab.
 * No `tabIndex`: both biosketch panels contain focusable controls, and APG says
 * a panel that does should NOT take a tab stop of its own.
 */
export function tabPanelProps(name: string, value: string) {
  return {
    role: "tabpanel" as const,
    id: tabPanelId(name, value),
    "aria-labelledby": tabId(name, value),
  };
}

export function SegmentedTabs<T extends string>({
  label,
  name,
  options,
  value,
  onValueChange,
  disabled = false,
  className,
}: {
  /** Accessible name for the tablist (never rendered — the tabs label themselves). */
  label: string;
  name: string;
  options: ReadonlyArray<SegmentedTabOption<T>>;
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  /** ←/→ wrap around the set; Home/End jump to the ends. Selection follows focus,
   *  which is the expected behavior for tabs whose panels are already in the DOM. */
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? options.length - 1
          : e.key === "ArrowLeft"
            ? (i - 1 + options.length) % options.length
            : (i + 1) % options.length;
    const target = options[next];
    if (!target) return;
    onValueChange(target.value);
    refs.current[target.value]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[opt.value] = el;
            }}
            type="button"
            role="tab"
            id={tabId(name, opt.value)}
            aria-selected={selected}
            aria-controls={tabPanelId(name, opt.value)}
            // Roving tabindex: one stop for the whole tablist, then ←/→ within it.
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onValueChange(opt.value)}
            onKeyDown={onKeyDown}
            className={cn(
              segmentPillClass(selected, disabled),
              "focus-visible:ring-ring/50 gap-2 focus-visible:ring-[3px] focus-visible:outline-none",
            )}
            data-testid={opt.testId}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
