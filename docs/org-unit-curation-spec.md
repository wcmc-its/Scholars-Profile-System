# Org-Unit Curation: official/compact names, leadership, and the comms data update

**Status:** Implemented (this branch). Data backfill is a gated operational step.
**Date:** 2026-06-12
**Driver:** Head of Communications feedback on departments, centers, and institutes.

---

## 1. Objective

1. **Data-model change** — give departments and centers a distinct **official name**
   (ceremonial, e.g. "Samuel J. Wood Library") and **compact name** (short/common,
   e.g. "Library"), and use each in the right place.
2. **Apply the comms data update** — renames, additions, removals, directors,
   chairs, and label corrections.
3. **Protect staging.** Staging is authoritative *for now* (will move later).
   Nothing here is clobbered by an ETL re-run, and the curated truth lives in
   version-controlled files so prod is aligned from the repo later.

---

## 2. Data model

Two nullable columns added to `department` AND `center`
(`migration 20260612140000_org_unit_official_compact_names`):
`official_name`, `compact_name`. Resolution helpers in `lib/org-unit-names.ts`:

- `officialUnitName(u) = u.officialName ?? u.name` — full surfaces.
- `compactUnitName(u) = u.compactName ?? u.officialName ?? u.name` — facet chips.

**ED-preserving contract:** the ED ETL writes only `name`/`slug` on UPDATE; it
seeds `officialName`/`compactName` on CREATE (from `lib/department-names.ts`) but
**never** writes them on UPDATE. So curated renames survive every refresh — no
ETL-logic change beyond the CREATE seed.

- **Departments** are ED-sourced — `name` stays the raw ED name; `officialName`
  carries the ceremonial rename. Both curated columns used.
- **Centers** are manually-owned — `name` already IS the official name (renames
  update `name` directly), so `officialName` stays NULL and `compactName` carries
  the short facet label.

No reindex: search keys on stable codes; names resolve at query time.

---

## 3. Where each name is used (implemented)

| Surface | Name | File |
|---|---|---|
| Department page H1 / breadcrumb / JSON-LD | official | `components/department/department-page.tsx` + `lib/api/departments.ts` |
| Browse departments grid (rows, filter, sort) | official | `components/browse/departments-grid.tsx` + `lib/api/browse.ts` |
| Profile affiliation | official (falls back to `primaryDepartment`) | `components/profile/profile-view.tsx` + `lib/api/profile.ts` |
| People-search facet chips (centers) | compact | `app/(public)/search/page.tsx` (`resolveDeptDivLabels`) |
| Center page heading / browse cards / autocomplete | official (= `center.name`) | unchanged — `name` already holds it |
| Center-roster org-unit facet / search result dept line | ED `name` (compact-equivalent) | unchanged — index-sourced |
| Dept category badge | n/a (separate `category` label) | unchanged |

Browse filter now matches official + ED + compact forms; browse sort orders by the
displayed (official) name so order matches the visible labels.

**Deferred (minor):** the `/edit` unit-edit shell still shows the raw ED name for
departments (centers show the official `name`). Low-value; can follow up.

---

## 4. Why department chairs weren't nailed by the ETL

D-03 chair detection matches the appointment **title** by regex, requiring the
title's `{dept}` to match the department name. Concrete case found on staging:
**Michael G. Stewart's** title *is* "Chair of Otolaryngology", but the department's
ED name is "Otolaryngology **Head and Neck Surgery**" — so the regex misses it and
`chairCwid` stays null. Endowed/acting chairs fail the same way. The durable fix is
the curated `field_override(department, code, leaderCwid)` layer, which the ED chair
phase consults (etl/ed/index.ts:949-959) and which short-circuits the regex
(line 1042). The backfill writes these overrides (and the `chairCwid` column for
immediate display).

---

## 5. The data update (resolved)

### 5a. Centers / institutes (`prisma/center-seed-data.ts` + backfill)

| Code | Official name | Compact | Type | Director (CWID) | Action |
|---|---|---|---|---|---|
| `englander_ipm` | Englander Institute for Precision Medicine | Institute for Precision Medicine | institute | Elemento `ole2001` | +director |
| `meyer_cancer_center` | Sandra and Edward Meyer Cancer Center | Meyer Cancer Center | center | (existing `jdw2002`) | compact only |
| `cardiovascular_ri` | Cardiovascular Research Institute | Cardiovascular Research | institute | Pitt `gep9004` | +director |
| `aging_research` | Center for Aging Research | Aging Research | center | Lachs `mslachs` | +director |
| `health_equity` | Cornell Center for Health Equity | Center for Health Equity | center | Safford `mms9024` | rename +director |
| `inflammation_research` | Jill Roberts Institute for Research in Inflammatory Bowel Disease | Jill Roberts Institute | institute | — | rename + type→institute |
| `computational_biomed` | — | — | — | — | **DELETE** |
| `iris_cantor_womens_health` | — | — | — | — | **DELETE** |
| `drukier_childrens_health` | Drukier Institute for Children's Health | Drukier Institute | institute | Pascual `vip2021` | add |
| `weill_metabolic_health` | Weill Center for Metabolic Health | Metabolic Health | center | Alonso `lca4001` | add |
| `global_health` | Center for Global Health | Global Health | center | Fitzgerald `dwf2001` | add |
| `appel_alzheimers` | Appel Alzheimer's Disease Research Institute | Appel Alzheimers Institute | institute | Gan `lig2033` | add |
| `friedman_nutrition` | Friedman Center for Nutrition | Nutrition | center | — (recruiting) | add |

Renamed centers keep their existing slugs (URL stability). New-center descriptions
are conservative placeholders — **comms to refine via `/edit`**.

### 5b. Departments — renames (`lib/department-names.ts`)

| Code | ED name | Official name | Compact | Chair |
|---|---|---|---|---|
| `N1760` | Brain and Mind Research | Feil Family Brain and Mind Research Institute | Brain & Mind Research Institute | Iadecola `coi2001` |
| `N1220` | Dermatology | Englander Institute of Dermatology | Dermatology | (unchanged) |
| `N1932` | Library | Samuel J. Wood Library | Library | (unchanged) |
| `N1280` | Medicine | Weill Department of Medicine | Medicine | (unchanged) |
| `N1360` | Ophthalmology | Englander Department of Ophthalmology | Ophthalmology | (unchanged) |

`N1760` stays a **department** (retains privileges) per comms — slated to move to
Centers/Institutes later.

### 5c. Departments — chairs only (`field_override` + `chairCwid`)

| Code | Department | Chair (CWID) |
|---|---|---|
| `N1400` | Otolaryngology Head and Neck Surgery | Stewart `mgs2002` |
| `N1740` | Systems and Computational Biomedicine | Silver `rbsilve` |
| `N1540` | Rehabilitation Medicine | **Joel Stein — NOT SET** (Columbia primary appt; not a WCM scholar, no CWID to link) |

### 5d. Department categories (`lib/department-categories.ts`)

`N1280` Medicine `mixed→clinical` · `N1420` Pathology `mixed→clinical` ·
`N1740` Systems & Comp Bio `mixed→basic`.

---

## 6. Known limitations / follow-ups

- **Joel Stein (Rehab Med chair)** can't be represented — `directorCwid`/`chairCwid`
  must link to a displayable WCM scholar. A free-text leader field is a possible
  future enhancement.
- **Cross-campus director display**: a director who isn't a WCM scholar can't show.
  All 8 directors here resolved to WCM scholars.
- **New-center descriptions** are placeholders pending comms copy.
- `N1760` will need a department→center migration when comms is ready.

---

## 7. Verification

- `prisma validate` ✓ · `tsc --noEmit` ✓ · unit suite 4224/4224 ✓.
- Backfill is idempotent (`updateMany`/`upsert`/`deleteMany`) with `--dry-run` and a
  read-back of the final center + department state.

---

## 8. Operational rollout (gated)

1. Merge PR → CD applies migration `20260612140000` (migrate-before-roll).
2. Run the backfill once per env (read-back printed):
   `npx tsx scripts/backfills/2026-06-12-org-unit-comms-update.ts --dry-run` then live.
   On staging, via the etl `run-task` recipe.
3. Verify on staging: renamed depts show official names (page/profile/browse),
   compact names in facet chips; 2 deletes gone; 5 adds present with correct type
   badge; chairs/directors render; categories corrected; a simulated ED ETL run
   does not revert anything.
4. **Prod later** (staging authoritative for now): same backfill, promoted from the
   repo SOR.
