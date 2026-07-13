# Sponsor-match followups — what shipped, and what §6d/§6e actually cost

Date: 2026-07-13
Supersedes the cost estimates in `docs/2026-07-13-sponsor-match-iteration-handoff.md`.
Branch: `feat/sponsor-match-followups`.

## 0. The correction that reframes this one

The prior handoff's §3 recommended a standing check — *"before building anything new on this
surface, grep both directions for every optional field on the contract: who writes it, who
reads it."* We ran it, and then we ran an adversarial review over our own diff. Between them
they overturned **four** of the plan's premises and found **seven** real defects in the first
commit. The plan was not wrong to propose the work; it was wrong about what the work costs,
in every case in the same direction — the cheap items were cheaper than stated and the cheap-
sounding items were not cheap at all.

Worth stating plainly, because it is the lesson that generalises: **§6b's "cheap LLM call" and
§6e's "unblocked today" were both confident, both load-bearing, and both false.** Neither was
checkable from the handoff. Both took one grep.

## 1. Shipped (this branch)

| Item | Shipped as | Note |
|---|---|---|
| §2 person-type facet | `SponsorMeasures.roleCategory` + facet + filter + CSV column | Cheaper than specced — the spine already SELECTed the column and dropped it |
| §6a paste read-back | `lib/sponsor-paste-highlight.ts` + `PasteReadback` | Honest LOWER BOUND, see §2 below |
| §6b the ask | `sponsorAskFrom` — **derived, no Bedrock call** | See §3 — the specced design was rejected |
| §6c submission dedup | sha256 key + `shouldCache` gate | See §4 — nearly shipped a stuck-failure bug |

Also: deleted `SponsorFacet` (declared, no producer, no consumer); made `preferenceBoost`
exhaustive with a `never` default, which the contract's header already claimed but did not
enforce.

**Handoff item 1 (`submittedBy` on the intake queue) was already shipped** — it renders at
`components/edit/opportunity-intake-panel.tsx:253`. The handoff called it "the cheapest win on
this list." It was already done.

## 2. §6a is a lower bound, and the UI says so

The extractor's own prompt instructs canonicalisation: *"prefer the standard medical term over
the sponsor's jargon: 'cystic fibrosis', not 'CF'"* and *"expand abbreviations"*
(`sponsor-match-extract.ts:123-127`). So a concept's canonical form frequently does **not**
appear in the paste, and no string matcher can anchor it. Marking is therefore a lower bound on
the decomposition, never a picture of it.

That is not a bug to be fixed in the client. Closing it honestly requires the extractor to emit
the verbatim span it read each concept from — a **server + prompt** change, and that prompt is
eval-tuned (#1681 swept K and γ against it). Not a change to make for a highlight.

What the panel does instead: state the count out loud, and never let an unmarked paragraph read
as "the matcher ignored this."

## 3. §6b — there is no cheap model to call

The plan said: *"a separate call with its own small prompt… cheap model, low token ceiling."*

**There is no cheap model available to this service.** `cdk/lib/app-stack.ts:761-776`
(`TaskRoleBedrockPolicy`) grants `bedrock:InvokeModel` on exactly four ARNs — Opus 4.8 and
Sonnet 4.x — and the comment at :757 says the wildcards were chosen *"while still excluding
Haiku and every non-Anthropic provider."* The exclusion is deliberate. So the "cheap call" was
a **second Sonnet call**, at the same per-token price as the extractor, on a route that has
**no rate limit** (every sibling LLM surface has one: `lib/edit/rate-limit.ts`). It would have
roughly doubled sponsor-match LLM spend, and needed a new flag wired per-env in `app-stack.ts`
plus a cdk deploy in both envs before it could run without an `AccessDenied`.

To name something the extractor **had already told us**.

`sponsorAskFrom` builds the title from the top two concepts plus any detected preference, and
reuses the preference's existing verbatim paste quote. No Bedrock, no flag, no deploy, no eval
risk. It cannot fail, cannot time out, and costs nothing. **This removed §6b from the critical
path of §6d entirely** — the title no longer depends on an LLM call, so persistence no longer
waits on one.

## 4. §6c — the cache nearly shipped a stuck failure

Two things the plan did not anticipate, both caught only by review:

**The paste was going to be cached.** The plan proposed storing `{hash → ranked cwids +
concepts + preferences}`. But `SponsorPreference.evidence` is a verbatim ±40-character slice of
the paste (`sponsor-preferences.ts:127-132`) — caching it would have stored the sponsor's prose,
the exact thing the route promises never to retain. Preferences are now recomputed per request
(they are a pure sync function; they were never the expensive part).

**A Bedrock outage would have become sticky.** `extractSponsorConcepts` does not throw on
throttle/timeout — it logs and returns `[]` — so the engine *resolves* with an empty result, and
a resolved value is a cacheable value. A ten-second blip would have been frozen into the cache,
and the officer's re-submit — the very thing that would have healed it — would have been served
the cached empty, instantly, with no retry. **The cache would have converted a transient,
self-healing outage into a sticky one, invisibly**, because an instant empty result looks
exactly like "this paste genuinely matches nobody."

Ceiling, stated because it is real: the cache is **per-task**, and prod runs 2–6 tasks with no
ALB stickiness (`cdk/lib/config.ts:735`), so the hit rate is ~1/N, not 1. It is never a *loss* —
a miss is exactly today's behaviour — but do not expect dedup to be reliable. Making it shared
would mean writing derived-from-sensitive-text data to S3 (the ISR cache handler is on in both
envs), which is the trade the "never persisted" promise refuses.

The TTL question the plan left open is **moot**: the reused cache's 30-minute staleness ceiling
means no entry can outlive a nightly ETL run.

## 5. §6d — persist the submission: NEEDS A DECISION

Buildable now (§6b no longer gates it). But it is a **design reversal** and there is a fork the
plan did not name.

`app/api/edit/sponsor-match/route.ts:6-7` states, as a deliberate property: *"the pasted text is
a query, never persisted."* Persisting a submission record makes that route a writer. The
"never the paste" constraint is right and sufficient — but the doc comment becomes false the
moment a row is written, and in this repo doc comments are treated as contracts.

**The fork — and they cost very differently:**

| Option | Cost | Catch |
|---|---|---|
| **New Prisma model** (copy `SlugRequest`, `schema.prisma:2462`) | Clean additive migration | Required anyway if officers must LIST past submissions |
| **B03 audit row** (`lib/edit/audit.ts`) | No schema change — it already persists actor + timestamp + JSON | `manual_edit_audit.target_entity_type` is a **MySQL ENUM**; a new value is NOT a Prisma migration, it rides `scripts/sql/audit-log.sql` + a **db-bootstrap run per environment** |

Note the sibling precedent is ambiguous: opportunity-intake persists to **DynamoDB**
(`opportunity-intake/route.ts:128`), not Prisma. "Follow the intake pattern" does not resolve it.

**The recommendation: a new Prisma model, and only if the submissions LIST is actually wanted.**
A persisted row with no reader is the seventh instance of this repo's dominant defect — the one
the prior handoff's §3 is entirely about. If the goal is only "the officer can refer back to a
past search", the panel **already** has per-officer history in localStorage. The genuinely new
capability is *cross-officer* visibility. That is a real thing to want, but it should be wanted
out loud, because it is the whole justification for reversing the route's posture.

**Decide:** cross-officer submissions list — yes or no? If yes, it ships as model + write + read
API + a panel section, together, in one PR.

## 6. §6e — copy-emails is a POLICY NO-GO, not a deferral

The plan said Phase 1 is *"unblocked right now"* because the abstention floor prerequisite is
met. The floor is indeed met. **The blocker is somewhere else entirely, and it is not
negotiable.**

1. **The policy forbids it by name.** `docs/email-visibility-spec.md:87-90`: *"We do not support
   bulk download of WCM scholars, even for internal users."* Enforced as
   `SCHOLAR_EXPORT_CAP = 50` (`lib/api/export-scholars.ts:57`) with a hard server refusal. The
   sponsor-match pool is **up to 800** candidates and the route passes no limit. "Copy all
   visible emails" *is* the bulk download the policy refuses.

2. **The visibility filter FAILS OPEN, and prod is the failing case.**
   `isEmailExportableByReleaseCode` is `if (!isEmailReleaseGateEnabled()) return true;` — and
   `PROFILE_EMAIL_RELEASE_GATE` is `off` in prod (`app-stack.ts:2066`). So a copy-emails button
   on prod would emit **every** scholar's email with zero regard for their Web Directory release
   code — re-creating the exact over-disclosure the spec was written to prevent, in the one
   surface where the harm is irreversible: an outbound mass send by a fundraising officer.

3. **And turning the gate on does not fix it.** Prod's `email_visibility` is NULL for every row
   until its ED backfill runs, and NULL is fail-closed — so every email blanks and the feature
   ships inert. The prod backfill has never run; it needs the LDAP→S3 bridge (#898), because the
   in-VPC ED ETL cannot reach WCM LDAP (#443). **That is an ETL/infra task, not app code.**

**There is no prod flag state in which §6e both works and complies.**

The only compliant path, for whenever it is wanted:
- a per-row `mailto:` reveal (copy `app/api/profile/[cwid]/contact-email/route.ts`), **or** a
  checkbox selection hard-capped at the shared `SCHOLAR_EXPORT_CAP`;
- stacking `isEmailVisibleToViewer` + `isPubliclyDisplayed`, behind `PROFILE_EMAIL_RELEASE_GATE`;
- **after** the prod ED backfill lands.

The contact log — *(opportunity, recipient, date)*, so the same faculty are not repeatedly
approached — is worth building **independently** of the email export, and is unblocked. The
prior handoff was right that it is the part protecting the institution's relationship with its
own faculty. It does not need anyone's email to work.

## 7. A live prod bug this surfaced (not in scope, needs an issue)

`evidence` is produced by the **bespoke** engine and rendered by the panel
(`sponsor-match-panel.tsx:885`), but is **not produced by the spine** — and #1687 made the spine
the prod default. **The "Why this match — top papers" block is empty in prod right now.**

This is not a dead optional field to delete: it is live, rendered UI whose producer only exists
on the other engine. Connecting it needs the match-explain aggregation the spine deliberately
skips (`skipFacetAggs`) — a retrieval round-trip, not a contract edit. Deleting it would remove
working bespoke UI. Either way it is a real decision, and it should be an issue.

## 8. Still true from the prior handoff

- `scripts/search-eval/sponsor-fixtures-union.json` is untracked, carries real CWIDs, exists
  only in the canonical checkout. **Back it up; never commit it** (public repo).
- Topical baseline, staging, 2026-07-13, commit `181042b5`: meanNDCG@20 = 0.726, meanρ = 0.544,
  coverage 573/637.
- **Nothing in this branch touches the ranking**, so that baseline still holds and no eval re-run
  is required. (`sponsorAskFrom` is display-only; the cache returns the same engine output; the
  facet filters client-side.)
- §4's preference-bearing fixtures remain the only way to ever score λ, and remain the one item
  here that needs a human judgment call rather than code. The eval also does not currently
  exercise `preferenceBoost` at all — `sponsor-eval.sh:90` reads only `.candidates[].cwid`, and
  the route ships the un-nudged order by design. Measuring λ needs a nudge-aware scoring step
  in the harness first. Budget that before any weighting work, or it is unmeasurable.
