# Sponsor-match console — polish, round 2: handoff

Grounded at `origin/master` @ `e09605dc`. Companion to `docs/2026-07-14-sponsor-findings.md` (read §1
and §3 before touching anything that produces a number) and `docs/2026-07-14-sponsor-reskin-handoff.md`.

**Re-derive every table below before you build against it.** That is not ceremony. Two of the three
"blocked" claims I inherited this session were false, and one of the two I *made myself* was false. The
tables rot; `git grep` does not.

## 0. State

Merged this session, both auto-deployed to staging, **neither visually verified**:

| PR | What |
|---|---|
| #1707 | Per-card `Contact` button. Deleted `SponsorCandidate.caveat` and `ask.quote`. |
| #1708 | DELETE erases every run of a paste (was: one row, leaving the text behind). History deduped per paste. Headshots. |

**#1696's evidence blocks are now visually verified** and they render correctly: multiple
concept-captioned blocks per card, each with its own reason line and count, and cards with zero blocks
render nothing. That was the top item of the last handoff and it is done. The screenshot that proves it
is what produced every finding below — **looking at the thing found four defects that 7,192 passing
tests did not.**

Prod: `SPONSOR_MATCH` and `SPONSOR_MATCH_SPINE` remain **off**. Nothing here has run against prod.

## 1. 🔴 THE FILTERS SEE 100 OF 430 CANDIDATES — start here

`components/edit/sponsor-match-panel.tsx`:

```ts
const ranked = useMemo(() => rerankCandidates(...).slice(0, RESULT_MAX), [...]);  // RESULT_MAX = 100
const deptFacet = useMemo(() => { for (const c of ranked) ... }, [ranked]);        // ← ranked, not candidates
```

Every facet — Department, Matched concept, Career stage, Person type, Clinician, **CTL portfolio** —
iterates `ranked`, which is the top **100**. The staging run that produced this finding ranked **430**.
So a candidate at rank 101–430 cannot be surfaced by any filter, and does not appear in any facet count.

The `conceptFacet` comment says *"Counts are over the full candidate set, pre-filter."* **It is not the
full candidate set.** It is the top-100 slice. Same defect class as everything else in this subsystem's
history: a confident comment describing something the code does not do.

This bites hardest on the one filter this surface exists for. The console showed **"Holds CTL
technology: 9"** — that is 9 of the top 100, not 9 of 430. A CTL officer filtering to the portfolio is
being shown a subset of it and has no way to know.

**Note what is NOT broken:** the *sliders* re-rank the full pool and *then* slice, so dragging a concept
genuinely can pull someone from rank 150 into view. Retrieval and re-ranking are fine. Only the
**filter/facet layer** is capped.

### The decision, and it is a real one

Filtering the full 430 client-side is cheap — the payload is already in the browser. But it changes what
`RESULT_MAX` means, and the two readings are not compatible:

- **"Render at most 100 rows"** (a display cap) ⇒ facet over `candidates`, filter over `candidates`,
  slice to 100 *after* filtering. A CTL filter then finds every CTL holder in the pool.
- **"Rank only the top 100"** (a relevance cutoff) ⇒ today's behaviour is correct, and the facet counts
  are honest about a deliberately truncated world — but the comment must stop claiming otherwise, and
  the UI should say "top 100" rather than "100 researchers".

I believe the first is what everyone assumes and the second is what ships. **Pick one, then fix the
comment either way.** The lazy version of option 1 is: facet over `candidates`, filter over `candidates`,
`.slice(0, RESULT_MAX)` last. It is a re-order of three memos, not new machinery.

**Verify before you build:** probe whether candidates 101–430 actually contain CTL holders. If they do,
this is a live under-reporting bug, not a theoretical one. One in-VPC run of the route and a count is
enough. Do not take my structural argument as the empirical answer — that is the exact substitution this
subsystem keeps punishing.

## 2. `·rare` fires on 6 of 8 concepts — accurate, and useless

It was never removed. **Rarity was deleted from the FUSION (#1698); the rail's badge is display-only and
has been rendering all along.** If a handoff (or a person, including me) tells you the badge is gone,
they are wrong — `git grep rareTerms`.

The threshold (`RARE_COVERAGE_RATIO = 0.1`) is **relative to the most-covered concept in the same ask**:

```
coverage <= maxCoverage * 0.1  ⇒  ·rare
```

On the ADC paste that is 6 of 8 concepts. The reasoning in `rareTerms`'s doc-comment is sound — an
*absolute* cutoff would badge everything, since every MeSH concept is rare at corpus scale — but the
result is a badge that fires on three-quarters of the rail and therefore says nothing. When 6 of 8 are
"rare", the informative fact is which 2 are not.

Options, cheapest first. **None of these touch the ranking**, so none needs an eval:

1. Do nothing. It is accurate. (Defensible.)
2. Tighten the ratio until it badges ~1–2 concepts on a typical ask. Requires sampling several real
   pastes, not one.
3. Invert it: badge the *common* ones. Blocked — **"common" is unsayable.** ~40% of descriptors have no
   coverage row, and absent ≠ zero, so "not rare" cannot be rendered as "common" without lying about the
   unknowns.
4. Drop the badge. If rarity does not affect rank and the officer cannot act on it, ask what it is for.

## 3. `claimedPmids` release-on-unmount in `EvidenceLine` (~6 lines)

Unchanged from the last handoff, still cosmetic, still correctly last. `EvidenceLine` only ever *adds*
to the shared paper-dedup Set. #1704 keyed the Set on the rendered block list, which fixes the
mute→unmute leak; the correct fix belongs inside `EvidenceLine`, which is **shared with the public
People card** and so needs its own review and its own staging look. Residual today: after a mute/unmute
cycle two blocks can briefly offer the same representative paper.

## 4. Prod launch — two gates, neither has moved

`SPONSOR_MATCH` + `SPONSOR_MATCH_SPINE`: staging-on, prod-off. (#1632 is closed; the flags are not.)

- **Flip them TOGETHER.** `SPONSOR_MATCH=on` + `SPONSOR_MATCH_SPINE=off` is a *supported* config that
  routes to the bespoke engine — which lost the bake-off decisively (0.367 vs 0.594) and returned zero
  real scleroderma experts. The surface would work and the results would be bad.
- **The fan-out has never run against prod's OpenSearch**, which serves the public search. Staging is
  m6g.large ×1; prod is ×2. Land the prod breaker alarm, and consider a controlled fan-out outside peak
  hours, before flipping.

## 5. Two things that need a person, not a commit

**CTL was shown a compose modal that is not shipping.** The approved mockup
(`sponsor-match-scholars.html`, lines 484–693) draws a `Contact` button per card, a **`Contact
selected`** bulk button, and a working **compose modal**. #1707 shipped the per-card button *only*. Bulk
email is a standing policy no-go — `docs/email-visibility-spec.md` forbids bulk email download "even for
internal users" at a cap of 50, and a sponsor pool runs to 800. **If CTL believes "Contact selected" is
coming, someone has to tell them it is not.** That is the only external commitment in this subsystem.

**The Contact button finds nothing in prod, by design, today.** `/api/profile/[cwid]/contact-email`
fails closed, and in prod the release gate is off *and* the `email_visibility` backfill has never run —
so it returns `{ email: null }` for everyone and the button reads "No email released". It degrades
quietly, which means **it will not look broken in a demo; it will look like nobody at WCM has an
email.** Enabling it is a separate rollout decision with a consent story attached, not a flag flip.

## 6. #1699 is empty — close it or retitle it

Its "Unblocked today" table is now stale in the same way as the table it was written to correct. Against
`e09605dc`:

| #1699 row | Reality |
|---|---|
| Export CSV / Excel | Built (`exportVisible`, `lib/edit/sponsor-match-export.ts`) |
| Sort: Fit | Built (`SORT_TABS`, `aria-pressed` chips) |
| Filter panel | Built (an `<aside>` with six `FacetGroup`s) — **but see §1** |
| Edit paste / Re-run match | Built (search-history rows re-run on click) |
| Contact / Contact selected | Per-card shipped (#1707); bulk is a policy no-go (§5) |
| Scholars visual skin | **Already done.** The panel's own module doc records it: skinned to the mockup's *information design and token values*, not its chrome. The mockup's palette was authored from this app's tokens (`--accent #2C4F6E` **is** `--color-accent-slate`). There was never a reskin to do. |

The chrome question §4 of the reskin handoff asks you to confirm is **already answered in the code** and
was re-confirmed this session: house-console, Apollo bar, console `h1`. Stop re-litigating it.

## 7. What to internalize

Three from the findings doc, which still stand, plus two this session added.

**The eval has a ~0.0074 nDCG noise floor at `temperature: 0`.** Any single-run ranking improvement under
~0.01 is unproven. Sample N times, compare distributions. Nothing in §1 or §2 above touches the ranking,
which is why none of it needs an eval — check that claim before you assume it of your own change.

**Grep the assignment; don't read the comment.** Every defect this session was an assertion nobody
checked against the thing it described:

- the DELETE's doc-comment said *"nothing of the sponsor's prose survives this call"* — false for any
  paste run more than once, which is most of them;
- the `conceptFacet` comment says *"Counts are over the full candidate set"* — it is the top-100 slice
  (§1);
- the reskin handoff said `ask` was absent — it ships;
- **and I claimed `ask` had no producer, from a `git grep '\bask:'` that could not match
  `const ask = sponsorAskFrom(...)`.** A regex that only finds object-literal syntax will miss every
  producer that assigns to a local. I made the exact mistake I was reading the document about. Grep for
  the *symbol*, not for a syntax you assumed.

**A field that is WRITTEN but never READ is worse than one that is merely declared.** `ask.quote` had a
producer (`preferences[0]?.evidence ?? ""`), shipped an empty string on the wire, and was rendered by
nothing. It survives the usual audit precisely *because* `git grep` finds an assignment. When you hunt
dead fields, grep the **readers**, not the writers.

**Mutate the code back to the bug and watch the test fail.** This is now standard here and it earned its
keep twice this session. The old DELETE test *asserted the bug* —
`toHaveBeenCalledWith({ where: { id: "s1" } })` — green, and locking a privacy hole shut. A test that
passes against both the bug and the fix is not evidence of anything.

**Look at the screen.** Four defects in this document came from one PDF of the running console. None of
them came from the test suite, and the suite was green over all of them.

## 8. Verification — you still cannot do this locally

The console is auth-gated. **Verify on STAGING.** Local `.env.local` needs all of these, and without the
first two the evidence blocks render EMPTY and you will "verify" a page whose feature never ran:

```
SEARCH_RESULT_EVIDENCE=on          # else searchPeople emits NO evidence at all
SEARCH_EVIDENCE_REASON_COUNTS=on   # else the stacked evidenceLines[] shape is absent
SPONSOR_MATCH=on                   # else the route 404s
SPONSOR_MATCH_SPINE=on             # else you silently drive the BESPOKE engine
DEVELOPMENT_ENABLED=on             # else the route 403s
SCHOLARS_DEVELOPMENT_ALLOWLIST=<cwid>
```

Use `npx next dev -p 3007`, not `npm run dev` — turbopack chokes on a worktree symlink.

**First thing to look at on staging**, because both shipped unverified: do the **headshots resolve**
(#1708), and does the **Contact** button produce a `mailto:` (#1707, staging only — see §5)? And is the
search history now **one row per paste**?
