/**
 * ReCiter Identity `institutions` for etl/orcid-evidence's `history_match`
 * (ORCID queue v2 spec, item 1): the list ReCiter keeps of a person's prior
 * institutions (e.g. Albany and Rochester for a lateral recruit). Read once
 * per run with one paged Scan of the WCM Identity DynamoDB table, the same
 * table, region and client etl/identity uses (`IDENTITY_TABLE`,
 * `IDENTITY_REGION`, the task role's existing `dynamodb:Scan` grant on
 * `table/Identity`). Like the ORCID iD, the list is nested under `identity`.
 *
 * Only rows whose `identity.institutions` is a list are returned, and only the
 * two attributes read (`uid`, the list), server-side. Each entry is a string;
 * an object entry with a string `institution` / `name` is read too.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { cwidFromIdentityItem, IDENTITY_REGION, IDENTITY_TABLE } from "@/etl/identity/index";

export const IDENTITY_INSTITUTIONS_SCAN = {
  FilterExpression: "attribute_type(#identity.#inst, :l)",
  ProjectionExpression: "uid, #identity.#inst",
  ExpressionAttributeNames: { "#identity": "identity", "#inst": "institutions" },
  ExpressionAttributeValues: { ":l": "L" },
} as const;

type IdentityInstitutionsRow = { uid?: string; identity?: { institutions?: unknown } | null };

/** The institution names on one Identity item, trimmed, de-duplicated. Pure. */
export function institutionsFromIdentityItem(row: IdentityInstitutionsRow): string[] {
  const raw = row.identity?.institutions;
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    const name =
      typeof v === "string"
        ? v
        : v && typeof v === "object"
          ? ((v as Record<string, unknown>).institution ?? (v as Record<string, unknown>).name)
          : null;
    if (typeof name === "string" && name.trim()) out.add(name.trim());
  }
  return [...out];
}

type Send = (cmd: ScanCommand) => Promise<{
  Items?: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}>;

/** lowercase cwid → institution names, for the cwids asked for only. `send`
 *  defaults to a document client on the Identity region (tests inject one). */
export async function loadIdentityInstitutions(
  cwids: ReadonlySet<string>,
  send?: Send,
): Promise<Map<string, string[]>> {
  let run = send;
  if (!run) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: IDENTITY_REGION }));
    run = (cmd) => ddb.send(cmd) as ReturnType<Send>;
  }
  const wanted = new Set([...cwids].map((c) => c.toLowerCase()));
  const out = new Map<string, string[]>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await run(
      new ScanCommand({
        TableName: IDENTITY_TABLE,
        ...IDENTITY_INSTITUTIONS_SCAN,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const it of (resp.Items ?? []) as IdentityInstitutionsRow[]) {
      const cwid = cwidFromIdentityItem({ uid: it.uid });
      if (!cwid || !wanted.has(cwid)) continue;
      const names = institutionsFromIdentityItem(it);
      if (names.length > 0) out.set(cwid, names);
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return out;
}
