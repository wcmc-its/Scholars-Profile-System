# design-sync notes — Scholars Profile System

## Scope decision
This repo is the whole Next.js app (routes, ETL, API, DB), not a standalone
component package. Synced scope is deliberately narrow: `components/ui/**`
+ `app/globals.css` only (`cfg.srcDir` / `cfg.cssEntry`). A separate,
unbuildable snapshot of the same files also lives at
`~/Dropbox/Projects/Scholars-Profile-System/design-system` (no package.json,
not git-tracked) — that copy was NOT the sync source. Not reconciled here.

## Source: a dedicated worktree off origin/master, not the primary checkout
The primary checkout (`~/Dropbox/GitHub/Scholars-Profile-System`) was 20+
commits behind `origin/master` with local uncommitted WIP on top when this
sync started — including exactly the Apollo v2 audit-fix commits (new
`components/ui/progress.tsx` + `switch.tsx`, `tabs.tsx` removed, ~130-line
`app/globals.css` rewrite) that had since landed on master in another
session. Building from that stale/dirty tree would have shipped wrong
components and a wrong stylesheet. This sync instead uses a fresh worktree:
`~/worktrees/scholars-profile-system-design-sync`, branch
`design-sync/claude-design-import` tracking `origin/master`, `npm ci`
(not an APFS clone of the primary checkout's node_modules — package.json/
package-lock.json had also drifted). **Re-sync: re-fetch and either fast-
forward that worktree or re-add a fresh one — never build from the primary
checkout without first checking `git log --oneline HEAD..origin/master`.**

## No library build — synth-entry mode
No script in `package.json` produces a component-library `dist/` (the
`build` script is `next build`, the whole app). The converter is run with
`--entry ./dist/index.js` (a path that does NOT exist) purely so it walks
up from that path to find the repo root's `package.json` (name
`scholars-profile-system`) — then `cfg.srcDir: "components/ui"` makes it
synthesize the entry from source directly (`[NO_DIST]` lines in the build
log for this are expected, not an error). `.d.ts` prop extraction is
therefore structural inference, not a checked `.d.ts` — weaker than a real
build.

## buildCmd: CSS must be compiled before every build
`app/globals.css` is Tailwind v4 source (`@import "tailwindcss"` — a bare
npm-package specifier, not a file path), which the converter can't @import
literally. `cfg.buildCmd` runs `.ds-sync/compile-css.mjs` (postcss +
`@tailwindcss/postcss`, scanning the whole repo for utility classes — that's
why some out-of-scope tokens show up in TOKENS_MISSING, see below) to
`.ds-sync/compiled-globals.css`, which `cfg.cssEntry` points at. That script
also defines `--font-inter` (see next section) — always re-run it before
`package-build.mjs`, not just once.

## Fixed: `--font-inter` was undefined (real bug, not cosmetic)
`--font-sans: var(--font-inter), -apple-system, ...` — `--font-inter` is
never defined in source CSS; production sets it via a generated class
`next/font/google` adds to `<html>` at runtime, invisible to a static
scrape. Per the CSS spec, an undefined `var()` referenced inside a custom
property makes every property that consumes it invalid at computed-value
time — so without a fix, **every** component's `font-family` would have
silently fallen back to inherited/UA-default, not gracefully skipped to
`-apple-system`. Fixed in `compile-css.mjs`: appends
`:root, :host { --font-inter: 'Inter', sans-serif; }` after compilation,
matching the real self-hosted family shipped via `cfg.extraFonts`
(`@fontsource/inter` 400 + 600 weight, the two weights actually used —
installed as a `.ds-sync` dev dependency, OFL-licensed, safe to bundle).

## Charter/Tiempos: accepted the production substitute (user decision, 2026-08-15)
The serif stack `'Charter', 'Tiempos', 'Georgia', serif` has no self-hosted
files or font-service script anywhere in the repo — production already
just falls through to system Georgia for any visitor without those fonts
installed locally. Tiempos is a commercial Klim Type Foundry font that
can't be sourced/redistributed; Charter's status wasn't worth chasing given
production doesn't ship it either. User explicitly chose to accept the same
substitute for the DS bundle rather than source a free Charter-alike — do
not silently "fix" this on a future re-sync without asking again.

## TOKENS_MISSING: out-of-scope, not a sync bug
6 vars show up as referenced-but-undefined: `--color-border-info`,
`--color-background-info`, `--color-text-info`, `--color-text-primary`,
`--color-text-secondary`, `--color-text-tertiary`. Verified none of
`components/ui/**` or `lib/utils.ts` reference any of them — they're used
only by out-of-scope app components (`components/division`,
`components/center`, `components/department`, etc.) and surfaced here only
because `compile-css.mjs` scans the whole repo for Tailwind content
(needed so components/ui's own utility classes generate). Possibly a real
latent bug in those out-of-scope components (grepped and found NO
`:root` definition for `--color-text-primary` etc. anywhere in the app's
shipped CSS, only in a standalone mockup HTML file under `docs/mockups/`)
— worth flagging to the team separately, but not a design-sync fix.

## Known render warns (final state — all 30 scoped components authored + graded good)
- **11 `[RENDER_BLANK]`** on the final validate, all accepted floor cards for
  compound sub-parts that were deliberately left unauthored (user chose
  "core ~30 top-level components" preview scope, not all 92):
  `AlertTitle`, `AvatarGroupCount`, `BreadcrumbEllipsis`, `BreadcrumbItem`,
  `BreadcrumbSeparator`, `CardHeader`, `PaginationEllipsis`, `PaginationItem`,
  `PaginationLink`, `SheetFooter`, `SheetHeader`. Re-syncing with more of
  these authored is the standing incremental-improvement offer.
- **6 `[GRID_OVERFLOW]`** found and fixed via `cfg.overrides.<Name>:
  {"cardMode": "column"}`: `Alert`, `Card`, `Collapsible`, `Pagination`,
  `ScrollArea`, `Skeleton`. Grades carried forward (presentation-only fix,
  per the skill's own rule that column cards can't re-flag wide).
- **Two components can't show their "open" hover state statically**
  (internal React `useState`, no prop to force it): `AbbrTooltip` and
  `HoverTooltip`. Their preview cards show the resting/closed trigger only
  — graded good on that basis, not a bug to chase on re-sync.
- **`Badge`'s `ghost`/`link` variants render as bare text with no visible
  container** at rest — confirmed genuine component behavior (their classes
  are hover-only / near-black-on-white respectively), not a rendering bug.
- `[TOKENS_MISSING]` warns 6 vars (`--color-*-info`, `--color-text-*`) on
  every build — confirmed out-of-scope (see above), expected to persist.
- `[FONT_MISSING]` warns Charter/Tiempos on every build — expected, accepted
  substitute (see above), not a bug to fix.

## Re-sync risks
- Prop types are structurally inferred (no real `.d.ts` source) — a prop
  that changes shape (e.g. a union widened) may not be reflected precisely
  in the emitted `<Name>.d.ts`.
- 92 components discovered from 30 source files (shadcn-style compound
  exports — e.g. `Card` → `Card`, `CardHeader`, `CardContent`, ... each a
  separate synced component). If `components/ui` gains a file with new
  named exports, expect the count to jump accordingly, not 1:1 with files.
- `compile-css.mjs` scans the WHOLE repo for Tailwind utilities (Tailwind
  v4 auto content-detection), not just `components/ui` — a class used only
  in `components/ui` but nowhere else in the app would still generate
  correctly, but the reverse means TOKENS_MISSING can surface vars that
  are genuinely out-of-scope (see above) — don't assume every future
  TOKENS_MISSING hit is a synced-component problem without checking.
