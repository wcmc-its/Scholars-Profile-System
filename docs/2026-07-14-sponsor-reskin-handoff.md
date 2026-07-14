# Sponsor-match console — Scholars reskin (#1699): handoff

Grounded at `origin/master` @ `1def8333`. Companion to `docs/2026-07-14-sponsor-findings.md` — read
its §8 before trusting any table in this file, including the ones below.

## 0. The issue's own blocker table is STALE. Four of five rows have shipped.

#1699 lists five mockup elements as blocked on a missing ranker-side producer. **Four now have one.**
Each re-verified against master:

| Mockup element | #1699 says | Actually, on `1def8333` |
|---|---|---|
| Topic/method evidence rows | blocked | **Shipped, and widened.** #1691, then #1696 — `SponsorCandidate.searchEvidence[]`, up to **3 blocks**, one per matched concept |
| Preferences rail | blocked | **Shipped** — `lib/api/sponsor-preferences.ts`, produced by the route, rendered (`data-slot="sponsor-match-preferences"`) |
| Sort: Seniority + status tags | blocked | **Shipped** — `measures.careerStage` (`careerStageBucket`), `measures.isClinician` |
| **Ask** header | "still absent" | **Shipped** — `sponsorAskFrom()` (`app/api/edit/sponsor-match/route.ts`); the panel already renders `data-slot="sponsor-match-ask"` |
| **"Show anyway"** (demoted near-miss) | absent | **STILL ABSENT — and it is a landmine.** See §1. |

**Re-derive this table yourself before you build against it.** That instruction is not ceremony: this
subsystem's single documented hazard is confidently-worded notes that are false, and the table above
will itself go stale. `git grep` the producer.

## 1. `caveat` is DECLARED but never CONNECTED — do not build UI against it

`SponsorCandidate.caveat` exists on the type (`lib/api/sponsor-match-contract.ts` ~409, *"Near-miss
reason. Present ⇒ the card takes the demoted treatment + amber caveat"*) and **nothing writes it.**
`git grep caveat` over `lib/` and `app/` returns the declaration and unrelated components. There is no
producer.

This is the codebase's most common latent bug (`abstain`, `measures`, `prefBoost` all shipped inert).
The type will happily let you render a demoted-card treatment that **never fires in production**, and
it will typecheck, and the tests will pass.

Building "show anyway" means **first writing a producer** — deciding what a near-miss *is*, and what
reason to emit — and that is its own scoped PR with its own decision about whether the producer earns
its cost. It is not part of a reskin.

## 2. What #1696 changed UNDERNEATH the mockup, and it changes the layout

The mockup was drawn when a card carried **one** evidence line. It now carries **up to three**, each
captioned with the concept term it belongs to. Measured by driving the real route against the real
corpus on a scleroderma paste (341 candidates):

```
0 blocks:  21 candidates      <- correct, not broken. See below.
1 block : 255
2 blocks:  53
3 blocks:  12                 <- MAX_EVIDENCE_CONCEPTS
```

Two consequences:

1. **Card height is variable.** Design for 0, 1, 2, and 3 blocks. There is no fixed card.
2. **A card with ZERO evidence blocks is correct.** Those 21 candidates genuinely ranked, and have no
   *research-match* evidence for any concept. **Render nothing** — no placeholder, no empty state, no
   dash. An empty labelled block is a fabrication of relevance, and suppressing precisely that is what
   #1704 was for: before it, all 21 shipped a block captioned with a concept and backed by the
   scholar's self-reported areas.

## 3. Hard constraints. Not style preferences.

- **NO fit meter.** The mockup draws a bar whose width is `fusedScore / topScore`. The fused score is
  deliberately kept out of the DOM and out of the CSV export. Drawing it as a *length* still ships it.
- **NO rarity number, and never the word "common."** `corpusCoverage` is display-only and is **not** in
  the fusion weight — it was deleted from it (#1681/#1698), not merely bounded. The mockup's caption
  *"Rarity (fixed) rewards experts in areas few at WCM cover"* is **FALSE**. Shipping it teaches
  fundraising officers a model of the ranker that does not exist. `absent ≠ zero` also makes "common"
  unsayable: ~40% of descriptors sit at zero coverage, which means *unknown*, not *ubiquitous*.
- **Absent ≠ zero.** Never fabricate a count. The optional fields exist so the route never has to
  invent one.
- **Export is CSV, not `.xlsx`.** The mockup offers both. `lib/csv.ts` documents rejecting ExcelJS, and
  the CSV path carries the OWASP formula-injection guard — **load-bearing, not theoretical: concept
  terms originate in a PASTED SPONSOR EMAIL** and land in a spreadsheet an officer opens.
- **Contact / "Contact selected" / the compose modal (Cc, Bcc, Send): scope OUT.** Email-address
  resolution is a **separate directory lookup**, explicitly outside the ranking contract, and addresses
  must not enter the match payload. Bulk email export is a standing **policy no-go**. This needs its own
  design decision, including what it means to hand a commercial sponsor a list of colleagues'
  addresses. Do not fold it into a reskin.

## 4. The one real open question — answer it before touching pixels

**The mockup is drawn as the PUBLIC Scholars site** (Cornell-red header, serif page title, a white card
per candidate). **`/edit/sponsor-match` is a CONSOLE surface** under the Apollo bar, next to
`/edit/find-researchers`.

A previous pass resolved this in favour of house-console style and kept the console `h1` + list rows.
**Confirm that is still the intent.** It decides most of the work, and it is a product call, not an
implementation detail. Repo policy requires design sign-off on spacing/colour before pixels move.

## 5. Verification — you cannot do this locally

The console is auth-gated (`/edit`). **Verify on STAGING** with a session cookie (Playwright
`context.addCookies`).

If you drive it locally anyway, `.env.local` needs all of these — **without the first two, the evidence
blocks render EMPTY and you will "verify" a page whose feature never ran**:

```
SEARCH_RESULT_EVIDENCE=on          # else searchPeople emits NO evidence at all
SEARCH_EVIDENCE_REASON_COUNTS=on   # else the stacked evidenceLines[] shape is absent
SPONSOR_MATCH=on                   # else the route 404s
SPONSOR_MATCH_SPINE=on             # else you silently drive the BESPOKE engine
DEVELOPMENT_ENABLED=on             # else the route 403s
SCHOLARS_DEVELOPMENT_ALLOWLIST=<cwid>
```

Use `npx next dev -p 3007`, not `npm run dev` — turbopack chokes on a worktree symlink.

## 6. Loose ends inherited from #1696

- **`claimedPmids` release-on-unmount.** `EvidenceLine` only ever *adds* to the shared paper-dedup Set;
  it never releases on unmount. #1704 keyed the Set on the rendered block list, which fixes the
  mute→unmute leak, but the correct fix (~6 lines) belongs **inside `EvidenceLine`** — a component
  shared with the **public People card**, which cannot be visually verified locally. Its own reviewed
  change. Residual today: after a mute/unmute cycle two blocks can briefly offer the same
  representative paper. Cosmetic.
- **Nobody has seen #1696's evidence blocks rendered.** The logic is runtime-verified against the real
  emitter, real OpenSearch and real Bedrock; the **pixels have never been looked at.** That is the
  natural first step here, and it should happen before CTL sees the surface.

## 7. Environment

Worktree `~/worktrees/sps-sponsor-weighting` is warm: `node_modules`, generated Prisma client,
`.env.local` carrying the flags above. Local OpenSearch runs at 4 GiB (`docker-compose.yml`, on master)
with the full corpus — ~8.9k people, ~420k publications. The 1 GiB heap that caused the old
`circuit_breaking_exception` 502 storms is fixed; any handoff still telling you to bump it is stale.
