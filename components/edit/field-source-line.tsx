/**
 * The inline "Source: <system>" line shown in a sourced `/edit` panel header
 * (#511). Quiet, always-visible (no hover), sits above the panel description —
 * the per-field provenance affordance that makes the "Request a change"
 * routing self-explanatory.
 */
import { fieldSource } from "@/lib/edit/field-sources";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

export function FieldSourceLine({ attribute }: { attribute: RequestAttribute }) {
  return (
    <p className="text-muted-foreground text-sm" data-slot="field-source">
      Source: <span className="text-foreground font-medium">{fieldSource(attribute)}</span>
    </p>
  );
}
