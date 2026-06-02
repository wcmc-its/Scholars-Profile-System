# Grad School bios — structure & voice analysis (crawl results)

**Status:** Findings (read-only crawl complete)
**Date:** 2026-06-01
**Parent:** [gradschool-harvest-scope.md](./gradschool-harvest-scope.md) · [../overview-coverage-scope.md](../overview-coverage-scope.md)
**Dataset:** 343 profiles crawled from `gradschool.weill.cornell.edu/faculty` at 3s delay, 0 fetch failures. Tools: [`gradschool-crawl.py`](./gradschool-crawl.py), [`analyze-gradschool.py`](./analyze-gradschool.py). Per-profile metrics (no full bio text): [`bio-metadata.csv`](./bio-metadata.csv). Raw bios live in `/tmp` (not committed — scraped content).

---

## TL;DR

- **The bios exist and are mostly substantive** — 340 of 341 real faculty have a bio (median 147 words, curated prose).
- **But the harvest yield against our gap is modest: ~85 net-new overviews,** not the ~150–200 first estimated. Three leaks: only **63%** carry a mappable CWID, the WCGS↔MSK partnership means many grad faculty **aren't WCM scholars**, and **half of the mapped FT faculty already have an overview** (shared VIVO provenance).
- **The content is heterogeneous and cannot be copied raw.** Voice is mixed (**76% third-person, 16% first-person**), shapes range from career-CV to research-statement to pointer-stub, and the HTML is dirty (**66% have empty `<p>`, 28% embed images, 58% append an awards bullet-list**). A harvest needs a **clean + normalize + voice pass**, not a paste.
- **Net:** worth doing for the ~85 high-quality research-faculty bios, but it confirms the **generator (option 4) is still needed for the bulk** — the Grad School site closes well under a fifth of the 512 high-value gap.

---

## The mapping funnel — where the net-new number comes from

| Step | Count | Note |
|---|---:|---|
| Profiles crawled | 343 | includes 2 nav pages (`faculty-honors`, `faculty-stories`) |
| Real faculty with a bio | **340** | 99.7% of the 341 real faculty have one |
| …with an inline CWID (VIVO link) | 217 (63%) | **37% have no VIVO link** → no deterministic map |
| …CWID resolves to a Scholars record | 208 (96% of those) | 9 don't (alumni / MSK-only / stale) |
| …that is `full_time_faculty` | 158 | the rest: affiliated, emeritus, MSK, non-faculty |
| …FT **and lacks** an overview | 75 | |
| **…and has a bio → NET-NEW (deterministic)** | **74** | the firm, no-ambiguity seed set |
| FT **already** covered (overlap w/ VIVO seed) | 83 | confirms shared provenance — half are done |
| CWID-less bios recovered by exact name-match | +11 FT-no-overview | of 124 cwid-less; 33 name-matched, 12 FT |
| CWID-less, **unmatched** | 91 | likely MSK-only / name-format mismatch → fuzzy or drop |

**Firm net-new ≈ 74 + 11 = ~85** overviews. Against the [gap](../overview-coverage-scope.md) that's ~17% of the 512 high-value cut — a real but partial contribution.

> Correction to the feasibility scope: the "deterministic CWID mapping, no fuzzy matching" claim held for the Blenis sample but **only ~63% of profiles carry the VIVO link**. The rest need name-matching (collision-prone) or drop out — many are Sloan Kettering faculty who aren't WCM scholars.

---

## Voice — mixed, needs a site-wide decision

| Voice (heuristic) | Share | |
|---|---:|---|
| Third-person, named ("Dr. Boire earned her BA…") | 41.5% | **third-person total ≈ 76%** |
| Third-person, lab-framed ("The Blenis lab studies…") | 34.7% | |
| First-person singular ("Work in my lab…", "My laboratory…") | 8.5% | **first-person total ≈ 16%** |
| First-person plural ("Our laboratory investigates…") | 2.9% + 4.1% | |
| Ambiguous / stub | 8.2% | includes the pointer-stubs below |

**Issue:** seeding as-is would publish a profile set that mixes "Dr. X studies…", "I study…", and "The X lab studies…" — visibly inconsistent. **Pick one voice site-wide** (recommend third-person, matching both the majority here and the existing VIVO seed) and normalize on import.

*Caveat:* the named-vs-lab split is approximate (the classifier keys on the word "lab" appearing anywhere), so treat 41.5/34.7 as soft; the third-vs-first split (76/16) is reliable.

---

## Content shape — four distinct kinds, not one

The "bio" field holds at least four different things, which matters because only some make a good *overview*:

1. **Career narrative (CV-style)** — "Dr. Boire earned her BA at Macalester… Ph.D. at Tufts… joined WCM in…". Good biographical overview material.
2. **Research statement** — "The lab studies biochemical mechanisms…". Good *research* overview; often lab-centric rather than person-centric.
3. **Prose + awards list** — ~58% append a bulleted honors list ("Pershing Square Sohn Prize (2019)", "Pew Biomedical Scholar"). Valuable structured data, but it's a list grafted onto prose.
4. **Pointer-stub (15 profiles)** — "Click here or the 'About' button below to read more about Dr. X's research." **Useless for seeding** — exclude.

---

## Structure — the HTML is dirty (cleaning is mandatory)

| Signal | Bios affected | Total | Harvest implication |
|---|---:|---:|---|
| Empty `<p></p>` | 66.2% | 670 | strip — pure junk from the CMS editor |
| Embedded `<img>` (+ `panopoly`/caption wrappers) | 27.6% | 95 | strip or relocate — an overview is prose, and 28% carry caption-div scaffolding |
| `<a>` links | 27.1% | 362 | decide: keep lab/site links or drop |
| Bulleted lists (`<ul>/<ol>`) | 57.6% | 304 | these are the **awards lists** — keep as structured honors, or render inline |
| Caption/figure wrappers | 27.9% | — | the `panopoly-image` scaffolding must be unwrapped |
| Headings inside | 1.8% | 9 | rare; normalize away |
| Single real paragraph | 54.1% | — | the other ~46% are multi-paragraph |

Every one of these survives a naive copy. The overview sanitizer (`sanitizeOverviewHtml`) would catch the worst, but the **images, caption scaffolding, and awards-vs-prose split need deliberate rules**, not just tag-allowlisting.

---

## Length — wide and inconsistent

median **147** words · mean 192 · range **13 → 1490**.

| Words | Share |
|---|---:|
| <50 | 8.2% |
| 50–99 | 17.6% |
| 100–199 | 39.7% |
| 200–349 | 19.4% |
| 350+ | 15.0% |

18 bios are <30 words (mostly the pointer-stubs); one is 1,490 words. A seed should set a floor (drop/flag <30–50w) and likely a soft ceiling for the *overview* slot (long CVs may want trimming).

---

## Verdict & the cleaning rules a harvest must apply

**Viable, with a transform pass.** The ~85 net-new bios are high-value (prominent research faculty) and the content is genuinely good — but it must be **cleaned and normalized**, not copied. Minimum rules:

1. **Drop pointer-stubs** (`/click here|read more|button below/i`) and bios <~30 words.
2. **Strip** empty `<p>`, `panopoly`/caption wrappers, embedded images (or move images out of the overview).
3. **Decide** what to do with the appended **awards lists** — keep as a structured honors block, or fold into prose; don't leave a raw `<ul>` mid-overview.
4. **Normalize voice** to the site-wide choice (recommend third-person) — this is the one step a pure harvest can't do mechanically; it implies a light LLM rewrite or human edit, which **points right back at the option-4 generator as the cleaning engine.**
5. **Map by CWID where present (63%); name-match the rest with human confirmation**, never blind fuzzy.

**Strategic read:** the Grad School site is a good *seed corpus for ~85 prominent research faculty*, but the cleaning/voice work it needs is most of the generator's pipeline anyway. The efficient path is to **feed these bios through the option-4 generator as "source material to normalize," not a separate raw-import** — one cleaning path, one voice, one review gate.
