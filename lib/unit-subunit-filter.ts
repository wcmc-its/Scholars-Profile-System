/**
 * Unit Page v2 — the tiny window-event contract between the hero's subunit
 * chips (divisions / programs, `components/shared/unit-subunit-chip-row.tsx`)
 * and the roster client that owns the matching facet
 * (`DepartmentFacultyClient` Division facet, center `GroupedRoster` Program
 * facet). The hero is a Server Component and the roster a separate client
 * island, so they share no React tree: the chip asks, the roster answers.
 *
 *  - `SUBUNIT_SELECT_EVENT` (chip → roster): "select this value" / "remove it".
 *    Dispatched synchronously; a roster that can serve the request sets
 *    `detail.handled = true`, and only then does the chip cancel its link
 *    navigation. No listener (another tab, facet flag off, no-JS) ⇒ the chip's
 *    real `href` (`?div=<code>#people`) navigates as a plain link. The filter
 *    is then applied by the roster's client mount seed; nothing reads the param
 *    server-side, so with JS off the link opens the unfiltered roster.
 *    A roster that unmounts (tab switch) broadcasts an empty selection so the
 *    chips never show a filter nobody is applying.
 *  - `SUBUNIT_SELECTION_EVENT` (roster → chips): the roster's current selection
 *    for that param, so a chip's active state follows the facet checkboxes too.
 *
 * Pure module — no server imports; it ships in the client bundle.
 */

export type SubunitParam = "div" | "program";

export const SUBUNIT_SELECT_EVENT = "sps:subunit-select";
export const SUBUNIT_SELECTION_EVENT = "sps:subunit-selection";

export type SubunitSelectDetail = {
  param: SubunitParam;
  value: string;
  /** "only" = make `value` the sole selection (the mock's pick()); "remove" =
   *  drop it (clicking an already-active chip). */
  action: "only" | "remove";
  /** Set to true by the roster that applied the request. */
  handled: boolean;
};

export type SubunitSelectionDetail = {
  param: SubunitParam;
  values: string[];
};

/** Ask the roster to apply a chip click. Returns true when a roster handled it. */
export function requestSubunitSelect(
  param: SubunitParam,
  value: string,
  action: SubunitSelectDetail["action"],
): boolean {
  const detail: SubunitSelectDetail = { param, value, action, handled: false };
  window.dispatchEvent(new CustomEvent(SUBUNIT_SELECT_EVENT, { detail }));
  return detail.handled;
}

/** Roster side: announce the current selection for `param` to the chips. */
export function broadcastSubunitSelection(param: SubunitParam, values: Iterable<string>): void {
  const detail: SubunitSelectionDetail = { param, values: Array.from(values) };
  window.dispatchEvent(new CustomEvent(SUBUNIT_SELECTION_EVENT, { detail }));
}

/** Apply a select request to a selection set (new set; input untouched). */
export function applySubunitSelect(
  prev: ReadonlySet<string>,
  value: string,
  action: SubunitSelectDetail["action"],
): ReadonlySet<string> {
  if (action === "only") return new Set([value]);
  const next = new Set(prev);
  next.delete(value);
  return next;
}

/**
 * Listen for chip requests for one `param`. `apply` returns false when it
 * can't serve the value (unknown code) — the request then stays unhandled and
 * the chip falls back to its link. Returns the unsubscribe function.
 */
export function onSubunitSelect(
  param: SubunitParam,
  apply: (value: string, action: SubunitSelectDetail["action"]) => boolean,
): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<SubunitSelectDetail>).detail;
    if (!d || d.param !== param || d.handled) return;
    if (apply(d.value, d.action)) d.handled = true;
  };
  window.addEventListener(SUBUNIT_SELECT_EVENT, handler);
  return () => window.removeEventListener(SUBUNIT_SELECT_EVENT, handler);
}

/**
 * `history.replaceState` target for a roster's query sync that KEEPS the
 * current hash (the chip lands on `#people`; a bare `?qs` URL would drop it).
 */
export function urlWithQuery(qs: string): string {
  return `${qs ? `?${qs}` : window.location.pathname}${window.location.hash}`;
}
