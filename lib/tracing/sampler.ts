import {
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-node";

/**
 * SDK-side sampler.
 *
 * The issue #123 acceptance criterion is "5% baseline + 100% on errors".
 * OTel head sampling cannot reverse a NotSampled decision -- if the SDK
 * drops a span, no span ever exists to promote on error. The error /
 * slow-trace promotion therefore has to happen in the ADOT collector's
 * `tail_sampling` processor (see `cdk/lib/otel-collector-config.yaml`),
 * which sees the full trace once it has ended.
 *
 * The SDK's job is then to record everything: `ParentBasedSampler(root =
 * AlwaysOn)`. Root spans (no parent) are always recorded; child spans
 * honor the parent context so downstream services stay consistent with the
 * decision that began the trace.
 */
export function createTracingSampler(): Sampler {
  return new ParentBasedSampler({ root: new AlwaysOnSampler() });
}
