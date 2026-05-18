# Runbook — rotating the `/api/revalidate` bearer token

`POST /api/revalidate` is the webhook the ETL orchestrator calls to bust the
ISR cache after a run. It authenticates an `Authorization: Bearer` token
(issue #103 / B04).

- **Secret:** `scholars/revalidate-token` in AWS Secrets Manager.
- **Injected as:** `SCHOLARS_REVALIDATE_TOKEN` (current) and — only during a
  rotation window — `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS` (the prior token).
- **Cadence:** rotate quarterly, and immediately on any suspected exposure.
- **Code:** `lib/revalidate-auth.ts`, consumed by `app/api/revalidate/route.ts`
  (verifier) and `etl/orchestrate.ts` (caller).

## Why two tokens

The app reads the accepted tokens once and caches them for the process
lifetime — a fresh process (a cold start, or a redeploy) is the only thing
that re-reads the environment. During a rotation the app tasks and the ETL
callers do not all pick up the new token at the same instant. Accepting both
the current and the previous token for a window means no caller gets a 401
mid-rotation.

## Rotation procedure

1. **Generate** a new token — a strong random value, e.g.
   `openssl rand -base64 32`.

2. **Stage both tokens in the secret.** Set `scholars/revalidate-token` so the
   new value is the current token and the *outgoing* value is the previous
   token. In environment terms: `SCHOLARS_REVALIDATE_TOKEN` = new,
   `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS` = old.

3. **Force the app to re-read it.** Redeploy the app service so every task
   restarts with a fresh process. Until this happens, running tasks still hold
   only the old token (which is fine — it is now the *previous* token).

4. **Roll the callers.** Deploy the ETL so it sends the new token (it reads the
   same `SCHOLARS_REVALIDATE_TOKEN`).

5. **Verify the window is open.** Trigger a revalidate from the ETL path, or
   `curl` the internal endpoint with the new token, and confirm a `200`.
   Confirm the old token also still returns `200`.

6. **Close the window.** After at least 24 h — one full ETL cycle — drop
   `previous` from the secret so `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS` is unset,
   and redeploy the app once more. The old token is now rejected.

## Failure modes

- A request with no token, the wrong token, or a non-`Bearer` scheme → `401`;
  the response body never echoes the presented token.
- Neither token configured (`SCHOLARS_REVALIDATE_TOKEN` unset) → `500`
  `server misconfigured`, never a silent allow.

## Quarterly reminder

There is no automated job — rotating a production secret is a deliberate
operator action. Add a recurring **quarterly calendar entry** ("Rotate
`scholars/revalidate-token`") for whoever owns the deployment.
