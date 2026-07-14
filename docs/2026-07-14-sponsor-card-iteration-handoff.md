# Sponsor-match card — iteration handoff

Grounded at `origin/master` @ `4bb4ac37`, 2026-07-14. Everything below was merged today. **Re-derive any table before you build against it** — this subsystem's handoffs rot, and two of the three "blocked" claims I inherited this session were false, as was one I made myself.

## 0. READ THIS FIRST — the design rules, so nobody has to restate them

The user supplied two mockups (`her2_low_term_evidence_drawer_level2.html`, `evidence_card_interactive_strip_and_expand.html`). **The mockup is the spec, not a mood board.** I got this wrong twice and was told so twice: *"I think you're adhering too closely to the 'laziest approach' is best"* and *"The evidence does not match the design spec."*

Reuse-what-exists is an IMPLEMENTATION strategy. It is not a design strategy. The rules, stated by the user and now binding:

1. **No redundant listings of the same set.** A row of concept "pills" was deleted because the coverage strip, the block captions, and the gap line already named those concepts. If a fact is on screen once, do not render it again in a different shape.
2. **No borrowed chrome.** The shared reason-line's fixed kind-word column was deleted — *"we shouldn't be doing the 'O Concept' thing."* A label that earns its place on the public People card (where the kind is the only thing separating one row from the next) is pure noise under a caption that already names the concept. **Extract the fact; re-render it natively. Do not import a component and inherit its decoration.**
3. **Lead with the artifact, not the statistic.** *"Just list relevant pubs and grants."* A card answering "why did this person match?" shows a titled paper or grant. The count belongs in the disclosure, or as the fallback when nothing resolves.
4. **The card must never contradict itself.** "Covers 8 of 8 concepts asked" sat above two rows reading "ranked, no evidence shown". Both were true; together they were nonsense. **Numbers must PARTITION the thing they describe and add up.**
5. **Never invent a datum to satisfy a pixel.** The mockup's compact row cites "1 pub · Cancer Cell 2022, middle author". For those concepts no paper exists (see the evidence cap, §3). Say what is true instead.
6. **Name every deviation and the missing datum that forced it**, in the same breath as the deviation.

## 1. State — merged, and what is still INERT

| PR | What | Status |
|---|---|---|
| #1714 | Sponsor card: pool-wide facets/filters, coverage strip, artifact-lead evidence, grants | merged (`f205ceaa`) |
| #1720 | `SEARCH_FUNDING_CONCEPT_GRANTS` prod-on | merged (`98ed0391`) — **INERT** |
| #1722 | Per-person authorship role on the pubs index | merged (`4bb4ac37`) — **INERT** |

#1713 (the previous handoff) is closed. #1721 was auto-closed by a self-inflicted `--delete-branch`; #1722 is its cherry-pick.

**Two merged things do nothing yet, and neither fires on merge:**

- **#1720 needs `cdk deploy Sps-App-prod`.** CD re-rolls the image; it does NOT apply task-env changes (the flag-parity rule). This is a **PUBLIC People-card change** — more grants surface on the Key Funding row, and reason labels move from `mention "<query>"` to `N of M grants tagged <Concept>`. Prod deploys pause for reviewer.
- **#1722 needs a FULL PUBLICATIONS REINDEX.** It adds `wcmAuthors.role` to the pubs mapping. Safe merged-and-un-reindexed *by design*: documents lack the field, every reader treats absent as unknown, and the card renders `Blood · 2025` with no role. The role appears only after the reindex.

**NOTHING IN THIS SESSION HAS BEEN SEEN ON STAGING.** Every claim below is from unit tests plus a local preview harness against stubbed data. The console is auth-gated; see §5.

## 2. What the card renders now

```
Evidence for 2 of 8 concepts asked · also ranked under Drug resistance,
Patient-derived xenograft models · no evidence for Topoisomerase I inhibitors,
Bystander effect, Antigen downregulation, Lysosomes

Antibody-drug conjugates                                            ask 1.00
  PUB    Site-specific conjugation preserves DAR in anaplastic lymphoma xenografts
         Blood · 2025 · last author        (role only after the reindex)
         + 2 more pubs (2025, 2023)

HER2-low breast cancer                                              ask 0.75
  GRANT  Resistance mechanisms in HER2-low disease
         R01 CA-2xxxxx · active to 2028 · NCI
  PUB    Antibody-drug conjugate response in HER2-low breast carcinoma
         Nature Medicine · 2025
         + 1 more pub (2024)
```

Above it: a **coverage strip** — one segment per asked concept, width = `conceptWeight` (the number the fusion actually ranks on, so the bar cannot drift from the ranking), re-drawn live under the sliders. Three fills: evidence / ranked-no-block / gap.

## 3. The traps. Do not re-learn these the hard way

**`MAX_EVIDENCE_CONCEPTS = 3`.** The spine ships evidence blocks for at most the 3 strongest concepts *at DEFAULT weights*. This is the root of the self-contradiction in §0.4, and it is reachable on demand: drag a 4th concept's slider to the top and it has a chip and a strip segment and **no block**, and no client can conjure one. The strip's middle fill state exists for exactly this and says *"ranked under this, evidence not shown"* — **never** render it as a weaker shade of "found".

**Auto-resolving evidence KILLED the cross-concept de-dup, silently.** `claimedPmids` makes a card's blocks show DIFFERENT papers: whoever resolves first claims the paper, the others send it as `exclude=`. That works on the click path because a human opens one disclosure at a time. Fetching on render fires every block in the SAME commit, so they all read an empty claimed set and a paper that is the best evidence for two concepts gets offered as the evidence for both. **Cards now resolve their blocks IN ORDER** (block *i* waits for *i-1* to settle, via `onResolved`). If you touch the resolve path, this is what you break.

**The old de-dup test could not have caught it.** Its stub returned pmid 111 regardless of `exclude`, so it passed against a build with the de-dup deleted outright. It now honors `exclude` and asserts the two concepts lead with different papers. *A test that passes against both the bug and the fix is not evidence of anything.*

**Absent role is UNKNOWN, not "middle author".** Every document indexed before the reindex carries a `wcmAuthors` entry with no `role`. Rendering the weakest role on a missing field would quietly demote every senior author on every stale document — a wrong answer that looks exactly like a right one. Guarded by a test, not a comment.

**`wcmAuthorPositions` can NEVER attribute a role to a person.** It is a paper-level UNION across all WCM authors: on a paper with a WCM first-author and a WCM middle-author it holds `["first","middle"]`. Right on solo papers, silently wrong on collaborations. That is why #1722 added a per-author field.

**`searchEvidence` is ABSENT, never `[]`.** Gate on a term's PRESENCE, never on array truthiness.

**`gh pr merge --delete-branch` auto-closes any PR stacked on that branch.** Retarget dependents to master first. Cost me #1721.

## 4. What is NOT built, and why

| Mockup element | Why not |
|---|---|
| **The level-2 drawer** (whole thing) | Payload behind it is **≤6 rows** (papers and grants both cap at 3), so its Group-by / Sort / "Senior author only" controls are chrome for a dataset the product deliberately does not fetch. Scoped in `docs/2026-07-14-evidence-drawer-unblock-scope.md`, which argues against building it. **Revisit only if the caps are raised for an unrelated reason.** |
| **"also supports \<other concept\>"** | **Destroyed by design.** Each line sends `exclude=<claimedPmids>` and the query drops them, so a paper supporting two concepts is shown under exactly one *by construction*. Getting it back by removing the de-dup would render the same paper under several concepts **on the PUBLIC People card** — that is the repetition the design deliberately removed. If genuinely wanted, it must be built as a cross-reference over an already-de-duped list (compute the other concepts a shown pmid belongs to and label it). **That is a different and much larger piece of work than it looks.** |
| **"contact PI" on the grant line** | No PI-role field on `EvidenceGrant`. Would need the funding route widened. |
| **Per-year sparkline, grant-active timeline bar** | Drawer-only. `year` is an aggregatable integer, so it needs one agg and no reindex — but it adds a query to a public, latency-sensitive path. |

## 5. How to look at it — localhost, no deploy, no auth

**The dev server is running and should be LEFT RUNNING:**

```
http://localhost:3007/sponsor-card-preview
```

Type anything into the description box, press **Rank researchers**.

- Worktree: `~/worktrees/sps-card` (branch `docs/sponsor-card-iteration-handoff`, off merged master).
- Launched detached: `nohup bash -c 'npx next dev -p 3007' > /tmp/sps-card-dev.log 2>&1 & disown`. **Do NOT `dev-server-track.sh` it** — the Stop hook reaps tracked PIDs at every turn end.
- `npx next dev`, NOT `npm run dev`: turbopack chokes on the worktree's symlinked `node_modules`.

**The harness is UNTRACKED and deliberately never committed:** `app/sponsor-card-preview/page.tsx` (stubs `fetch`, renders the REAL `SponsorMatchPanel`), plus `_dbg2.mjs` / `_ev_check.mjs` (headless Playwright checks). If the worktree is removed, they are gone — copy them out first.

The fixture is built to expose the traps, not to look pretty:
- **Inghirami** (card #2) is the mockup's person: 8 concepts asked, 2 with evidence, 2 ranked-no-block, 4 gaps. **He starts below the fold on purpose** — scroll to him and watch the papers resolve. That is the IntersectionObserver, and it is what makes artifact-first affordable (100 rendered cards × 3 concepts would otherwise be ~300 requests for a page you see five rows of).
- The ADC and HER2-low pools **deliberately share one paper**, titled *"Shared ADC/HER2 paper — only ONE concept may lead with this"*. If it appears under BOTH concepts, the ordered resolution is broken.
- **Ada Allcover** covers all 8 (no gap clause). **Sol Onething** covers only the weakest (nearly empty strip). **Zed Deepcut** is the CTL holder at rank **105** — below the render cap, which is the #1714 bug.

**What the harness CANNOT verify:** real evidence text, real headshots, real OpenSearch, the auth gate, real grant recall. Those need STAGING.

## 6. Verification status — be honest about this

| | |
|---|---|
| Full vitest suite | **7,213 passing** (one unrelated suite, `usage-summary.test.ts`, fails to import `@aws-sdk/client-athena` in a worktree with a stale symlinked `node_modules` — CI installs it and is green) |
| typecheck / eslint | clean on every touched file |
| CI on all three PRs | build + cdk green |
| Browser | local preview only, stubbed data |
| **Staging** | **NEVER RUN.** Nothing in this session has been seen on a real index. |

**First things to look at on staging:** do grants actually surface per concept (the flag is already staging-on)? Does the coverage line's arithmetic hold on a real ask? Does the ordered resolve actually produce different papers per concept on a real corpus, or does the `exclude` chain starve a block to empty?

## 7. Open issues

- **#1699** — "Sponsor match console: Scholars reskin (2a)". The previous handoff concluded this issue is **empty**: every row of its table is built, policy-blocked, or was already done, and the chrome question it asks is answered in the panel's own module doc. **Close it or retitle it to the precise remaining gap.** Do not re-litigate the reskin.
- **#1440** — dead-code / flag-debt sweep. `SEARCH_FUNDING_CONCEPT_GRANTS` is now unconditional; when it has soaked, the flag itself is deletable.

Not an issue but needs a person, not a commit: **CTL was shown a compose modal and a "Contact selected" bulk button that are NOT shipping.** Bulk email is a standing policy no-go (`docs/email-visibility-spec.md`). Somebody has to tell them.

## 8. Next moves, ranked

1. **Look at it on staging.** Nothing here has been. That is the single highest-value next action and it is what found four defects last round.
2. **Run the pubs reindex** so #1722's authorship role actually renders — it is the last unbuilt element of the card mockup.
3. **`cdk deploy Sps-App-prod`** for #1720, with a before/after on the public People-card funding row.
4. Decide **#1699**: close or retitle.
5. Only then consider "also supports" — and read §4 before you do.
