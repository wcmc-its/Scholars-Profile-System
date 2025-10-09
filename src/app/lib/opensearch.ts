// lib/opensearch.ts
import { Client } from '@opensearch-project/opensearch';

export const openSearchClient = new Client({
  node: process.env.OPENSEARCH_URL,
  auth: {
    username: process.env.OPENSEARCH_USERNAME || '',
    password: process.env.OPENSEARCH_PASSWORD || '',
  },
  ssl: {
    rejectUnauthorized: false, // adjust to your cert setup
  },
});
