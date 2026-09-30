/**
 * Scroll-then-focus helpers for "the selection changed, take the user to the
 * results" moments (unit-page subunit chips, the taxonomy rail's mobile sheet).
 *
 * Pure DOM, no React, no env — safe to import from any client component.
 */

/** True when the viewer asked the OS to reduce motion. Never throws. */
export function prefersReducedMotion(): boolean {
  return matchesMedia("(prefers-reduced-motion: reduce)");
}

/** `window.matchMedia(query).matches`, false where matchMedia is missing or throws. */
export function matchesMedia(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Scroll `scrollTarget` to the top of the viewport (smooth unless reduced
 * motion is on), then move focus to `focusTarget` with `preventScroll` so the
 * scroll owns the viewport. Keyboard and screen-reader users land where the
 * change happened instead of staying on the control that caused it. The focus
 * target must be focusable (a `tabIndex={-1}` region is enough).
 */
export function scrollIntoViewAndFocus(
  scrollTarget: HTMLElement | null | undefined,
  focusTarget: HTMLElement | null | undefined = scrollTarget,
): void {
  scrollTarget?.scrollIntoView?.({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
  focusTarget?.focus({ preventScroll: true });
}
