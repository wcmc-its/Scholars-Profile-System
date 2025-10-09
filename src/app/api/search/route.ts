import { NextRequest } from "next/server";

// This API route fetches data from local OpenSearch via HTTP (no SSL)
export async function GET(req: NextRequest) {
    const username = process.env.OPENSEARCH_USERNAME || "";
    const password = process.env.OPENSEARCH_PASSWORD || "";
    const url = process.env.OPENSEARCH_URL + "/people_index/_search";
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q") || "";

    // Build OpenSearch query body
    const body = {
      query: query
        ? {
            multi_match: {
              query,
              fields: [
                "person.name.first",
                "person.personIdentifier",
                "person.title",
                "publications.title",
                "person.overview",
              ],
            },
          }
        : { match_all: {} },
      size: 50,
    };

    const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization:
     "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
  },
  body: JSON.stringify(body),
});
    if (!res.ok) {
      const text = await res.text();
      console.error("OpenSearch error:", text);
      return new Response(JSON.stringify({ error: text }), { status: res.status });
    }

    const data = await res.json();
    const hits = data.hits?.hits?.map((hit: any) => hit._source) || [];

    return new Response(JSON.stringify(hits), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching data from OpenSearch:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
