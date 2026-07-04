# People-card evidence rows — count-first redesign (handoff)

**Status as of 2026-07-01:** three PRs **MERGED + DEPLOYED to staging**. This is the
continuation of `docs/evidence-rows-polish-handoff.md` (the earlier collapse/dot work).
All changes are presentational, under the existing `SEARCH_EVIDENCE_REASON_COUNTS` flag
(**staging-on / prod-off**). Prod rollout is a separate, un-taken decision.

**Staging to review:** `https://scholars-staging.weill.cornell.edu/search?type=people&q=hypertension`

---

## Shipped (all merged to master + live on staging)

| PR | Squash | What |
|----|--------|------|
| #1381 | `ccb3f700` | Collapse the "Also matched" group to a one-line summary (colored dot + category label per secondary, **no counts** — mixed denominators). Expands to the full lesser rows. Fires for ≥2 secondaries. |
| #1382 | `0ffedb7a` | Primary type indicator → **dot + type word** (retired the bordered pill/icon). Lone secondary now also collapses under "Also matched" with **one click** straight to its records. −8px above the group. |
| #1391 | `43a01c75` | **Count-first, column-aligned primary** (this doc's focus). Per-kind relation phrase, entity underline for all-but-keyword, method = burnt umber, fatter chevron, flavor pill retired. |

Deploy of #1391 = run `28525809477`, authoritative `conclusion: success` on `headSha 43a01c75`.

---

## The current primary layout (#1391)

```
● Method        14 of 98 publications used CRISPR Genome Editing        ⌄
[dot] [type col: w-124px]  [count-first phrase ...............]  [far-right chevron]
```

- **No pipe, no middot** between type and phrase. The type word sits in a **fixed 124px
  column** so the phrases align across cards; the chevron is pushed far-right.
- **Count-first**: the matched **N** is the emphasized anchor (`font-semibold #1a1a1a`),
  then a muted `of M <thing> <relation>` (`#8c8c8c`), then the entity.
- **Entity dotted-underline for every kind EXCEPT a literal keyword/mention.**

### Per-kind relation table ("all the possibilities")

| Kind | Type word | Thing | Relation | Entity underline? |
|------|-----------|-------|----------|-------------------|
| Method | Method | publications | **used** | yes |
| Research area (topic) | Research area | publications | **in** | yes |
| Concept | Concept | publications | **tagged** | yes |
| Keyword | Keyword | publications | **mention** | **no** (quoted literal) |
| Funding (tagged) | Funding | grants | **tagged** | yes |
| Funding (mention) | Funding | grants | **mention** | **no** |
| Clinical | Clinical | — (no count) | — | yes (the specialty) |

### Color tokens

| Kind | Dot (`bg-`) | Type/label (`text-`) |
|------|-------------|----------------------|
| Method | `#8B4A2F` | `#8B4A2F` | ← burnt umber (was red `#c2410c`/`#9a3412`) |
| Research area | `#2563eb` | `#1d4ed8` |
| Concept | `#7c3aed` | `#6d28d9` |
| Keyword | `#64748b` | `#475569` |
| Clinical | `#0891b2` | `#0e7490` |
| Funding | `#16a34a` | `#166534` |

- Entity underline = `ENTITY_UNDERLINE` = `underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]`.
- Count anchor `#1a1a1a` (dim → `#9a958a`); muted meta `#8c8c8c`.
- Type column `w-[124px]`; dot `size-2.5` (10px); chevron lucide `ChevronDown` `size-3.5` `strokeWidth={2.5}`.

---

## Component map (where things live — all in `components/search/`)

- **`match-reason.tsx`**
  - `MatchAwareReason` — **the single count-first primary renderer.** kinds =
    `method | topic | clinical | funding | concept | keyword`. Renders
    `[dot] [w-124px type col] [children phrase] [far-right chevron]`. Takes the phrase as
    `children`. `PRIMARY_KIND` = the per-kind {dot, type, word} token map.
  - `CountFirst` (**exported**) — the phrase builder: `**N** of M <thing> <relation> <entity>`.
    Props `n?, m?, thing?, relation?, entity, underline, dim`. No count (n/m omitted) ⇒ entity only.
  - `DisclosureRow` — the shared toggle button. `wide` = full-width row + `ml-auto` chevron
    (the primary). `compact` = tight padding (lesser rows).
  - `LesserReason` — the compact "Also matched" dot rows.
  - `MatchReason` — **LEGACY**, the old icon row. STILL used by the Publications tab
    (`publication-result-row.tsx`) and Funding tab (`funding-result-row.tsx`) and the
    People-card legacy flag-off path — NOT the People primary. Left untouched on purpose.
  - `RepresentativePapers`, `KeyFunding`, `MentionNote`.
- **`result-evidence.tsx`** — `ResultEvidence`, the kind switch.
  - Primary method/topic/clinical → `MatchAwareReason` + `CountFirst`.
  - Primary publications → `MatchAwareReason` + **the server `evidence.text` with the leading
    count bolded via regex** (`/^(\d[\d,]*)(\s[\s\S]*)$/`) + the `evidence.term` span. NOT
    reconstructed from count/pubCount — that preserves the three strength phrasings
    (tagged "N of M publications tagged" / concept "via related concept" / mention) and
    avoids needing the raw query. Concept term underlined, mention term not.
  - Lesser (`tier="lesser"`) → `LesserReason` rows; `ENTITY_UNDERLINE` now on method/topic/
    clinical entities too (all but keyword).
  - `badged` prop is now **DEPRECATED / ignored** (the §4.7 flavor pill was removed; the dot
    layout is no longer flag-gated). Kept in the type only so callers still type-check.
- **`evidence-line.tsx`** — `EvidenceLine`, one reason line + its disclosure + lazy fetch.
  `defaultExpanded` prop pre-expands a **lone** "Also matched" secondary so it opens in one
  click (kicks the lazy fetch on mount).
- **`people-result-card.tsx`** — the card.
  - `SECONDARY_META` = the collapsed "Also matched" summary chip tokens (method = umber).
  - `alsoExpanded` (collapse state), `fundingLoneDemoted` (lone-funding one-click), the funding
    node (full = `MatchAwareReason`+`CountFirst`; demoted = `LesserReason`). Legacy path also
    uses `MatchAwareReason`+`CountFirst`.

---

## Decisions made (with rationale)

1. **Count-first, count emphasized.** The matched N is the anchor; "publications/grants"
   kept for the unit (user rejected dropping it). Per-kind relation verb.
2. **No pipe → fixed-column alignment.** The user tried a pipe (in a mock), rejected it;
   image 3 shows aligned columns. Implemented as a fixed 124px type column.
3. **Underline the entity for every kind but keyword.** Underline = "system-resolved
   entity"; a literal keyword/mention stays plain (quoted).
4. **Method = burnt umber `#8B4A2F`** everywhere (primary, lesser, collapsed chip).
5. **§4.7 flavor pill retired; dot layout no longer flag-gated.** The non-flagged
   single-evidence pub row now also renders as a dot (test updated). If prod wants the old
   muted look behind a flag, that's a follow-up.
6. **DARK MODE HELD** per the user. When added: method dark pair = clay **`#C67B54`** (pure
   `#8B4A2F` goes muddy on a dark surface); the other categories need dark-surface variants
   too, contrast-tested separately. Do NOT reuse the light hexes on dark.

---

## Open questions / candidate next iterations

1. **Fixed-column vs natural inline.** The type words sit in a fixed 124px column (aligns
   phrases across cards, matches image 3). If that reads too "tabular" live, swap `w-[124px]`
   for natural inline spacing (dot + type + phrase flow). User flagged this as a maybe.
2. **Dark mode** (held) — see decision 6.
3. **Entity weight inconsistency:** `CountFirst` entity = `font-[450]`; the publications term
   = `font-semibold`. Minor, **unverified visually** — may want to unify.
4. **Secondaries ("Also matched" expanded rows)** still use the compact `● Type · entity · N of M`
   format, NOT the count-first column. Consistency call if you want them to match.
5. **Name · Title line:** image 3 showed "Name · Title" on one line; NOT implemented (the card
   keeps avatar + separate name/title/dept + right-rail stats). User may want the condensed header.

---

## Gotchas / environment (READ before iterating)

- **CANNOT visually verify locally** — People-search needs OpenSearch data the local DB lacks
  (`/methods` 404, profiles 500 are environmental). **Code-verify** via tsc + eslint + vitest;
  **visual-verify on STAGING** (the source of the screenshots).
- **Mock-driven review:** serve an HTML mock via `python3 -m http.server <port> --directory <scratchpad>`
  (Playwright MCP blocks `file:`). Playwright's browser is often **locked by a parallel session**
  → fall back to giving the user the `localhost` URL. **Accurate reference mock (matches #1391):**
  `localhost:8791/pr1391-actual2.html`. ⚠ **Do NOT link a stale mock** — this session linked the
  old `goal-ordering.html` (pipe + tagged-only underline) and the user thought the code ignored
  their advice when it was actually correct. Regenerate the mock to match current code every time.
- **Worktree** `~/worktrees/sps-evidence-polish` — `node_modules` + `lib/generated` are SYMLINKS to
  canonical, `.env*` are copies. **Never `git add -A`** (commits the symlink); stage explicit paths.
  For NEW work branch off **fresh `origin/master`** (`git checkout -b <b> origin/master`).
- **Full vitest has ONE pre-existing failure** — `edit-page.test.tsx` (Radix Avatar `handleLoad`
  reading `currentTarget` from a `FakeImage.onload()` mock in the shared `node_modules`). It is
  UNRELATED to this work and is **absent in CI's fresh install** (which is why every CI `build`
  went green). Don't chase it. Everything else: 6385 passed.
- **Run the FULL suite before pushing** (`npx vitest run --maxWorkers=4`) — repo lore: it catches
  mock-factory / render-order regressions tsc+lint miss.
- **Staging deploy rolls the SHARED staging image.** Merging to master auto-deploys to staging
  (push-to-master → staging). Concurrency churn is common — a direct deploy can get **cancelled**
  by a newer master push; **chase the actual successful run** and verify the authoritative
  `gh run view ... --json conclusion` (NOT just the watch exit code — a cancelled run once
  returned exit 0). Confirm the deployed `headSha` is (or contains) your merge commit.
- CI required checks = **build + cdk** (Orca not required). Merge path: poll `gh pr checks <n>
  --watch --required`, then `gh pr merge <n> --squash` on green. Never merge without explicit
  user go.

## Tests

`tests/unit/result-evidence-card.test.tsx`, `tests/unit/people-result-card-funding.test.tsx`,
`tests/unit/people-result-card-match-aware.test.tsx`. Assertions to remember: entities are
`<span>` (not `<strong>`) now; the count is its own bolded span, so assert the full phrase on
`container.textContent` / `document.body.textContent`, not a single `getByText`.
