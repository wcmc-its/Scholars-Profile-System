import { cache } from "react";
import { getFamily } from "@/lib/api/methods";

/** #2963 — shared by the layout's existence gate, generateMetadata and the page;
 *  React `cache()` keeps getFamily's groupBy to one run per request. */
export const loadFamily = cache((supercategory: string, family: string) =>
  getFamily(supercategory, family),
);
