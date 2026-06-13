# Role-aware navigation entry points — recommendation

**Status:** Recommendation, awaiting approval. No code changed.
**Trigger:** dwd2001 (external comms, `comms_steward`) logged in on staging and
could not navigate to the Method-Family management page.
**Scope:** What the **login dropdown** (`AccountMenu`) and the **top horizontal
bar** (`components/site/header.tsx`) should show, for every user role.

---

## 1. Root cause (confirmed in code, not hypothesised)

dwd2001 is a *correctly provisioned* steward. #900 set
`SCHOLARS_COMMS_STEWARD_ALLOWLIST=dwd2001` on staging, so `isCommsSteward()`
returns `true` and `/edit/methods` admits them (`app/edit/methods/page.tsx`
guard: `isCommsStewardEnabled()` on + `isCommsSteward || isSuperuser`). The role
works. The **only** thing missing is a clickable way in.

What dwd2001 sees after login:

| Signal | Value for dwd2001 | Source |
|---|---|---|
| `scholar` | `null` (external comms — no profile row) | `/api/auth/session` |
| `canBrowseProfiles` | `false` (not a superuser) | `app/api/auth/session/route.ts` |
| `canImpersonate` | `false` | same |
| *(any comms_steward signal)* | **absent — the probe doesn't compute one** | same |

`components/site/account-menu.tsx` renders, in order: "Edit my profile"
(only if `scholar !== null`), "View my profile" (same gate), "Manage profiles"
(only if `canBrowseProfiles`), "View as…" (only if `canImpersonate`), "Sign out"
(always). For dwd2001 every gate is false → the menu collapses to the
no-profile case: trigger label **"Account"**, body **"Sign out" only**.

The "Method Families" tab does exist — but only inside `AdminSubnav`
(`components/edit/admin-subnav.tsx`), which renders *after* you are already on a
`/edit` console page. And `/edit` itself 404s for dwd2001: `app/edit/page.tsx`
calls `loadEditContext` (null — no scholar row), then `scholarsServedByProxy`
(empty — not a proxy), and falls through to `notFound()`.

**Net:** no link, no tab, no landing. The page is reachable only by typing the
URL. The complaint is legitimate and fully explained.

### This is not a one-off

The dropdown's admin section is gated on `canBrowseProfiles || canImpersonate`
— **both superuser-only**. Every privileged-but-not-superuser role hits the same
wall:

- **`comms_steward`** → no entry to `/edit/methods` (this complaint).
- **Unit Owner / Curator** (not also superuser) → no entry to `/edit/units`
  ("Units you manage"). They reach unit editing today only via a bookmark or a
  deep link, never from the dropdown.

comms_steward is simply the first to *notice*, because it is the only privileged
role with no profile to fall back on.

---

## 2. Current state inventory

### 2a. Top horizontal bar — `components/site/header.tsx`

Server component on cacheable public surfaces. **By design it never reads the
session** (#640): CloudFront strips the cookie from the cached default behavior,
so the bar always renders `isAuthenticated={false}` and defers the real auth
state to `HeaderAuthSlot`, which client-probes `/api/auth/session`.

| Item | Route | Gate |
|---|---|---|
| "Browse" | `/search` | always |
| "About" | `/about` | always |
| Auth slot | "Sign in" **or** `<AccountMenu>` | client probe: `authenticated` |

### 2b. Login dropdown — `components/site/account-menu.tsx`

Client component (a Popover). Reused in two places: the public header
(`HeaderAuthSlot`) and the console header (`EditShell`, with
`showViewProfile={false}`). Opens a deferred probe (`useImpersonationProbe`) so a
signed-in render fires no extra request until the menu is opened.

| Item | Route | Gate (today) |
|---|---|---|
| Edit my profile | `/edit` | `scholar !== null` |
| View my profile | `/{slug}` | `scholar !== null` && `showViewProfile` |
| Manage profiles | `/edit/scholars` | `canBrowseProfiles` (**superuser**) |
| View as… | (switcher) | `canImpersonate` (**superuser** + `IMPERSONATION_ENABLED`) |
| Sign out | `POST /api/auth/logout` | always |

### 2c. Console tab strip — `components/edit/admin-subnav.tsx` (already correct)

#900 did the *inside-the-console* half right. Once a viewer is on any `/edit`
console list surface, `AdminSubnav` shows exactly the tabs they can open:

- `superuserSurfaces` (= `session.isSuperuser`) gates Profiles / URL requests /
  Slug registry / Administrators.
- `methodsTab` is shown iff `isMethodsTabVisible(session)` (flag on AND
  `isSuperuser || isCommsSteward`).
- A steward-only viewer on `/edit/methods` correctly sees **only** the Method
  Families tab (`superuserSurfaces=false`).

The gap is **getting into** the console, not navigating once inside.

---

## 3. Design principles

1. **One canonical home for role-aware destinations: the login dropdown.** It is
   already where authenticated users look for "their stuff," already
   client-probed, and already isolated from the cached public bar. The top bar
   stays public (Browse / About + auth slot). Don't push role concepts into the
   always-visible, cached bar.
2. **Never advertise a surface a viewer can't open** (matches the existing
   `isMethodsTabVisible` / `superuserSurfaces` discipline). Display follows the
   same role verdicts the route guards already enforce.
3. **Authority stays server-side.** Eligibility is computed where
   `isSuperuser` / `isCommsSteward` / unit-role already resolve — never
   re-derived in the client. The route guard remains the real boundary; the menu
   is display only.
4. **Profile-independent.** A privileged role must get its entry point whether or
   not it owns a Scholar row (the dwd2001 case). The admin section must not be
   nested under the `scholar !== null` block.
5. **Dropdown = one entry per role; `AdminSubnav` = tabs within the console.**
   The dropdown drops you at the right surface; the in-console tab strip fans out
   from there. Keep the dropdown short.

---

## 4. Recommendation

### 4a. Architecture — server-built destination list (recommended)

Extend `/api/auth/session` to return an ordered, server-computed list of console
entry points the viewer is entitled to:

```ts
// app/api/auth/session/route.ts — new field on the existing payload
consoleLinks: Array<{ id: string; label: string; href: string }>
```

built from the verdicts already (or cheaply) available server-side:

| Entry | Condition (server-side) | href |
|---|---|---|
| Manage profiles | `isSuperuser` | `/edit/scholars` |
| Method Families | `isMethodsTabVisible(session)` **and not** `isSuperuser` *(a superuser already reaches it via Manage profiles → AdminSubnav)* | `/edit/methods` |
| Units you manage | owns or curates ≥1 unit **and not** `isSuperuser` | `/edit/units` |

`AccountMenu` renders `consoleLinks` verbatim as a single separated section,
shown whenever the list is non-empty — **independent of `scholar`**. `View as…`
stays a separate action signal (`canImpersonate`); it is an action, not a
destination. `canBrowseProfiles` can be retired in favour of the list, or kept as
the source for the "Manage profiles" entry — either is fine.

Resulting dropdown order: *Edit/View my profile (if scholar)* → *console links
(if any)* → *View as… (if canImpersonate)* → *Sign out*.

**Why a server-built list rather than more booleans (named alternative —
Option A):** Option A adds one boolean per surface (`canManageMethods`,
`canManageUnits`, …) plus one client branch each, mirroring today's code. It is
the smaller diff, but it is *exactly the pattern that produced this bug*: #900
shipped the Method Families tab and nobody added the matching dropdown
boolean+branch, so the entry silently never appeared. Every future surface would
need a coordinated client+server change and could drift the same way. The
server-built list makes the client dumb, single-sources authority server-side,
and makes "add a role/surface" a one-file server change. **Recommended:
Option B (the list).**

**Cost of the list.** The probe is already `force-dynamic` and already does a
`scholar` lookup + `isSuperuser`. The list adds, for non-superusers only:
`isCommsSteward` (allowlist is free; the LDAP path fails-closed and is the same
check the route already runs) and one indexed `UnitAdmin` count by `cwid`
("owns/curates ≥1 unit"). Acceptable for a menu-open probe. Short-circuit: a
superuser needs neither extra check (Manage profiles covers them).

### 4b. Top bar — keep public (recommended), with one optional affordance

Leave `header.tsx` as Browse / About + auth slot. Admin destinations belong in
the dropdown, not beside public links on a cached surface.

*Optional, non-core:* when `consoleLinks` is non-empty, `HeaderAuthSlot` could
render a single compact "Console" affordance in the bar that opens the dropdown
to the console section — a convenience for privileged users deep in public pages.
Recommend **deferring** this: it reintroduces a role concept into the
always-visible bar and adds hydration nuance, for marginal benefit over the
dropdown. Revisit only if operators ask.

### 4c. Console dead-end — note, don't fix now

A no-profile steward who types `/edit` still gets a 404 (`app/edit/page.tsx`).
With 4a they never need to: the dropdown links straight to `/edit/methods`. A
later, optional refinement is to redirect a steward-only / unit-admin-only viewer
from `/edit` to their single console surface. **Out of scope** for this fix; flag
as a follow-up so the bare-URL path isn't a silent 404 forever.

---

## 5. Role × dropdown matrix (target state)

| Viewer | Edit / View my profile | Console links | View as… | Sign out |
|---|---|---|---|---|
| Anonymous | — *(Sign in in bar)* | — | — | — |
| Scholar (self only) | ✓ | — | — | ✓ |
| Unit Owner/Curator, has profile | ✓ | Units you manage | — | ✓ |
| comms_steward, has profile | ✓ | Method Families | — | ✓ |
| **comms_steward, no profile (dwd2001)** | — | **Method Families** | — | ✓ |
| Superuser, has profile | ✓ | Manage profiles | ✓ *(flag)* | ✓ |
| Superuser, no profile (staff) | — | Manage profiles | ✓ *(flag)* | ✓ |

A viewer holding several roles sees several links (e.g. unit Owner who is also a
steward → both entries). Superuser collapses to "Manage profiles" because the
in-console `AdminSubnav` already fans out to every superuser surface (incl.
Method Families when the comms flag is on).

---

## 6. Edge cases the implementation must cover

| Case | Expected |
|---|---|
| comms_steward, no profile (dwd2001) | Dropdown shows **Method Families**; trigger label "Account"; no Edit/View. |
| comms_steward, has profile | Edit/View my profile **and** Method Families. |
| `COMMS_STEWARD_ENABLED` off | `isMethodsTabVisible` false → no Method Families link (surface 404s anyway). No betrayal of the dark surface. |
| Superuser (steward or not) | Manage profiles only; no separate Method Families row (reached via AdminSubnav). |
| Unit Curator of 1 div, no profile | Units you manage; no Edit/View. |
| Plain scholar | Edit/View + Sign out; no console section. |
| Probe fails / returns `authenticated:false` | Bar shows "Sign in"; no dropdown. Fail-closed — a probe error never invents a link. |
| Impersonating (superuser "View as" steward) | Links reflect the **real** signed-in CWID (probe already reads real cwid for `canImpersonate`/`canBrowseProfiles`); keep that for `consoleLinks`. |

---

## 7. Verification

- **Unit:** extend `tests/unit/account-menu.test.tsx` — render with
  `consoleLinks=[{Method Families}]` and `scholar=null`; assert the link renders
  and "Edit my profile" does not. Add the unit-admin and superuser cases.
- **Route/probe:** add a `/api/auth/session` test asserting the computed
  `consoleLinks` for: superuser, steward-only, unit-owner-only, plain scholar,
  flag-off steward.
- **`AdminSubnav`:** no change needed — already covered by
  `tests/unit/admin-subnav.test.tsx` (#900).
- **Manual on staging:** sign in as dwd2001, open the account menu, confirm a
  single "Method Families" entry that lands on `/edit/methods`.
- Run the suite (`vitest --maxWorkers=4`) before pushing — tsc alone won't catch
  the rendered-order / probe-shape regressions.

---

## 8. Files this would touch (for scoping; not yet changed)

- `app/api/auth/session/route.ts` — compute and return `consoleLinks`.
- `components/site/account-menu.tsx` — render the list; move the admin section
  out from under the `scholar !== null` gate.
- `lib/auth/use-impersonation-probe.ts` (or the probe type) — surface
  `consoleLinks`.
- `lib/edit/manageable-units.ts` — reuse `loadManageableUnits` / a count for the
  "owns or curates ≥1 unit" verdict (already imported by `/edit`).
- Tests: `tests/unit/account-menu.test.tsx`, a new session-route test.
- No flag changes; no `AdminSubnav` change; no top-bar change (unless the
  optional 4b affordance is accepted).

---

## 9. Addendum — operator follow-ups (post-launch feedback)

After the §1–§8 dropdown fix shipped (#941), a superuser reported two console
gaps. Both are operator-discoverability, not authorization.

### 9a. Unify the console tab strip (Issue 2 — shipped)

The `/edit` self-edit surface rendered only "My Profile / All profiles", so the
full admin option set (Method Families included) appeared only after drilling
into the roster. Fix: render the shared `AdminSubnav` on the self-edit surface
for a superuser or comms_steward (`active="self"`, "My Profile" the active tab),
so every role-gated option is visible from anywhere in the console. A plain
scholar keeps the minimal strip. Drill-down detail pages
(`/edit/scholar/[cwid]`, unit editors) deliberately keep their contextual
breadcrumb — this unifies the **top-level** surfaces.

### 9b. View-as for comms_stewards (Issue 1 — shipped)

A superuser could not "View as" dwd2001 to preview the steward experience: the
candidate search is over `Scholar` rows and dwd2001 has none, and even if listed
the POST guard (impersonation-spec.md §7) rejected any target without a Scholar
row (`target_not_found`).

Changes: `/api/impersonation/candidates` appends enumerable stewards
(`listCommsStewardCwids`, the allowlist — LDAP-group enumeration is a noted
follow-up; profile-less stewards show their CWID, role "Communications
Steward"); the POST guard is broadened to admit a comms_steward target; the
session probe + banner surface a profile-less steward target (so the amber
banner **and its "Return to my view" exit** still render); and a profile-less
steward landing on `/edit` redirects to `/edit/methods` instead of 404 (the
impersonation landing, and a real steward's own home).

**Security rationale (the broadened guard).** This relaxes impersonation-spec.md
§7's "target must be a real scholar" to "a real scholar **or** a comms_steward."
No escalation: **R1** (only a superuser initiates) and **R2** (target may not be
a superuser, via `assertImpersonable`) are unchanged, and a superuser is already
a **superset** of comms_steward — so "view as a steward" is a strictly narrower
preview of a capability the actor already holds, never a gain. **R3** (writes
attributed to the real actor) and the enter/exit audit are unchanged. The check
is flag-gated (`isCommsSteward` ⇒ false when `COMMS_STEWARD_ENABLED` is off), so
the broadening is inert on a dark deployment.
