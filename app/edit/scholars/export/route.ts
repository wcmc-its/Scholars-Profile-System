/** `/edit/scholars/export` moved to `/edit/profiles/export`. */
import { NextResponse, type NextRequest } from "next/server";

export function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/edit/profiles/export";
  return NextResponse.redirect(url, 308);
}
