# Apollo Surface Language v2 audit — `/edit` console

> **Snapshot as of 2026-08-14 — point-in-time; not maintained.** Kept for provenance under [Audits & snapshots](../DOCUMENTATION-REGISTRY.md). Re-verify file:line references before acting on any finding below if `origin/master` has moved since.

**Ruleset:** [`docs/mockups/apollo-surface-language.html`](../mockups/apollo-surface-language.html) — rules R1 through R14, the token/pattern language the `/edit` console is built against.
**Method:** a 13-agent `Workflow` run, one finder agent per surface family, each independently re-discovering findings against `origin/master` at `d763ff9e` (not trusting any prior summary), followed by an adversarial verify pass on every Tier A claim (a second agent re-reads the actual file:line and confirms or refutes before a finding is recorded as verified).
**Why this doc exists:** a prior (uncommitted-session) 12-agent audit produced ~23 findings that were never filed as a durable doc or issue set and were lost when that session ended, leaving only a lossy prose summary in a handoff. This re-run replaces that summary with verified, re-grounded findings and — per that handoff's own recommendation — is committed here so it can't be lost the same way twice.

---

## 1. Summary

| Tier | Count | What it means |
|---|---|---|
| **A** — isolated one-line token swap | 15 | Safe, mechanical, independently verified against the actual current line. Ready to fix without further review. |
| **B** — needs restructuring | 8 | Real, confirmed violations; the fix is more than a token swap (new wrapper markup, a shared-component migration, a table restructuring) but has no open design question. |
| **C** — judgment call | 11 | A design decision is needed before any fix — usually a genuine second meaning for maroon/amber competing with the ruleset's canon, or how much shell chrome a denied-access / pre-selection page should carry. |

15 Tier A findings all carry a `confirmed: true` adversarial-verify note citing the exact current line content — see §2. Tier B (§3) and Tier C (§4) were not re-verified line-by-line (their fixes/decisions aren't mechanical, so a second read doesn't reduce to a boolean); treat their file:line references as sweep-agent-reported, not adversarially confirmed.

---

## 2. Tier A — verified, ready to fix

| # | File:line | Rule | Finding | Fix |
|---|---|---|---|---|
| A1 | `components/edit/reports-index.tsx:128` | R4 | 2a filter sidebar uses `bg-apollo-surface-2`/`border-apollo-border` (the chip/thead/ghost-hover treatment) instead of the rail treatment every other filter sidebar uses. | Swap to `bg-apollo-rail border-apollo-rail-border`. |
| A2 | `components/edit/honors-queue.tsx:255` | Colour-language DANGER token | Error banner uses raw `border-red-300 bg-red-50 text-red-800` instead of the app's `--destructive` token; every sibling `/edit` error banner (8+ sites, including its own sibling `news-queue.tsx:149`) uses `text-destructive`. | Swap to `text-destructive` (optionally `border-destructive/40 bg-destructive/10`). |
| A3 | `components/edit/honors-queue.tsx:448` | R13 | Contested-group card wrapper uses raw `border-amber-400 bg-amber-50/40` instead of the established `border-apollo-amber-tint-border bg-apollo-amber-tint` pairing (used identically in `coi-card.tsx`, `reciter-pending-card.tsx`, `method-families-roster.tsx`). | Swap to the token pair. |
| A4 | `components/edit/honors-queue.tsx:499` | R13 | Year-plausibility warning uses raw `text-amber-800` instead of `text-apollo-amber`. | Swap token. |
| A5 | `components/edit/honors-queue.tsx:274` | R3 | "Group" `<select>` uses bare `border` (resolves to the cool-gray shadcn `--border`) instead of `border-apollo-border-strong`. | Add `-apollo-border-strong`. |
| A6 | `components/edit/honors-queue.tsx:287` | R3 | "Sort" `<select>` — identical miss to A5. | Same fix. |
| A7 | `components/edit/news-queue.tsx:45` | R9 | Candidate scholar-name link uses the legacy un-namespaced `text-[var(--color-accent-slate)]` instead of the migrated `--apollo-slate` token every other scholar-name link uses (`profiles-roster.tsx`, `administrators-roster.tsx`, `home-panel.tsx`). | Swap to `text-apollo-slate`. |
| A8 | `components/edit/administrators-roster.tsx:372` | R9 | Every person `<Card>` gets an unconditional `border-apollo-maroon/60` left-rule — maroon spent on static chrome, not the primary-link/selection jobs R9/R12 reserve it for. New finding, surfaced while confirming the R11 item below (§3). | Drop the maroon border (note: the R11 restructuring in §3 removes this `Card` entirely anyway). |
| A9 | `components/edit/admin-subnav.tsx:419` | R9/R12 | The pending-count pill fills solid `bg-apollo-maroon`/`text-white` — a third maroon job beyond the primary link and the active-tab underline (same function, line 429). | Swap to the neutral status-pill tokens (`--apollo-slate-tint`/`--apollo-slate-tint-border`, already used ~18 sites for status pills). |
| A10 | `components/edit/forbidden-edit-page.tsx:41,61` | R1 | Neither denial variant's `<main>` sets a background class, so it inherits the root layout's literal-white `--background` instead of `--apollo-page`. (The deeper R14 "no shell at all" version of this gap is Tier C — see C1.) | Add `bg-apollo-page` (+ `min-h-screen`) to both `<main>` roots. |
| A11 | `components/edit/unit-edit-page.tsx:342` | R2 | `RetiredNotice` pairs `bg-apollo-surface-2` with `border-apollo-border` — the hairline-on-fill mispairing `globals.css`'s own token comment warns about ("reads 1.035:1 on the rail (dead)"). Same mispairing recurs in `all-units-directory.tsx`, `edit-page.tsx`, `slug-card.tsx`, `slug-request-card.tsx`, `slug-request-row.tsx` (out of scope for this pass — not independently verified). | Swap to `border-apollo-border-strong`. |
| A12 | `app/edit/administrators/page.tsx:115` | R9 | "Web Directory" external link uses a static resting `underline` alongside `apollo-maroon`; every other maroon-link site uses `hover:underline` only. | Swap `underline` → `hover:underline`. |

*(12 rows shown; A2–A6 count as 5 distinct honors-queue.tsx misses, matching the "4 separate raw-Tailwind-vs-apollo-token misses" the original lost summary undercounted by one — the fresh sweep found a 5th at A6.)*

---

## 3. Tier B — confirmed, needs restructuring (no open design question)

| # | File:line | Rule | Finding | Fix shape |
|---|---|---|---|---|
| B1 | `app/edit/reports/4/page.tsx:120` | R2 | The Grants report table is missing the bordered/greige-header frame its siblings (`reports/3`, `reports/5`) use, and its row borders use the cool-gray shadcn `--border` instead of `--apollo-border`. This is the exact gap the design doc's own R14 rulebox names ("Reports are still R1/R2/R5 territory... framed tables, greige thead"). | Add the wrapper div + swap 3 className strings to mirror `reports/3`/`reports/5`. Mechanical, touches ~4 lines. |
| B2 | `components/edit/administrators-roster.tsx:370` | R11 | One `<Card>` + one full `<table>` (with its own re-declared header) per person — the exact card-per-record anti-pattern R11 forbids, and the design doc names `/edit/administrators` for this specific pattern by name. | Collapse to one table; each person becomes a group-header band row (name/title/CWID + `ViewAsButton`), grant rows nest under the band, header renders once. |
| B3 | `app/edit/methods/page.tsx:89` | R14 | Hand-rolls its own bar + directly-invoked `AdminSubnav` instead of `ConsoleShell`, and hand-computes tab-visibility props `ConsoleShell`/`deriveConsoleTabs` would supply for free. Two concrete visual drifts already present: badge is `size-7 rounded-sm` vs the shared `size-9 rounded-md`, and it's missing `sticky top-0 z-40` + the skip-to-content link. | Replace the hand-rolled chrome with `<ConsoleShell active="methods" ...>`. *(Note: the [`loadConsoleTabs` migration](../edit-console-ia-spec.md) touches this same file for role-gating reasons — sequence this after that lands to avoid two overlapping rewrites of the same block.)* |
| B4 | `components/edit/scholar-history-view.tsx:74` | R14 | Renders a bare `<main>` with **no shell at all** — not a wrong-token nuance, a genuinely white page (root layout's `--background` is literal white, only `ConsoleShell`/`EditShell` apply `--apollo-page`). No comment anywhere explains the omission. | Wrap in a `ConsoleTopBar`-based shell, following the precedent at `app/edit/core/[coreId]/review/page.tsx:78-79`. |
| B5 | `components/edit/center-history-view.tsx:91` | R14 | Identical defect to B4. Notably, `app/edit/core/[coreId]/review/page.tsx`'s own docstring claims this route "mirrors" a shelled pattern — it doesn't; a later engineer already treated this gap as fixed precedent, which is itself evidence of drift risk. | Same fix as B4. |
| B6 | `components/edit/publication-takedown-page.tsx:19` | R14 | Applies the correct `bg-apollo-page` token (satisfies R1) but has no bar/nav anywhere in its tree, including its 3 child components. Traced via `git log` to the same commit that introduced `edit-shell.tsx` (#745) — never migrated onto it; its own docstring inaccurately calls this "the standard /edit/* shell layout." | Add `<ConsoleTopBar variant="console" />`, same precedent as B4/B5. |
| B7 | `app/edit/methods/page.tsx:89` (R14, shell-membership angle) | R14 | Same file as B3, found independently by the shell-membership sweep: not bare/white (so a naive R1 check misses it), but structurally outside `ConsoleShell`/`EditShell` and already visually drifted — exactly the bug class `ConsoleTopBar`'s own docstring says the ~14-hand-rolled-copies consolidation was built to eliminate. | Same fix as B3 — folded in as one item, not double-counted in the tier totals above. |
| B8 | `app/edit/scholars/page.tsx:99` | R14 | The unauthorized-viewer denial branch returns bare `<ForbiddenEditPage />` instead of the `<ConsoleShell>` wrapper the success path below it uses — a denied viewer gets a fully chrome-less page on pure white. | Wrap the denial branch in `<ConsoleShell session={session} active="profiles">`, mirroring the success return. |

## 3a. Shell-membership conclusion (R14 sweep)

The three history/takedown views named in the original lost summary — `scholar-history-view.tsx`, `center-history-view.tsx`, `publication-takedown-page.tsx` — are **confirmed unexplained gaps, not a deliberate exclusion**. No comment anywhere in either component, its page-route caller, or child components states a reason (e.g. no "audit/legal-hold surface kept outside normal chrome" language exists anywhere in the codebase). Two of the three (scholar/center history) are the more severe case — a genuinely bare, unstyled `<main>` — while the third (publication-takedown) at least carries the correct page background. This reads as an incomplete migration off an older layout pattern, not intent (`publication-takedown-page.tsx` was touched by the very commit that introduced the current shell without being migrated onto it). The fresh sweep also surfaced a **fourth** and **fifth** route in the same class not named in the original summary: `app/edit/methods/page.tsx` (B3/B7 above) and `app/edit/unit/new/page.tsx` (partial — see C11).

---

## 4. Tier C — judgment calls (need a decision, not a fix)

Two shapes of Tier C finding came out of this pass: **(a)** maroon/amber genuinely carrying a second, competing meaning somewhere in the app, and **(b)** how much shell chrome a non-happy-path page (denied access, pre-selection chooser) should carry.

### 4a. Maroon/amber as a second meaning

| # | File:line | Rule | Competing meaning | Decision needed |
|---|---|---|---|---|
| C1 | `components/edit/method-families-roster.tsx:71` | R12 | The Tier segmented control ties maroon specifically to the "sensitive" value — maroon identifies *which* category, not *that* something is selected. | Mint a genuine non-maroon danger ink and free maroon for selection only, or formally exempt category-tinted segmented controls from R12. |
| C2 | `components/edit/matcha-panel.tsx:212,353,2822` | R13 | Three static, already-settled classifications (fit tier, eligibility, evidence provenance) render in `--apollo-amber`. The file's own comments explicitly argue for a second deliberate meaning ("the house amber... do NOT harmonize this back to green"), a direct competing claim against R13. | Formally document a second sanctioned amber meaning (confidence/tier) app-wide, or re-hue these three. |
| C3 | `components/edit/find-researchers.tsx:1460,1541` | R13 | Funding-status pill and `StageBadge` "moderate" tone both color a static category, reinventing C2's pattern independently with no shared token — the competing meaning is proliferating ungoverned. | Same decision as C2, plus: if kept, replace raw Tailwind with a shared token. |
| C4 | `components/edit/find-researchers.tsx:272,1062` + `grant-recs-card.tsx:242` + `matcha-panel.tsx:2173` | R13 | A ticketed convention (#1608) tones any deadline inside a 30-day window amber ("coming up soon") at 4 independent call sites, none using the `apollo-amber` token — an established but unwritten second meaning. | Name "time-urgent" as a sanctioned second meaning (with a real token), or move deadline-soon styling off amber. |
| C5 | `app/edit/etl-status/page.tsx:129` | R13 | ETL health board's `STATE_STYLE` map colors "Late" amber as one rung of a 5-state ops severity scale — describes pipeline health, not a pending human decision, and never touches the apollo token system at all. | Carve out operational-status boards as exempt from R13, or fold this board onto apollo tokens and pick a non-amber "late" hue. |
| C6 | `components/edit/all-units-directory.tsx:338` | R13 | "Retired" unit badge flags a permanent settled fact in amber. Unlike the others, this file's own header comment explicitly invokes R5/R7 by name — reads as an unreviewed slip in an otherwise rule-aware file, not a deliberate second meaning. | Recolor to the neutral/settled treatment (`apollo-slate` tokens, as used for "Suppressed" elsewhere), or document a deliberate "look twice" rationale. |
| C7 | `app/edit/reports/page.tsx:164` (also A-adjacent) | R13 | The identical "advisory only, nothing writes to the roster" sentence renders three different ways across two files: plain muted text (table mode, line 160; single-unit page), amber alert box (bands mode only, line 164). Same static fact, inconsistent treatment. | Drop the amber box to match the plain-text version elsewhere (R10: an invariant fact belongs in a lede, not a colored alert), or recolor a kept callout off-amber. |

### 4b. Shell-chrome-for-non-happy-path decisions

| # | File:line | Rule | Gap | Decision needed |
|---|---|---|---|---|
| C8 | `components/edit/forbidden-edit-page.tsx` (all ~24-30 call sites) | R14 | Beyond A10's color fix: **no** denial call site wraps `ForbiddenEditPage` in any shell — a denied user sees no bar and no nav anywhere in the app, not just the wrong fill color. Fixing every call site individually would still leave inconsistency; fixing it once inside `ForbiddenEditPage` needs session threading it doesn't currently have. | Whether a denied view should carry the full role-gated `AdminSubnav` at all (it would surface tab labels for surfaces the viewer can't open), which shell (`ConsoleShell` vs `EditShell`) fits which call-site family, and how to source session/tab props at call sites that hit the forbidden branch before other page data loads. |
| C9 | `app/edit/administrators/page.tsx:53,69` | R1/R14 | Same `ForbiddenEditPage`-unwrapped pattern as C8, at this page's two denial branches specifically. | Same decision as C8 — listed separately only because `session` happens to already be in scope here, making a local fix easier if C8 is decided against a shared fix. |
| C10 | `app/edit/page.tsx:136` | R14 | The proxy fan-out landing (`ProxyLanding`, a signed-in proxy serving 2+ scholars) self-supplies bar + warm page but renders no nav — R14 names nav as required, but there's no attribute rail or console tab strip to show before a scholar is picked. | Whether a pre-selection chooser legitimately needs a nav at all, or this is a sanctioned third chrome pattern (in which case, document it the way `core/[coreId]/review` documents its own reduced-chrome choice). |
| C11 | `app/edit/unit/new/page.tsx:177` | R14 | Uses the real `ConsoleTopBar` + correct page background, but no nav strip and no skip link — 2 of R14's 3 elements. The identical partial pattern at `core/[coreId]/review/page.tsx` is explicitly documented as deliberate; this one isn't. | Whether this create-form page is the same sanctioned reduced-chrome pattern (then document it) or an oversight (then add the nav). |

---

## 5. Explicitly not re-verified / out of scope this pass

- Tier B and C findings above were not adversarially re-verified line-by-line (see §1) — their file:line references come from the sweep agent's own read, not a second confirming agent.
- `components/edit/reports-index.tsx:177` (Tier B, table restructuring for `administrators-roster.tsx` — see B2) and the `bg-apollo-surface-2`/`border-apollo-border` mispairing noted as recurring in `all-units-directory.tsx`, `edit-page.tsx`, `slug-card.tsx`, `slug-request-card.tsx`, `slug-request-row.tsx` (mentioned under A11) were named by the sweep agent but not independently confirmed at each site — treat as a lead, not a filed finding, until checked.
- News-queue's article-title link (also `--color-accent-slate`, like A7) was found but demoted out of Tier A into an unlisted "needs a decision" state: the correct destination token is genuinely ambiguous (the app has two live conventions — maroon for administrative-object rows, slate for person/nav links — and neither precedent obviously fits "an external news article link"), and the identical legacy token is used verbatim by two sibling editor cards (`news-edit-card.tsx`, `technology-edit-card.tsx`) that would newly diverge from a one-file fix. Needs the same token decision as the maroon/amber items in §4a before it's mechanical.

## 6. Decisions needed (consolidated)

1. **Maroon-as-category-color** (C1) and **amber-as-tier/status/urgency** (C2–C7) — six independent findings converging on the same underlying question: does the design system have exactly one meaning per accent color (R9/R12/R13's canon), or do confidence-tier, urgency, and operational-status need their own sanctioned second meanings? Recommend deciding this once, centrally, rather than per-finding — the amber pattern alone repeats across 4+ unrelated files.
2. **Denied-access chrome** (C8/C9) — whether `ForbiddenEditPage` gets shell chrome at all, and if so, how (shared fix vs. per-call-site).
3. **Reduced-chrome pages** (C10/C11) — whether the proxy-landing / unit-create pattern (bar + page bg, no nav) is a sanctioned third chrome tier that needs documenting, on top of the two already-named shells (`ConsoleShell`, `EditShell`).

## 7. Suggested next steps

1. Ship the 12 Tier A findings (§2) as isolated token-swap PRs — each independently verified, no design input needed. Natural groupings: honors-queue.tsx (A2–A6, one PR), news-queue.tsx (A7), administrators-roster.tsx (A8), admin-subnav.tsx (A9), forbidden-edit-page.tsx (A10), unit-edit-page.tsx (A11), administrators/page.tsx (A12), reports-index.tsx (A1).
2. Decide §6 item 1 (color semantics) before touching any Tier C amber/maroon finding — a one-off fix to any single file will be wrong if the eventual answer is "amber has two sanctioned meanings."
3. Tier B (§3) restructuring items have no open question and can be scheduled independently of the Tier C decisions — `administrators-roster.tsx`'s table restructuring (B2) and the three-view shell fix (B4–B6) are the highest-value.
4. `app/edit/methods/page.tsx` (B3/B7) should land *after* the `loadConsoleTabs` migration ([`docs/edit-console-ia-spec.md`](../edit-console-ia-spec.md) Part B §2), since both touch the same hand-rolled block for different reasons — sequencing avoids two overlapping rewrites.
