/**
 * GET /api/topics/[slug]/subtopics/[subtopicId]/scholars
 *
 * CSR endpoint for the subtopic-scoped top-scholars chip row on the topic
 * detail page. Returns up to 7 chip-render rows for scholars whose first/last
 * authored publications fall under the requested primarySubtopicId.
 *
 * Security: same allowlist regex pattern as the publications endpoint
 * (T-03-05-02 subtopic injection, T-03-05-04 path traversal). Silent rejection
 * with static error strings.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSubtopicScholars } from "@/lib/api/topics";

export const dynamic = "force-dynamic";

const SUBTOPIC_RE = /^[a-z0-9_]+$/;
const TOPIC_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; subtopicId: string }> },
): Promise<NextResponse> {
  const { slug, subtopicId } = await params;
  if (!TOPIC_SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "invalid topic slug" }, { status: 400 });
  }
  if (!SUBTOPIC_RE.test(subtopicId)) {
    return NextResponse.json({ error: "invalid subtopic" }, { status: 400 });
  }

  const scholars = await getSubtopicScholars(slug, subtopicId);
  return NextResponse.json({ scholars: scholars ?? [] });
}
