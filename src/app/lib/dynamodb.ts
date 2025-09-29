// src/app/lib/dynamodb.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({
  region: "us-west-2",               // your region
  endpoint: "http://localhost:8000", // local DynamoDB URL
  credentials: {
    accessKeyId: "dummy",            // can stay dummy
    secretAccessKey: "dummy",
  },
});

export const ddbDocClient = DynamoDBDocumentClient.from(client);
