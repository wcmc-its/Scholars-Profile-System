/**
 * Tab styling for the console nav, which sits IN the dark `ConsoleTopBar`.
 * Shared by `AdminTab` (server), `AdminGroupMenu` and `MatchaTab` (client) —
 * they used to hand-mirror these strings. Full bar height so the active
 * underline sits on the bar's bottom edge.
 */
export const BAR_TAB_ACTIVE =
  "border-apollo-maroon-on-bar inline-flex h-14 shrink-0 items-center gap-1 border-b-2 text-sm font-medium whitespace-nowrap text-white";
export const BAR_TAB_INACTIVE =
  "inline-flex h-14 shrink-0 items-center gap-1 border-b-2 border-transparent text-sm whitespace-nowrap text-white/70 transition-colors hover:text-white";
