import { cache } from "react";
import { getTopic } from "@/lib/api/topics";

/** #2963 — per-request memo so `layout.tsx` (the real-404 gate), `generateMetadata`
 *  and the page share one topic lookup. */
export const getTopicCached = cache(getTopic);
