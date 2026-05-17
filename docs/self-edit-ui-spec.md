# Self-edit — v1 UI-SPEC (`/edit/*` surfaces)

**Status:** Draft
**Date:** 2026-05-17
**Authors:** Scholars Profile System development team
**Builds on:** [self-edit-spec.md](./self-edit-spec.md) § Surfaces and § Suppression UX and behavior — the routes, sections, and behavior this SPEC gives a visual and interaction design.
**Co-revises:** [self-edit-spec.md](./self-edit-spec.md) — adds `<a>` to the `overview` tag allowlist (§ The v1 editable-field set, § Hyperlinks in `overview`, edge case 8); the two documents change together.
**Foundation:** [ADR-005](./ADR-005-manual-override-layer.md) — the `field_override` + `suppression` mechanism.
**Implements:** [#355](https://github.com/wcmc-its/Scholars-Profile-System/issues/355) — UI-SPEC for the `/edit/*` self-edit surfaces.
**Design system:** Tailwind v4 tokens in `app/globals.css`; primitives in `components/ui/`.
**Gated by:** B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) — the `/edit/*` pages are SSO-gated and unreachable until B01 lands.

---

## Purpose

`self-edit-spec.md` § Surfaces defines the `/edit/*` route tree — three routes, their sections, and their behavior — and explicitly defers their **visual and interaction design** to a UI-SPEC ([self-edit-spec.md § Surfaces](./self-edit-spec.md), § Non-goals). This is that document.

It specifies **what the `/edit/*` pages look like and how they behave** — layout, the sign-in affordance, the components each surface uses, the overview editor, the suppression and slug controls, every loading / empty / error / validation state, the user-facing copy, accessibility, and responsive behavior. It does **not** redefine the routes, the authorization rules, the write-path, or the editable-field set — those are `self-edit-spec.md`'s, cited here, not relitigated.

Two design decisions are **ratified** and encoded below:

1. The `overview` editor is a **WYSIWYG rich-text editor** (Tiptap) — not a Markdown textarea.
2. `/edit` is a **settings-style, single-column** page of stacked section cards — not a mirror of the public-profile shell.

This revision also adds **hyperlink (`<a>`) support** to the bio — a capability `self-edit-spec.md` originally excluded. Because that SPEC owns the `overview` sanitize rule, the change is made in both documents together; the editor mechanics are in [§ The overview editor](#the-overview-editor), and the named security trade-off is in `self-edit-spec.md` § Hyperlinks in `overview`.

The feature is **unbuilt**. The Scholars Profile System is today a read-only site: no forms, no mutation endpoints, no authenticated routes, no editor, no sign-in. [§ Design foundations](#design-foundations) inventories what exists and what this SPEC adds.

*Terminology* carries over from `self-edit-spec.md` (**self-editing scholar**, **superuser**, **displayed author**). **Card** = the existing `components/ui/card.tsx` family. **Primitive** = a reusable `components/ui/*` component.

---

## Scope and ratified decisions

| Route | Actor | This SPEC defines |
|---|---|---|
| `/edit` | self | Layout + the three cards: Overview editor, Profile visibility, My publications. |
| `/edit/scholar/[cwid]` | self **or** superuser | When `cwid == session.cwid`: identical to `/edit`. When `cwid ≠ session.cwid` (superuser only): read-only Overview, Profile visibility, Slug override. |
| `/edit/publication/[pmid]` | superuser | The whole-publication takedown surface. |

Plus the **sign-in affordance** in the site header and the entry points to `/edit` — [§ Signing in](#signing-in-and-reaching-edit).

**Ratified — not reopened:** the WYSIWYG editor and the settings-style layout (above).

**Out of scope** — owned elsewhere, cited not redesigned:

- The routes, the per-action authorization predicate, the `/api/edit/*` request/response shapes, the write-path, the editable-field set, the behavioral edge-case table — **`self-edit-spec.md`**.
- The `field_override` / `suppression` tables and the read-merge — **ADR-005**.
- The SSO flow, the session cookie, and the sign-in / sign-out endpoints — **B01 #100**. This SPEC designs the header's sign-in affordance and account menu (§ Signing in); B01 implements the mechanism behind them.
- The suppression-management admin console and broad admin field-editing — `self-edit-spec.md` § Non-goals.

---

## Design foundations

**Stack.** Next.js 15.5 (App Router, `app/` only), React 19, TypeScript 5.7, Tailwind CSS v4, Prisma 7. Icons: **Lucide**. The `/edit/*` pages are server components (they do SSR reads — `self-edit-spec.md` § Surfaces); each interactive control is a `'use client'` island inside that server-rendered shell.

**Tokens.** All spacing, color, type, and radius come from the `@theme` block in `app/globals.css` — this SPEC names tokens, never raw values:

- Color: `--primary` (dark navy — primary actions), `--destructive` (red — destructive actions, errors), `--muted` / `--muted-foreground` (secondary surfaces and text), `--border`, `--input`, `--accent`. Cornell red `#B31B1B` is the site header only.
- Type: Inter sans throughout; the serif `.page-title` is reserved for the single page heading. Sizes `--text-sm` (13px), `--text-base` (15px), `--text-lg` (18px); weights normal 400 / semibold 600.
- Spacing: the 8-px grid (`--space-1`…`--space-16`).
- Layout: `--max-narrow` (720px), `--header-h` (60px); `--radius` (10px).

**Reused as-is** (`components/ui/`): `Button` (variants `default` / `destructive` / `outline` / `ghost`; sizes `sm` / `default` / `icon-sm`), `Card` family (`Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter`), `Input` (supports `aria-invalid`), `Badge`, `Select`, `Popover`, `Separator`, `ScrollArea`, `Skeleton`, `Avatar`. Site `header.tsx` / `footer.tsx`.

**Net-new — this SPEC adds them** (Radix-wrapped, into `components/ui/`, matching the existing `Select` / `Popover` pattern):

| Primitive | Base | Used for |
|---|---|---|
| `dialog.tsx` | Radix Dialog | The destructive-action confirmation dialogs (hide profile, hide a sole-author publication, publication takedown). |
| `textarea.tsx` | native `<textarea>` + the `Input` styling | The suppression `reason` field. |
| `alert.tsx` | — | Inline feedback: `info` (the superuser banner, the "hidden" notice) and `destructive` (save failures, validation errors) variants. |

The closest existing interaction precedent for state-managed client UI is `components/publication/publication-modal.tsx` (focus trap, Esc, scroll lock, loading/error/data states, `AbortController`); the new `dialog.tsx` supersedes its hand-rolled approach for `/edit/*`.

No `Checkbox`, `Switch`, `Radio`, or menu primitive is added — every control in this SPEC is a button, an input, the editor, a dialog, or a `Popover` (the account menu and the link-URL editor reuse the existing `Popover`).

---

## Global layout — the `/edit/*` shell

Every `/edit/*` page shares one shell:

```
┌──────────────────────────────────────────────┐
│  ▓▓ site header (Cornell red, sticky, 60px) ▓▓│
├──────────────────────────────────────────────┤
│                                                │
│        ┌──────────────────────────────┐        │
│        │  Edit my profile             │ ←page- │
│        │  Short intro line.           │  title │
│        │                              │        │
│        │  ┌────────── Card ─────────┐ │        │
│        │  └─────────────────────────┘ │        │
│        │  ┌────────── Card ─────────┐ │        │
│        │  └─────────────────────────┘ │        │
│        │  ┌────────── Card ─────────┐ │        │
│        │  └─────────────────────────┘ │        │
│        └──────────────────────────────┘        │
│            720px · centered · gap-6            │
├──────────────────────────────────────────────┤
│                 site footer                    │
└──────────────────────────────────────────────┘
```

- **Header / footer:** the site `header.tsx` and `footer.tsx`. The header gains a sign-in affordance and account menu — see [§ Signing in](#signing-in-and-reaching-edit).
- **Container:** `<main>` centered, `max-width: --max-narrow` (720px), `mx-auto`, `px-6`, `py-10` (mobile) / `py-12` (≥ md) — matching the public profile's outer padding.
- **Page title:** one `.page-title` (serif) per page; an optional muted intro line (`--text-sm`, `--muted-foreground`) beneath it.
- **Sections:** stacked `Card`s, `gap-6` (24px) between them. Each card = `CardHeader` (`CardTitle` is an `<h2>`, `--text-lg`, semibold; optional `CardDescription` in `--muted-foreground`) + `CardContent`.
- **No global "Save".** Each card owns its own write — the overview editor and the slug card each have their own Save; suppression actions commit immediately through a confirm dialog. This matches the three independent `/api/edit/*` endpoints.
- **No page-level loading state.** The pages are server-rendered with their data already resolved (`self-edit-spec.md` § Surfaces); loading is per-action only (saving, hiding). An unauthenticated request never renders this shell — it server-redirects to SSO (B01).

---

## Signing in and reaching `/edit`

The `/edit/*` pages are SSO-gated; B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) implements the SSO flow, the session cookie, and the sign-in / sign-out endpoints. This SPEC owns the **affordances** that let a scholar sign in and find their edit surface — the site has none today.

- **Header — signed out.** The site header (`components/site/header.tsx`) carries a modest **"Sign in"** control, right-aligned — a `Button variant="ghost"`, present but not loud, since most visitors are the browsing public, not editors. Activating it begins the SSO flow; on success the scholar returns to the page they were on, now signed in.
- **Header — signed in.** "Sign in" is replaced by the scholar's name as the trigger for an **account menu** — a `Popover` holding a short vertical list: **Edit my profile** (→ `/edit`), **View my profile** (→ their public `/scholars/{slug}`), a `Separator`, and **Sign out**. A `Popover`, not a new menu primitive — the list is three items.
- **Direct access.** An unauthenticated request to any `/edit/*` URL redirects to SSO and, after sign-in, lands on the originally requested page ([States](#states-and-edge-cases) row 1).
- **From the public profile.** When a signed-in scholar views *their own* public profile (`session.cwid == profile.cwid`), the profile shows an **"Edit my profile"** button near the name in the sidebar. This is a small, contained addition to `app/(public)/scholars/[slug]/page.tsx` — the only change this SPEC makes outside the `/edit/*` tree.
- **Signed-out on one's own profile.** If a scholar visits their own profile while signed out, the page cannot yet identify them, so the "Edit my profile" button is **absent** — the header's **"Sign in"** is the entry point. The button appears once the profile re-renders for the now-signed-in scholar (the server check is `session.cwid == profile.cwid`, so it resolves on the post-sign-in navigation, not via client hydration of an already-rendered page).

B01 owns the SSO mechanism and drives the header's signed-in / signed-out state; this SPEC owns only the affordances above and where they lead.

---

## `/edit` — the self-edit surface

Bound to `session.cwid`; no CWID in the URL. Page title **"Edit my profile"**, intro line *"Changes appear on your public profile."* Three cards, in order.

### Card 1 — Overview

`CardTitle` "Overview". `CardDescription` *"A short bio shown at the top of your public profile."*

`CardContent` is the [overview editor](#the-overview-editor) — a bordered region (`--border`, `--radius`) holding a formatting toolbar, the editable content area, and below it a character counter (left-aligned `--muted-foreground`) and a **"Save bio"** `Button variant="default"` (right-aligned).

- **Save** is disabled while the editor is pristine (no unsaved change) and while the content exceeds the 20,000-character limit; it shows "Saving…" + disabled during the write.
- **Success:** an inline "Saved" with a Lucide `Check`, in `--primary`, beside the button; it clears on the next edit. (The app has no success/green token — [Open questions](#open-questions) #3.)
- **Failure:** an `Alert variant="destructive"` below the editor; the editor keeps the unsaved content; Save re-enables.

### Card 2 — Profile visibility

`CardTitle` "Profile visibility". The card is a small state machine over the scholar's own `suppression` rows (read suppression-OFF — `self-edit-spec.md` § Surfaces, edge case 1):

| State | `CardContent` shows | Control |
|---|---|---|
| **Visible** | *"Your profile is visible to the public."* | `Button variant="outline"` **"Hide my profile"** → [confirm dialog](#suppression-and-confirmation-dialogs). |
| **Hidden — self-applied** | `Alert variant="info"` *"Your profile is hidden. It is not visible to the public or in search."* | `Button variant="default"` **"Make my profile visible"** (revoke). |
| **Hidden — by an administrator** | `Alert variant="info"` *"Your profile has been hidden by a site administrator."* + a contact line. | No restore control — a scholar may revoke only suppressions they applied (`self-edit-spec.md` Authorization). |
| **Hidden — self + admin both** | The admin notice above; *plus* a line *"You have also hidden it yourself."* and a **"Remove my hold"** button. | "Remove my hold" revokes the scholar's own row; the card warns the profile stays hidden while the administrator hold remains (`self-edit-spec.md` edge case 4). |

### Card 3 — My publications

`CardTitle` "My publications". `CardDescription` *"Hide a publication to remove yourself as an author from it across the site. Use this for a paper that isn't yours, too."*

`CardContent`:

- A header row: a count — *"128 publications · 3 hidden"* — and a **filter `Input`** (*"Filter by title…"*).
- The list of the scholar's confirmed authorships (from `lib/api/edit-context.ts` — including already-hidden ones, each annotated with its suppression state), **grouped by year descending**, inside a `ScrollArea` with a bounded max-height.
- Each row: the publication title, then journal · year in `--muted-foreground` `--text-sm`; trailing, a visibility control.

| Row state | Trailing control |
|---|---|
| **Shown** | `Button variant="ghost" size="sm"` **"Hide"** (Lucide `EyeOff`). |
| **Hidden — by this scholar** | Row text muted; a `Badge` **"Hidden"**; `Button variant="ghost" size="sm"` **"Show"** (Lucide `Eye`). |
| **Removed by an administrator** (whole-publication takedown) | A `Badge variant="destructive"` **"Removed by an administrator"** and, beside it, an inline line of `--muted-foreground` `--text-sm` text: *"An administrator removed this publication site-wide; hiding or showing it here has no effect."* **No Hide/Show button is rendered** — a disabled `<button>` is not focusable, so a keyboard or screen-reader user could not reach a tooltip on it; the inline text carries the explanation instead (see [Accessibility](#accessibility)). |

- **Hide / Show is optimistic:** the row flips state immediately; the "Show" / "Hide" button beside it *is* the undo. On a write error the row reverts and an inline message appears.
- **Sole-displayed-author guard:** if `edit-context` reports the scholar is the only displayed WCM author, **Hide** opens a [confirm dialog](#suppression-and-confirmation-dialogs) first — hiding will take the whole publication dark site-wide (`self-edit-spec.md` edge case 7).
- **Empty:** *"No publications are currently associated with your profile."*

---

## `/edit/scholar/[cwid]` — the superuser surface

The same page component, bound to an arbitrary `cwid`. A non-superuser requesting a `cwid` other than their own gets a **403** ([States](#states-and-edge-cases) row 2). When `cwid == session.cwid` it renders exactly `/edit` (above). When `cwid ≠ session.cwid`:

- **Superuser banner.** Above the cards, an `Alert variant="info"` with a Lucide `ShieldAlert`: *"You are editing **{Scholar Name}**'s profile as an administrator."* Page title becomes **"Edit profile — {Scholar Name}"**.
- **Card 1 — Overview, read-only.** `overview` editing is self-only (`self-edit-spec.md` Authorization — a superuser does not inherit it; broad admin field-editing is deferred). The card renders the current bio read-only with a note: *"Only the profile owner can edit the bio."* The editor's toolbar and Save are absent.
- **Card 2 — Profile visibility.** As `/edit` Card 2, acting on the target scholar — but the confirm dialog's `reason` is **required** (`self-edit-spec.md` § Suppression UX — a superuser suppression's reason is mandatory). Copy: "Hide **{Name}**'s profile?".
- **Card 3 — Slug override** (replaces "My publications"; superuser-only, #29). `CardTitle` "Profile URL". `CardContent`:
  - Current state: *"Current URL: `/scholars/{live-slug}`"*.
  - An `Input` prefixed with a static, non-editable `/scholars/` segment; the editable part is the slug.
  - **Live format validation** as the superuser types — lowercase `a–z 0–9 -`, no leading/trailing `-`, no `--`, ≤ 64 chars (`self-edit-spec.md` editable-field set). A malformed value shows an inline error and disables Save. A **collision** is *not* checked live — it surfaces on Save (below); [Open questions](#open-questions) #4.
  - **"Save URL"** `Button`. On success the card shows: *"Override saved: `/scholars/{override}` — the new URL takes effect after the next directory sync."* The live URL is unchanged until `etl/ed` runs (`self-edit-spec.md` edge case 12) — the copy must say so.
  - A collision (server `400`) shows an inline error: *"That URL is already in use."* (`self-edit-spec.md` edge cases 10, 11).
  - When an override exists: a **"Clear override"** `Button variant="ghost"` (deletes the `field_override(slug)` row).

The superuser's "My publications" management is not a v1 surface — per-author management for others happens implicitly through the takedown page and the authorization predicate, not a list here (`self-edit-spec.md` § Surfaces lists only suppress + slug for this route).

---

## `/edit/publication/[pmid]` — the takedown surface

Superuser-only; whole-publication suppression for retraction or compliance (`contributorCwid = NULL`). Page title **"Manage publication"**.

- **Card 1 — Publication.** A read-only summary: title, the author list (WCM authors marked), journal, year, PMID / DOI.
- **Card 2 — Visibility.** State-driven:

| State | Shows | Control |
|---|---|---|
| **On the site** | *"This publication is visible on the site."* | `Button variant="destructive"` **"Remove from site"** → [confirm dialog](#suppression-and-confirmation-dialogs), `reason` **required**. |
| **Removed — explicit takedown** | `Alert variant="destructive"` with the reason, actor, and date. | `Button variant="default"` **"Restore to site"** (revoke). |
| **Dark — zero displayed authors** | `Alert variant="info"` *"This publication is currently hidden because every Weill Cornell author has hidden it."* (no explicit takedown) | None — informational; restoring requires an author to un-hide, or a new co-author (ADR-005 derived visibility). A takedown may still be added on top. |

---

## The overview editor

A `'use client'` island, `components/edit/overview-editor.tsx`, built on **Tiptap** (React 19 / Next 15 compatible).

**Schema — exactly the eight allowed tags.** Compose the explicit extension set (not the full `StarterKit`) so the document schema admits only the allowlist — `self-edit-spec.md`'s seven structural tags **plus `<a>`**:

- Structural: `Document`, `Paragraph` (`<p>`), `Text`, `HardBreak` (`<br>`).
- Marks: `Bold` → `<strong>`, `Italic` → `<em>`. (Tiptap renders `strong`/`em` by default — confirm, do not use `b`/`i`.)
- Lists: `BulletList` (`<ul>`), `OrderedList` (`<ol>`), `ListItem` (`<li>`).
- Links: `Link` (`<a>`) — `@tiptap/extension-link`, configured `openOnClick: false` (clicking a link in the editor edits it, never navigates), `protocols: ['https', 'http', 'mailto']`, a `validate` that rejects any other scheme, and `HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }`.
- UX-only, no tag: `History` (undo/redo), `Placeholder`.
- **Excluded:** images, headings, blockquote, code, strikethrough, horizontal rule, underline, and every other node/mark. A paste of disallowed content (images, headings) is **stripped to the schema**; a pasted hyperlink is **kept** when its scheme is allowed. A helper line under the editor sets the expectation: *"Formatting is limited to bold, italics, lists, and links."*

**`<a>` co-revises `self-edit-spec.md`.** That SPEC originally locked `overview` to seven tags with *zero attributes* and stripped `<a>`. Supporting links changes its `overview` sanitize rule (§ The v1 editable-field set, edge case 8): the tag allowlist gains `a`; `href` is permitted on `<a>` with its scheme constrained to `https` / `http` / `mailto`; a disallowed scheme has the `href` dropped, leaving the text; every surviving `<a>` is rewritten with `rel="noopener noreferrer nofollow"` and, for web links, `target="_blank"`. This UI-SPEC and that SPEC change together. The security trade-offs this opens — institutional-authority transfer, the deferred destination-domain policy, and one-shot sanitization — are named and accepted in `self-edit-spec.md` § Hyperlinks in `overview`.

**The client schema is not a security boundary.** `self-edit-spec.md` mandates a server-side sanitize on write — including the `href`-scheme validation above. The editor's locked schema and the `Link` extension's `validate` are UX conveniences; the server remains authoritative.

**Toolbar.** A single row of `Button variant="ghost" size="icon-sm"` controls: **Bold** (`Bold`), **Italic** (`Italic`), a `Separator`, **Bullet list** (`List`), **Numbered list** (`ListOrdered`), a `Separator`, **Link** (`Link`). Each carries an `aria-label` and an `aria-pressed` reflecting whether the mark/node is active at the cursor; the active state uses an `--accent` background. The **Link** control opens a small `Popover` with a URL `Input` and Apply / Remove buttons — selecting text and clicking Link adds a link; clicking it with the cursor inside an existing link pre-fills the popover for editing or removal.

**Content area.** Min-height ≈ 12rem, padding `--space-4`, `--text-base`, relaxed line-height. It renders formatted content live — it **is** the preview. It uses the same prose styles the public profile applies to `overview`. `Placeholder`: *"Write a short bio — your background, research focus, and clinical interests."*

**Public render — the bio is shown in full.** The public profile renders the stored, sanitized `overview` HTML **in full** — paragraphs, lists, emphasis, and links — with the site's prose and link styling (links in the site's accent-slate). The bio is sanitized once, on write (the security boundary — `self-edit-spec.md`); **nothing is stripped at render time**. If the public `overview` render currently flattens to a plain paragraph, the build adds the prose / list / link styling so the published bio matches what the editor shows.

**Character counter.** The counter measures **`editor.getHTML().length`** — the length of the serialized HTML — against **20,000**, the limit `self-edit-spec.md` places on the sanitized HTML (what is stored in the `field_override.value` `Text` column). It is computed directly from `getHTML()` on each change, **not** via `@tiptap/extension-character-count` — that extension counts *visible* characters, a different measure, so it is deliberately omitted from the schema above. Because the `Link` extension emits `rel`/`target` in its serialized output, the client's `getHTML()` already carries the same attribute bytes the server's sanitizer enforces, so the client and server lengths agree within trivial normalization noise; 20,000 is a generous rail with ample headroom for any real bio, not a tight budget. The counter is **advisory** — the server check is authoritative. Within limit: `--muted-foreground`; over limit: `--destructive`, and Save is disabled. The counter is `aria-live="polite"`.

**Empty.** Tiptap serializes an empty document as `<p></p>` (7 characters), not `""`. The editor detects the structurally-empty state via `editor.isEmpty` — when empty, the counter reads **0**, Save stays disabled, and a Save sends `value: ""`. `self-edit-spec.md`'s sanitize rule independently normalizes a structurally-empty sanitized result (`<p></p>`, whitespace only) to `""`, so the stored "no overview" value is consistent whichever side normalizes first.

**Dependency footprint.** Tiptap is a deliberate dependency commitment — roughly 14 small extension packages, ≈ 80–120 KB minified + gzipped. It is scoped to keep that cost off the public site: the editor is a `'use client'` island loaded only on `/edit/*`, never in the public bundle, and the explicit-extension approach (over `StarterKit`) keeps both the schema and the footprint to exactly what the eight-tag allowlist needs.

---

## Suppression and confirmation dialogs

Every destructive or hard-to-notice action confirms through one `dialog.tsx` pattern (Radix Dialog — focus trap, Esc, scroll lock). The dialog has a title, an explanatory body, an optional/required `reason` field, and a two-button footer; **focus defaults to Cancel**, never the destructive button.

| Trigger | Title | Body | `reason` | Confirm button |
|---|---|---|---|---|
| Scholar — hide own profile | "Hide your profile?" | "Your profile will be removed from public view and search immediately. You can make it visible again at any time." | **Optional.** A `Select` of presets — *"Information is out of date"*, *"Personal or privacy reasons"*, *"Other"* — with a free-text `Textarea` when "Other". Blank stores the SPEC default. | `variant="destructive"` "Hide my profile" |
| Superuser — hide a profile | "Hide {Name}'s profile?" | As above, for the named scholar. | **Required.** Free-text `Textarea` — retraction notice, compliance reference, or ticket link. Confirm disabled until non-empty. | `variant="destructive"` "Hide profile" |
| Scholar — hide a sole-author publication | "Hide this publication?" | "You are the only Weill Cornell author shown on this publication. Hiding it removes the publication from the site entirely until you restore it, or another WCM author is added." | None. | `variant="destructive"` "Hide it anyway" |
| Superuser — publication takedown | "Remove this publication from the site?" | "This removes the publication site-wide immediately, independent of its authors." | **Required.** Free-text `Textarea`. | `variant="destructive"` "Remove publication" |

**The rule:** an action confirms **iff it removes something from public view by default** — hide a profile, hide a sole-author publication, take a publication down. Its inverse — every **revoke / restore / un-hide**, and a non-sole-author publication hide (freely reversible from the same control) — does **not** confirm; a dialog there would only add friction. Confirmation gates the *loss* of visibility, never its restoration.

---

## Feedback, dirty state, and interaction

- **Write feedback is inline, not a toast** — the app has no toast primitive, and a settings page with discrete sections reads more clearly with feedback anchored to the section that changed. Overview save → the inline "Saved" / `Alert`. Suppression/slug → the card re-renders into its new state. Per-publication hide/show → the row itself.
- **Success responses carry the post-merge value** (`self-edit-spec.md` § `/api/edit/*`) — the client updates from the response; no refetch.
- **Optimistic** only for the per-publication row (cheap, instantly reversible). The overview Save and the slug Save are confirmed (button → "Saving…" → result). Dialog-gated suppressions re-render on the committed response.
- **Dirty-state scope.** Only the two cards with a Save button — Overview and Slug — carry a "dirty" (unsaved-changes) notion; the per-publication hide/show and the suppression actions commit immediately and have no dirty state. The unsaved-changes prompt fires **only on navigation away from the page** — cross-page navigation, a full reload, or a tab close (`beforeunload` + an App-Router navigation guard) — and **never on an intra-page action**. So editing the bio and then, in the same session, hiding the profile or hiding a publication proceeds with no prompt: those writes are independent of the bio draft and do not discard it (the draft survives the suppression write). Leaving the page with the draft unsaved is the one thing that prompts. *(A within-page action — e.g. the hide-profile dialog — deliberately does not surface an unsaved-bio warning; the two writes are independent and nothing is lost. If a coupled warning is wanted, that is a scoped change to the dialog, flagged here as a considered omission.)*
- **Keyboard:** every control is reachable and operable; the editor toolbar is standard rich-text keyboarding (⌘/Ctrl-B, -I); dialogs and popovers trap focus and close on Esc.

---

## States and edge cases

Covers what the **user sees**; `self-edit-spec.md`'s edge-case table covers the write-path behavior and is not duplicated.

| # | Scenario | What the user sees |
|---|---|---|
| 1 | Unauthenticated request to any `/edit/*` | Server-side redirect to WCM SSO (B01); the `/edit/*` shell never renders — no flash. |
| 2 | Authenticated non-superuser opens `/edit/scholar/[other-cwid]` | A 403 page: *"You don't have permission to edit this profile."* + a link to their own `/edit`. (Authenticated — so a 403 page, not the SSO redirect.) |
| 3 | Self-suppressed scholar opens own `/edit` | Page loads (suppression-OFF read); Profile-visibility card in the **Hidden — self-applied** state with "Make my profile visible". |
| 4 | Superuser-suppressed scholar opens own `/edit` | Loads; Profile-visibility card **Hidden — by an administrator**, no restore control; the Overview editor still works. |
| 5 | `overview` exceeds 20,000 characters | Counter turns `--destructive`; "Save bio" disabled; on a forced save attempt, an inline `destructive` Alert. |
| 6 | `overview` save fails (5xx / network) | Inline `destructive` Alert; the editor keeps the unsaved content; Save re-enabled. |
| 7 | `overview` saves successfully | Inline "Saved" + `Check`; counter and Save return to pristine. |
| 8 | Scholar pastes an image, a heading, or a `javascript:` link into the editor | Images and headings are stripped to the schema; a link with a disallowed scheme keeps its text but loses the link; an `https` / `http` / `mailto` link is kept. |
| 9 | Empty `overview` | Editor shows the placeholder; counter reads 0 (the `<p></p>` empty document is detected via `editor.isEmpty`); Save disabled until edited; saving an emptied editor sends `""` — a valid "no overview". |
| 10 | Scholar hides a publication (not sole author) | Row flips to **Hidden** optimistically; "Show" appears; on error the row reverts with an inline message. |
| 11 | Scholar hides a publication where they are the sole displayed WCM author | The sole-author confirm dialog appears before the write, warning of site-wide removal. |
| 12 | A publication removed by a superuser appears in "My publications" | Row shows a `destructive` "Removed by an administrator" badge with inline explanatory text; no Hide/Show control is rendered. |
| 13 | Scholar opens "Hide my profile" | Confirm dialog: immediate-effect copy + optional preset/free-text reason; Cancel focused. |
| 14 | Superuser opens "Hide this profile" | Same dialog; reason **required**; the confirm button is disabled until a reason is entered. |
| 15 | Superuser types a malformed slug | Inline error under the input, live; "Save URL" disabled. |
| 16 | Superuser saves a colliding slug | Server `400` → inline error *"That URL is already in use."*; nothing saved. (Collision is not checked live — only on Save.) |
| 17 | Superuser saves a valid slug override | Success; card shows *"…takes effect after the next directory sync"*; the live URL is unchanged; a "Clear override" control appears. |
| 18 | Scholar with unsaved editor (or slug) changes navigates away | An unsaved-changes prompt. |
| 19 | "My publications" is empty | *"No publications are currently associated with your profile."* |
| 20 | Superuser views the Overview card on `/edit/scholar/[other-cwid]` | Bio shown read-only; note *"Only the profile owner can edit the bio."*; no toolbar, no Save. |
| 21 | Scholar opens the sole-author hide dialog; a co-author is attributed (by ReCiter) before they confirm | The per-author hide still writes correctly; the publication does **not** go dark, because a displayed author now remains. The dialog's warning was conservative but harmless. v1 does not re-validate an open dialog against mid-interaction data changes — the window (a dialog open across a nightly ETL run) is vanishingly small. |

---

## Accessibility

- Every control is keyboard-operable with a visible focus ring (the `Button` `focus-visible:ring-[3px]` pattern, applied site-wide).
- The editor: an `aria-label` ("Profile overview"), `role="textbox"`, `aria-multiline="true"`; toolbar buttons carry `aria-label` and `aria-pressed`; the counter is `aria-live="polite"`. The link-URL `Popover` traps focus, closes on Esc, and returns focus to the toolbar's Link button.
- Dialogs (Radix): focus trap, Esc-close, `aria-labelledby` / `aria-describedby`; the destructive confirm is **not** the default-focused element. The header account menu (`Popover`) is arrow-key / Esc operable and returns focus to its trigger.
- **No disabled control carries its only explanation.** Where an action is unavailable — e.g. a publication removed by an administrator — the reason is conveyed by adjacent **visible text**, never by a disabled `<button>` with a tooltip: a disabled button is not focusable, so a keyboard or screen-reader user could never reach the tooltip. The "Removed by an administrator" row renders inline text, not a disabled control.
- **No color-only signalling.** A hidden publication carries the "Hidden" text `Badge`, not just dimming; validation errors are text plus `aria-invalid` on the input, not just a red border; the destructive intent of an action is in its label, not only its color.
- **Non-Latin scripts.** Faculty bios may include names or terms in non-Latin or right-to-left scripts. The editor (Tiptap) accepts them; the public `overview` prose styling must use script-neutral CSS — no hard-coded `direction` or text-alignment that would misrender non-Latin content — so the published bio renders as authored.
- All inputs have associated `<label>`s; errors are wired via `aria-describedby`.
- Contrast meets WCAG AA against the existing token palette (`--destructive`, `--muted-foreground`, `--primary` on their backgrounds).

---

## Responsive behavior

The `/edit/*` pages are single-column at every width — none use the profile's sidebar layout, so responsive behavior is simple.

- Below 720px + padding, the container is full-width with `px-6`; `py-10` (mobile) / `py-12` (≥ `md`).
- The editor toolbar (five icon buttons + two separators) fits the narrowest supported width without wrapping.
- "My publications" rows place the title/metadata and the trailing control on one line on `≥ sm`; on the narrowest widths the control wraps below the title.
- The header's "Sign in" control and account menu collapse with the existing header's responsive behavior; the account-menu `Popover` is full-width-aware on small screens.
- Dialogs and popovers are near-full-width with margin on small screens (Radix default), centered on larger.
- Breakpoints: Tailwind defaults (`sm` 640, `md` 768); no custom breakpoints.

---

## Copy

The user-facing strings, collected for the build. Tone: plain, second-person, non-alarming.

| Where | String |
|---|---|
| Header — signed out | "Sign in" |
| Account menu | "Edit my profile" / "View my profile" / "Sign out" |
| Public profile (own, signed in) | "Edit my profile" |
| `/edit` title / intro | "Edit my profile" / "Changes appear on your public profile." |
| Overview card | "Overview" / "A short bio shown at the top of your public profile." |
| Editor helper | "Formatting is limited to bold, italics, lists, and links." |
| Editor placeholder | "Write a short bio — your background, research focus, and clinical interests." |
| Save states | "Save bio" / "Saving…" / "Saved" |
| Visibility — visible | "Your profile is visible to the public." / "Hide my profile" |
| Visibility — hidden (self) | "Your profile is hidden. It is not visible to the public or in search." / "Make my profile visible" |
| Visibility — hidden (admin) | "Your profile has been hidden by a site administrator." |
| Publications card | "My publications" / "Hide a publication to remove yourself as an author from it across the site. Use this for a paper that isn't yours, too." |
| Publication removed (admin) | "An administrator removed this publication site-wide; hiding or showing it here has no effect." |
| Publications empty | "No publications are currently associated with your profile." |
| Superuser banner | "You are editing **{Name}**'s profile as an administrator." |
| Slug card | "Profile URL" / "Current URL: `/scholars/{slug}`" / "Save URL" / "Clear override" |
| Slug applied | "Override saved: `/scholars/{slug}` — the new URL takes effect after the next directory sync." |
| Slug errors | "Use lowercase letters, numbers, and hyphens only." / "That URL is already in use." |
| 403 page | "You don't have permission to edit this profile." |
| Save failure | "Something went wrong — your changes weren't saved. Please try again." |

Dialog copy is in [§ Suppression and confirmation dialogs](#suppression-and-confirmation-dialogs).

---

## Open questions

1. **Self-suppression reason input.** `self-edit-spec.md` allows "free text, or a preset". **Recommendation:** the preset `Select` + "Other" free-text described in § Dialogs; blank stores the SPEC's default string.
2. **"My publications" at scale.** A scholar with several hundred authorships. **Recommendation:** the filter + year-grouping + bounded `ScrollArea` for v1; virtualize or paginate only if profiles routinely exceed ~300 publications.
3. **Success-feedback styling.** The token set has `--destructive` but no success/green token. **Recommendation:** a neutral "Saved" + `Check` in `--primary`; do not add a token in v1.
4. **Live slug collision check.** The slug card validates *format* live as the superuser types, but a *collision* surfaces only on Save (server `400`). **Recommendation:** acceptable for v1; a debounced server-side availability check as the superuser types is a clean fast-follow.

*Resolved in this revision:* discoverability and the header sign-in affordance are now specified ([§ Signing in](#signing-in-and-reaching-edit)); the public profile renders the full sanitized HTML, with nothing stripped at render ([§ The overview editor](#the-overview-editor)).

---

## Implementation

The component file map. `self-edit-spec.md` § Implementation lists the `app/edit/*` pages, the `app/api/edit/*` routes, and `lib/edit/*`; this table is the components those pages render.

| Path | Role |
|---|---|
| `components/ui/dialog.tsx` *(new)* | Radix Dialog primitive — the confirmation-dialog base. |
| `components/ui/textarea.tsx` *(new)* | The suppression-`reason` field. |
| `components/ui/alert.tsx` *(new)* | Inline `info` / `destructive` feedback and validation messages. |
| `components/edit/edit-page.tsx` *(new)* | The shared `/edit/*` shell — container, page title, card stack; branches on self vs. superuser. |
| `components/edit/overview-editor.tsx` *(new)* | The Tiptap WYSIWYG editor — eight-tag schema (incl. `Link`), toolbar, link popover, counter. `'use client'`. |
| `components/edit/overview-card.tsx` *(new)* | Card 1 — wraps the editor, owns Save and its feedback. |
| `components/edit/visibility-card.tsx` *(new)* | Card 2 — the profile-visibility state machine. |
| `components/edit/publications-card.tsx` *(new)* | Card 3 — the filterable, year-grouped hide/show list. |
| `components/edit/slug-card.tsx` *(new)* | The superuser slug-override card. |
| `components/edit/publication-takedown.tsx` *(new)* | The `/edit/publication/[pmid]` visibility card. |
| `components/edit/confirm-dialog.tsx` *(new)* | The destructive-action confirm — title, body, optional/required reason, Cancel-focused footer. |
| `components/edit/superuser-banner.tsx` *(new)* | The "editing as an administrator" `Alert`. |
| `components/site/header.tsx` *(modified)* | Gains the "Sign in" control / account menu (§ Signing in). |
| `components/site/account-menu.tsx` *(new)* | The signed-in account menu — a `Popover` (Edit / View / Sign out). |
| `app/(public)/scholars/[slug]/page.tsx` *(modified)* | Gains the "Edit my profile" button for the signed-in profile owner; renders the full sanitized `overview` HTML with prose / list / link styling. |
| `app/edit/*`, `app/api/edit/*`, `lib/edit/*`, `lib/api/edit-context.ts` | `self-edit-spec.md` § Implementation — the routes and write-path these components render and call. |

**New dependencies:** `@tiptap/react` and the explicit Tiptap extension packages (`@tiptap/extension-document`, `-paragraph`, `-text`, `-bold`, `-italic`, `-bullet-list`, `-ordered-list`, `-list-item`, `-hard-break`, `-link`, `-history`, `-placeholder`) — ≈ 80–120 KB minified+gzipped, loaded only on `/edit/*` (see § The overview editor → Dependency footprint). `@tiptap/extension-character-count` is **not** used — the counter measures `getHTML().length` directly. No toast, modal, or form library is added.

---

## References

- [self-edit-spec.md](./self-edit-spec.md) — the feature SPEC: routes, authorization, write-path, the editable-field set, § Hyperlinks in `overview` (the named `<a>` trade-off), the behavioral edge-case table. This UI-SPEC designs its § Surfaces and co-revises its `overview` sanitize rule to allow `<a>`.
- [ADR-005](./ADR-005-manual-override-layer.md) — the `field_override` / `suppression` mechanism and derived publication visibility.
- `app/globals.css` — the Tailwind v4 `@theme` tokens this SPEC names.
- `components/ui/` — the reused primitives; `components/publication/publication-modal.tsx` — the existing state-managed-client-UI precedent.
- [#355](https://github.com/wcmc-its/Scholars-Profile-System/issues/355) — this UI-SPEC; [#356](https://github.com/wcmc-its/Scholars-Profile-System/issues/356) — the build umbrella; B01 [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) — SSO.
- [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) — `/edit/*` and `/api/edit/*` are `CachingDisabled` (rows 1–2).
