import { describe, expect, it } from "vitest";
import { context, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-node";
import { createTracingSampler } from "@/lib/tracing/sampler";

function rootContext() {
  return context.active();
}

function contextWithParent(sampled: boolean) {
  return trace.setSpanContext(context.active(), {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

describe("createTracingSampler", () => {
  const sampler = createTracingSampler();

  it("records every root span (AlwaysOn at the root)", () => {
    const decision = sampler.shouldSample(
      rootContext(),
      "0af7651916cd43dd8448eb211c80319c",
      "GET /",
      SpanKind.SERVER,
      {},
      [],
    );
    expect(decision.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("respects a sampled remote parent (child stays sampled)", () => {
    const decision = sampler.shouldSample(
      contextWithParent(true),
      "0af7651916cd43dd8448eb211c80319c",
      "GET /child",
      SpanKind.SERVER,
      {},
      [],
    );
    expect(decision.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("respects an unsampled remote parent (child stays unsampled)", () => {
    const decision = sampler.shouldSample(
      contextWithParent(false),
      "0af7651916cd43dd8448eb211c80319c",
      "GET /child",
      SpanKind.SERVER,
      {},
      [],
    );
    expect(decision.decision).toBe(SamplingDecision.NOT_RECORD);
  });
});
