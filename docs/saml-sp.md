# SAML SP — operator runbook (B01 #100)

Operator-facing procedures for the Scholars-Profile-System SAML service provider. The SP terminates WCM SSO in front of `/api/edit*` and `/edit/*`; the code lives at `lib/auth/saml.ts` and is configured through the `SAML_*` env vars documented in [`.env.example`](../.env.example) and [`lib/auth/config.ts`](../lib/auth/config.ts).

Three procedures, in order of how often you will need them:

1. **Staging smoke test** — manual end-to-end check that the SAML round-trip works against the real WCM IdP. Run once when staging is first wired up, then after any change to `lib/auth/*` or to the `SAML_*` secrets.
2. **IdP-certificate rollover** — what to do before **2026-08-19**, when the active IdP signing cert expires. Same procedure applies to every future rollover.
3. **Migrating to metadata-URL refresh** — the deferred follow-up. Replaces the concatenated-PEM env-var with a periodic pull from the IdP metadata document, so the next rollover is a no-op for operators.

The IdP team confirmed (issue [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100), comment 2026-05-21) that non-prod authenticates against the **same** production IdP — there is no separate staging IdP. The smoke test below therefore exercises the same trust relationship that production will use.

---

## 1. Staging smoke test

Pre-conditions:

- Staging cluster reachable at its public DNS name (B13).
- SP certificate installed; private key in Secrets Manager (B06) and published to the IdP team (we did this on 2026-05-20; SHA-256 `91:A1:86:0F:B8:66:16:B8:3D:DB:C0:C1:C9:C4:4C:F2:30:0B:D5:64:DC:B1:43:04:2A:53:A4:F4:2A:E2:68:90`, see [issue #100 comment](https://github.com/wcmc-its/Scholars-Profile-System/issues/100#issuecomment-4508287804)).
- A test CWID account known to be authorised in WCM SSO (your own is fine).

Walkthrough (single browser session, incognito so no stale cookie leaks in):

1. **SP metadata reachable.** `curl -sS https://<staging-host>/api/auth/saml/metadata | head -20` should return an `<EntityDescriptor>` XML document containing the SP entityID and a certificate node. If this 503s, `SAML_SP_*` config is incomplete; stop here.
2. **Open `/edit` unauthenticated.** Navigate to `https://<staging-host>/edit`. Expected: 302 to `/api/auth/saml/login` and on to the IdP. Verify the URL bar lands on `login-proxy.weill.cornell.edu/...`.
3. **Sign in at the IdP.** Use the test CWID. Expected: IdP POSTs the SAMLResponse to `https://<staging-host>/api/auth/saml/callback`.
4. **Cookie minted.** Open DevTools → Application → Cookies. Verify exactly one cookie named `__Secure-sps_session` (or `sps_session` if `SESSION_COOKIE_NAME` is overridden):
   - `HttpOnly` ✓
   - `Secure` ✓
   - `SameSite=Lax` ✓
   - `Domain=scholars.weill.cornell.edu` ✓ (in prod; staging will have the staging domain)
   - `Max-Age` ≤ 28800
5. **`/edit` reachable.** The callback should land you on `/edit` (the default return path; or whatever path was in `RelayState`). The page must render without redirecting back through SSO.
6. **Server-side validation works.** Open a new tab, hit `https://<staging-host>/api/edit/health` (or any `/api/edit*` route that doesn't need a body). Expected 200 (or the route's own success status). Now delete the `__Secure-sps_session` cookie and hit the same URL — expected 401 with no response body leakage.
7. **Logout.** Navigate to `https://<staging-host>/api/auth/saml/logout`. Expected: cookie is cleared and the next `/edit` hit re-runs the full SSO round-trip.

If any step fails, do not declare the smoke test passed. Capture the failing step number, the request/response in DevTools Network, and any server logs from the ECS task, and attach them to issue [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) or the active staging-cutover ticket. Common failure modes:

- IdP returns a SAML status error like `urn:oasis:names:tc:SAML:2.0:status:Responder` — almost always `SAML_SP_ENTITY_ID` doesn't match what the IdP team registered. Check the issue comment.
- `idp_status_error` or `invalid_saml_response` from the callback — signature mismatch. The IdP cert may have rotated, or `SAML_IDP_CERT` is the wrong cert. Re-pull metadata (see procedure 2).
- `no_cwid` from the callback — the IdP isn't releasing the attribute we expect. Confirm with the IdP team whether the CWID arrives in the assertion NameID (current default) or in a specific `<Attribute Name="…">` (then set `SAML_CWID_ATTRIBUTE`).

---

## 2. IdP-certificate rollover

> ### ⚠️ Hard calendar reminder: 2026-08-19
>
> The active WCM IdP signing certificate (CN `login-proxy.weill.cornell.edu`, issued 2016-08-19) expires on **2026-08-19**. The successor cert (issued 2026-03-27, expires 2036-03-27) is already published in the IdP metadata. **Trust both at the same time well before that date**, or every SSO login in this app will start failing the moment the IdP switches over.
>
> Set a calendar reminder for **2026-08-05** (two weeks before expiry) to verify the env-var is carrying both certs and that the post-rollover successor cert is still the one the IdP is signing with. Set a second reminder for **2026-08-26** (one week after expiry) to drop the expired cert from the env-var so the trust set is back down to one.

`SAML_IDP_CERT` accepts either a single PEM block or multiple PEM blocks concatenated with whitespace between them. The parser ([`parseIdpCert` in `lib/auth/config.ts`](../lib/auth/config.ts)) hands node-saml the list, and node-saml will accept an assertion signed by any cert in the list. This is what makes a rollover an env-var change rather than a code change.

### Two weeks before the IdP rotates

1. Pull the current IdP metadata document:
   ```bash
   curl -sS https://login-proxy.weill.cornell.edu/idp/saml2/idp/metadata.php > /tmp/wcm-idp-metadata.xml
   ```
2. Extract every `<ds:X509Certificate>` under an `<md:IDPSSODescriptor>` `<md:KeyDescriptor use="signing">` (or no `use=` — they default to signing). There should be two during a rollover.
3. For each base64 blob, wrap it as a PEM:
   ```
   -----BEGIN CERTIFICATE-----
   <base64 lines, 64 chars per line>
   -----END CERTIFICATE-----
   ```
   `openssl x509 -inform pem -noout -enddate -in <file>` on each one will confirm the expiry. Sanity check: one cert should match the currently-known active cert (issued 2016-08-19), the other the successor (issued 2026-03-27).
4. Concatenate both PEMs in a single string, with a blank line between them, and update the `SAML_IDP_CERT` value in AWS Secrets Manager (`scholars/saml-sp/<env>/idp-cert` or wherever it lives in the active deployment).
5. Trigger an ECS rolling deploy (no code change). Verify via the staging smoke test (procedure 1) that login still works — the IdP is still signing with the OLD cert at this point, so a successful login proves the cert array is correctly trusted in both shapes.

### The day of (or after) the IdP rotates

The IdP team usually rotates without a precise hand-off. Once they have rotated:

1. Repeat the smoke test (procedure 1, steps 2–6). A successful login now proves the SP also trusts the NEW cert.
2. If login fails: pull the metadata again. The IdP may have published a third cert or removed one early. Update `SAML_IDP_CERT` to match what the metadata currently lists and re-deploy.

### A week or two after the IdP rotates

1. Remove the expired cert from `SAML_IDP_CERT` so the trust set is back to one cert. Leaving an expired cert in the array is harmless (node-saml validates the signature, not the cert chain), but it is technical debt and confuses future operators.
2. Re-deploy. Smoke test once more.

### Validation commands

```bash
# Confirm the env value parses as the expected number of certs (run in a node REPL
# inside an ECS exec session against the live config, or against a local .env.local):
node -e 'const { parseIdpCert } = require("./lib/auth/config"); const c = parseIdpCert(process.env.SAML_IDP_CERT); console.log(Array.isArray(c) ? `array of ${c.length}` : "single string");'

# Confirm each PEM in the value is well-formed and inspect expiry:
node -e 'const m = process.env.SAML_IDP_CERT.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []; m.forEach((p, i) => { require("fs").writeFileSync(`/tmp/idp-cert-${i}.pem`, p); });'
for f in /tmp/idp-cert-*.pem; do echo "$f:"; openssl x509 -in "$f" -noout -subject -enddate -fingerprint -sha256; done
```

---

## 3. Migrating to metadata-URL refresh (future work)

The concatenated-PEM approach above is fine for the 2026 rollover and probably the 2036 one too, but every rollover still requires an operator to pull metadata, paste into Secrets Manager, and trigger a deploy. The next step is to teach the SP to refresh its trust set from the IdP metadata URL on an interval, so cert rotations are transparent.

When that is built (separate ticket — not in this PR):

1. Introduce `SAML_IDP_METADATA_URL` (set to `https://login-proxy.weill.cornell.edu/idp/saml2/idp/metadata.php`) alongside `SAML_IDP_CERT`. The metadata URL takes precedence; `SAML_IDP_CERT` becomes a fallback for offline development and tests.
2. Add a periodic background refresh (default 1h) that re-fetches the metadata, extracts the signing certs, validates each PEM, and atomically replaces the in-memory trust set. On fetch failure, keep serving with the previous set and emit a CloudWatch metric (`SamlMetadataFetchFailures`); after N consecutive failures, fall back to the env-var if present.
3. Cache the parsed metadata to a local file under `/tmp` so a restart doesn't go through a cold fetch.
4. Delete this section of the runbook (operators no longer need to do anything for a rollover) and replace it with a paragraph describing the failure modes of the refresh, where to find the CloudWatch metric, and how to force a manual refresh if the IdP team signals an emergency rotation.
5. Drop the `SAML_IDP_CERT` requirement from `.env.example` once `SAML_IDP_METADATA_URL` is mandatory in every environment.

Risks to weigh when this work starts:

- The auth path can no longer be fully self-contained — a partial outage of the IdP metadata host degrades login. Cache + grace period mitigates but does not eliminate this.
- The first request after restart needs to either block on the metadata fetch (cold-start latency) or accept that login fails for the first ~1s. Cache-on-disk solves the second restart but not the very first.
- Metadata signing: if WCM ever signs the metadata document itself, we must validate that signature with a long-lived signing key, otherwise an attacker who can MITM the metadata URL trivially swaps in their own IdP cert. Do not skip this.

---

## References

- Issue [#100](https://github.com/wcmc-its/Scholars-Profile-System/issues/100) — B01 acceptance criteria, IdP-team handoff comment.
- [`lib/auth/config.ts`](../lib/auth/config.ts) — `getSamlEnv()`, `parseIdpCert()`.
- [`lib/auth/saml.ts`](../lib/auth/saml.ts) — node-saml wiring, `validateSamlResponse`.
- [`.env.example`](../.env.example) lines 117–145 — the `SAML_*` block.
- [`@node-saml/node-saml`](https://github.com/node-saml/node-saml) v5 — the underlying library; `SamlConfig.idpCert` accepts `string | string[]`.
