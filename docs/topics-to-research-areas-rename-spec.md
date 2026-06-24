# Spec: rename the `/topics` route to `/research-areas`

Issue: #1256. Status: **proposal — review the open questions in §7 before implementing.**

## 1. Problem

The URL path still says `/topics` while every user-facing surface says "Research
areas":

- `scholars.weill.cornell.edu/topics/aging_geroscience`
- breadcrumb: `Home › Research areas › Aging & Geroscience`
- page eyebrow: `RESEARCH AREA`

The "Topics → Research areas/subareas" copy rename already shipped (PRs
#1061/#1063/#1065). The route path is the last inconsistency. This spec covers
renaming it without breaking inbound links or SEO.

## 2. Decision

- **New path: `/research-areas`.** It matches the breadcrumb label "Research
  areas" exactly and the existing home anchor `#browse-all-research-areas`.
  `/areas` was considered and rejected as ambiguous (reads as geography).
- **`?subtopic=` query param → `?subarea=`** is split into a separate, optional
  Phase 2 (§5) with backward-compatible reads, so the route rename can ship
  without a second moving part.
- **Internal code identifiers stay `topic`/`subtopic`.** This is a *URL* rename
  only; route folder names, function names, and the Prisma schema keep their
  existing identifiers (consistent with the prior copy rename, which left
  internal `topic`/`subtopic` in place by design). Only the public path string
  changes.

## 3. Blast radius

73 files reference `/topics`, `/api/topics`, or `?subtopic=` on `master`.
Grouped:

### 3.1 Routes to move (5)
- `app/(public)/topics/[slug]/page.tsx`
- `app/(public)/topics/[slug]/scholars/page.tsx`
- `app/(public)/topics/[slug]/scholars/loading.tsx`
- `app/api/topics/[slug]/publications/route.ts`
- `app/api/topics/[slug]/subtopics/[subtopicId]/scholars/route.ts`

→ move the `topics` segment to `research-areas` (public) and `api/topics` →
`api/research-areas`.

### 3.2 Internal link/URL builders (~28 source files)
Page links and `fetch()` URLs that hardcode `/topics/…` or `/api/topics/…`,
including: `components/home/{browse-all-research-areas-grid,subtopic-card,spotlight-section}.tsx`,
`components/{center,department,division}/…-page.tsx`,
`components/browse/departments-grid.tsx`,
`components/publication/publication-modal.tsx`,
`components/topic/{publication-feed,subtopic-scholars-row,top-scholars-chip-row,topic-all-scholars}.tsx`,
`lib/api/{topics,search,search-taxonomy,spotlight}.ts`,
`app/llms.txt/route.ts`.

### 3.3 SEO / canonical / sitemap
- `app/(public)/topics/[slug]/page.tsx:39` and `…/scholars/page.tsx` — `alternates.canonical`
- `lib/sitemap.ts:113` — `url: ${base}/topics/${t.id}`
- `lib/seo/jsonld.ts` — `buildDefinedTermJsonLd` `@id`
- `app/llms.txt/route.ts:74` — the LLM index link shape

### 3.4 Routing / auth / revalidation
- `lib/auth/return-path.ts` — safe-return-path allowlist must accept the new path
- `lib/revalidate-allowlist.ts` — ISR revalidation allowlist
- `app/api/revalidate/route.ts` — doc comment referencing `/topics/{slug}`

### 3.5 CDN (CloudFront) — `cdk/lib/edge-stack.ts`
Two cache behaviors key on the path and must be **added for the new path**
(keep the old patterns alive for the redirect window):
- L527 `"/api/topics/*/publications"`
- L642 `"/topics/*/scholars"`

⚠️ **Known edge-stack gotcha** (from the funding-matcher work): the edge stack
has a route-coverage guard plus an ordered behavior/IPSet count ratchet. Adding
behaviors trips it — bump the count/order ratchet and run `npx jest edge-stack -u`
to refresh the CFN snapshot, or `cdk synth` fails CI.

### 3.6 `?subtopic=` producers (6 source, 2 docs) — Phase 2 only
`components/home/{spotlight-section,subtopic-card}.tsx`,
`components/publication/publication-modal.tsx`,
`components/topic/subtopic-publication-layout.tsx`,
`lib/api/{search,spotlight}.ts`; docs in `OPERATIONS-RUNBOOK.md`,
`spotlight-runbook.md`.

### 3.7 Tests (18 files)
`tests/e2e/{seo-metadata,topic-detail,topic-placeholder}.spec.ts`,
`tests/unit/{auth-return-path,revalidate-allowlist,revalidate-route,search-taxonomy,topic-publications-route,sitemap,jsonld,research-areas-row,feedback-page-route,publication-feed-tiers,vivo-404-telemetry}.test.*`,
plus `cdk/test/edge-stack.test.ts` (+ snapshot).

### 3.8 Docs
`docs/ADR-007-csp-script-src-strategy.md`, `docs/OPERATIONS-RUNBOOK.md`,
`docs/spotlight-runbook.md`.

## 4. Redirects (mandatory)

Old URLs are bookmarked, shared, indexed, and emailed. A **permanent redirect
must ship with the rename and be kept indefinitely.**

Add to `next.config.ts` `redirects()` (`permanent: true` → HTTP 308, which
Google treats as a 301 for link-equity):

```
/topics/:slug                          → /research-areas/:slug
/topics/:slug/scholars                 → /research-areas/:slug/scholars
/api/topics/:slug/publications         → /api/research-areas/:slug/publications
/api/topics/:slug/subtopics/:sid/scholars → /api/research-areas/:slug/subtopics/:sid/scholars
```

Query strings (incl. `?subtopic=`) are preserved by Next redirects automatically.

The CloudFront behaviors for the OLD patterns (§3.5) stay in place so the
redirect itself is served/cached at the edge; they are not removed.

## 5. Phasing

**Phase 1 — route rename + redirects (one PR).** §3.1–§3.5, §3.7, §3.8. No flag:
the redirect layer makes old links keep working, so there is no dark/period
state to gate. Ship, then:
1. Re-submit the sitemap in Google Search Console (it now emits new URLs).
2. Watch 404 logs for any missed `/topics/` reference for one deploy cycle.

**Phase 2 — `?subtopic=` → `?subarea=` (optional, separate PR).** §3.6. Update
producers to emit `?subarea=`; make the consumer accept **both** `subarea` and
`subtopic` for one release so existing redirected links keep resolving. Lower
priority; purely cosmetic.

## 6. Test plan

- Update the 18 test files' `/topics/` assertions to `/research-areas/`.
- Add redirect tests: `GET /topics/<slug>` → 308 `/research-areas/<slug>` (+ the
  scholars and api variants).
- Keep one regression test asserting an old `/topics/<slug>` link still resolves
  (via redirect) so the redirect can't be silently dropped later.
- `npx jest edge-stack -u` after the CDN behavior change (§3.5 gotcha).
- e2e: `tests/e2e/topic-detail.spec.ts` and `seo-metadata.spec.ts` exercise the
  new canonical and a redirect.

## 7. Open questions (decide before implementing)

1. **Path name:** `/research-areas` (recommended) vs `/areas`?
2. **`?subtopic=` rename:** do Phase 2 at all, or leave the param as
   `?subtopic=` indefinitely (internal-identifier consistency argument)?
3. **Redirect code:** Next `permanent: true` (308) is simplest; if a literal 301
   is required for a downstream tool, it needs middleware instead of
   `next.config` redirects. Any reason to prefer 301?
4. **Scope of the API redirect:** `/api/topics/*` callers are all internal and
   updated in Phase 1, so the API redirect is belt-and-suspenders. Keep it, or
   skip it to avoid extra edge behaviors/ratchet churn?

## 8. Estimate

~150–200 line changes across ~80 files, mostly mechanical find/replace, plus the
redirect block, the CDN behavior additions (+ ratchet/snapshot), and the test
updates. One Phase-1 PR; Phase 2 is a small follow-up.
