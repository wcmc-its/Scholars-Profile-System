import { createHash } from "node:crypto";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";

/**
 * Redaction processor.
 *
 * Default-on in every environment. The cost of an over-redacted span is "a
 * field is `sha256:<first-12>` instead of plaintext"; the cost of a leaked
 * identifier into X-Ray retention is much higher. A per-span opt-out is
 * available for the rare debugging case where a plaintext value is needed:
 *
 *   span.setAttribute("sps.trace.redact", "off")
 *
 * A global kill switch (`SPS_TRACE_REDACT=off`) bypasses the processor
 * entirely. The kill switch is documented in `docs/tracing.md` as
 * "ask before flipping" -- it exists for emergencies, not regular
 * operation.
 */

const PER_SPAN_OPT_OUT_KEY = "sps.trace.redact";
const PER_SPAN_OPT_OUT_VALUE = "off";

/**
 * Span attribute keys whose values are hashed before export. Keys that match
 * one of these literals OR end with `.<key>` are redacted -- so an
 * instrumentation that emits `http.target` or `http.route` covering a
 * dynamic segment like `/scholar/[cwid]` will have its value processed by
 * the path-segment redactor below, while a Prisma span with the raw
 * `cwid: '0000-0002-...'` parameter has the value hashed in place.
 */
const IDENTIFIER_KEYS = new Set<string>([
  "cwid",
  "email",
  "pmid",
  "personid",
  "infoedid",
  "orcid",
]);

/**
 * Prisma's `@prisma/instrumentation` emits parameter values on this key.
 * Hash the whole array so a single redact pass covers every value.
 */
const PRISMA_PARAMETERS_KEY = "db.statement.parameters";

/**
 * Next.js dynamic-route segments arrive on `http.target` / `http.route`
 * as `/scholar/0000-0002-...` after the router resolves them. The pattern
 * `/<segment>/<value>` for any segment in this set gets the value hashed
 * while preserving the route shape -- so `/scholar/0000-0002-...` becomes
 * `/scholar/sha256:abcdef012345` and the route stays human-readable in
 * X-Ray's UI.
 */
// Only segments whose FOLLOWING segment is an identifier value belong here.
// "edit" was wrong on both counts: it is a static segment whose successor is
// another static name (/edit/scholar/<cwid>, /edit/publication/<pmid>), so
// matching it hashed the literal word "scholar" and — because the walk then
// re-inspected the hashed segment instead of skipping it — let the actual
// CWID through in plaintext. The id-bearing parents below cover the /edit
// routes on their own.
const REDACT_PATH_SEGMENTS = new Set<string>([
  "scholar",
  "publication",
  "person",
]);

const PATH_BEARING_KEYS = new Set<string>([
  "http.target",
  "http.url",
  "url.path",
  "url.full",
]);

export function shaPrefix(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/**
 * `true` when redaction should run for this span. Reads the per-span opt-out
 * and the global kill switch.
 */
export function shouldRedactSpan(
  span: ReadableSpan,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.SPS_TRACE_REDACT === PER_SPAN_OPT_OUT_VALUE) {
    return false;
  }
  const optOut = span.attributes[PER_SPAN_OPT_OUT_KEY];
  return optOut !== PER_SPAN_OPT_OUT_VALUE;
}

/** Match an identifier-ish key (last segment of a dotted key, lowercase). */
function isIdentifierKey(key: string): boolean {
  const last = key.toLowerCase().split(".").pop() ?? key.toLowerCase();
  return IDENTIFIER_KEYS.has(last);
}

function redactPath(value: string): string {
  // Walk segment pairs; `/<segment>/<value>` -> `/<segment>/<sha>`.
  const parts = value.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!.toLowerCase();
    if (REDACT_PATH_SEGMENTS.has(seg) && parts[i + 1]!.length > 0) {
      parts[i + 1] = shaPrefix(parts[i + 1]!);
      // The hashed value is data, not a segment name — skip past it so the
      // walk never re-inspects (and mis-matches) what it just rewrote.
      i++;
    }
  }
  return parts.join("/");
}

function redactAttributeValue(key: string, value: unknown): unknown {
  if (key === PRISMA_PARAMETERS_KEY) {
    // Prisma emits a JSON-stringified array or an array of primitives. Hash
    // the literal string so the cardinality is preserved (same parameters
    // -> same hash) without leaking the actual value.
    if (typeof value === "string") {
      return shaPrefix(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => shaPrefix(String(v)));
    }
    return shaPrefix(String(value));
  }
  if (PATH_BEARING_KEYS.has(key) && typeof value === "string") {
    return redactPath(value);
  }
  if (isIdentifierKey(key) && value !== undefined && value !== null) {
    return shaPrefix(String(value));
  }
  return undefined;
}

/**
 * Return a new attribute object with identifier-ish values hashed. Does not
 * mutate the input.
 */
export function redactAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...attributes };
  for (const [key, value] of Object.entries(attributes)) {
    const replacement = redactAttributeValue(key, value);
    if (replacement !== undefined) {
      out[key] = replacement;
    }
  }
  return out;
}

/**
 * SpanProcessor that rewrites identifier-ish attributes in place at span end.
 * Composes with whatever export processor is configured downstream.
 */
export class RedactionSpanProcessor implements SpanProcessor {
  constructor(
    private readonly env: Readonly<
      Record<string, string | undefined>
    > = process.env,
  ) {}

  onStart(): void {
    // No work at start; values land via instrumentations once the span runs.
  }

  onEnd(span: ReadableSpan): void {
    if (!shouldRedactSpan(span, this.env)) {
      return;
    }
    // Mutating the attributes bag in place is the documented pattern for
    // SpanProcessor.onEnd; the next processor in the chain reads the same
    // reference. We avoid replacing the bag wholesale so downstream
    // processors that snapshot keys stay valid.
    const attrs = span.attributes as Record<string, unknown>;
    for (const [key, value] of Object.entries(attrs)) {
      const replacement = redactAttributeValue(key, value);
      if (replacement !== undefined) {
        attrs[key] = replacement;
      }
    }
  }

  async forceFlush(): Promise<void> {
    // Stateless processor; nothing to drain.
  }

  async shutdown(): Promise<void> {
    // Stateless processor; nothing to release.
  }
}
