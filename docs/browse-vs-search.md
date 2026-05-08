# Browse vs Search — current state

## Summary

The two browse-style pages have distinct jobs and distinct verbs:

- `/search` — header nav target ("Browse"). Query-driven results page; A–Z surname directory shows above the People results when the query is empty.
- `/browse` — "Departments & Centers" hub. Departments list + centers grid. No A–Z. URL retained to avoid redirect churn.

Earlier the app had two pages both calling themselves "Browse." The A–Z directory previously sat on `/browse` even though its job — "find a person by surname" — is a search affordance. This document records the split and the rationale.

---

## `/browse` today

**File:** `app/(public)/browse/page.tsx`
**Page title:** "Departments & Centers — Scholars at WCM"
**H1:** "Departments & Centers"
**Breadcrumb:** Home › Departments & Centers

**Sections (in order):**
1. **Anchor strip** (`components/browse/browse-anchor-strip.tsx`) — two in-page anchors (Departments, Centers & Institutes) plus a subordinate cross-link "Or browse by research area →" that targets `/#research-areas`.
2. **Departments** (`components/browse/departments-grid.tsx`) — compact single-column expandable list, grouped by category (Clinical, Basic Science, Basic & Clinical, Administrative). Each row collapses to name + chair + counts; expanding reveals division and topic chips plus a "View {dept} →" link. (Issue #22 will flatten the four-category grouping into a single sortable/filterable list with type badges per card; tracked separately.)
3. **Centers & Institutes** (`components/browse/centers-grid.tsx`) — 2-column card grid. Each card shows name, description, and director (when present).

**Data:** `getBrowseData()` (`lib/api/browse.ts`) returns `{ departments, departmentsByCategory, centers }`. `getAZBuckets()` is exported separately and consumed by `/search`.

**Inbound links to `/browse`:**
- Global header "Browse" link no longer points here — it now targets `/search`. The `/browse` URL is reachable via the cross-link from `/search`'s empty People state and via contextual back-links from topic / division / center / department pages and the home-page research carousel.

---

## `/search` today

**File:** `app/(public)/search/page.tsx`
**Page title:** Default ("Scholars @ Weill Cornell Medicine")
**H1:** **"Browse scholars"** when `q=""`, otherwise `Results for "{q}"`
**Robots:** `noindex, follow` — non-canonical
**Render:** `force-dynamic` — every request renders fresh, no ISR

**Tabs:** `?type=people` (default) | `?type=publications`

**People tab UI:**
- When `q=""`: an A–Z directory strip renders between the tabs and the results grid, with a subordinate "Or browse departments & centers →" link beneath it. Once the user types, the strip and cross-link hide.
- Left sidebar: **Sort** (Relevance, Last name A–Z, Most recent publication) and **Department** facet list with counts.
- Main column: paginated people list (20 per page) using `PeopleResultCard`. Each card shows headshot, name, primary title, primary department, and an "Active grants" badge if applicable.

**Publications tab UI:**
- Default sort flips from Relevance to Year (newest first) when `q=""` — Relevance is meaningless without a query.
- Left sidebar: **Sort** (Relevance, Most recent, Citation count) and Department / Year facets.
- Main column: paginated publication list with author chips.

**Data:** `lib/api/search.ts` exposes `searchPeople` and `searchPublications` against OpenSearch. `getAZBuckets()` from `lib/api/browse.ts` is called only when `q="" && type="people"`. The empty-query state shows all active scholars, paginated.

---

## Why the split

1. **One verb per page.** The global "Browse" link goes to `/search`. `/browse` calls itself "Departments & Centers." No more two pages claiming the same word.
2. **A–Z lives where searching lives.** Finding a person by surname is the same job a search query does. The strip now sits on `/search`'s empty People state, where the search box is right there if surname browsing isn't enough.
3. **Reciprocal cross-links.** `/browse` has "Or browse by research area →"; `/search` empty-People has "Or browse departments & centers →". A user landing on either page can see a path to the other.
4. **A–Z deep-links into `/search` already.** "View all N scholars starting with M" goes to `/search?q=M&tab=people`. The directory was already a router into search; co-locating it removes the mid-page hop.

---

## Non-goals (explicitly deferred)

- Promoting "letter" to a real combinable filter param on `/search` (combines with dept facet, alters API). Larger surgery — left for a follow-up if needed.
- Redirecting `/browse` → `/departments-and-centers` URL. Not changing the URL for now.
- Issue #22's department-list rework (flatten four-category grouping, type badges, type filter, sort by name/count). Tracked separately; this restructure is purely the navigation/affordance split.
