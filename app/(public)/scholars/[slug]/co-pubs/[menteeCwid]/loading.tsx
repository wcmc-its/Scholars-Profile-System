/**
 * #2963 — the per-mentee page's loading UI, the same skeleton it showed when
 * the co-pubs loading.tsx sat one level up. It lives here, BELOW this segment's
 * layout, so the layout's pair gate runs outside the Suspense boundary and an
 * unrecorded pair is a real 404 rather than a 200 after the fallback streamed.
 */
export { default } from "../(rollup)/loading";
