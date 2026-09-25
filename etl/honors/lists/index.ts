/**
 * Per-list scrapers, keyed by the ids in `lib/honors/lists.ts`. One module per
 * list; a list present there with no scraper here fails its run loudly.
 */
import { scrapeAaas } from "./aaas";
import { scrapeBwf } from "./bwf";
import { scrapeNai } from "./nai";
import type { ListScraper } from "./types";

export const SCRAPERS: Readonly<Record<string, ListScraper>> = {
  "nai-fellows": scrapeNai,
  "aaas-fellows": scrapeAaas,
  "bwf-cams": scrapeBwf,
};
