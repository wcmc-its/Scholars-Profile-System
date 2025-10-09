import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
     const username = process.env.OPENSEARCH_USERNAME || "";
    const password = process.env.OPENSEARCH_PASSWORD || "";
    const url = process.env.OPENSEARCH_URL + "/people1_index/_search";
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") || "";

    // Only use phrase_prefix for text fields
    const textFields = [
      "person.name.displayFirstLast",
      "person.name.displayLastFirst",
      "person.title",
      "publications.title",
      "person.overview",
      
    ];

    const body: any = {
      query: q
        ? {
            bool: {
              should: [
                {
                  multi_match: {
                    query: q,
                    fields: textFields,
                    type: "phrase_prefix",
                  },
                },
                {
                  term: {
                    "person.personIdentifier": {
                      value: q,
                    },
                  },
                },
              ],
            },
          }
        : { match_all: {} },
      _source: [
        "person.name.displayFirstLast",
        "person.personIdentifier",
        "person.department",
        "appointments"
      ],
      size: 10,
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
      const errText = await res.text();
      console.error("OpenSearch error:", errText);
      return NextResponse.json(
        { error: "OpenSearch request failed", details: errText },
        { status: res.status }
      );
    }

    const json = await res.json();

    const hits =
      json.hits?.hits?.map((hit: any) => ({
        id: hit._source.person.personIdentifier,
        name: hit._source.person.name.displayFirstLast,
        department: hit._source.appointments[0].orgUnit || "Unknown",
      })) || [];

    return NextResponse.json(hits);
  } catch (err: any) {
    console.error("Autocomplete API error:", err);
    return NextResponse.json(
      { error: "Unexpected server error", details: err.message },
      { status: 500 }
    );
  }
}
