# Browse vs Search — current state and agreed direction

## Summary

The app has two pages that currently overlap in branding and partially in function:

- `/browse` — header nav target ("Browse"). Currently a hub of three sections: Departments, Centers & Institutes, and an A–Z Directory of scholars.
- `/search` — query-driven results page. H1 says **"Browse scholars"** when no query is present, with two tabs (People / Publications), filter rail, and sort options.

Both pages call themselves "Browse." The A–Z Directory on `/browse` is a people-finding affordance that conceptually belongs with `/search`. The agreed direction is to give the two pages distinct verbs and reduce the overlap.

---

## `/browse` today

**File:** `app/(public)/browse/page.tsx`
**Page title:** "Browse Scholars — Scholars at WCM"
**H1:** "Browse Scholars"
**Breadcrumb:** Home › Browse

**Sections (in order):**
1. **Anchor strip** (`components/browse/browse-anchor-strip.tsx`) — three in-page anchors (Departments, Centers & Institutes, A–Z Directory) plus a subordinate cross-link "Or browse by research area →" that targets `/#research-areas`.
2. **Departments** (`components/browse/departments-grid.tsx`) — compact single-column expandable list, grouped by category (Clinical, Basic Science, Basic & Clinical, Administrative). Each row collapses to name + chair + counts; expanding reveals division and topic chips plus a "View {dept} →" link.
3. **Centers & Institutes** (`components/browse/centers-grid.tsx`) — 2-column card grid. Each card shows name, description, and director (when present).
4. **A–Z Directory** (`components/browse/az-directory.tsx`) — a strip of 26 letter pills (A–Z) with click-to-expand inline behavior. Clicking a letter reveals up to 10 scholars whose surname starts with that letter, plus a "View all N scholars" link to `/search?q={letter}&tab=people`.

**Data:** all five sections consume a single `getBrowseData()` call (`lib/api/browse.ts`) that returns `BrowseData` with departments, centers, and pre-bucketed A–Z buckets.

**Inbound links to `/browse`:**
- `components/site/header.tsx:38` — global "Browse" link
- `app/(public)/topics/[slug]/page.tsx`, `components/division/division-page.tsx`, `components/center/center-page.tsx`, `components/department/department-page.tsx`, `components/home/selected-research-carousel.tsx`, `components/browse/{departments-grid,centers-grid}.tsx` — breadcrumbs and contextual back-links

---

## `/search` today

**File:** `app/(public)/search/page.tsx`
**Page title:** Default ("Scholars @ Weill Cornell Medicine")
**H1:** **"Browse scholars"** when `q=""`, otherwise `Results for "{q}"`
**Robots:** `noindex, follow` — non-canonical
**Render:** `force-dynamic` — every request renders fresh, no ISR

**Tabs:** `?tab=people` (default) | `?tab=publications`

**People tab UI:**
- Left sidebar: **Sort** (Relevance, Last name A–Z, Most recent publication) and **Department** facet list with counts.
- Main column: paginated people list (20 per page) using `PeopleResultCard`. Each card shows headshot, name, primary title, primary department, and an "Active grants" badge if applicable.

**Publications tab UI:**
- Left sidebar: **Sort** (Relevance, Most recent, Citation count) and Department / Year facets.
- Main column: paginated publication list with author chips.

**Data:** `lib/api/search.ts` exposes `searchPeople` and `searchPublications` against OpenSearch. The empty-query state shows all active scholars, paginated.

---

## Where the overlap is

1. **Both pages use the verb "Browse"** in their H1 / nav target. A user clicking the global "Browse" link arrives at `/browse`; the empty-query `/search` independently calls itself "Browse scholars."
2. **A–Z is on `/browse` but is a search affordance.** The A–Z Directory's job ("find a person by surname") is the same job `/search` does with a query or a Last-name sort. It sits awkwardly next to Departments and Centers, which are about institutional structure.
3. **Cross-links partially exist.** `/browse` has a subordinate "Or browse by research area →" link out to `/#research-areas`. `/search` has no equivalent cross-link to `/browse`. The asymmetry means once a user lands on `/search`, the org-structure browse path is invisible.
4. **A–Z buckets already deep-link into `/search`** ("View all N scholars with last name starting with M" → `/search?q=M&tab=people`). So the A–Z directory is effectively a router into `/search`, which reinforces that it belongs on `/search` directly.

---

## Agreed direction

Two pages, two verbs, clearly distinct jobs:

| Page | URL | Job | Primary affordance |
|---|---|---|---|
| **Browse** (header link) | `/search` | Find a scholar or publication | Search box + filters; A–Z strip when query is empty |
| **Departments & Centers** | `/browse` | Explore the org structure | Compact list of departments + centers |

### Changes to `/browse`
- **Page title:** "Departments & Centers — Scholars at WCM"
- **H1:** "Departments & Centers"
- **Breadcrumb:** Home › Departments & Centers
- **Anchor strip:** drops A–Z anchor; just Departments + Centers
- **Sections:** drops `<AZDirectory>` entirely; data fetch (`getBrowseData()`) drops `azBuckets`
- **Keeps:** "Or browse by research area →" subordinate link

### Changes to `/search` (People tab)
- When `q=""` and `tab=people`: render the A–Z directory above the results, plus a subordinate link **"Or browse departments & centers →"** mirroring the symmetry of `/browse`'s research-areas cross-link.
- Once the user types a query, A–Z and the cross-link hide; results render as today.
- Open: H1 stays "Browse scholars" or simplified to "Browse" — leaning keep.

### Header nav
- "Browse" link target changes from `/browse` to `/search`. Label unchanged.
- `/browse` URL stays (avoid redirect churn); reachable via the cross-link from `/search`'s empty People tab and via existing direct/inbound links.

### Non-goals (explicitly deferred)
- Promoting "letter" to a real combinable filter param on `/search` (combines with dept facet, alters API). Larger surgery — left for a follow-up if needed.
- Redirecting `/browse` → `/departments-and-centers` URL. Not changing the URL for now.
