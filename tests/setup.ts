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
