# Distributed tracing

Implements issue #123 (B24). The goal is to render a CloudFront -> ALB -> ECS
-> Aurora request as a single trace, so debugging a slow `profile_view` page
becomes "open the trace, find the longest Prisma span" instead of "scroll
through 20 minutes of CloudWatch logs."

## Backend choice: OpenTelemetry (ADOT) -> AWS X-Ray

The issue body said "X-Ray or OpenTelemetry." We use the OTel SDK on the
application side and the AWS Distro for OpenTelemetry (ADOT) collector as a
Fargate sidecar that exports to AWS X-Ray.

Why over a plain X-Ray SDK:

- **Standards-based + portable.** Swapping X-Ray for Tempo / Honeycomb /
  Datadog later only edits the sidecar config; the application code is
  untouched.
- **First-class Prisma + Next.js support.** `@prisma/instrumentation` is an
  OTel-native auto-instrumentation; `@vercel/otel` wires the App Router
  into OTel in ~10 lines. The X-Ray SDK has no equivalent.
- **Sampling lives in the SDK / sidecar**, not in the AWS service. Tunable
  without a redeploy of CDK -- edit `cdk/lib/otel-collector-config.yaml`
  and re-deploy AppStack.

Cost ballpark at 5% baseline + 100% on errors: under $2/mo X-Ray
($5/1M traces recorded). The collector sidecar adds ~0.25 vCPU + 256 MB
RAM per task -- negligible against the existing Fargate sizing.

## Architecture

```
  Browser ─▶ CloudFront ─▶ ALB ─▶ ECS task ───────────────┐
                                   ├─ app container       │
                                   │   (Next.js + Prisma) │
                                   │   OTLP/HTTP          │
                                   ▼   localhost:4318     │
                                   ├─ otel-collector ─────┼─▶ AWS X-Ray
                                   │   sidecar            │
                                   │   tail-samples       │
                                   │   here               │
                                   └──────────────────────┘
```

The app posts OTLP/HTTP to `localhost:4318` inside the task -- the sidecar
shares loopback with the app via Fargate's task networking. Outbound from
the sidecar to X-Ray goes via NAT (no X-Ray VPC endpoint provisioned today;
adding one is a NetworkStack edit and out of B24 scope).

### CloudFront -> ALB gap

Until EdgeStack (B07+B14) ships its origin-verify header and X-Ray
propagation, **traces start at ALB** -- the CloudFront edge id does not
land in the trace. The ALB-as-root segment is the documented merge-window
state; revisit once EdgeStack lands.

## Sampling: 5% baseline + 100% on errors

Issue #123 requires "5% baseline + 100% on errors." OTel head sampling
cannot reverse a NotSampled decision -- if the SDK drops a span, no span
exists to promote on error. The error promotion therefore has to happen
**after** the span is recorded, at the collector, where the trace status
is known.

- **SDK** (`lib/tracing/sampler.ts`): `ParentBasedSampler(root=AlwaysOn)`.
  Every root span is recorded. Child spans honor the parent context so
  downstream services stay consistent with the trace.
- **Collector** (`cdk/lib/otel-collector-config.yaml`): the `tail_sampling`
  processor evaluates each completed trace against three policies, in
  order:
    1. `errors` (`status_code = ERROR`) -> 100% kept
    2. `slow` (`latency > 1500 ms` -- the latency SLO threshold) -> 100% kept
    3. `baseline` (`probabilistic 5%`) -> 5% kept

Drops happen at the collector, before the `awsxray` exporter -- the X-Ray
bill tracks the kept-trace rate (~5% baseline + every error + every slow
trace), not the SDK's 100% recording rate.

**Trade-off:** 100% in-SDK recording slightly raises per-request CPU vs
head-sampling 5%. The documented requirement is non-negotiable; tail
sampling is the only way to deliver it cleanly.

### Tuning the sampling rate

Edit `cdk/lib/otel-collector-config.yaml`, then:

```
cd cdk
npx cdk deploy --exclusively Sps-App-staging
```

No app-image rebuild required -- the collector reads the config from a
container env var assembled at synth time from the YAML file.

## PII / redaction

Default-on in every env. The cost of an over-redacted span is "a field
reads `sha256:<first-12>` instead of plaintext"; the cost of leaking an
identifier into X-Ray retention is much larger (audit, blast radius into
the observability backend).

What gets hashed:

- **Prisma SQL is fine.** Prisma uses parameterized queries, so column /
  table names render but values never appear in the statement string.
- **Prisma parameter values** (`db.statement.parameters`) -> hashed.
- **Identifier-key attributes** (`cwid`, `email`, `pmid`, `personId`,
  `infoEdId`, `orcid` -- and any nested key whose last dotted segment
  matches) -> hashed.
- **Dynamic route segments** under `http.target` / `http.url` / `url.path`
  / `url.full` -- the segment after a known route key (`/scholar/`,
  `/publication/`, `/person/`, `/edit/`) is hashed while the route shape
  is preserved. So `/scholar/0000-0002-1234-5678` becomes
  `/scholar/sha256:abcdef012345` and the route stays human-readable in
  X-Ray.

### Per-span opt-out

For the rare debugging case where a plaintext value is needed:

```ts
import { trace } from "@opentelemetry/api";

const span = trace.getActiveSpan();
span?.setAttribute("sps.trace.redact", "off");
```

The opt-out skips redaction for that single span. Reasoning must be
recorded in the calling code -- this is not a fire-and-forget knob.

### Global kill switch (ask before flipping)

`SPS_TRACE_REDACT=off` bypasses the redaction processor entirely. The
switch exists for emergencies; flipping it sends raw identifier values
into X-Ray retention. **Ask before flipping in production.**

## How to debug a slow request

1. Identify the affected request in CloudWatch (path + approx timestamp).
2. Open the [X-Ray service map](https://console.aws.amazon.com/xray/) in
   the same AWS account; filter to `service.name = Scholars-prod` (or
   `Scholars-staging`) plus the relevant time window.
3. The trace list shows kept traces only. Errors + traces > 1500 ms are
   always kept; the rest is the 5% baseline sample. If the request you
   want isn't there and wasn't an error / wasn't slow, you may have to
   reproduce it.
4. Open the trace timeline. Prisma spans render with the query type and
   a redacted parameter array. The longest span is the bottleneck; if
   it's a Prisma span, the SQL is in the span's `db.statement`
   attribute. Cross-reference against the slow-query log in CloudWatch
   if you need the actual values.

## Local smoke test

Run a stdout-printing OTel collector against a local app:

```
docker run --rm -p 4318:4318 otel/opentelemetry-collector \
  --config /dev/stdin <<'EOF'
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
EOF

# In another terminal:
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm run dev

# Hit a route that talks to Prisma:
curl http://localhost:3000/scholar/<cwid>
```

The collector terminal should print spans for the HTTP request and the
Prisma query within ~5 s of the request completing.

## What is NOT instrumented

B24 covers the Next.js server runtime + Prisma. The following are out of
scope and would each be their own follow-on workstream:

- **Browser client.** No `@opentelemetry/instrumentation-document-load`
  or similar. RUM stays on the existing CloudFront access logs for now.
- **ETL Lambdas.** EtlStack runs Step Functions over per-source ETL
  Lambdas; tracing those needs the Lambda OTel layer + ADOT collector
  extension, scoped under a future EtlStack workstream.
- **CloudFront edge.** See the "CloudFront -> ALB gap" note above --
  ships with EdgeStack.

## Risks already taken

- **Next 15 + Turbopack hot reload** sometimes fails to honor the root
  `instrumentation.ts` on dev hot reload. Smoke test on `next build &&
  next start` (production mode) as well as `next dev` after any change to
  the instrumentation hook.
- **`@prisma/instrumentation` vs Prisma 7 driver-adapter.** The OTel
  instrumentation patches the engine event path, which is engine-agnostic,
  so it works under the adapter-mariadb driver. Watch for changes here
  on Prisma minor bumps.
- **`AWSXRayDaemonWriteAccess`** is a managed policy that includes more
  than the two actions we need. We use a custom inline grant on the task
  role with exactly `xray:PutTraceSegments` + `xray:PutTelemetryRecords`
  on `Resource: *` (X-Ray Put* actions don't accept resource scoping).
  The assertion in `cdk/test/app-stack.test.ts` pins the action surface;
  any future PR that swaps to the managed policy will fail it.
- **Sidecar image pinning by digest.** `ADOT_COLLECTOR_IMAGE` in
  `cdk/lib/app-stack.ts` is pinned by SHA, not `:latest`. Look up the
  next bump with:

  ```
  aws ecr-public describe-images \
    --repository-name aws-otel-collector \
    --image-ids imageTag=v0.43.3 --region us-east-1
  ```
