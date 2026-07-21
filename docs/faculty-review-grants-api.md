# Faculty Review Tool — Grants API

Server-to-server read of a single scholar's **complete grant history** from the
Scholars Profile System (SPS), for the WCM-internal Faculty Review Tool.

This endpoint is a plain data read. It is **not** the same as
`/api/scholar/[cwid]/grants`, which is a session-gated topic-matching *search
widget* (needs a `q`, returns only the top few matches, off by default).

## Endpoint

```
GET /api/faculty-review/{cwid}/grants
```

| | |
|---|---|
| Base URL (staging) | `https://<sps-staging-host>` |
| Base URL (prod) | `https://<sps-prod-host>` |
| Path param | `cwid` — the scholar's CWID (1–32 chars) |
| Method | `GET` |
| Auth | `Authorization: Bearer <token>` (required) |
| Response | `application/json`, `Cache-Control: no-store` |

Consumption model: **per-faculty, on demand.** Look up one scholar at review
time; loop your review cohort client-side. There is no bulk/all-faculty
variant — do not poll it as a sync feed.

## Authentication

Every request must carry a shared bearer token:

```
Authorization: Bearer <FACULTY_REVIEW_TOKEN>
```

- The token is issued out-of-band by the SPS operator (WCM secret). Store it as
  a secret in your service; never commit it or put it in a URL.
- Comparison is constant-time. A missing, malformed, or wrong token → `401`.
- **Rotation:** during a rotation window both the current and the immediately
  previous token are accepted, so you can roll the token with no downtime —
  deploy the new token, then the operator retires the old one.
- If no token is configured on the SPS side, **every** request returns `401`
  (fail-closed). A `401` right after go-live usually means the secret has not
  been wired yet — contact the operator.

## Request example

```bash
curl -sS \
  -H "Authorization: Bearer $FACULTY_REVIEW_TOKEN" \
  "https://<sps-host>/api/faculty-review/abc1001/grants"
```

## Response

```jsonc
{
  "cwid": "abc1001",
  "count": 2,
  "grants": [
    {
      "externalId": "INFOED-1234567",
      "source": "InfoEd",
      "title": "Mechanisms of Tumor Immune Evasion",
      "role": "PI",
      "awardNumber": "R01 CA123456",
      "funder": "NCI",
      "primeSponsor": "NCI",
      "directSponsor": "NCI",
      "isSubaward": false,
      "programType": "Grant",
      "mechanism": "R01",
      "nihIc": "NCI",
      "applId": 9988776,
      "startDate": "2021-04-01",
      "endDate": "2026-03-31",
      "isActive": true
    }
  ]
}
```

### Envelope

| Field | Type | Notes |
|---|---|---|
| `cwid` | string | Echoes the requested CWID. |
| `count` | number | `grants.length`. |
| `grants` | array | Ordered **most-recent-end-date first** (active grants surface at the top). |

### Grant object

| Field | Type | Meaning |
|---|---|---|
| `externalId` | string | Stable, source-issued unique id. Use as the record key for dedupe/joins. |
| `source` | string | `"InfoEd"` (WCM-administered awards) or `"RePORTER"` (NIH prior-institution / dropped-WCM-history federal grants). |
| `title` | string | Project title. |
| `role` | string | This scholar's role on the grant: `PI`, `PI-Subaward`, `Co-PI`, `Co-I`, or `Key Personnel`. |
| `awardNumber` | string \| null | Sponsor-issued award number (e.g. `"R01 CA123456"`). `null` for awards without one (many industry/internal awards). |
| `funder` | string | Ready-to-display sponsor string (e.g. `"NCI"` or `"NCI via Duke University"`). Use this if you just need one label. |
| `primeSponsor` | string \| null | Canonical short name of the original source of funds; `null` when the raw sponsor isn't in the canonical lookup. |
| `directSponsor` | string \| null | Canonical short name of the institution that issued the (sub)award to WCM; equals prime when WCM holds the prime directly. `null` when not in the lookup. |
| `isSubaward` | boolean | `true` when the direct sponsor differs from the prime. |
| `programType` | string | `Grant`, `Contract with funding`, `Fellowship`, `Career`, `Training`, `BioPharma Alliance Agreement`, or `Equipment`. |
| `mechanism` | string \| null | NIH activity code derived from the award number (e.g. `"R01"`, `"K23"`, `"U01"`). `null` for non-NIH grants. |
| `nihIc` | string \| null | NIH funding Institute/Center (e.g. `"NCI"`, `"NHLBI"`). `null` for non-NIH grants. |
| `applId` | number \| null | NIH RePORTER application id for outbound deep-links (`reporter.nih.gov/project-details/<applId>`). `null` for non-NIH grants. |
| `startDate` | string | Project start, `YYYY-MM-DD`. |
| `endDate` | string | Project end, `YYYY-MM-DD`. |
| `isActive` | boolean | `true` while the grant is within its end date **plus a 12-month no-cost-extension grace window** — the same Active/Past definition the public profile shows. |

## Semantics you need to know

- **Full history.** This returns *every* grant SPS holds for the scholar,
  including old awards that are default-hidden on the public profile's recency
  filter. A review sees the complete record, not the display subset.
- **No dollar amounts.** SPS never ingests award `$` from InfoEd, so no funding
  totals / direct-cost figures are available here. If you need dollar amounts,
  the system of record is InfoEd, not SPS.
- **Two sources, deduped.** `InfoEd` rows are WCM-administered awards;
  `RePORTER` rows are NIH awards from a scholar's prior institution or dropped
  WCM history that InfoEd never had. RePORTER rows that duplicate an InfoEd
  award are already removed upstream.
- **Empty list is ambiguous by design.** A `200` with `count: 0` means *either*
  the scholar has no grants *or* the CWID isn't a scholar in SPS. The caller
  owns its cohort, so the endpoint does not spend a query distinguishing the
  two. Validate CWIDs on your side.
- **Never cached.** Responses carry `Cache-Control: no-store`; always fetch live.

## Errors

| Status | Body | Cause |
|---|---|---|
| `401` | `{ "error": "unauthorized" }` | Missing / malformed / wrong token, or no token configured server-side. |
| `400` | `{ "error": "invalid_cwid" }` | Empty CWID or longer than 32 chars. |
| `500` | `{ "error": "grant_lookup_failed" }` | Transient DB error — retry with backoff. |

## Data provenance

SPS is a **downstream** display copy of grant data — it materializes InfoEd and
NIH RePORTER awards into its own store and layers on canonical sponsor names,
NIH mechanism/IC derivation, and an Active/Past projection. It is the right
source when you want grants *as the Scholars profile presents them*, keyed to
the SPS CWID identity. For authoritative award financials, go to InfoEd.
