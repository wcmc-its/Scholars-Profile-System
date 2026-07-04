# Handoff — CV outline preview polish (post-#1316)

## State

PR **#1316** (`39aafbcf`) is **merged and live on staging** — the `/edit` → Tools →
**CV (WCM format)** panel now renders a live, document-ordered outline of the WCM CV
(every section + subsection A–S, ≤10 items each, bordered D9D9D9 shaded-header tables),
the builder bins pubs into the 9 WCM bibliography categories, writes POPS specialties/
practices/expertise to Section L1, splits grants Current/Past, and leaves a blank line
after section headers. Reviewed at `/edit/scholar/ccole?attr=cv` (Curtis Cole, clinical).

This handoff is **three preview-UI polish items** the reviewer asked for. **All three are
preview-only** — no builder/`.docx` change, no flag, no schema, no cdk. Rides the existing
`EDIT_CV_EXPORT` gate; merge → image roll → staging shows it.

### The surfaces involved
- **`components/edit/cv-tool.tsx`** — `CvOutline` / `OutlineGroup` / `OutlineEntry` (the
  rendered outline), plus the now-redundant `PopsPreview` / `buildPopsPreviewGroups`.
- **`lib/edit/cv-export.ts`** — `cvOutline(input)` (pure; returns `CvOutlineGroup[]`, each
  with `entries: CvOutlineEntry[]`, `entry.items: string[]`, `entry.source:
  "scholars"|"pops"|"generated"|"none"`). Row helpers `educationRows` / `appointmentRows`
  / `honorRows` feed it.
- **`app/api/edit/cv/outline/route.ts`** — GET that returns `{ outline }`.
- **`app/api/edit/cv/pops/route.ts`** — GET that feeds `PopsPreview` ONLY (see change 3).

---

## Change 1 — a source badge per record

**Today:** POPS-fed entries show an inline `· POPS` text tag (`OutlineEntry`,
`{e.source === "pops" && filled && <span>· POPS</span>}`); Scholars/Generated entries show
nothing. `POPS` is internal jargon.

**Want:** a proper badge (pill) showing each record's **system of record**.

**Build on what exists — do NOT invent labels:**
- Reuse **`components/ui/badge.tsx`** for the pill.
- Reuse the **operator-validated provenance vocabulary** in **`lib/edit/field-sources.ts`**
  (`name-title`→"Enterprise Directory", `appointments`→"ASMS by way of Enterprise
  Directory", `funding`→"InfoEd", `publications`→"PubMed (attributed by ReCiter)", …) and
  the `field-source-line.tsx` rendering. The badge copy should match these, so the CV
  outline reads the same as the rest of `/edit`. POPS has no entry there yet → add one
  label, e.g. **"WCM physician directory"** (avoid the bare acronym "POPS" in user copy).

**DECISION — granularity (per-entry vs per-record).** The coarse `entry.source` is **not
accurate enough**: three sections MERGE sources within one entry —
- `B1 Academic Degrees` = `p.educations` (Enterprise Directory/ASMS) **+** `pops.degrees`
  (WCM directory) — `educationRows()` concatenates both.
- `D1`/`D2 Appointments` = `p.appointments` (ASMS/ED) **+** `pops.appointments` (WCM
  directory) — `appointmentRows()` concatenates both.
- The rest are uniform (Honors/Training/Board-cert/L1 = POPS; grants/mentees/leadership/
  bibliography = Scholars; M1 = generated).

  So a single badge on `B1`/`D1`/`D2` would mislabel the POPS-derived rows. **Recommended:
  per-record source.** Change `entry.items` from `string[]` to
  `{ text: string; source: <sourceKey> }[]`, and have `educationRows`/`appointmentRows`/
  `honorRows` emit the source per row (they currently drop it when they merge). Then render
  one badge per item line. Map `sourceKey` → label via `field-sources.ts`.
  - *Cheaper alternative if per-record is rejected:* keep the per-entry badge but, for the
    three merged sections, badge them "Scholars + WCM directory". Less precise; flag it.

**DECISION — which records carry a badge.** Recommend **all** records (Scholars, WCM
directory, AI-drafted for M1) so provenance is explicit and uniform, not just the POPS ones.
Confirm with reviewer — they may want only the non-obvious (POPS/AI) badged to reduce noise.

**DECISION — M1 "Research Activities".** Source `generated`; badge copy e.g.
**"AI-drafted"** (it already shows the "drafted on download" status tag — don't duplicate).

---

## Change 2 — bullets

**Today:** `OutlineEntry` renders items as a flex column of `<li>` with **no markers**
(`<ul className="text-muted-foreground mt-0.5 ml-6 flex flex-col gap-0.5 text-xs">`) — they
read as plain stacked lines.

**Want:** actual bullets. Switch that `<ul>` to a real bulleted list (`list-disc` with a
left marker indent; keep the `+N more` remainder line, ideally un-bulleted or italic so it
reads as a continuation, not an item). Pure CSS/markup change in `OutlineEntry`.

*Out of scope:* the `.docx` bibliography/grants are already numbered/prose per the WCM
template — **do not** bullet the builder output. This is the preview list only.

---

## Change 3 — drop the "Clinical credentials" section

**Today:** the block at the bottom titled **"Clinical credentials (from your WCM physician
directory)"** is the old `PopsPreview` (`components/edit/cv-tool.tsx` `PopsPreview` +
`buildPopsPreviewGroups`), fed by `GET /api/edit/cv/pops`. It lists Board Certifications /
Residency / Hospital Appointments / Honors / Degrees / Clinical Specialties / Practices /
Expertise / NPI, each tagged `→ CV <section>`.

**Why it's redundant:** the outline above it already shows **every** POPS-fed section with
the same data — `C` (training), `F1` (NPI), `F2` (board cert), `H` (honors), and **`L1`
(specialties/practices/expertise)** which #1316 added. The only thing `PopsPreview` ever had
that the outline didn't was specialties/practices/expertise — now in L1. Reviewer: *"not
sure clinical credentials section gets us anything."* **It doesn't anymore.**

**Recommended — remove it entirely:**
- Delete `PopsPreview`, `buildPopsPreviewGroups`, `PopsPreviewGroup`, the `pops` state +
  its fetch effect, and the `{pops && <PopsPreview …/>}` render in `cv-tool.tsx`.
- Delete **`app/api/edit/cv/pops/route.ts`** — it has no other caller (`git grep
  api/edit/cv/pops` → only the route, `cv-tool.tsx`, and the spec doc).
- Delete **`tests/unit/cv-pops-preview.test.ts`**.
- The `POPS_PATH` const and the `PopsEnrichment` import in `cv-tool.tsx` go too if unused
  after removal.

**Consent is preserved:** the §6b transparency copy already lives in the outline header
("Clinical sections come from your WCM physician directory (POPS) and are not added to your
public Scholars profile"), so removing `PopsPreview` does **not** lose the consent notice.
Update `docs/scholar-cv-generator-spec.md` §6b to reflect that the outline subsumes the
standalone preview.

**CONFIRM with reviewer before deleting the route + test** (low risk; they said "not sure",
which reads as "remove" given the redundancy).

---

## Files touched (expected)

| File | Change |
|---|---|
| `components/edit/cv-tool.tsx` | Badge per record (`OutlineEntry`); bullets; remove `PopsPreview`/`buildPopsPreviewGroups`/`pops` fetch |
| `lib/edit/cv-export.ts` | (if per-record badges) `cvOutline` items → `{text, source}`; thread source through `educationRows`/`appointmentRows`/`honorRows` |
| `app/api/edit/cv/pops/route.ts` | **delete** (dead after change 3) |
| `tests/unit/cv-pops-preview.test.ts` | **delete** |
| `tests/unit/cv-export.test.ts` | update `cvOutline` assertions if `items` shape changes |
| `lib/edit/field-sources.ts` | add a "WCM physician directory" label if reused for the badge |
| `docs/scholar-cv-generator-spec.md` | §6b note: outline subsumes the standalone POPS preview |

## Guardrails / mechanics
- **Preview-only.** No `buildWcmCvBuffer`/`.docx` change, no flag, no schema, no cdk.
- Base off **fresh `origin/master`** (do not branch off a drifted local branch). SPS is a
  Dropbox repo — prefer a normal branch unless running parallel agents (worktree needs
  `node_modules` + `npx prisma generate` + `.env*`).
- Run `vitest` (`cv-export` + any `cv-tool`/`cv-pops` specs) **and** `tsc` **and** `eslint`
  before pushing — tsc alone is insufficient. Tight diff; no blanket `prettier --write`
  (master isn't prettier-clean; reformatting unrelated lines bloats the diff).
- Worktree symlink gotcha: stage files explicitly by path; never `git add -A`.

## Verification
- After merge + staging image roll: `/edit/scholar/<clinical-cwid>?attr=cv` (e.g. `ccole`).
  Confirm (1) a source badge on each record reading like the rest of `/edit`, (2) bulleted
  item lists, (3) no "Clinical credentials" block. **Check dark mode** (the `#D9D9D9`
  literals + badge contrast are the only things headless can't verify).
- Authed-only surface (WCM SSO); not reachable headless.

## Out of scope (parked, not part of this handoff)
- Prod flag flip (`EDIT_CV_EXPORT`) after soak; ASMS enrichment
  (`docs/cv-asms-enrichment-handoff.md`); cosmetic Name:-tab strip; optional bibliography
  hyperlinks.
