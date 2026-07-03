# Account dropdown + console nav + rail-description polish — handoff

Three related UI changes, all staging-first behind flags where they touch live surfaces.
Mockup: `~/Downloads/account_dropdown_public_vs_console.html` (two states: public navbar +
dropdown, and admin-console navbar + dropdown). Builds on the **self-edit rail restructure
(PR #1198, merged `e89a8a20`, staging-live, user-confirmed working)** — see
`docs/917-followups-rollout-handoff.md` siblings and the `project_edit_rail_restructure` memory.

Grounded against `origin/master` @ `e89a8a20` (worktree `~/worktrees/sps-biosketch`).

---

## Workstream A — Unified account dropdown (public ↔ console)

The avatar dropdown becomes the single home for profile + context actions in **both** the public
site and the admin console, with one context-dependent row.

### Desired end state (per mockup)
Menu rows, in this order:
1. **View my profile**
2. **Edit my profile**
3. — divider —
4. **Admin console** (when on the public site) **/ Back to Scholars** (when in the console)
5. — divider —
6. **Sign out**

(The role-aware console destinations — Method families / Org units / Funding opportunities — and the
superuser "View as…" impersonation row still live in the middle section; see the open questions.)

In the **admin console navbar**, the account chip/dropdown **replaces the old "My Profile" tab** on
the right end of the tab strip. Profile actions move entirely into the dropdown.

### Current state
- `components/site/account-menu.tsx` — the dropdown (client; Radix Popover). Today renders, for a
  scholar: **Edit my profile**, **View my profile**, divider, the `consoleLinks` rows + a **View as…**
  impersonation row (when `canImpersonate`), divider, **Sign out**. It is mounted only in the public
  header via `components/site/header-auth-slot.tsx`.
- `components/edit/admin-subnav.tsx` — the console tab strip; **"My Profile"** anchors the right end
  (`selfEditHref`). The account dropdown is **not** mounted here today.
- `lib/auth/console-links.ts` — `buildConsoleLinks(verdicts)` returns the console destinations:
  `manage-profiles` (label **"Admin"**, `/edit/scholars`, superuser), `methods` ("Method families"),
  `units` ("Org units"), `find-researchers` ("Find researchers" — see Workstream B).

### Work
1. **Reorder** the top two rows to **View my profile → Edit my profile** (mockup order; today Edit is
   first).
2. Add a **context** notion to `AccountMenu` (`context: "public" | "console"`, or derive from
   `usePathname()` — `/edit*` ⇒ console):
   - **public** ⇒ the console entry reads **"Admin console"** (rename the superuser `manage-profiles`
     label from "Admin" → "Admin console" in `console-links.ts`, or relabel at render).
   - **console** ⇒ replace that row with **"Back to Scholars"** (a link to `/` / the public site),
     using the left-arrow icon.
3. **Mount `AccountMenu` in the admin console navbar** (`admin-subnav.tsx`), right-aligned, and
   **remove the "My Profile" tab** (`selfEditHref` tab). Pass `context="console"`. Keep the
   impersonation banner/switcher behavior intact.
4. Keep **Sign out** as the POST `<form>` (unchanged).

### Open questions
- **Middle section on public:** the mockup (a superuser) shows a single **"Admin console"** row. For a
  non-superuser steward / unit-admin the middle section today shows multiple rows (Method families,
  Org units). Decide: keep showing each role-entry row, or collapse non-superusers to a single
  "Admin console" entry too? Recommend: keep per-role rows (don't regress the dwd2001 steward path),
  just rename the superuser row to "Admin console".
- **"View as…"** impersonation row — confirm it stays in the middle section in both contexts.

---

## Workstream B — "Funding opportunities" (rename + admin-only)

The mockup draws **"Researchers for funding"** in the public navbar. **Note from PO:** it should be
**"Funding opportunities"** and live **in admin**, not the public top nav.

### Current state
- There is **no** "Researchers for funding" item in the public top nav today (`header.tsx` has only
  Browse / About + the account slot). The surface it refers to is the GrantRecs Phase 4 admin tool at
  `/edit/find-researchers` (`app/edit/find-researchers/page.tsx`, `components/edit/find-researchers.tsx`),
  surfaced as the `find-researchers` console-links row labeled **"Find researchers"** in the account
  dropdown (superuser + `development`-role; `console-links.ts` + `canFindResearchers`).

### Work
1. **Rename** the `find-researchers` console link label **"Find researchers" → "Funding opportunities"**
   in `lib/auth/console-links.ts` (and any test asserting the label).
2. **Keep it admin-only** — it is already a console-links dropdown row (not a public nav item); do
   **not** add a "Researchers for funding"/funding item to the public `header.tsx` top nav.

### Open question (resolve before relabeling)
`/edit/find-researchers` is "given a funding opportunity, find good-fit **researchers**." Relabeling it
"**Funding opportunities**" reads as the inverse (a list of opportunities). Confirm with PO that the
rename targets this same surface (just a label change) vs. pointing at a different/owner surface (e.g.
the `grant-recs` "Grants for me" feature). Do not mislabel the destination.

---

## Workstream C — Rail group descriptions (extends #1198)

The self-edit rail (restructured in #1198) currently renders each group's one-line description as
visible muted text under the group header. Change that:

### Tuck under an info ("ⓘ") button (keep the text, reveal on hover/click)
- **From WCM records** → "Sourced from WCM. Show, hide, or flag here — corrections happen in the source
  system."
- **Tools** → "Generators that produce an artifact to use elsewhere."
- **Settings** → "Profile administration."

### Delete entirely (no info button)
- **Yours to edit** → "Your profile content." (and its third-person variant "The scholar's profile
  content.")
- The edit-surface intro paragraph: **"Changes here appear on your public profile. Most fields come
  from WCM systems — use Request a change to fix those."**

### Where
- `components/edit/edit-page.tsx` — `RAIL_V2_GROUP_META`: remove the `"Yours to edit"` and
  `"Profile content"` description entries (delete). Keep the other three descriptions (they become the
  info-button content).
- `components/edit/attribute-rail.tsx` — the group-header render block that today emits
  `{description && <p …>}` (the `groupMeta?.[label]?.description` line I added in #1198). Replace the
  inline `<p>` with a small **info button beside the group label** that reveals the description in a
  tooltip/popover.
  - **Implementation note:** `AttributeRail` is currently a **server component** (its rows are
    `next/link`). An interactive tooltip/popover needs a client island — either extract a tiny
    `"use client"` `GroupInfoButton` (shadcn `Tooltip`/`Popover`) used only for the header, or use a
    native `<button>` with `aria-label` + `title`/`aria-describedby` to avoid making the whole rail
    client. Prefer the small client sub-component for hover+focus parity and a11y.
- `components/edit/edit-shell.tsx` — **delete** the `{mode === "self" && (<p>…Changes here appear on
  your public profile…</p>)}` block (≈ lines 209–213).

### Tests
- Update `tests/unit/edit-page.test.tsx` — the #1198 block asserts `getByText("Your profile content.")`
  etc. After this change: `"Your profile content."` must be **absent**; the three tucked descriptions
  are no longer plain text under the header (assert the info button exists, e.g. an `aria-label` like
  "About this group", and that the description is reachable via the tooltip/popover).

---

## Sequencing / flags
- **C** is the smallest and rides the same `SELF_EDIT_RAIL_RESTRUCTURE` surface (already staging-on);
  no new flag. Could land first as a quick follow-up PR.
- **A + B** touch shared nav chrome (header, account menu, console subnav). Consider one PR. No data
  changes; presentational + nav. Decide whether to flag-gate the dropdown/nav restructure (recommend a
  flag, staging-first, given it changes every signed-in viewer's chrome).
- All staging-first; prod flips are gated as usual.

## Related open item (carried from #1198)
- The **"From WCM records"** group label undersells the group once Clinical Trials (ClinicalTrials.gov)
  and Publications (PubMed) sit there — consider renaming to "Sourced records." Tracked alongside the
  Clinical Trials edit panel, **issue #1199**.
