# Search match reasons & evidence rows

What renders under a person's name / title / department on the People tab of `/search`, and the one contract every "key [thing]" disclosure must obey.

Companion to [`search.md`](./search.md) (how ranking is computed) — this doc is about *why a result says what it says*, not where it ranks.

## The two things

1. **Match reason** — the muted line(s) directly under the identity block explaining *why* this person matched (e.g. "Research area: …", "Concept: …"). It's the `matchReason` field on each search hit, rendered by `MatchReason` (`components/search/match-reason.tsx`). Shaped server-side by `selectEvidence()` in `lib/api/result-evidence.ts`.

2. **Evidence rows** — the richer, badged disclosures below the match reason: **KEY PAPERS**, **KEY METHODS**, **KEY FUNDING**. Each is a "key [thing]" disclosure (an accordion `DisclosureRow`, hide-when-empty). Gated by the `SEARCH_EVIDENCE_ROWS` flag.

> Vocabulary: "the match reason" = the top why-matched line; "evidence rows" = the badged KEY-* disclosures. The whole stack = match reason + evidence rows.

## Match reason line

`MatchReasonKind = "concept" | "publications" | "area"` picks the leading icon. When `badged`, a `PubFlavor` pill sets the label/color (`FLAVOR_BADGE`, `match-reason.tsx`):

| flavor | label | meaning |
|---|---|---|
| `area` | **Research area** | topic-taxonomy assignment (the `areasOfInterest` slugs — see [`data-dictionary`](./data-dictionary.md)) |
| `concept` | **Concept** | expanded MeSH concept match (#1337 relabeled the former "tagged") |
| `keyword` | **Keyword** | literal mention |

## Evidence rows — the three disclosures

Flag: `SEARCH_EVIDENCE_ROWS` (`resolveSearchEvidenceRows`, `lib/api/search-flags.ts`). Env state: **staging `on`, prod `off`** (`cdk/lib/app-stack.ts` — `env === "staging" ? "on" : "off"`). Off ⇒ the fetchers return empty and the rows never render, so prod is inert and the routes can't be probed for data early.

| Disclosure | Fetch | Query it matches on | Admission |
|---|---|---|---|
| **KEY PAPERS** | `/api/search/key-paper` → `fetchKeyPaper` (`lib/api/search.ts`) | `keyPaperConfig.contentQuery` — **generic-stripped** | `multi_match operator:"and"` (all significant tokens) |
| **KEY METHODS** | `/api/scholar/[cwid]/method-exemplar` | resolved `family=`/`topic=` **id** (raw `q` is order-only) | id match — not token-susceptible |
| **KEY FUNDING** | `/api/scholar/[cwid]/grants` → `searchFunding` | `contentQuery` — **generic-stripped** (#1339) | `multi_match operator:"or"` |

Each renders only when ≥1 item comes back (**hide-when-empty**): the card gates on `qParam` + `grantCount`/`keyPapers.length` and omits the row otherwise (`components/search/people-result-card.tsx`). A disclosure fetch must never 500 — it returns a default-safe empty instead.

## The contract (#692 / #707 / #1339)

**Every "key [thing]" disclosure must match on the generic-stripped *significant* query — the `contentQuery` from `stripDeprioritized()` (`lib/api/deprioritized-terms.ts`) — never the raw `q`.**

Why: `searchFunding`/`fetchKeyPaper` admit on academic-common terms ("health", "research", "disease" — all in `data/search/deprioritized-terms.json`). On a raw OR match, `q="children's health"` admits grants/papers on **"health" alone**, surfacing off-topic results for scholars who match "children" zero times. The route computes `contentQuery` **once per search** (`app/api/search/route.ts:89`, `stripDeprioritized(q)`) and threads it in.

- `stripDeprioritized` has a **never-empty contract**: a fully-generic query ("health") falls back to itself, so a `contentQuery` is always non-empty when `q` is. KEY PAPERS and KEY FUNDING behave identically here.
- KEY METHODS is exempt — it keys on a resolved concept **id**, so raw `q` only affects ordering, never admission.

**Adding a new "key [thing]" disclosure?** It MUST consume `contentQuery`, not raw `q`. This is exactly the bug #1339 fixed for KEY FUNDING (it had been matching raw `q`); KEY PAPERS is the reference implementation to copy.

## Code map

- `components/search/match-reason.tsx` — `MatchReason`, `DisclosureRow`, badge/flavor logic, evidence-row margins.
- `lib/api/result-evidence.ts` — `EvidencePub`, `EvidenceGrant`, `ResultEvidence`, `selectEvidence()`, caps (`AREAS_CAP`).
- `app/api/search/key-paper/route.ts` + `fetchKeyPaper` (`lib/api/search.ts`) — KEY PAPERS.
- `app/api/scholar/[cwid]/method-exemplar/route.ts` — KEY METHODS.
- `app/api/scholar/[cwid]/grants/route.ts` — KEY FUNDING.
- `lib/api/deprioritized-terms.ts` — `stripDeprioritized` (the contract).

## How to verify

Evidence rows are flag-on in **staging** (prod-dark), so verify there — the API is public-from-WCM, no SSO:

```bash
B=https://scholars-staging.weill.cornell.edu
# KEY FUNDING significant-query contract (#1339): "children's health" must match
# "children", not "health" (row hides when no significant-token grant matches).
for q in "children's health" children health; do
  curl -4 -s -G "$B/api/scholar/cjg7003/grants" --data-urlencode "q=$q" \
    | jq -r --arg q "$q" '"q=\"\($q)\" total=\(.total)"'
done
```

> **Local caveat:** the local search index predates the evidence-row enrichment fields (`topMeshTerms`, `meshSubtreeCounts` are empty locally; `publicationMeshUi` is thin), and the local DB schema is behind master — so the **rendering** of these rows (reason lines, TOPICS hint) is unreliable locally and can't be rebuilt from the local DB. Tune ranking locally; verify evidence-row display on staging. See [`search.md`](./search.md).
