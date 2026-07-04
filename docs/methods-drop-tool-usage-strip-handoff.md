# Handoff — drop the "How researchers use these tools" strip from method family pages

**Created:** 2026-06-21 · **Owner:** Paul Albert
**Status:** code edits DONE in a worktree (uncommitted); blocked on a transient Anthropic Bash-classifier outage for verify + ship. Resume = run the steps in §4.

---

## 1. The task & why

On tool/method family pages (e.g. `/methods/molecular-biochem-reagents/recombinant-protein-reagents-fam_0580`) the per-tool usage snippets render as the legacy **#1119 "How researchers use these tools"** prose strip — plain `tool — context` list, no highlight, no ellipsis, no badge. It's the odd-one-out vs. the polished cell-line feed.

**Decision (user, 2026-06-21):** **cut that section entirely** rather than badge/highlight it. Rationale: the prose strip is the old format; the clean snippet treatment (badge + `<mark>` + ellipsis) stays on the cell-line feed (shipped in #1197), and proper per-paper *tool/method* usage snippets return later via the WS-B/WS-C producer work (ReciterAI #252/#253/#254), not this list.

This removes only the **family-page UI surface**. The `getFamilyToolUsage` API, the `METHODS_LENS_TOOL_CONTEXT` flag, and other #1119 consumers (search snippets, overview, Surface-A profile rail) are untouched.

---

## 2. Current state

- **Worktree:** `~/worktrees/sps-cut-toolusage`, branch **`feat/methods-drop-tool-usage-strip`**, based on `origin/master @ e89a8a20` (fetched 2026-06-21; was the tip after #1198).
- **Edits are saved to disk (via the Edit tool) but UNCOMMITTED.** No `.env*` copied, **no `npm ci`**, no prisma client generated yet (the compound shell commands that would do that kept failing on the classifier outage).
- Blocker: the Bash safety classifier (runs on Opus 4.8, flagged "temporarily unavailable") rejected most shell calls. Read/Edit/Write tools worked, which is why the source edits are in. **The change itself is trivial and low-risk** (a deletion); CI will verify.

---

## 3. Exact edits already applied (do NOT redo — verify they're present)

**`app/(public)/methods/[supercategory]/[family]/page.tsx`** — 4 removals:
1. Import: removed `getFamilyToolUsage,` from the `@/lib/api/methods` import block.
2. `Promise.all` destructure: removed the `toolUsage,` binding (the array stays positionally aligned: `topScholars, scholarCount, representativePubs, cellLineEntities, distinctPmidTotal`).
3. `Promise.all` body: removed the `// #1119 …` comment + `getFamilyToolUsage(resolved.supercategory, resolved.familyLabel).catch(() => []),` call.
4. JSX: removed the entire block
   ```
   {/* #1119 … */}
   {!hasCellLines && toolUsage.length > 0 && (
     <section … aria-labelledby="tool-usage-heading"> … How researchers use these tools … </section>
   )}
   ```
   (sat between the header `</section>` and the Spotlight gate). `hasCellLines` is still used by the `#publications` master-detail block, so it stays.

**`tests/unit/methods-loader-notfound.test.tsx`** — removed the now-unused `getFamilyToolUsage: () => Promise.resolve([]),` line from the `vi.mock("@/lib/api/methods", …)` factory. (This is the ONLY test that referenced the strip; it does not assert the section renders, so no other test edits are needed. `grep -rlE "How researchers use these tools|getFamilyToolUsage" tests/` returned only this file.)

> If the worktree is gone, re-create it (`git worktree add ~/worktrees/sps-cut-toolusage -b feat/methods-drop-tool-usage-strip origin/master`) and re-apply the five removals above.

---

## 4. Remaining steps to finish (all need Bash)

```bash
cd ~/worktrees/sps-cut-toolusage
cp ~/Dropbox/GitHub/Scholars-Profile-System/.env* .          # untracked env (Dropbox repo)
npm ci && npx prisma generate                                 # worktree has no node_modules / prisma client
npx tsc --noEmit                                              # expect clean
npx vitest run --maxWorkers=4 tests/unit/methods-loader-notfound.test.tsx \
  tests/unit/methods-section.test.tsx                         # expect green (loader control test + spotlight-gate tests still pass)
git status --short                                            # expect: M page.tsx, M methods-loader-notfound.test.tsx
git add "app/(public)/methods/[supercategory]/[family]/page.tsx" tests/unit/methods-loader-notfound.test.tsx
git commit -m "feat(methods): drop the #1119 'How researchers use these tools' strip from family pages"  # NO AI attribution
git push -u origin feat/methods-drop-tool-usage-strip
gh pr create --base master --title "feat(methods): drop the 'How researchers use these tools' strip from family pages" --body "<see §5>"
```

Then: watch CI (`gh pr checks <PR> --watch`); merge only on green (`gh pr merge <PR> --squash --delete-branch`) if the user says merge; post-merge CD auto-deploys to staging; render-verify a tool family page (e.g. `…/recombinant-protein-reagents-fam_0580`) shows **no** "How researchers use these tools" section (header → Spotlight-if-≥12/≥3 → publications feed).

---

## 5. Suggested PR body

> Removes the legacy #1119 "How researchers use these tools" prose strip from method **family** pages. Per the methods-snippet redesign, per-tool usage context will return as proper per-paper snippets (badge + `<mark>` + clean boundaries, like the cell-line feed in #1197) once the producer emits tool/entity informativeness + sentence-aligned spans (ReciterAI #252/#253/#254). The `getFamilyToolUsage` API, `METHODS_LENS_TOOL_CONTEXT` flag, and other #1119 surfaces (search/overview/Surface-A) are untouched. Drops the now-unused fetch/import/var and the loader-test mock stub. Net deletion.

---

## 6. Session context (so the arc is clear)

- **#1195 MERGED** (`057f2baf`) + staging-verified — cell-line family page rebuilt as **master-detail** (`EntityRail`/`RailItem`, `FamilyRail` adapter, retired strip/directory, Spotlight volume-gate, punch #1/#3).
- **#1197 MERGED** (`6e37327e`) + staging-verified — **ellipsis** in shared `highlightSnippet` (leading `…` mid-sentence start, trailing `…` no terminal punct, span-shift safe) + reusable **`SnippetUsageBadge`** ("How it was used" default, flips to "Where it appears" with WS-C) on the cell-line feed.
- **ReciterAI #252 / #253 / #254** filed (generalized to ALL tools/methods): WS-B vocab normalization (canonicalize/generics/0-count/293≠293T), WS-C informativeness (`informativeness_score` + usage/mention class → the badge), entity_context sentence-boundary alignment.
- **SPS #1168** narrowed to mirror those (WS-B + WS-C + §5.5 cross-links).
- This task is the small follow-up that resolves the "I should see this everywhere" inconsistency by *removing* the legacy strip rather than badging it.

## 7. Gotchas

- **No AI attribution** in commits/PRs (repo + global rule). Use `-m` (or `-F`) — backticks in a double-quoted `-m` body get shell-substituted.
- Base any (re)branch off **fresh `origin/master`** — it moved fast today (#1195→#1196→#1197→#1198…).
- **Dropbox repo** → worktree needs `cp .env*` + `npm ci` + `npx prisma generate` before `tsc`/tests (no symlinked node_modules — full `npm ci`).
- `methods-loader-notfound.test.tsx` is the #954 mock-trap file; its `vi.mock("@/lib/api/methods")` must match the page's imports (already handled: dropped the `getFamilyToolUsage` stub).
- Canonical checkout is on `docs/spotlight-pipeline` (drifted) — don't trust its working-tree copies; the truth is `origin/master` / the worktree.
