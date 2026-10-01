import { cache } from "react";
import { getFamily } from "@/lib/api/methods";

/** #2963 — per-request memo so `layout.tsx` (the real-404 gate), `generateMetadata`
 *  and the page share one family resolution (two groupBy queries). */
export const getFamilyCached = cache(getFamily);
