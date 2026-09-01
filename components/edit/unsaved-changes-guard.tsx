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
 *      `ConfirmDialog`. On confirm we first pop the Back/Forward sentinel
 *      (route 3) off the history stack, then `router.push(href)` from the
 *      resulting (bypassed) `popstate` — so no phantom same-URL entry is left
 *      behind and Back from the destination reaches the edit page exactly once.
 *      Cmd/Ctrl/Shift/aux-click (new tab/window) and in-page `#` anchors bypass
 *      the guard — those don't unload the current document.
 *   3. **Browser Back / Forward** — `popstate` fires *after* the history
 *      pointer has already moved, so we cannot cancel it. Instead, while dirty,
 *      we push a sentinel history entry; a Back press then pops onto the
 *      sentinel (not off the page). On that `popstate` we re-push the sentinel
 *      (staying put) and open the dialog; on confirm we set a bypass flag and
 *      step back past the sentinel; on cancel we simply stay.
 *
 * Replaces the v1 native `window.confirm` (UI-SPEC dirty-state scope) and
 * closes the documented Back/forward gap (former KNOWN v1 GAP D6.3).
 *
 * ⚠ HAZARD FOR A FORM THAT NAVIGATES ON SAVE (#2546). Route 3's effect cleanup
 * pops the sentinel with `history.back()` whenever `dirty` goes false OR the
 * component unmounts. If the consumer clears `dirty` and calls
 * `router.push(...)` in the same commit, that pop races the push — and wins:
 * measured on staging, the redirect was eaten on every attempt, silently
 * (`bypassRef` swallows the resulting popstate, so there is no console output
 * and no dialog). The write had already committed, so the operator saw a
 * completed action with no navigation and no feedback.
 *
 * Every current consumer is safe: five of the six save in place with
 * `router.refresh()`, and `unit-create-form` deliberately no longer pushes at
 * all — it renders a success panel with a real link instead. If you add a form
 * under this guard that MUST navigate on save, do not simply call
 * `router.push`. Pass a `ref` to `UnsavedChangesGuard` and, after the save
 * commits, call `guardRef.current?.navigateAfterSave(href)` instead of
 * `router.push(href)` directly — it pops the sentinel (if armed) and pushes
 * from the resulting popstate via a listener that outlives the effect
 * cleanup, so it is safe to clear `dirty` or unmount the guard in that same
 * commit.
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

/** Imperative handle for a consumer that must navigate right after a save. */
export type UnsavedChangesGuardHandle = {
  navigateAfterSave: (href: string) => void;
};

export function UnsavedChangesGuard({
  dirty,
  ref,
}: {
  dirty: boolean;
  ref?: React.Ref<UnsavedChangesGuardHandle>;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const pendingRef = React.useRef<PendingTarget | null>(null);
  // When true, the next `popstate` is one we triggered ourselves (a confirmed
  // back-navigation, a confirmed href pop, or the disarm cleanup) and must NOT
  // re-open the dialog.
  const bypassRef = React.useRef(false);
  // Set when an href navigation has been confirmed: we pop the sentinel first
  // (history.back), then perform this push from the resulting bypassed popstate
  // so no phantom same-URL entry lingers above the destination. Held in a ref so
  // the popstate handler (registered once per arm) always sees the latest href.
  const pendingPushRef = React.useRef<string | null>(null);
  // `router.push` read through a ref so the popstate handler — closed over at
  // arm time — never calls a stale router.
  const routerRef = React.useRef(router);
  routerRef.current = router;
  // Set while our own `navigateAfterSave` pop is outstanding (issued, popstate
  // not yet observed). The route-3 cleanup consults this to skip its own
  // disarm pop — otherwise, since the state update from history.back() is not
  // guaranteed to be visible synchronously, the cleanup can fire while
  // history.state still reports the sentinel and issue a second back(),
  // stepping the user off the page (#2546).
  const popInFlightRef = React.useRef(false);

  // Navigate after a save without racing the disarm cleanup's own pop (#2546).
  // If the sentinel is armed, pop it first and push from the resulting
  // popstate via a one-shot *window* listener — independent of the route-3
  // effect, whose cleanup (and handler) may already have run by the time that
  // popstate arrives if the caller also clears `dirty` / unmounts the guard
  // in the same commit.
  const navigateAfterSave = React.useCallback((href: string) => {
    const sentinelArmed =
      typeof window !== "undefined" &&
      (window.history.state as Record<string, unknown> | null)?.[SENTINEL_KEY] === true;
    if (!sentinelArmed) {
      routerRef.current.push(href);
      return;
    }
    popInFlightRef.current = true;
    bypassRef.current = true;
    window.addEventListener(
      "popstate",
      () => {
        popInFlightRef.current = false;
        bypassRef.current = false;
        routerRef.current.push(href);
      },
      { once: true },
    );
    window.history.back();
  }, []);

  React.useImperativeHandle(ref, () => ({ navigateAfterSave }), [navigateAfterSave]);

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
        // A popstate we initiated (confirmed back-nav / confirmed href pop /
        // disarm cleanup); let it pass without re-trapping.
        bypassRef.current = false;
        // If this pop was the sentinel-removal for a confirmed href navigation,
        // the stack is now [...prev, editPage]; push the destination once so the
        // final stack is [...prev, editPage, href] — no phantom entry.
        const pendingPush = pendingPushRef.current;
        if (pendingPush !== null) {
          pendingPushRef.current = null;
          routerRef.current.push(pendingPush);
        }
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
      // Skip it while a `navigateAfterSave` pop is already in flight (#2546) —
      // otherwise this would issue a second, unwanted `history.back()`.
      const state = window.history.state as Record<string, unknown> | null;
      if (state && state[SENTINEL_KEY] === true && !popInFlightRef.current) {
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
      // While dirty, route (3) has pushed a sentinel (same URL as the edit page)
      // on top of the stack: [...prev, editPage, sentinel]. Pushing the href now
      // would leave [...prev, editPage, sentinel, href] — Back from the
      // destination would then land on the sentinel (a same-URL no-op) once
      // "for free" before reaching the edit page: one dead Back press.
      //
      // Instead pop the sentinel first (history.back), then perform the push
      // from the resulting bypassed popstate (see the route-3 handler). The
      // final stack is [...prev, editPage, href] — Back reaches the edit page
      // exactly once. If route (3) isn't armed (sentinel never pushed) there is
      // no popstate to drive the push, so fall back to pushing immediately.
      const sentinelArmed =
        typeof window !== "undefined" &&
        (window.history.state as Record<string, unknown> | null)?.[SENTINEL_KEY] === true;
      if (sentinelArmed) {
        pendingPushRef.current = pending.href;
        bypassRef.current = true;
        window.history.back();
      } else {
        router.push(pending.href);
      }
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
