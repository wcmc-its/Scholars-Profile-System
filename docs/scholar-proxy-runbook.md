# Scholar-assigned proxy editor (#779) — operator smoke-test & audit runbook

**Scope.** The hands-on steps to validate the scholar-assigned proxy editor on a deployed
environment (the part that cannot be unit-tested): the SAML grant → proxy-edit → revoke
flow, plus the standing audit queries for support triage.

**Companion docs.** `docs/scholar-proxy-spec.md` (#779 design + threat model, ADR-005 Amendment 3) ·
`docs/scholar-proxy-unit-admin-amendment.md` + ADR-005 § Amendment 4 (the **role-derived org-unit
administrator** editing path — a second editor axis, smoke-tested in §1b below).
The authorization predicates, the grant/revoke endpoint, and the field/suppress/page proxy
branches are covered by unit tests (`tests/unit/proxy-*.test.ts`, `unit-scholar-authz.test.ts`,
`edit-proxy-route.test.ts`, the proxy cases in `edit-field-route` / `edit-suppress-route` /
`edit-scholar-page`); this runbook covers only what those can't — the live SAML round-trip and the
DB state.

**Status when written (2026-06-08).** `921480d` (PR #781) is deployed to **staging**; the
`scholar_proxy` table and the `manual_edit_audit` `proxy_grant`/`proxy_revoke` ENUM values
are confirmed applied there. **Prod** has not yet had #779 deployed (prod CD is approval-gated)
— run the prod pass after that deploy, pointing the queries at `sps-cluster-prod` / `sps-etl-prod`.

---

## 0. Prerequisites

1. **Environment deployed.** The target env runs an image ≥ `921480d` and its migration +
   db-bootstrap ran (see `docs/scholar-proxy-spec.md` § deploy and `CD` Deploy run logs:
   `sps-migrate-<env>` shows `Applying migration 20260608131356_add_scholar_proxy`, and the
   `db-bootstrap` step succeeded — it applies the ENUM `MODIFY COLUMN` silently from
   `scripts/sql/audit-log.sql`).
2. **A superuser SAML account** (in the `scholars-admins` group) — the grantor for the
   superuser-on-behalf path, and the only identity that can read the public/edit surfaces of a
   non-public scholar.
3. **A non-superuser, non-scholar SAML identity** to act as the *proxy*. This is the one
   genuine constraint: a superuser **cannot** be a proxy (D3 denies `proxy_is_superuser`), so
   you cannot exercise the proxy edit path with your own admin account. Use the canonical
   **Beth Chunn `bec4010`** (pure staff, no Scholar row), or any staging test identity that is
   neither a scholar nor a superuser.
4. **Test scholar.** Canonical: **Rahul Sharma `ras2022`**. Have a second, *unrelated* scholar
   cwid handy (`<other-scholar>`) for the negative cross-scholar test.
5. **Site URL** — staging `https://scholars-staging.weill.cornell.edu`, prod
   `https://scholars.weill.cornell.edu` (both WCM-network gated). Profiles render at
   `/scholars/<slug>`; the editor at `/edit` (self) and `/edit/scholar/<cwid>` (superuser/proxy).

---

## 1. Smoke test — the SAML flow

> **⚠️ Known blocker (staging, 2026-06-08).** The "Add a proxy editor" typeahead does a **live
> `ldaps://` directory search** (`searchDirectoryPeopleByName`); when WCM LDAP is unreachable
> from the SPS VPC the API returns `503 directory_unavailable` and the UI shows **"search
> failed."** This is the same WCM-network routing gap that blocks #443 / #746
> (`project_sps_vpc_wcm_connectivity` — needs TGW + WCM firewall for `10.20.0.0/16`). Until ED
> is routable, you cannot pick a person, so **Step 1 (and the name display in the panel) cannot
> run via the UI**. Workaround for a functional smoke test: POST the grant directly with a known
> cwid — `POST /api/edit/proxy {scholarCwid:"ras2022", proxyCwid:"bec4010", action:"grant"}` —
> which does not need the typeahead (note the grant's D3 superuser leg also calls LDAP and is
> fail-closed, so during an ED outage it resolves the candidate to *not* a superuser).

### Step 1 — Grant (superuser on the scholar's behalf)

1. As the **superuser**, open `/edit/scholar/ras2022` → the **superuser** edit surface renders.
2. Open the **"Proxy editors"** panel. In **"Add a proxy editor"**, use the directory typeahead
   to find and pick **Beth Chunn**, then click **"Add proxy editor"**.
3. **Expect:** HTTP **200**; a row appears in the table (`Person` = Beth Chunn · her title,
   `Added on` = today) with a **Remove** button.
4. **Negative — ineligible grantee:** repeat the add with a person who *is* a scholar or a
   superuser. **Expect 403** with an **opaque** `proxy_ineligible` error (the endpoint must not
   reveal *which* leg conflicted — threat CD-6).

> A scholar can also self-assign: signed in as `ras2022`, the same "Proxy editors" panel appears
> on `/edit`. The audit row's `actor_cwid` is the scholar (self) vs the superuser (on-behalf),
> and the proxy's notification copy branches "you designated…" vs "an administrator assigned…".

### Step 2 — Proxy edits (sign in as the proxy)

1. Sign in as **`bec4010`** (the proxy). Open `/edit`.
2. **Expect:** because Beth has exactly **one** grant, `/edit` redirects straight to
   `/edit/scholar/ras2022`. (A proxy serving *multiple* scholars instead lands on a picker —
   "Profiles you edit as a proxy" — and chooses one.)
3. **Expect** an **info banner** above the cards: *"You are editing **Rahul Sharma**'s profile
   as their designated proxy"* (visually distinct from the amber superuser banner).
4. Edit the **Overview** → **Save**. **Expect 200**.
5. Confirm the change is live on the public profile `/scholars/<sharma-slug>`.
6. **Hide one of the scholar's own publications** (the second in-scope proxy action): on the
   Publications surface, hide one of **Sharma's own** authorships. **Expect 200**; the pub drops
   from his profile.

### Step 3 — Negative gates (still signed in as the proxy)

1. **Cross-scholar:** navigate to `/edit/scholar/<other-scholar>`. **Expect** the **403
   Forbidden** edit page (the grant binds the exact `(scholar, proxy)` pair — threat PE-06).
2. **Allowlist (overview-only):** the proxy surface offers **only** Overview + own-publication
   hide. There is **no** slug, name/title, visibility-of-others, or unit field — those stay
   self/superuser-only (PE-03). Confirm the proxy cannot reach them.
3. **No designee management:** the **"Proxy editors"** panel is **absent** in proxy mode — a
   proxy can never grant or revoke (CD-2).

### Step 4 — Revoke

1. As the **superuser** (or as `ras2022` self), reopen `/edit/scholar/ras2022` → **"Proxy
   editors"** → click **Remove** on Beth's row → confirm **"Remove this proxy editor?"**.
2. **Expect 200**; the row disappears.
3. Sign back in as **`bec4010`** → `/edit`. **Expect** access is gone immediately (no grant →
   `/edit` 404s; `/edit/scholar/ras2022` 403s). The revoke takes effect on the **next request**
   — there is no cached grant.

### Step 5 — Seed the real grant

After the test passes, seed the production-intended grant: as superuser (or as `ras2022`),
grant **Beth Chunn `bec4010`** as a proxy for **Rahul Sharma `ras2022`** and leave it in place.

---

## 1b. Unit-admin path (ADR-005 Amendment 4)

A **second, role-derived** editor path: an **owner/curator of a department or division the scholar
belongs to** can edit that scholar's profile — distinct from the #779 per-scholar designee grant.
Unlike the #779 typeahead, this path is **DB-column/roster-sourced** (`Scholar.deptCode`/`divCode` +
`DivisionMembership`), so it **works even while ED/LDAP is unrouted** — contrast the §1 known blocker,
which only affects the #779 directory grant.

**Prereq:** a SAML identity that is an **owner or curator** of a unit the test scholar belongs to,
and is **neither** a #779 proxy of that scholar **nor** a superuser (so the unit-admin path — not a
broader one — is what's exercised). Grant the role via the #540 Administrators tab if needed.

1. Sign in as that **unit administrator**. Open `/edit/scholar/<member-cwid>` (a scholar in your unit).
2. **Expect** an info banner *"You are editing **<name>**'s profile as an administrator of their
   {department|division}, **<unit name>**"* — visually distinct from the #779 proxy + superuser
   banners. (Live on master — P2.)
3. Edit the **Overview** → **Save** → **Expect 200**; confirm it is live on `/scholars/<slug>`.
4. **Hide one of the member's OWN publications** → **Expect 200**; the pub drops from their profile.
5. **Negative — outside the unit:** open `/edit/scholar/<scholar-outside-your-unit>` → **Expect 403
   Forbidden** (the relation gate denies).

> **P3/P4 not-yet-landed (while #791 is pending):** the panel still reads **"Proxy editors"** (the
> rename to "Profile editors" + the read-only "Org-unit administrators" group is **P3**), and the
> add-proxy copy still excludes roled people (the relaxation to *"must not already be a Scholars
> administrator"* is **P4**). Re-check these two strings after #791 merges.

---

## 2. DB verification & standing audit queries

Spec § Audit queries (A–E). Run read-only against the env's Aurora. Two access tiers:

- **Queries C, D, E** read the **main** `scholars` DB (`scholar_proxy` / `scholar` / `unit_admin`)
  — runnable with the `etl` task user via the one-off `run-task` recipe below.
- **Queries A, B** read **`scholars_audit.manual_edit_audit`**, on which the `etl`/`app_rw`
  users have **no SELECT** (least-privilege — `app_rw` holds only INSERT). They require a
  credential with SELECT on `scholars_audit` (a DBA/read path), so they are **not** runnable via
  the `etl` recipe — `SELECT command denied to user 'etl' … manual_edit_audit (errno 1142)`.

### Read-only run-task recipe (queries C/D/E)

No SPS bastion + ECS Exec is off, so the lightweight path is a one-off task on the ETL family
(image has the `mariadb` driver + `DATABASE_URL` baked). See memory
`project_sps_prod_db_readonly_query`. Network identifiers below are **staging, current
2026-06-08** — re-derive if changed:
`aws ecs describe-services --cluster sps-cluster-staging --services sps-app-staging --query 'services[0].networkConfiguration.awsvpcConfiguration'`.

```bash
# Inline a node -e SELECT into the ETL task. Replace SQL_HERE with query C / D / E.
# Driver: the mariadb connector wants a mariadb:// URL — rewrite the mysql:// scheme,
# preserving the query string (TLS params) exactly as the app uses them.
cat > /tmp/q.js <<'JS'
const mariadb = require('mariadb');
(async () => {
  const conn = await mariadb.createConnection(process.env.DATABASE_URL.replace(/^mysql:/, 'mariadb:'));
  try { console.log(JSON.stringify(await conn.query(`SQL_HERE`), (_, v) => typeof v === 'bigint' ? Number(v) : v, 2)); }
  finally { await conn.end(); }
  process.exit(0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
JS
node -e 'const fs=require("fs");fs.writeFileSync("/tmp/ov.json",JSON.stringify({containerOverrides:[{name:"etl",command:["node","-e",fs.readFileSync("/tmp/q.js","utf8")]}]}))'

aws ecs run-task --cluster sps-cluster-staging --task-definition sps-etl-staging \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3],securityGroups=[sg-0e9f5358a40c016a5],assignPublicIp=DISABLED}" \
  --overrides file:///tmp/ov.json --started-by "proxy-audit" --query 'tasks[0].taskArn' --output text

# then: aws ecs wait tasks-stopped --cluster sps-cluster-staging --tasks <arn>
#       aws logs tail /aws/ecs/sps-etl-staging --since 10m --format short
```

> **Query D — RETIRED by ADR-005 Amendment 4 (D4).** Once the scholar / unit-admin proxy-conflict
> legs are dropped (a roled person may now be a proxy), query D's two DB legs flag *legitimate*
> states, and the only surviving conflict (superuser) is SQL-inexpressible / enforced live per-edit.
> The first-class job `npm run etl:proxy-drift` (PR #786) is **not built** — PR #786 is closed
> unmerged. The role-derived Amendment 4 path has no grant row that can go stale (it is re-evaluated
> live per request), so there is no drift analog to run. Query D below is retained as historical
> context only.

### The queries

```sql
-- C) Currently-active grants (current state of access). [etl recipe OK]
SELECT sp.scholar_cwid, sp.proxy_cwid, sp.granted_by, sp.created_at
FROM scholar_proxy sp ORDER BY sp.scholar_cwid, sp.created_at;

-- D) [OBSOLETE — ADR-005 Amendment 4 D4] D3 DRIFT WATCH — a proxy that since acquired a
--    Scholar/UnitAdmin role. After D4 those are NO LONGER conflicts (a roled person may be a
--    proxy), so a hit is a legitimate state, not drift. Retained as historical context only.
--    (Superuser leg is per-edit/live, not SQL-able.) [etl recipe OK]
SELECT sp.scholar_cwid, sp.proxy_cwid, sp.created_at AS granted_at,
       CASE WHEN s.cwid IS NOT NULL THEN 'scholar'
            WHEN ua.cwid IS NOT NULL THEN 'unit_admin' END AS conflicting_role
FROM scholar_proxy sp
LEFT JOIN scholar    s  ON s.cwid  = sp.proxy_cwid AND s.deleted_at IS NULL
LEFT JOIN unit_admin ua ON ua.cwid = sp.proxy_cwid
WHERE s.cwid IS NOT NULL OR ua.cwid IS NOT NULL
ORDER BY sp.created_at DESC;

-- E) Fan-out (D5): proxies serving many scholars. [etl recipe OK]
SELECT proxy_cwid, COUNT(*) AS scholars_served FROM scholar_proxy
GROUP BY proxy_cwid HAVING COUNT(*) > 1 ORDER BY scholars_served DESC;

-- A) All proxy-attributed edits (overview + pub hide): actor != target, not impersonated.
--    NOTE: also matches #540 unit-curator/superuser edits AND Amendment 4 org-unit-admin edits
--    (actor = admin; after_values.edited_via = 'unit_admin' with via_unit_type/via_unit_code set).
--    Join scholar_proxy (C) to isolate scholar-DESIGNEE-proxy edits; filter
--    after_values.edited_via to separate role-derived unit-admin edits. [needs scholars_audit
--    SELECT — NOT the etl recipe]
SELECT aa.ts, aa.action, aa.target_entity_id AS scholar_cwid,
       aa.actor_cwid AS editor_cwid, aa.request_id
FROM scholars_audit.manual_edit_audit aa
WHERE aa.target_entity_type = 'scholar' AND aa.actor_cwid <> aa.target_entity_id
  AND aa.impersonated_cwid IS NULL
  AND aa.action IN ('field_override','suppression_create')
ORDER BY aa.ts DESC;

-- B) Grant / revoke trail. Any row with impersonated_cwid NOT NULL is a coding bug
--    (a grant must never be impersonated). [needs scholars_audit SELECT]
SELECT aa.ts, aa.action, aa.target_entity_id AS scholar_cwid,
       aa.actor_cwid AS grantor_cwid, aa.impersonated_cwid,
       JSON_UNQUOTE(JSON_EXTRACT(aa.after_values,  '$.proxy_cwid')) AS proxy_granted,
       JSON_UNQUOTE(JSON_EXTRACT(aa.before_values, '$.proxy_cwid')) AS proxy_revoked
FROM scholars_audit.manual_edit_audit aa
WHERE aa.target_entity_type = 'scholar' AND aa.action IN ('proxy_grant','proxy_revoke')
ORDER BY aa.ts DESC;
```

---

## 3. Pass / fail checklist

| # | Check | Pass |
|---|---|---|
| 1 | Superuser grants Beth → Sharma | 200, row in "Proxy editors" |
| 2 | Granting a scholar/superuser as proxy | 403 opaque `proxy_ineligible` |
| 3 | Beth `/edit` → redirected to `/edit/scholar/ras2022` + proxy banner | banner shows "…as their designated proxy" |
| 4 | Beth edits Sharma's Overview → Save | 200; live on `/scholars/<slug>` |
| 5 | Beth hides one of Sharma's **own** pubs | 200; pub drops |
| 6 | Beth visits `/edit/scholar/<other-scholar>` | 403 Forbidden |
| 7 | Proxy surface offers only Overview + own-pub hide; no "Proxy editors" panel | structurally absent |
| 8 | Revoke Beth | 200, row gone; Beth loses access on next request |
| 9 | Query B shows the grant + revoke rows, `impersonated_cwid` NULL | rows present, never impersonated |

**Cleanup.** Remove any throwaway test grants; **leave the real Beth → Sharma grant seeded**.

---

## 4. Prod

Repeat §1 and §2 on prod once #779 is deployed there (approval-gated CD), substituting
`sps-cluster-prod` / `sps-etl-prod` and the prod subnets/SG (re-derive from `sps-app-prod`).
Prod CD must show the `db-bootstrap` + migration steps green before the proxy route serves a
grant — a missing ENUM value rolls back every grant transaction (`write_failed`).
