import { cache } from "react";
import { getTopic } from "@/lib/api/topics";

/** #2963 — shared by the layout's existence gate, generateMetadata and the page;
 *  React `cache()` keeps it to one query per request/regeneration. */
export const loadTopic = cache((slug: string) => getTopic(slug));
