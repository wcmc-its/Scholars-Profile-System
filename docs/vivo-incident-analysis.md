# VIVO incident history — feedback coverage analysis

**Issue:** #514 (companion) · **Status:** analysis · **Relationship:** validates and extends `feedback-handling-matrix.md`.

**Data:** ServiceNow "VIVO support" incident export, opened 2016‑08‑29 → 2026‑05‑15. 604 records exported; **N = 594** after excluding 10 infra/non‑feedback records (AWS‑backup alarms, a Wiz Kubernetes finding, a closed‑ticket comment echo). Analyzed 2026‑05‑27.

> The raw export contains PII (faculty names, emails, CWIDs, personal phone numbers) and is **not committed**. Every example below is paraphrased to role level. Keep the export out of the repo.

This analysis answers three questions about the predecessor system (VIVO) that the Scholars Profile System replaces:

1. What did faculty and staff actually complain about for ~10 years?
2. Does the Scholars approach (auto‑generated profiles + the `/edit` self‑service surface + the `feedback-handling-matrix.md` routing) address those complaints?
3. Does the in‑app "Request a change" form capture the *right types* of feedback?

---

## 1. Method, and why the naive numbers mislead

The incidents are free‑text emails. Two methodology choices were load‑bearing; without them the aggregate is wrong by 5–15×.

- **Subjects are useless for classification.** The most common subject lines are "VIVO profile" (×13), "VIVO" (×9), "Vivo error" (×5). Classification has to read the email *body*.
- **Signatures and quoted reply chains must be stripped first.** A body that ends `— Jane Smith, MD, PhD, Professor, Department of Medicine, Division of …` makes a naive keyword match report ~39% "degree" complaints and ~33% "title" complaints. After stripping signatures and quoted threads, those fall to ~3% and ~6% — the boilerplate was the signal. The same hazard inflates "name" (the `My name is X, I'd like to…` self‑introduction wraps an *unrelated* complaint) and "department/division".
- **Multi‑label, then de‑noise.** Each incident is tagged with every theme its *ask* touches, then ambiguous buckets are corrected by sampling (below). Free‑text classification is inherently fuzzy: treat all figures as ±a few points and lead with the themes that are stable across independent runs.

**Buckets corrected after sampling** (do not trust their naive counts):

| Bucket | Naive | Corrected | Why |
|---|---|---|---|
| Name | ~30% | ~3–5% | "My name is X…" self‑intros, not name‑spelling complaints |
| Website/links | ~13% | ~3% | mostly "the VIVO website/page" (= the site itself → tech/access), not external links |
| Degree/title/dept | 33–39% | 3–6% | email‑signature post‑nominals and affiliations |
| Contact phone | ~4.5% | n/a | **moot — Scholars does not render phone numbers** (see §8) |

---

## 2. Aggregated themes (de‑noised)

Percentages are of N = 594. "Confidence" reflects stability across independent classification runs and sampling.

| Theme | ~% | Confidence | Disposition |
|---|---|---|---|
| **Publications** (missing / not‑mine / duplicate / wrong metadata) | **~27%** | high | feature + form (see §5) |
| **"Vague — just fix my profile"** (no specifics; often "see attached") | ~15% | high | needs the catch‑all (§6.1) |
| **Whole‑/intra‑profile removal & opt‑out** ("no longer here", "take it down") | ~12% | high | self‑service Hide + routes (§5) |
| **Profile provisioning** ("I have no profile / it's inactive / not populating") | ~11% | high | **structurally eliminated** (§4) |
| **Photo** (wrong / outdated / missing / hide) | ~11% | high | feature + form |
| **Edit mechanics** ("I can't edit / upload / how do I update") | ~8% | high | **structurally eliminated** (§4) |
| **Funding / grants** | ~8.7% | high | feature + form |
| **Title / rank** (incl. "remove my interim title") | ~6% | med | form (route) |
| **Access / login / CWID activation** | ~6% | high | **structurally eliminated** (§4) |
| **Education / training** | ~5% | med | form (route) |
| **Duplicate / "I have two profiles"** | ~4.4% | med | partial — see §6.3 |
| Appointment | ~3.5% | med | form (route) |
| Name (de‑noised) | ~3–5% | med | self‑service (Web Directory) |
| Degrees / post‑nominals (de‑noised) | ~3% | med | form (route) |
| Privacy / visibility (explicit) | ~2% | med | email/photo‑hide |
| Research interests / overview / bio | ~2% | med | **direct self‑edit** (§8) |
| External links / social / clinical trials | ~3% | low | not rendered → explain (§8) |
| Mentoring · awards · ORCID | <1% each | — | matrix / self‑service |

**Resolution data corroborates the shape.** Of the full export, **~25% of tickets closed as "Information provided"** — an answer, no fix — and by trouble‑type a further ~12% were info‑inquiry / how‑to. **A quarter to a third of VIVO's volume needed only an explanation or a pointer**, not a data change.

By ServiceNow `u_trouble` (full export, rounded):

| Class | ~share | Reads as |
|---|---|---|
| Data‑correction requests (modify / add / delete / maintain data) | ~55% | the route + self‑service target |
| Unexpected behavior / error / degraded performance | ~24% | bug reports (no form path today — §6.2) |
| Info inquiry / training / how‑to | ~12% | explain / self‑service (no ticket needed) |
| Account / login / access / permission | ~10% | eliminated by SSO + auto‑provision (§4) |

---

## 3. Headline finding: most VIVO pain is *structurally* eliminated, not "addressed by a feature"

The largest historical complaint classes do not need a feedback form at all — the Scholars architecture removed them by design.

| VIVO pain class | ~share | Why it is gone in Scholars |
|---|---|---|
| "I don't have a profile / activate mine / it's not populating / inactive" | ~11% + much of the 15% vague | Scholars **auto‑generates every profile** from source systems. There is no create/activate step to fail. |
| Login / CWID‑activation failures | ~6–10% | **Unified WCM SSO** — no separate VIVO account to provision. |
| "I can't edit / upload / how do I change this" | ~8% | Scholars **ships a self‑edit `/edit` surface** — VIVO's broken manual editing *was* the complaint. |
| Manual publication entry ("add this paper", "wrong papers", "duplicated pubs") | large share of the ~27% publications | **ReCiter auto‑ingests PubMed** — no hand‑entry, so no hand‑entry errors. |
| "My personal cell/phone is public" | ~4.5% | Scholars **does not render phone numbers** at all (§8). |
| VIVO platform bugs (504s, "site is down", "trimming out") | part of the ~24% unexpected‑behavior | New stack — VIVO‑specific defects are moot (new ones will arise → §6.2). |

Conservatively this is **~40–50% of historical volume eliminated by the platform choice**, before any feedback routing. The form's real job is the *residual*: source‑data corrections it cannot fix in place (title, department, degree, education, funding, appointment) plus the long tail.

---

## 4. Coverage of the residual

The shipped form is `lib/edit/request-a-change.ts` — six attributes (`name-title`, `photo`, `appointments`, `education`, `funding`, `publications`), each a fixed issue list resolving to one of three shapes (self‑service link / `mailto` route / in‑place explain). Its design — **collect only Route cases; let self‑service and explain resolve in‑modal** (`feedback-handling-matrix.md` §2) — is **validated by the ~25% "Information provided" deflection rate**: that is exactly the traffic self‑service + explain should absorb without a ticket.

| Residual theme | Handled by | Verdict |
|---|---|---|
| Publications (#1 theme) | ReCiter auto‑ingest + form's 5 publication issue types → Publication Manager / ReCiter | ✅ strong |
| Photo | Web Directory self‑service + photo‑hide | ✅ |
| Funding | RePORTER auto‑ingest + form route to OSRA | ✅ |
| Title / dept / division / appointment / education / degree | form routes to ITS Support / Faculty Affairs | ✅ |
| Name (real fraction) | Web Directory self‑service | ✅ |
| Overview / bio / research interests | **direct self‑edit** (`/api/edit/field` `overview`, self‑only, sanitized) | ✅ (not via the request form, correctly) |
| Whole‑profile opt‑out / "take it down" | self‑service **"Hide my profile"** (`components/edit/visibility-card.tsx`) + superuser hide | ✅ for the subject; ⚠️ third‑party reporter has no route (§6.5) |
| Email privacy | email‑hide self‑service | ✅ |
| Duplicate (per‑entity) | publications / education duplicate issue types + Hide | ✅ per‑entity; ⚠️ whole‑profile duplicate (§6.3) |

---

## 5. Gaps in the shipped `/edit` form (ranked by historical volume)

1. **No "Something else / I can't find an answer" catch‑all** — *highest ROI.* The form is six fixed attributes; the ~15% vague bucket and the entire long tail have nowhere to go but back to emailing support — **recreating the exact VIVO pattern the system replaces.** `feedback-handling-matrix.md` §4 already specs this ("Other" + "General feedback → Scholars team"); it is a *ship‑what‑is‑designed* gap, tracked as the build in #520, not a new discovery.
2. **No "report a technical problem / this page looks broken" path** — ~24% of VIVO tickets were "unexpected behavior." A brand‑new platform *will* have display bugs, and there is no in‑form route; it would currently fall into the missing catch‑all. Added to the matrix by this PR (§6).
3. **Whole‑profile duplicate / "I have two profiles"** — distinct from the per‑entity duplicate options; this is identity/disambiguation (ReCiter), ~4.4% of tickets with several whole‑profile cases. No route in the form. Added to the matrix by this PR (§6).
4. **Computed / relationship fields** — Topic / Impact / Synopsis, center membership, mentoring, disclosures, hospital position. The matrix §3.3 adds these (recipients flagged TBD); the **shipped form does not have them yet.** Users will contest "this topic is wrong."
5. **Third‑party departed‑removal** — "Dr. X left, please hide them" from a non‑superuser colleague has no route (subject self‑hide and superuser hide both exist; a reporting colleague does not). Minor; folds into the catch‑all.

---

## 6. What this analysis adds to the matrix

Two rows were missing from `feedback-handling-matrix.md` §3 and have been added in this PR:

- **Whole‑profile duplicate / identity** ("two profiles for one person") → Scholars team / ITS (ReCiter disambiguation). Distinct from the per‑entity duplicate flows.
- **Technical / display problem** ("this page is broken / shows an error") → Scholars team. A distinct handling concern from data‑correction routes; the new platform will generate these even though VIVO‑specific defects are moot.

---

## 7. Verified correct omissions — do **not** widen the form for these

- **Phone / contact** — Scholars does not render phone numbers, so the entire VIVO phone/cell theme (incl. "my personal cell is public") is moot. Email is the only contact field and it is covered (Web Directory + email‑hide).
- **Overview / bio / research interests** — rendered and **directly self‑editable**. You edit it; you do not request a change. Correctly absent from the request form's six attributes.
- **Provisioning / login** — structural (§3); no form path needed.

**Product‑expectation flag (not a form bug):** VIVO showed, or users expected, **external/lab websites, social links, and clinical‑trials / "research studies."** Scholars renders none of these. At launch these become *"we don't display that"* explanations — worth a deliberate `explain` entry so they do not read as missing data.

---

## 8. Recommendations

| ID | Recommendation | Type | Status |
|---|---|---|---|
| **A** | Ship the catch‑all now: "Something else / I can't find an answer" + "Report a problem with this page" → Scholars‑team route. | form code | **recommended** — the matrix §4 already designs it; build is #520. Closes the ~15% vague + long tail. |
| **B** | Add two rows to the matrix: whole‑profile duplicate/identity; technical/display problem. | spec | **done in this PR** (§6). |
| **C** | Sequence the matrix's net‑new attributes (Topic/Impact/Synopsis, center, mentoring, disclosures, hospital position) into the form as their §3.3 recipients resolve. | form code | recommended — gated on §3.3 recipient resolution (#518). |
| **D** | Decide the `explain` copy for external links / clinical trials / "research studies" before launch (expectation management). | content | recommended. |
| **E** | Do **not** add phone, overview, or provisioning to the form (§7). | — | non‑action; documented. |

A and C are application code and intentionally out of scope for this spec PR (`feedback-handling-matrix.md` is spec‑only; the build is #520). They are captured here as the validated path.

---

## 9. Relationship to #514 and follow‑ons

- **#514 / `feedback-handling-matrix.md`** — this analysis validates the matrix's three‑shape model and its "route‑only intake" against ten years of real volume, and adds the two §6 rows.
- **#520** — the build (graduate the "Request a change" modal off `mailto:` to a ServiceNow request). Recommendation A (the catch‑all) should be in that build's scope.
- **#518** — resolve the §3.3 ⚠️ recipients; gates recommendation C.
- **#160** — the modal + server mailer this work graduates; its three shapes and locked destinations are inherited unchanged.
