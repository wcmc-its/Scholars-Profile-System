# Grad School site harvest — feasibility scope (option 1)

**Status:** Feasibility probe (not yet a build plan)
**Date:** 2026-06-01
**Parent:** [../overview-coverage-scope.md](../overview-coverage-scope.md)
**Source:** `https://gradschool.weill.cornell.edu/faculty`

Goal: decide whether harvesting overview text from the Weill Cornell Graduate School (WCGS) faculty site is a viable first-pass source for the prominent-faculty overview gap, and what the pipeline + unknowns are. Findings below are from a **live probe of the index page and one sample profile** (`/faculty/john-blenis`); claims about the *full* set are marked as needing a crawl to confirm.

---

## What the site gives us

| Property | Finding | Confidence |
|---|---|---|
| **Population size** | "WCGS has appointed over **300**" faculty. | Stated on index. |
| **List structure** | A-Z pagination; filterable by **~11 degree programs** and **70+ research topics**. | Index. |
| **Profile URL pattern** | `/faculty/<firstname>-<lastname>` (e.g. `/faculty/john-blenis`, `/faculty/omar-abdel-wahab`). | Index + sample. |
| **Per-profile content** | A **curated narrative bio** (~200 words, substantive prose), title, department(s), programs of study, research areas/keywords, lab/website link, and a **VIVO profile link**. | Sample profile. |
| **Bio quality** | Hand-written, third-person, research-focused ("The Blenis lab studies biochemical mechanisms that coordinate extracellular cues…"). Not auto-generated, not a bare list. | Sample profile. |
| **Email / ORCID / education / publications** | Not consistently present on the profile page. | Sample profile. |

## The key de-risker: CWID is embedded, no fuzzy matching needed

The sample profile links to VIVO at `http://vivo.med.cornell.edu/individual/cwid-job2064`. The `cwid-<CWID>` token **is the Scholars `scholar.cwid`** (here `job2064`). So the harvest can map each Grad School profile to a Scholars record **deterministically** — extract the VIVO link, parse `cwid-([a-z0-9]+)`, join to `scholar.cwid`. This removes the usual name-collision risk of directory harvests.

> ⚠️ **MEASURED (crawl complete — see [gradschool-bio-analysis.md](./gradschool-bio-analysis.md)):** the VIVO link is present on **only ~63%** of profiles, not most/all. The remaining 37% have **no** CWID and need name-matching (collision-prone) or drop out — many are Sloan Kettering faculty who aren't WCM scholars. The "deterministic, no fuzzy matching" claim holds *for the 63% that carry the link*; it is not site-wide.

---

## Proposed pipeline (if greenlit)

1. **Crawl the index** A-Z (or per-program) → collect all `/faculty/<slug>` URLs (~300).
2. **Fetch each profile**, extract: the bio paragraph(s), the VIVO link → CWID, title, research areas.
3. **Map** CWID → `scholar.cwid`; drop rows that don't resolve or aren't `role_category='full_time_faculty'`.
4. **Diff against the gap list** ([../overview-coverage/target-list-prominent-uncovered.csv](./target-list-prominent-uncovered.csv)) — keep only scholars who **lack** an effective overview. This yields the true **net-new** set.
5. **Sanitize** to the overview HTML policy (`sanitizeOverviewHtml`, the same validator `/edit` uses) — strip to allowed tags, normalize entities.
6. **Stage for review**, then write via the agreed provenance path (recommended: `field_override` tagged `source='gradschool-seed'`; see parent doc). Emit a B03-style audit row per write.

Steps 1–5 are a read-only crawl + transform; only step 6 mutates the DB.

---

## Net-new estimate — now MEASURED: ~85 (not 150–200)

The estimate is resolved by the completed crawl — full funnel and method in **[gradschool-bio-analysis.md](./gradschool-bio-analysis.md)**:

| | |
|---|---:|
| Real faculty with a bio | 340 |
| FT faculty, no overview, mapped by CWID (firm net-new) | **74** |
| + recovered by exact name-match | +11 |
| **Firm net-new total** | **~85** |
| FT already covered (overlap w/ VIVO seed) | 83 |
| CWID-less, unmatched (likely MSK / name mismatch) | 91 |

The pre-crawl guess (150–200) was too high: ~37% of profiles lack a mappable CWID, the WCGS↔MSK partnership means many grad faculty aren't WCM scholars, and **half** of mapped FT faculty already have a VIVO-seeded overview. **~85 net-new ≈ 17% of the 512 high-value gap** — real, but partial; the bulk still needs the generator (option 4).

---

## Risks & open questions

| Risk / question | Notes |
|---|---|
| **Crawl etiquette** | WCM's own site, but throttle (e.g. 1 req/sec), set a descriptive UA, honor `robots.txt`. ~300 pages = a few minutes. |
| **Bio voice** | Third-person, lab-centric. Acceptable as an overview, but stakeholders may want a voice/standardization pass (and a decision on first vs third person site-wide). |
| **Attribution** | Should seeded text be labelled "Adapted from the Graduate School profile"? And should faculty be notified a draft now exists? (Shared with the option-4 review flow.) |
| **Bio = research focus, not full bio** | The WCGS paragraph is a *research summary*, often shorter than the rich VIVO bios. Good, but not equivalent to a full profile narrative; sets a quality floor, not ceiling. |
| **Stale/duplicate slugs** | Name-based slugs can collide or change; rely on the VIVO-CWID link, not the slug, as the identity key. |
| **Coverage of non-research faculty** | WCGS is graduate *research* faculty — clinical-only prominent faculty won't be here; those need option 3 (biosketches) or option 4 (generator). |

---

## Recommendation (post-crawl)

**Worth doing — but as a *cleaned, normalized* feed, not a raw import, and scoped to ~85 net-new.** The crawl (now complete, [gradschool-bio-analysis.md](./gradschool-bio-analysis.md)) confirms the bios are good source material for ~85 prominent research faculty, but the content is heterogeneous (mixed voice, awards-lists, embedded images, dirty HTML, 15 pointer-stubs) and needs the same clean + voice-normalize + review pass the **option-4 generator** already provides.

**So the efficient path is not a separate raw-import pipeline** — it's to feed these ~85 bios through the generator as *"source material to normalize"* (one cleaning path, one site-wide voice, one review gate), and rely on the generator + NIH biosketches (option 3) for the rest of the gap the Grad School site doesn't reach.
