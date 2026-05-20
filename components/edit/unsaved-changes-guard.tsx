/**
 * The unsaved-changes navigation guard (#356 Phase 6 C9, UI-SPEC § Feedback —
 * dirty-state scope).
 *
 * Two listeners are attached when `dirty === true`:
 *   1. `beforeunload` — reload / tab close — the browser shows its native
 *      confirmation. Fires natively on every browser.
 *   2. `click` capture on document — any `<a href>` click inside the page
 *      subtree (the header's account-menu links, the sidebar links) opens a
 *      `confirm()` dialog and `preventDefault()`s on cancel. Capture phase
 *      so the guard runs before Next's `Link` click handler.
 *
 * KNOWN v1 GAP (D6.3). Back / forward via the browser button is NOT
 * intercepted in v1. The `popstate` event fires *after* the navigation has
 * begun, so a confirm-and-revert is fragile; the cleaner alternative is a
 * `useRouter` wrapper (a `next-navigation-confirm`-style helper) and is
 * deferred. See `.planning/self-edit-v1-phase6-plan.md` D6.3 + § 11.
 */
"use client";

import * as React from "react";

const CONFIRM_MESSAGE = "You have unsaved changes. Leave anyway?";

export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  // (1) beforeunload — reload / tab close / cross-origin nav.
  React.useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      // Calling preventDefault + setting returnValue triggers the browser's
      // native "you have unsaved changes" prompt. Modern browsers ignore the
      // custom string but still honor the prompt.
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // (2) In-subtree <a href> click — intra-site App Router navigation.
  React.useEffect(() => {
    if (!dirty) return;
    function handler(e: MouseEvent) {
      // Honor Cmd/Ctrl-click (new tab) — that navigation does not leave the
      // current document, so the dirty state survives.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return; // in-page anchor — allow
      // `confirm` returns false on Cancel — block the navigation.
      if (!window.confirm(CONFIRM_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener("click", handler, true); // capture
    return () => document.removeEventListener("click", handler, true);
  }, [dirty]);

  return null;
}
