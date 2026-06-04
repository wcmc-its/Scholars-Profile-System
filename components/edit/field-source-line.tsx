/**
 * The inline "Source: <system>" line shown in a sourced `/edit` panel header
 * (#511). Quiet, always-visible (no hover), sits above the panel description —
 * the per-field provenance affordance that makes the "Request a change"
 * routing self-explanatory.
 */
import Link from "next/link";

import { fieldSource } from "@/lib/edit/field-sources";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

export function FieldSourceLine({ attribute }: { attribute: RequestAttribute }) {
  // The system name links to the provenance docs. The wrapping <Link> keeps the
  // line's textContent byte-identical ("Source: <system>") so the strict-equality
  // field-sources tests still pass (vision-round T1.10).
  return (
    <p className="text-muted-foreground text-sm" data-slot="field-source">
      Source:{" "}
      <Link
        href="/about#provenance"
        className="text-foreground font-medium underline-offset-2 hover:underline"
      >
        {fieldSource(attribute)}
      </Link>
    </p>
  );
}
