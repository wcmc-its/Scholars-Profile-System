import { NextResponse } from 'next/server';
import { openSearchClient as client } from '../../lib/opensearch';

export async function GET() {
  try {
    const response = await client.search({
      index: 'people1_index',
      body: {
        _source: ['person.personIdentifier'],
        query: {
          exists: {
            field: 'person.personIdentifier',
          },
        },
      },
    });

    const hits = response.body.hits?.hits || [];
    const identifiers = hits
      .map((hit: any) => hit._source?.person?.personIdentifier)
      .filter(Boolean);

    return NextResponse.json({ identifiers });
  } catch (error) {
    console.error('OpenSearch query failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch person identifiers' },
      { status: 500 }
    );
  }
}
