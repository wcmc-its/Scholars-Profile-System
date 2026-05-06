import { NextResponse, type NextRequest } from "next/server";
import { suggestEntities } from "@/lib/api/search";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const suggestions = await suggestEntities(q);
  return NextResponse.json({ suggestions });
}
