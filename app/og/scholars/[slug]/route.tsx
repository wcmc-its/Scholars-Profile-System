import { ImageResponse } from "next/og";
import { getScholarOgData } from "@/lib/api/profile";

// Prisma is NOT compatible with Edge Runtime — must use nodejs.
// (Phase 5 D-23, RESEARCH Pitfall 4)
export const runtime = "nodejs";

// Allow on-demand rendering for any active scholar slug. Phase 5 does not
// pre-render the OG image set; ImageResponse runs per request, with
// aggressive Cache-Control downstream (Phase 5 D-23).
export const dynamicParams = true;

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(
  _req: Request,
  context: RouteContext,
): Promise<Response> {
  const { slug } = await context.params;
  const scholar = await getScholarOgData(slug);

  if (!scholar) {
    return new Response("Not found", { status: 404 });
  }

  // Phase 5 D-25 default: branded WCM-wordmark fallback for every scholar
  // until headshot consent is confirmed with Sumanth post-launch.
  // Do NOT fetch identityImageEndpoint here.

  const canvas = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        background: "#B31B1B",
        padding: "72px 96px",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#FFFFFF",
        position: "relative",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 400,
          color: "rgba(255,255,255,0.7)",
          marginBottom: 16,
          display: "flex",
        }}
      >
        scholars.weill.cornell.edu
      </div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          lineHeight: 1.1,
          maxWidth: 1000,
          marginBottom: 12,
          display: "flex",
        }}
      >
        {scholar.preferredName}
      </div>
      {scholar.primaryTitle ? (
        <div
          style={{
            fontSize: 32,
            fontWeight: 400,
            lineHeight: 1.25,
            maxWidth: 1000,
            marginBottom: 8,
            display: "flex",
          }}
        >
          {scholar.primaryTitle}
        </div>
      ) : null}
      {scholar.primaryDepartment ? (
        <div
          style={{
            fontSize: 24,
            fontWeight: 400,
            color: "rgba(255,255,255,0.85)",
            lineHeight: 1.3,
            maxWidth: 1000,
            display: "flex",
          }}
        >
          {scholar.primaryDepartment}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          bottom: 56,
          right: 96,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "0.04em",
          color: "#FFFFFF",
          textTransform: "uppercase",
          display: "flex",
        }}
      >
        Weill Cornell Medicine
      </div>
    </div>
  );

  return new ImageResponse(canvas, {
    width: 1200,
    height: 630,
    headers: {
      // D-23: aggressive caching. Content only changes on ETL run or self-edit.
      // 1h max-age + 24h stale-while-revalidate keeps social cards fresh
      // without hammering the route.
      "Cache-Control":
        "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
