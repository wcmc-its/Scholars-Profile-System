# Communications Steward — Method-Family Visibility (SPEC, draft for review)

**Status:** Draft — awaiting approval before implementation.
**Scope:** Deliverable #1 only — the new `comms_steward` role + a global Method-Family
visibility surface. Org-unit statements and overview generation are documented as
follow-ons (§11), not built here.
**Related:** #799/#800/#801 (methods lens overlays), #866 (internal-viewer gating),
#847 (internal export), #728 (`/edit/administrators` precedent), #742 (overview gen).

---

## 1. Goal

Give External Affairs a self-service, audited surface to control the **visibility tier**
of method families, and to **deterministically surface** families that may be
reputationally sensitive (live-animal models especially) so a human can review them —
**without blocking publication**. Default stays "published"; one occasionally slipping
through is acceptable and is caught by the manual override.

Non-goals (this deliverable): review-before-publish / quarantine; editing profile fields;
org-unit statements; overview generation (all explicitly out, see §11).

## 2. The three visibility tiers (unchanged semantics)

| Tier | Table | Effect | Owner |
|---|---|---|---|
| **Public** (default) | — (no overlay row) | Visible everywhere | — |
| **Suppressed** (#800) | `family_suppression_overlay` | Hidden from **everyone**, always (relevance) | Editorial |
| **Sensitive** (#801) | `family_sensitivity_overlay` | Hidden from **public** only when `METHODS_LENS_SENSITIVE_GATE=on`; shown to internal viewers (#866) | Compliance / External Affairs |

Resolution is the existing query-time merge in `partitionScholarFamilies`
(`lib/api/profile.ts`) and `loadFamilyOverlayGate` (`lib/api/methods-overlay.ts`), keyed on
the stable pair `(supercategory, family_label)` — never the re-mintable `family_id`. **This
spec adds a writer and a surfacing signal; it does not change how visibility resolves.**

> ⚠️ **Inert-sensitive caveat (must surface in UI):** marking a family *Sensitive* hides it
> publicly **only when `METHODS_LENS_SENSITIVE_GATE=on`**. With the gate off (current prod
> state), a Sensitive family still renders publicly. The UI must show the live gate state so
> a steward is never misled into thinking a mouse-model family is hidden when it isn't.

## 3. New role: `comms_steward`

A **global** role (not per-scholar, not unit-scoped), resolved exactly like superuser.

- **Resolver:** `lib/auth/comms-steward.ts` → `isCommsSteward(cwid): Promise<boolean>`,
  mirroring `lib/auth/superuser.ts` (LDAP subtree search under `ou=Groups`, fail-closed on
  any LDAP outage).
- **Group CN:** env `SCHOLARS_COMMS_STEWARD_GROUP_CN` (e.g.
  `ITS:Library:Scholars/comms-steward-role` — ITS to create the group).
- **Dev override:** env `SCHOLARS_COMMS_STEWARD_ALLOWLIST` (case-insensitive cwid list),
  mirroring `SCHOLARS_SUPERUSER_ALLOWLIST`.
- **Session:** extend `EditSession` with `isCommsSteward: boolean`, populated in
  `getEditSession()` alongside `isSuperuser`.
- **Privilege boundary (enforced, not assumed):** `comms_steward` unlocks **only** the
  Method-Family surface (§5–§7). It is **not** a superuser; it gets no profile-field writes,
  no other `/edit` tabs. Superusers also pass every `comms_steward` guard (superset).

## 4. Surface placement — global route, not a per-scholar tab

The existing `/edit/scholar/[cwid]` tabs (`ATTRIBUTES`/`EditMode`/`attrsForMode` in
`components/edit/edit-page.tsx`) are **per-profile**. Method families span scholars, so this
lives at a **sibling global route**, parallel to `/edit/administrators` (#728):

- **Route:** `/edit/methods`  (label: **Method Families**)
- **Guard:** server component requires `isCommsSteward || isSuperuser`; else `notFound()`
  (404, not 403 — don't reveal the surface exists). Flag-off ⇒ 404 (§9).

This avoids touching the per-scholar `EditMode` union entirely.

## 5. Data model changes (one migration)

```prisma
// Provenance on BOTH overlay tables — lets the seed ETL avoid clobbering steward edits.
model FamilySuppressionOverlay {
  // ...existing (supercategory, familyLabel, sourceNote, refreshedAt)...
  source String @default("seed") @db.VarChar(16) // 'seed' | 'steward'
}
model FamilySensitivityOverlay {
  // ...existing...
  source String @default("seed") @db.VarChar(16) // 'seed' | 'steward'
}

// New: the deterministic surfacing ledger. Keyed on the STABLE family identity,
// independent of overlay membership (a family can be flagged yet still public).
model FamilyReviewFlag {
  supercategory  String    @db.VarChar(128)
  familyLabel    String    @map("family_label") @db.VarChar(255)
  reason         String    @db.VarChar(64)   // e.g. 'supercategory:animal_cell_models', 'term:mouse'
  firstSeenAt    DateTime  @map("first_seen_at")           // for the "new" signal
  lastSeenAt     DateTime  @map("last_seen_at")
  reviewedAt     DateTime? @map("reviewed_at")             // steward cleared the nag (tier may stay public)
  reviewedByCwid String?   @map("reviewed_by_cwid") @db.VarChar(32)
  @@id([supercategory, familyLabel])
  @@map("family_review_flag")
}
```

Audit ENUM extension (`scholars_audit.manual_edit_audit`, via the cdk bootstrap pattern in
`cdk/lambda/db-bootstrap-seed/statements.ts`):
- `AuditAction` += `family_tier_set`, `family_review`
- `AuditEntityType` += `method_family`

(`lib/edit/audit.ts` TS unions extended to match; mismatched ENUM ⇒ grants roll back, so the
ALTER must land before the role is granted — see §10.)

## 6. The surfacing pass (deterministic, allow-by-default)

A new idempotent ETL step, run after the A2 tools artifact ingests (`etl/tools/index.ts`):

- **Script:** `npm run etl:family-review` (also callable inline at the tail of `etl:tools`).
- **Signal (two parts, OR'd):**
  1. **Structural:** `supercategory === 'animal_cell_models'` → `reason='supercategory:animal_cell_models'`.
     This is the strongest signal and arrives free from A2.
  2. **Lexical:** `family_label` matches a maintained, case-insensitive term list at
     `etl/family-review/animal-model-terms.txt` (one term/regex per line, comment-able) →
     `reason='term:<matched>'`. Seed list: `mouse, mice, murine, rat, rodent, zebrafish,
     drosophila, xenograft, pdx, primate, macaque, nhp, canine, porcine, swine, rabbit,
     ferret, knockout, transgenic, germline, in vivo, animal model`. Editable as data, not code.
- **Behavior:** for every distinct `(supercategory, family_label)` in `scholar_family`,
  upsert `family_review_flag`: set/keep `firstSeenAt` (only on first insert), bump
  `lastSeenAt`, set `reason` if matched (clear the row if no longer matched). **Never changes
  a tier. Never hides anything.** It only decorates.
- **"New" = `firstSeenAt >= <this run's start>`.** An A2 **relabel** mints a new
  `(supercategory, family_label)` key → re-enters as new and unreviewed (correct: a renamed
  family should be re-reviewed). Expect some churn; that's the safe direction.

**Priority for the UI queue:** `new ∧ matched` (top) > `matched ∧ ¬reviewed` > `matched ∧ reviewed` > unmatched (informational).

## 7. API surface (all guarded `comms_steward || superuser`, all audited)

| Method / path | Purpose | Notes |
|---|---|---|
| `GET /api/edit/methods/families` | Roster: each distinct family with `{ tier, reason, isNew, reviewedAt, scholarCount, pmidCount }` | Filters: `?filter=all\|flagged\|new\|public\|suppressed\|sensitive`. Joins `scholar_family` (distinct) ⟕ both overlays ⟕ `family_review_flag`. |
| `POST /api/edit/methods/families/tier` | Set a family's tier | Body `{ supercategory, familyLabel, tier: 'public'\|'suppressed'\|'sensitive' }`. Writes the overlay table with `source='steward'`; `'public'` = delete the family's row from **both** overlays. Audit `family_tier_set`. |
| `POST /api/edit/methods/families/review` | Mark reviewed (clear the nag) | Sets `reviewedAt`/`reviewedByCwid` without changing tier. Audit `family_review`. |
| `GET /api/export/methods/families` | Download-for-review CSV | Reuses the #847 export machinery (`POST /api/export/scholars/{scope}` pattern). Columns: `supercategory, family_label, tier, reason, is_new, reviewed_at, scholar_count, pmid_count`. |

**Authz:** new predicate `authorizeCommsStewardAction(session)` in `lib/edit/authz.ts`; extend
`AuthzDenialReason` += `not_comms_steward`. Denials logged via `logEditDenial`.

**Setting a tier is reversible with no rebuild** — it's a row write to the query-time-merged
overlay (the property the DB-SOR decision preserves). No reindex, no ETL run required for a
change to take effect.

## 8. UI — `/edit/methods` (Method Families)

A single roster table (master list; no detail panel needed for v1):

- **Columns:** Family label · Supercategory · **Tier** (segmented control: Public /
  Suppressed / Sensitive) · **Flag** (reason chip if matched) · **New** badge · scholar/pub
  counts · "Reviewed" affordance.
- **Default view:** the review queue — `filter=flagged`, ordered by §6 priority, so the
  mouse-model families surface first. A filter bar switches to all / new / by-tier.
- **Tier control:** changing the segmented control calls the tier endpoint; optimistic update
  with the zero-latency-confirm pattern used in #841. Selecting "Sensitive" while the gate is
  off shows the §2 inline warning ("Hidden publicly only when the sensitivity gate is on —
  currently OFF; this family still renders publicly").
- **Download button:** "Download for review (CSV)" → the export endpoint.
- **No bulk quarantine, no approve-to-publish** — explicitly allow-by-default.

## 9. Flags & gates

| Flag | Default | Gates |
|---|---|---|
| `COMMS_STEWARD_ENABLED` | **off** (both envs) | The role resolver short-circuits to `false`, the route 404s, the APIs 404. Master kill-switch. |
| `METHODS_LENS_SENSITIVE_GATE` | (existing) | Whether the *Sensitive* tier actually hides publicly. Surfaced read-only in the UI (§2 caveat). |

Wire `COMMS_STEWARD_ENABLED`, `SCHOLARS_COMMS_STEWARD_GROUP_CN`,
`SCHOLARS_COMMS_STEWARD_ALLOWLIST` in **both** `.env.local` and `cdk/lib/app-stack.ts`
per-env (the local-on/deployed-off silent-shipping trap), then regenerate the app-stack
snapshot (`cd cdk && npm ci && npm test -- -u`, commit only the `.snap`).

## 10. Implementation sequence

1. **Migration + audit ENUM** — `source` cols, `family_review_flag` table, ALTER the audit
   ENUMs. Lands first (ENUM-before-grant, else grants roll back). Generate offline
   (`prisma migrate diff --script`).
2. **Role** — `lib/auth/comms-steward.ts`, env vars, `EditSession.isCommsSteward`, dev allowlist.
3. **Seed-ETL safety** — modify `etl/family-sensitivity/index.ts` (and any future suppression
   seed) so the reseed **upserts only `source='seed'` rows and never overwrites a
   `source='steward'` row** (replaces today's `deleteMany({})`-everything). The curated CSV
   becomes a one-time bootstrap, not a recurring truncate.
4. **Surfacing pass** — `etl/family-review/` + `npm run etl:family-review`; run once over the
   current corpus to populate the ledger (immediately surfaces already-public matches).
5. **API + authz + audit** — the four endpoints in §7.
6. **UI** — `/edit/methods` surface (§8).
7. **Tests** (§ below) + flag wiring + snapshot regen.

## 11. Follow-ons (documented, NOT in this deliverable)

Both ride existing infra and become additional `comms_steward`-gated surfaces later:

- **Org-unit statements** — `Center/Department/Division.description` already have a live edit
  path: `POST /api/edit/unit` (`description` in `CENTER_UPDATE_FIELDS`, B03-audited,
  `lib/edit/authz.ts:canEditUnit`). Work = extend `canEditUnit` to admit `comms_steward`.
  *Smallest.*
- **Overview generation for others** — the engine is built (`lib/edit/overview-generator.ts`,
  Bedrock; `authorizeOverviewWrite` already lists superuser/unit-admin/proxy). The block is a
  UI gate `generateEnabled={mode === "self"}` (`edit-page.tsx:488`). Overlaps **#742 Phase C**
  (bulk/org-wide generation, unstarted). Decide self-vs-bulk before spec-ing.

## 12. Threat model

- **In scope.** A `comms_steward` can globally hide/reveal method families, affecting public
  representation. Mitigations: fail-closed LDAP resolver; every tier change + review audited
  (`method_family` entity); surface scoped to families only (no profile writes, no other
  tabs); `COMMS_STEWARD_ENABLED` kill-switch; superuser superset but no reverse elevation.
- **Inert-sensitive misuse.** Steward believes a family is hidden when the sensitivity gate is
  off. Mitigation: the §2 live-gate banner; export/roster show effective public visibility,
  not just assigned tier.
- **Out of scope.** Steward editing profile fields; quarantine/approve-to-publish (deliberately
  rejected — allow-by-default); the term list being exhaustive (it isn't, by design — "one
  slips through" is accepted and caught by manual override).
- **Rejected alternative — review-before-publish quarantine.** Deny-by-default for novel
  families. Rejected: day-one backlog (every family is "new"), ongoing triage burden, and it
  fights the upstream gaps-only/allow-by-default grain. Surface-don't-block achieves the safety
  goal at a fraction of the cost.

## 13. Test matrix

| Case | Expected |
|---|---|
| Family in neither overlay | tier=Public |
| Family in suppression overlay | tier=Suppressed; hidden for everyone |
| Family in sensitivity overlay, gate **on** | tier=Sensitive; hidden public, shown internal |
| Family in sensitivity overlay, gate **off** | tier=Sensitive **but renders public**; UI warns |
| New `animal_cell_models` family after A2 ingest | flagged (`supercategory:…`), `isNew=true`, tier=Public |
| A2 relabels an existing family | new key ⇒ re-flagged, `isNew=true`, `reviewedAt=null` |
| Steward sets tier=Sensitive, then seed ETL runs | steward row **preserved** (`source='steward'`) |
| Seed ETL runs on a `source='seed'` family | upserted/replaced normally |
| Steward marks reviewed (no tier change) | `reviewedAt` set; tier unchanged; nag clears |
| Anonymous → any `/api/edit/methods/*` | 401 |
| Authenticated non-steward non-superuser | 404 (route) / 403 (API write) |
| `COMMS_STEWARD_ENABLED=off` | route + APIs 404; resolver returns false |
| Export with flag off | 404 |

## 14. Runnable audit SQL (provenance / validation)

```sql
-- Tier distribution across distinct families.
SELECT
  CASE WHEN s.family_label IS NOT NULL THEN 'suppressed'
       WHEN x.family_label IS NOT NULL THEN 'sensitive'
       ELSE 'public' END AS tier,
  COUNT(*) AS families
FROM (SELECT DISTINCT supercategory, family_label FROM scholar_family) f
LEFT JOIN family_suppression_overlay s USING (supercategory, family_label)
LEFT JOIN family_sensitivity_overlay  x USING (supercategory, family_label)
GROUP BY tier;

-- Already-slipped-through: public families that match the animal-model signal.
SELECT f.supercategory, f.family_label, r.reason
FROM (SELECT DISTINCT supercategory, family_label FROM scholar_family) f
JOIN family_review_flag r USING (supercategory, family_label)
LEFT JOIN family_suppression_overlay s USING (supercategory, family_label)
LEFT JOIN family_sensitivity_overlay  x USING (supercategory, family_label)
WHERE s.family_label IS NULL AND x.family_label IS NULL;   -- still public

-- Open review queue: flagged, not yet reviewed.
SELECT supercategory, family_label, reason, first_seen_at
FROM family_review_flag
WHERE reviewed_at IS NULL
ORDER BY first_seen_at DESC;
```

## 15. Open questions for sign-off

1. **Group ownership.** Who creates/owns the `comms-steward-role` LDAP group, and who are the
   initial members (External Affairs contacts)? (Blocks go-live, not build.)
2. **Term list seed.** Is the §6 animal-model term list the right v1, or does External Affairs
   want additional categories surfaced (e.g. human-subjects datasets, select agents)? Kept as
   editable data either way.
3. ~~**Suppression seeding.** #800's table is currently empty (no CSV/ETL). Restrict v1 to
   *Sensitive*, or also let stewards set *Suppressed*?~~ **RESOLVED — all three tiers in v1.**
   The steward UI is therefore the **first writer of #800's (empty) suppression overlay** as
   well as #801's. Consequence (accepted): `comms_steward` now owns both the reputational
   (Sensitive) and relevance (Suppressed) tiers — a deliberate blur of the
   Compliance-vs-Editorial split noted in §2; the audit trail still distinguishes intent via
   the `tier` value on each `family_tier_set` row.
