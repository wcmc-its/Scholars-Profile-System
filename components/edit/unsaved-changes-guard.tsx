/**
 * The unsaved-changes navigation guard (#356 Phase 6 C9, UI-SPEC § Feedback —
 * dirty-state scope; vision-round T3.2).
 *
 * When `dirty === true` it guards three exit routes:
 *
 *   1. **Reload / tab close / cross-origin nav** — a `beforeunload` listener
 *      triggers the browser's own native "you have unsaved changes" prompt.
 *      This is the one route a styled dialog cannot intercept (no async window
 *      between the event and the unload), so it stays native.
 *   2. **In-subtree `<a href>` click** (App Router `Link`s, header/account-menu
 *      links, sidebar links) — a capture-phase document `click` handler
 *      `preventDefault()`s + `stopPropagation()`s synchronously (so Next's
 *      `Link` handler never runs), stashes the href, and opens the branded
 *      `ConfirmDialog`. Navigation happens via `router.push(href)` only on
 *      confirm. Cmd/Ctrl/Shift/aux-click (new tab/window) and in-page `#`
 *      anchors bypass the guard — those don't unload the current document.
 *   3. **Browser Back / Forward** — `popstate` fires *after* the history
 *      pointer has already moved, so we cannot cancel it. Instead, while dirty,
 *      we push a sentinel history entry; a Back press then pops onto the
 *      sentinel (not off the page). On that `popstate` we re-push the sentinel
 *      (staying put) and open the dialog; on confirm we set a bypass flag and
 *      step back past the sentinel; on cancel we simply stay.
 *
 * Replaces the v1 native `window.confirm` (UI-SPEC dirty-state scope) and
 * closes the documented Back/forward gap (former KNOWN v1 GAP D6.3).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";

const CONFIRM_TITLE = "Leave without saving?";
const CONFIRM_DESCRIPTION =
  "You have unsaved changes. If you leave this page now, they'll be lost.";
const CONFIRM_LABEL = "Leave anyway";

/** A marker on the sentinel history entry so we recognize our own push. */
const SENTINEL_KEY = "__sps_unsaved_guard__";

type PendingTarget = { kind: "href"; href: string } | { kind: "back" };

export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const pendingRef = React.useRef<PendingTarget | null>(null);
  // When true, the next `popstate` is one we triggered ourselves (a confirmed
  // back-navigation or the disarm cleanup) and must NOT re-open the dialog.
  const bypassRef = React.useRef(false);

  // (1) beforeunload — reload / tab close / cross-origin nav (stays native).
  React.useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      // preventDefault + returnValue triggers the browser's native prompt.
      // Modern browsers ignore any custom string but still honor the prompt.
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
      // Honor Cmd/Ctrl/Shift-click + middle/aux-click (new tab/window) — those
      // navigations do not leave the current document, so dirty state survives.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return; // in-page anchor — allow
      if (anchor.target && anchor.target !== "_self") return; // opens elsewhere
      // Block the navigation unconditionally; the branded dialog now decides.
      e.preventDefault();
      e.stopPropagation();
      pendingRef.current = { kind: "href", href };
      setDialogOpen(true);
    }
    document.addEventListener("click", handler, true); // capture
    return () => document.removeEventListener("click", handler, true);
  }, [dirty]);

  // (3) Browser Back / Forward — sentinel-entry interception.
  React.useEffect(() => {
    if (!dirty) return;
    if (typeof window === "undefined") return;

    // Push a sentinel so a Back press pops onto it instead of off the page.
    window.history.pushState({ [SENTINEL_KEY]: true }, "");

    function handler() {
      if (bypassRef.current) {
        // A popstate we initiated (confirmed back-nav / disarm cleanup); let it
        // pass without re-trapping.
        bypassRef.current = false;
        return;
      }
      // The user pressed Back/Forward off our sentinel. Re-push the sentinel to
      // keep them on the page, then ask via the branded dialog.
      window.history.pushState({ [SENTINEL_KEY]: true }, "");
      pendingRef.current = { kind: "back" };
      setDialogOpen(true);
    }

    window.addEventListener("popstate", handler);
    return () => {
      window.removeEventListener("popstate", handler);
      // On disarm (dirty cleared or unmount), pop our sentinel so we don't leave
      // a phantom entry behind. Guard with the marker so we only pop our own.
      const state = window.history.state as Record<string, unknown> | null;
      if (state && state[SENTINEL_KEY] === true) {
        bypassRef.current = true;
        window.history.back();
      }
    };
  }, [dirty]);

  function handleConfirm() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setDialogOpen(false);
    if (!pending) return;
    if (pending.kind === "href") {
      router.push(pending.href);
    } else {
      // Confirmed a Back/Forward exit. The stack is [...prev, sentinel] after
      // our re-push; bypass the next popstate (our own) and step back twice —
      // once off the sentinel, once off the page the user wanted to leave.
      bypassRef.current = true;
      window.history.go(-2);
    }
  }

  function handleOpenChange(open: boolean) {
    if (open) {
      setDialogOpen(true);
      return;
    }
    // Dialog dismissed without confirming — drop the pending target and stay.
    pendingRef.current = null;
    setDialogOpen(false);
  }

  return (
    <ConfirmDialog
      open={dialogOpen}
      onOpenChange={handleOpenChange}
      title={CONFIRM_TITLE}
      description={CONFIRM_DESCRIPTION}
      reasonMode="none"
      confirmLabel={CONFIRM_LABEL}
      confirmVariant="destructive"
      onConfirm={handleConfirm}
    />
  );
}
