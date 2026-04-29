import { NextResponse, type NextRequest } from "next/server";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
} from "@/lib/api/search";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "people";
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10));

  if (type === "publications") {
    const sort = (params.get("sort") ?? "relevance") as PublicationsSort;
    const yearMin = params.get("yearMin") ? parseInt(params.get("yearMin")!, 10) : undefined;
    const yearMax = params.get("yearMax") ? parseInt(params.get("yearMax")!, 10) : undefined;
    const result = await searchPublications({
      q,
      page,
      sort,
      filters: { yearMin, yearMax },
    });
    return NextResponse.json(result);
  }

  const sort = (params.get("sort") ?? "relevance") as PeopleSort;
  const department = params.get("department") ?? undefined;
  const personType = params.get("personType") ?? undefined;
  const hasActiveGrantsParam = params.get("hasActiveGrants");
  const hasActiveGrants =
    hasActiveGrantsParam === null ? undefined : hasActiveGrantsParam === "true";
  const includeIncomplete = params.get("includeIncomplete") === "true";

  const result = await searchPeople({
    q,
    page,
    sort,
    filters: { department, personType, hasActiveGrants, includeIncomplete },
  });
  return NextResponse.json(result);
}
