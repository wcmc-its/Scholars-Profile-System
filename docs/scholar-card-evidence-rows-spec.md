# Spec — Generalized evidence rows on the scholar search card (incl. Funding)

Status: DRAFT — §7 decisions RESOLVED 2026-06-28, ready for implementation sign-off. No code written. Mocks in
`…/scratchpad/{grants-funding-badge,grants-stacked-vs-inline,evidence-catalog,generalized-evidence,row-order}.html`
(served on `:8814` during the design session).

All code references grounded against `origin/master` (working tree is ~342 commits behind).
All data figures verified live against staging (`scholars-staging.weill.cornell.edu`, search API is public/no-SSO) on 2026-06-28.

---

## 1. Goal

Two requests started this:
1. Surface a scholar's topic-matching **grants** on the search card.
2. Generalize the existing "key papers" disclosure (already on Research-area / Concept matches) into one pattern.

The design collapses both into a single component: every "why this scholar matched" row is
**`[type badge] claim ⌄ → key records`**, where the record type is papers / grants / trials by axis.
Funding stops being a special case — it's just an axis whose records are grants.

Non-goal restated explicitly in §8.

---

## 2. Current state (grounded)

- **`components/search/match-reason.tsx`** — already has:
  - `MatchBadge` with three kinds: `method` (rust `#fbf4ea`/`#8a4a1f`, Wrench), `clinical` (teal `#e8f4f8`/`#1a5f7a`, Stethoscope), `topic`→"Research area" (blue `#eef2f6`/`#2c4f6e`, Shapes). Colors are literal in that file.
  - `DisclosureRow` — the accessible chevron toggle (native `<button>`, `aria-expanded`, `aria-controls`) used by the publications "key papers" disclosure.
  - `MatchReasonKind = "concept" | "publications" | "area"` (muted leading icons: Waypoints / FileText / Shapes).
- **`lib/api/result-evidence.ts`** — `ResultEvidence` union: `method {family, tools[]}`, `clinical {specialty, boardCertified}`, `topic {label,id}`, `publications {strength: "tagged"|"mention"|"concept", text, pubs[]}`, `concepts {items[]}`, `areas {labels[]}`, plus funding stubs `fundingRole` / `awardAmount`. `selectEvidence()` returns exactly **one** per card by a fixed precedence.
- **`components/ui/entity-badge.tsx` + `app/globals.css`** — 7-hue entity palette. No funding hue, no clinical-specialty list field.
- **Funding** lives in a **separate** `scholars-funding` index (`lib/api/search-funding.ts`). Per-scholar reachable via the `wcmInvestigatorCwids` keyword array (`lib/search.ts` `fundingIndexMapping`). Match is text/keyword: `title^4 · sponsorText^2 · peopleNames^1 · abstract^1 · keywordsText^1` (MeSH only an optional flagged OR-boost — **not** the base mechanism).
- **`app/api/scholar/[cwid]/method-exemplar/route.ts`** — existing lazy "key papers" fetcher; the template for new fetchers.
- **`etl/clinical-trials/{export,import}.ts`** — clinical-trials ETL is built; per-scholar trials live in `clinical_trial` + `person_clinical_trial`. Not yet on the search hit or any read API.

---

## 3. Data reality (the acceptance test — drove the design)

Measured live, 2026-06-28:

- **Funding precision: good.** For "cardiology", 10 of 11 un-flagged matches were genuinely cardiovascular; 1 stray (an NSF methods grant via funded-pubs). Top scholar's panel (Goyal) all on-topic.
- **Funding volume: sparse — the binding constraint.** Per-scholar **median = 1 matching grant for every topic tested** (cardiology, cancer, diabetes, immunotherapy, machine learning, alzheimer's). Cardiology: only 45 of 202 result scholars have *any* matching grant; **35 of those 45 have exactly one**. ⇒ ~78% of cards show **no** grant row; most of the rest show **one**.

Consequences baked into the design below: **always a dropdown** (even for 1), **hide row when zero**, **no eager "X of Y" count** on the search hot path.

---

## 4. Design

### 4.1 The `EvidenceRow` component

One component replaces the per-axis treatments.

```
EvidenceRow({
  kind,          // 'method' | 'publications' | 'clinical' | 'funding'  (badge + record type)
  flavor,        // publications only: 'area' | 'concept' | 'keyword'   (picks the badge)
  claim,         // pre-built string, e.g. "30 publications tagged Cardiology"
  fetchRecords,  // () => Promise<Record[]>, lazy on first expand
})
```

- Renders `[badge] claim` as a `DisclosureRow` (reuse existing) with a trailing chevron.
- Expands to a panel of **key records**; records are papers / grants / trials depending on `kind`.
- **Always** expandable (settles the "always a dropdown, even for one" decision).
- Caller omits the row entirely when there's no match (hide-when-empty; never render "0 of N").

### 4.2 Badge family — extend by exactly one

Reuse `match-reason.tsx`'s `MatchBadge`. Add **one** kind:

| kind | bg / ink | icon | label | status |
|---|---|---|---|---|
| method | `#fbf4ea` / `#8a4a1f` | Wrench | Method | exists |
| clinical | `#e8f4f8` / `#1a5f7a` | Stethoscope | Clinical | exists |
| area (Research area) | `#eef2f6` / `#2c4f6e` | Shapes | Research area | exists |
| concept | `#e6e8f7` / `#34408a` | Waypoints | Concept | exists (as muted; promote to badge) |
| keyword | `#f4f4f5` / `#52525b` | message/quote | Keyword | **new marker** |
| **funding** | **`#eef6ef` / `#2f6b3a`** | **Banknote** | **Funding** | **new — pending WCAG-AA check** |

Banknote chosen over Landmark (Landmark collides with `Building2` = org units). Green is the only warm-distinct family not already taken.

### 4.3 Per-axis table

| Row | Badge | Claim source | Record type | Fetcher | Build? |
|---|---|---|---|---|---|
| Publications | area / concept / keyword (by strength) | `evidence.publications` | papers | existing top_hits / rep-papers | — |
| Method | Method | `evidence.method {family, tools[]}` | papers | `/api/scholar/[cwid]/method-exemplar` | — |
| Clinical | Clinical | `evidence.clinical {specialty, boardCertified}` | **clinical trials** | **NEW** `/api/scholar/[cwid]/trials` over `person_clinical_trial` | yes |
| Funding | **Funding** | `searchFunding` + `term wcmInvestigatorCwids=cwid` | grants | **NEW** `/api/scholar/[cwid]/grants?q=…` (lazy) | yes |

### 4.4 Row order — fixed precedence, hide-when-empty

Top→bottom: **Publications → Method → Clinical → Funding.** *(RESOLVED §7.1.)*
- **Publications first** — intentionally diverges from `selectEvidence`'s `method`-first order. That precedence was tuned for *picking one* evidence (most-specific wins); for *ordering a stack* the near-universal, primary signal leads, giving a stable scan (the first row is almost always Publications).
- Method then Clinical follow.
- Funding placed last by the **sparse-rows-last** rule (it toggles off on ~78% of cards; anchoring it at the bottom edge means its appear/disappear never punches a hole mid-stack).
- A real card shows the subset that applies, in this order — **never all four**.

### 4.5 Publications row — one row, flavor by precedence

A scholar can match a query several ways at once, but the records are the **same papers**. Show **one** row; pick the flavor badge by precedence (mirrors `selectEvidence`, avoids overlapping double-counts):

`Research area (canonical topic tag) > Concept (expanded MeSH) > Keyword (literal mention)`

The **Scope** toggle ("Exact word · Word + concepts · Concept only") constrains which flavors are eligible; within the active pool, strongest wins.

**Text treatments (the keyword-vs-concept distinction):**
- Keyword: literal query in quotes — `… publications mention "Computational pathology"`.
- Concept: expanded MeSH descriptor in **concept-indigo + dotted underline** (it's the system's term, not the user's words) — `… tagged `*Image Interpretation, Computer-Assisted*.
- Research area: canonical topic, plain — `… tagged Cardiology`.

### 4.6 Consistency rules (resolve the row-2 inconsistencies)

- **Every row is badge-led**, count+what form. (Publications was the lone non-badged row.) Badging the pub row is scoped to the **Scholars result card only** — see §4.7.
- **Keep the "of Y" denominator — Publications only.** "30 of 757 publications tagged Cardiology". *(RESOLVED §7.2.)* The ratio is a real topic-centrality signal where denominators are large (2/500 vs 93/173); other axes have no meaningful denominator (method/clinical) or tiny ones (funding) and stay count-only. The genuine inconsistency was the missing badge (now fixed); the denominator is a pub-specific enrichment, not noise. Keeps shipped behavior unchanged.
- Record-panel meta (role, sponsor, year, PMID) is **muted, normal weight** — e.g. "Principal Investigator · NIH / NIA" is not bold.

### 4.7 Pub-row badge scope (Scholars card only)

`MatchReason` is shared across People / Publications / Funding result rows. Badging it globally is a large, risky diff to a shipped, high-traffic element. **Scope the flavor badge to the Scholars result card** (where the multi-axis stack lives and consistency matters) via an opt-in prop; the Publications tab and other surfaces keep the muted FileText row unchanged. *(RESOLVED §7.6.)*

---

## 5. Edge cases

| Case | Behavior |
|---|---|
| Scholar matches multiple pub flavors | Strongest only (area > concept > keyword); one row. |
| Grants exist but none match the topic | Funding row hidden entirely. Never "0 of N". |
| Exactly one matching grant | Still a dropdown (badge differentiates; chevron reveals the one record). |
| Clinical specialty present, no trials | Row renders (specialty + board-cert is a valid claim); **chevron omitted** when trial-count is 0. No empty-panel state. Requires a cheap per-scholar trial-count field (see §6). *(RESOLVED §7.5.)* |
| Concept expansion term == query | Plain text, no indigo treatment (only differs-from-query terms get it). |
| Funding/trials fetch fails or times out | Row still renders the claim; panel shows a quiet retry/error, never blocks the card. |

---

## 6. New vs existing work

- **New:** Funding badge kind; `/grants` lazy fetcher (reuse `searchFunding` + cwid term); `/trials` lazy fetcher over `person_clinical_trial`; **per-scholar trial-count field** on the people hit (cheap int, like `grantCount`) to gate the Clinical chevron (§7.5); `EvidenceRow` generalization; keyword/concept badge markers + text treatment; opt-in `badged` prop on the pub row for the Scholars card (§4.7).
- **Existing (reuse):** `DisclosureRow`, `MatchBadge` (method/clinical/area), `method-exemplar`, `result-evidence` model, pub rep-papers, `grantCount`/`hasActiveGrants` projection pattern.

---

## 7. Decisions — RESOLVED 2026-06-28

1. **Order: Publications → Method → Clinical → Funding.** Publications first (stability + primary signal); intentionally diverges from `selectEvidence`'s single-pick `method`-first order. See §4.4.
2. **Keep "of Y" — Publications only.** Real centrality signal where denominators are large; other axes count-only. The badge fix resolved the actual inconsistency; no shipped-behavior change. See §4.6.
3. **No row cap.** Hide-when-empty bounds it (realistic max ~3); a cap + "+more" is speculative. Revisit only if real cards prove too tall.
4. **Funding = green `#eef6ef`/`#2f6b3a` + Banknote.** Confirmed. WCAG-AA at 10px is a build gate (§9) — darken the ink if it fails; not a design re-open.
5. **Clinical: chevron only when trial-count ≥ 1.** Claim always renders; proof is gated, no empty-panel. Adds a cheap trial-count field (§6).
6. **Pub-row badge scoped to the Scholars result card** via opt-in prop; other surfaces unchanged. See §4.7.

---

## 8. Out of scope / explicitly not doing

- **Research Area as a standalone row** — folded into Publications as a flavor (it's the same papers; `areas` is second-from-last in `selectEvidence`; broad areas already render as the page-top pills).
- **Eager per-card grant count** ("X of 32") — needs a cross-index funding agg on the search hot path for a low-value number (p50=1). Skipped; lazy-load on expand instead.
- **Relevance-sort changes** — grants already feed a small prominence term (`PEOPLE_PROMINENCE_GRANT_WEIGHT`, `0.5·log1p(grantCount)`). Leave untouched; adding more general-grant weight is off-axis (boosts prominence, not topic fit).
- **Grant topic-tagging upstream** — not needed; the funding text matcher already supplies on-topic results.

---

## 9. Verification gates (before "done")

- WCAG-AA contrast check on the Funding hue (the other badges already pass).
- Funding-match precision spot-check across p50/p10 scholars for 2–3 more topics (cardiology already passed).
- `vitest` for the new `EvidenceRow`, the two new fetchers, and the flavor-precedence selection (per the run-vitest-before-push rule; tsc alone won't catch rendered-order regressions).
- Confirm `person_clinical_trial` is populated in the target env before shipping the Clinical→trials row.
