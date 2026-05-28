/**
 * Vitest setup — jsdom polyfills for components that touch viewport geometry.
 *
 * Tiptap / ProseMirror's `scrollToSelection` calls `Range.getClientRects()` on
 * every state update through `editor.chain().focus()...`. jsdom's `Range` does
 * not implement that method, so the call throws an unhandled `TypeError` and
 * vitest exits non-zero even when assertions pass. Returning an empty list is
 * enough — the editor only needs the call to not throw; scroll geometry has no
 * effect in jsdom.
 */
// Radix Select calls `scrollIntoView` on the focused option when its content
// portal mounts; jsdom does not implement it. A no-op is enough for tests.
if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.scrollIntoView !== "function") {
  HTMLElement.prototype.scrollIntoView = function () {};
}

// Radix primitives (e.g. RadioGroup's size hooks) observe element geometry via
// ResizeObserver, which jsdom does not implement. A no-op stub is enough — the
// callbacks have no effect on assertions in jsdom.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = function () {
      return [] as unknown as DOMRectList;
    };
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = function () {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
  }
}
