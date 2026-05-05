import { NextResponse, type NextRequest } from "next/server";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
} from "@/lib/api/search";

export const dynamic = "force-dynamic";

// Valid topic slug pattern — same as topic page slug (D-02 candidate (e): topic.id is the slug).
// Rejects non-slug shapes to prevent blind-comparison probing (T-03-06-01).
const TOPIC_SLUG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "people";
  const rawPage = parseInt(params.get("page") ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;

  if (type === "publications") {
    const sort = (params.get("sort") ?? "relevance") as PublicationsSort;
    const yearMin = params.get("yearMin") ? parseInt(params.get("yearMin")!, 10) : undefined;
    const yearMax = params.get("yearMax") ? parseInt(params.get("yearMax")!, 10) : undefined;
    const publicationType = params.get("publicationType") ?? undefined;
    const result = await searchPublications({
      q,
      page,
      sort,
      filters: { yearMin, yearMax, publicationType },
    });
    // ANALYTICS-02 (D-02): structured search-query log (publications branch).
    console.log(
      JSON.stringify({
        event: "search_query",
        q,
        type: "publications",
        resultCount: result.total,
        filters: { yearMin, yearMax, publicationType },
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(result);
  }

  const sort = (params.get("sort") ?? "relevance") as PeopleSort;
  const department = params.get("department") ?? undefined;
  const personType = params.get("personType") ?? undefined;
  const hasActiveGrantsParam = params.get("hasActiveGrants");
  const hasActiveGrants =
    hasActiveGrantsParam === null ? undefined : hasActiveGrantsParam === "true";
  const includeIncomplete = params.get("includeIncomplete") === "true";

  // D-10 topic filter: validate slug shape before passing to searchPeople.
  const topicRaw = params.get("topic");
  let topic: string | undefined;
  if (topicRaw !== null && topicRaw.length > 0) {
    if (!TOPIC_SLUG_RE.test(topicRaw)) {
      return NextResponse.json({ error: "invalid topic" }, { status: 400 });
    }
    topic = topicRaw;
  }

  const result = await searchPeople({
    q,
    page,
    sort,
    filters: { department, personType, hasActiveGrants, includeIncomplete },
    topic,
  });
  // ANALYTICS-02 (D-02): structured search-query log (people branch).
  console.log(
    JSON.stringify({
      event: "search_query",
      q,
      type: "people",
      resultCount: result.total,
      filters: { department, personType, hasActiveGrants, includeIncomplete },
      ts: new Date().toISOString(),
    }),
  );
  return NextResponse.json(result);
}
