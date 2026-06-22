/**
 * Flag reader for the unified account dropdown + console-nav restructure
 * (`docs/account-dropdown-nav-and-rail-descriptions-handoff.md`, Workstreams
 * A + B). When on:
 *   - the account menu lists **View my profile → Edit my profile** (reordered),
 *     relabels the superuser roster row "Admin" → "Admin console", and the
 *     GrantRecs row "Find researchers" → "Funding matcher";
 *   - inside the `/edit` console the account chip/dropdown REPLACES the old
 *     "My Profile" tab at the right end of the `AdminSubnav` strip, and its
 *     context row reads "Back to Scholars" instead of "Admin console".
 *
 * Presentational / navigational only — no data changes. Default-off and
 * staging-first (`env === "staging" ? "on" : "off"` in `cdk/lib/app-stack.ts`);
 * takes effect on a manual `cdk deploy --exclusively Sps-App-<env>`. Mirrors the
 * `isRailRestructureEnabled` shape in `lib/edit/rail-layout.ts`.
 *
 * Read server-side in two places (the flag never reaches the client as a prop):
 *   - `app/api/auth/session/route.ts` — the value rides the `/api/auth/session`
 *     probe to the client `AccountMenu`, and gates the `buildConsoleLinks`
 *     relabel.
 *   - `components/edit/admin-subnav.tsx` — the (server-rendered) console strip
 *     reads it directly to swap the right-end tab for the account menu.
 */
export function isAccountConsoleNavRestructureEnabled(): boolean {
  return process.env.ACCOUNT_CONSOLE_NAV_RESTRUCTURE === "on";
}
