import { registerOTel } from "@vercel/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { readResourceAttrs, resourceAttributes } from "./attrs";
import { createTracingSampler } from "./sampler";
import { RedactionSpanProcessor } from "./redact";

/**
 * Boot the OTel SDK for the Next.js server runtime.
 *
 * Called once from the repo-root `instrumentation.ts` register() hook --
 * Next.js guarantees that hook runs before any route module loads, which is
 * what `@prisma/instrumentation` needs to patch the Prisma client before
 * the first query.
 *
 * The exporter posts OTLP/HTTP to localhost:4318 -- the ADOT collector
 * sidecar bundled in the same ECS task. The sidecar is the component that
 * implements "5% baseline + 100% on errors" via its tail_sampling
 * processor (see cdk/lib/otel-collector-config.yaml); the SDK runs at
 * AlwaysOn (every root span recorded). Tail sampling is the only way to
 * deliver the error-promotion rule cleanly -- head sampling can't reverse
 * a NotSampled decision.
 *
 * Redaction is default-on via RedactionSpanProcessor; per-span opt-out is
 * `span.setAttribute("sps.trace.redact", "off")` and the documented
 * "ask before flipping" global kill switch is `SPS_TRACE_REDACT=off`.
 *
 * Setting OTEL_EXPORTER_OTLP_ENDPOINT outside that ECS sidecar context
 * (e.g. a developer pointing at a local collector) just changes which
 * collector the exporter talks to -- nothing else in the boot path moves.
 */
export function initTracing(): void {
  const attrs = readResourceAttrs();
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  registerOTel({
    serviceName: attrs.serviceName,
    attributes: resourceAttributes(attrs),
    propagators: [new AWSXRayPropagator(), "tracecontext"],
    traceSampler: createTracingSampler(),
    spanProcessors: ["auto", new RedactionSpanProcessor()],
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
}
