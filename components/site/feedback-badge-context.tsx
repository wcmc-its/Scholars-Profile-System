"use client";

/**
 * Suppression registry for the site-wide feedback badge (#538,
 * docs/feedback-badge-spec.md § "The badge" — "Suppressed inside any
 * open Radix Dialog overlay").
 *
 * The pattern is a refcount: any client component that wants the badge
 * hidden while it is mounted calls `useSuppressFeedbackBadgeWhileMounted`,
 * which `acquire()`s on mount and `release()`s on unmount. The badge
 * reads `useFeedbackBadgeSuppressed()` and returns `null` while the
 * count is > 0.
 *
 * Currently only `components/ui/dialog.tsx` `DialogContent` registers
 * itself — when any Radix Dialog is open, its content mounts inside a
 * Portal, the effect fires, the badge hides; when the dialog closes,
 * the content unmounts and the badge re-appears. Tooltips, popovers,
 * and hover-cards do **not** register: they're transient floating UI,
 * not modal interruptions, and the SPEC specifically scopes
 * suppression to Dialog.
 *
 * If a future component needs the same "hide while I'm here" affordance
 * (a full-page wizard, a confirmation overlay), it imports the same
 * hook. No abstraction tax for the first consumer.
 */
import * as React from "react";

interface FeedbackBadgeContextValue {
  suppressionCount: number;
  acquire: () => void;
  release: () => void;
}

const Ctx = React.createContext<FeedbackBadgeContextValue | null>(null);

export function FeedbackBadgeProvider({ children }: { children: React.ReactNode }) {
  const [suppressionCount, setSuppressionCount] = React.useState(0);
  // Refs to keep `acquire` / `release` stable across renders so the
  // `useEffect` in `useSuppressFeedbackBadgeWhileMounted` doesn't need
  // them in its dependency list — preventing acquire-on-render thrash.
  const acquire = React.useCallback(() => {
    setSuppressionCount((c) => c + 1);
  }, []);
  const release = React.useCallback(() => {
    setSuppressionCount((c) => Math.max(0, c - 1));
  }, []);
  const value = React.useMemo(
    () => ({ suppressionCount, acquire, release }),
    [suppressionCount, acquire, release],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** True when at least one consumer has acquired suppression. */
export function useFeedbackBadgeSuppressed(): boolean {
  const ctx = React.useContext(Ctx);
  return ctx ? ctx.suppressionCount > 0 : false;
}

/**
 * Acquire feedback-badge suppression on mount, release on unmount.
 * No-op when not wrapped in a `FeedbackBadgeProvider` (so a Dialog
 * rendered in isolation in a test or a Storybook does not throw).
 */
export function useSuppressFeedbackBadgeWhileMounted(): void {
  const ctx = React.useContext(Ctx);
  React.useEffect(() => {
    if (!ctx) return;
    ctx.acquire();
    return () => {
      ctx.release();
    };
    // `acquire` and `release` are stable callbacks; we intentionally
    // run this effect once per mount, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
