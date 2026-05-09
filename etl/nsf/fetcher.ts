/**
 * NSF Awards API client (issue #92).
 *
 * Public, key-free REST endpoint:
 *
 *   GET https://api.nsf.gov/services/v1/awards.json
 *       ?id=<7-digit award id>
 *       &printFields=id,title,abstractText,awardeeName,startDate,expDate,piFirstName,piLastName
 *
 * Per-id lookup is one request per candidate grant — fine for the WCM
 * volume we expect (< 100 NSF grants in InfoEd today). NSF doesn't publish
 * a hard rate limit; we throttle to 1 req/sec to stay under any silent
 * one. The single bulk endpoint (`?awardeeName=Cornell`) is technically an
 * option but NSF mixes Cornell-Ithaca + Weill records and the awardee
 * string varies, so per-id is safer.
 */

const NSF_API = "https://api.nsf.gov/services/v1/awards.json";
const REQ_DELAY_MS = 1000;
const PRINT_FIELDS = [
  "id",
  "title",
  "abstractText",
  "awardeeName",
  "startDate",
  "expDate",
  "piFirstName",
  "piLastName",
].join(",");

export type NsfAward = {
  id: string;
  title: string | null;
  abstractText: string | null;
  awardeeName: string | null;
  startDate: string | null;
  expDate: string | null;
  piFirstName: string | null;
  piLastName: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a single NSF award by ID. Returns null when NSF has no record for
 * that ID (which is the common "InfoEd has it, NSF doesn't surface it"
 * case for very old or sub-award entries). Throws only on transport errors
 * or non-2xx responses we can't interpret.
 */
export async function fetchNsfAward(id: string): Promise<NsfAward | null> {
  const url = `${NSF_API}?id=${encodeURIComponent(id)}&printFields=${PRINT_FIELDS}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`NSF /awards.json failed for id ${id}: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    response?: {
      award?: Array<Partial<NsfAward>>;
    };
  };
  const award = data.response?.award?.[0];
  if (!award || !award.id) return null;
  return {
    id: String(award.id),
    title: award.title ?? null,
    abstractText: award.abstractText ?? null,
    awardeeName: award.awardeeName ?? null,
    startDate: award.startDate ?? null,
    expDate: award.expDate ?? null,
    piFirstName: award.piFirstName ?? null,
    piLastName: award.piLastName ?? null,
  };
}

/** Throttle helper — used by the orchestrator to space requests. */
export function sleepBetweenRequests(): Promise<void> {
  return sleep(REQ_DELAY_MS);
}
