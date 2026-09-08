/**
 * POST/DELETE /api/edit/core-client — a core owner (or Superuser/comms_steward)
 * maintains the "Known clients" CWID list on `/edit/core/[coreId]/review`
 * (ReciterAI #383 / SPS #2607, CWID-only pass — the owner chose the /edit
 * panel with CWIDs only for this first pass; name-based / fuzzy resolution is
 * explicitly out of scope).
 *
 * POST carries TWO modes, chosen by `mode` (absent = the original add):
 *   - `mode: "name"` — record a NAME-ONLY client (`{ displayName, affiliation? }`):
 *     someone the owner knows uses the core but who has no CWID. The row is
 *     roster-only — it cannot flag a byline (the match is by CWID) and is never
 *     mirrored to the engine. Deduped by a case-insensitive `displayName`
 *     comparison against the core's active list, because the (coreId, cwid)
 *     unique index cannot dedupe rows whose cwid is NULL (MySQL permits any
 *     number of NULLs in a unique index).
 *   - default — the CWID add below: it resolves the pasted block AND writes the
 *     roster rows in one round-trip. A third mode, `mode: "lookup"`, used to
 *     serve the modal's "Look up CWIDs" preview; HANDOFF-11 #2 collapsed that
 *     two-step flow into one button and the mode lost its last caller. Its
 *     Scholars-then-enterprise-directory resolution did NOT go with it —
 *     `resolvePeople` below is that same order, naming the rows the add has
 *     just written.
 *
 * POST body: `{ coreId: string; cwids: string[] }` — a pasted, already
 * client-parsed block. Re-parsed here too (via `parseCwidBlock`, never
 * trusting the client) so a malformed token never reaches `core_client`;
 * malformed tokens are reported back as `invalid`, not rejected outright — a
 * paste of 40 CWIDs with one typo should not throw the other 39 away.
 * Response: `{ added: Array<{id, cwid, name, slug, affiliation, source}>,
 * alreadyPresent: string[], invalid: string[] }`, where `source` names the store
 * the name came from: `"scholars"`, `"directory"`, `null` for a CWID BOTH stores
 * were asked about and neither holds (recorded anyway, and the ONLY case the
 * panel may label "not found"), or `"unavailable"` when the directory could not
 * be asked at all — it threw, or it outran the budget below. `"unavailable"` is
 * a name we could not look up, NOT a name that does not exist: the two used to
 * collapse into `null`, so a directory outage printed "not found, recorded
 * anyway" about people the directory knows perfectly well.
 *
 * DELETE body: `{ coreId: string; cwid: string }` — soft-removes one active
 * row. `{ removed: true }`, or 404 when there is no active row for that CWID.
 *
 * Both verbs share the SAME core-claim authorization gate
 * (`getCoreOwnerRole` + `authorizeCoreClaim` from `lib/edit/authz.ts`) — this
 * is not a new permission surface, it's the existing claim-queue owner gate
 * extended to a second manual-override table on the same core.
 *
 * Each write is one MySQL transaction: upsert/soft-remove the `core_client`
 * row + a B03 audit row (`core_client_add` / `core_client_remove`,
 * `targetEntityType: "core"`, `targetEntityId: "{coreId}:{cwid}"`,
 * before/after `{ active: boolean }`), and — still inside that same
 * transaction — a re-read of the FULL active client list. That in-tx list
 * (never a separate `db.read` call) is what gets mirrored to the engine's
 * DynamoDB after the commit (`lib/cores/client-writeback.ts`, best-effort,
 * dormant-safe, never fails the write): a reader-replica read at that point
 * would race replica lag and could miss the just-added CWID or still show a
 * just-removed one. The two pre-write reads that gate what gets written
 * (`activeRows` in POST, `existing` in DELETE) go through `db.write` for the
 * same read-your-writes reason; the core-existence and name-resolution reads
 * stay on `db.read`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { parseCwidBlock } from "@/lib/api/core-clients";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import type { EditSession } from "@/lib/auth/superuser";
import { writeBackCoreClients } from "@/lib/cores/client-writeback";
import { fetchDirectoryPeopleByCwid } from "@/lib/sources/ldap";

const PATH = "/api/edit/core-client";
/** Generous for a real paste; a guard so a pathological body is a 400, not an
 *  unbounded transaction (mirrors MAX_BULK_PMIDS on the claim bulk route). */
const MAX_CWIDS = 500;
/** A name-only client's typed fields, capped to the column widths. */
const MAX_NAME_LEN = 255;
/** How long the add will wait on the enterprise directory before giving up and
 *  reporting the resolve as DEGRADED. The rows are already committed by the time
 *  it runs, so this call can only add latency to a response that is otherwise
 *  ready — and `openLdap` allows 10s to connect plus 30s per search, across as
 *  many searches as the batch needs (100 CWIDs each). CloudFront kills a silent
 *  response at 30s, so an unbudgeted directory could turn an add that WROTE
 *  every row into "Could not save — try again." on the panel. */
const DIRECTORY_BUDGET_MS = 5_000;

/** Mirror a core's FULL active client list to the engine, best-effort. Never
 *  throws — a mirror failure must not fail the write it follows. `cwids` must
 *  come from a read taken INSIDE the write transaction (never a separate
 *  `db.read` call) — see the module comment for why. */
async function mirrorActiveClients(
  coreId: string,
  cwids: Array<string | null>,
): Promise<unknown> {
  // NAME-ONLY rows carry no cwid and are dropped here — the engine's curated
  // client signal matches bylines by CWID, so a name has nothing to match on.
  // This is the only place that filter belongs: the in-transaction re-read must
  // stay the FULL active list (that is what makes it consistent), and it is the
  // mirror, not the roster, that is CWID-shaped.
  const mirrorable = cwids.filter((c): c is string => c !== null);
  return writeBackCoreClients({ coreId, cwids: mirrorable }).catch((err) => {
    logEditFailure(`${PATH}#writeback`, err);
    return { ok: false as const, skipped: false as const };
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { coreId, cwids, mode, displayName, affiliation } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  const isNameOnly = mode === "name";

  // --- name-only add: no cwids at all, a typed name instead ---
  if (isNameOnly) {
    return addNameOnlyClient({
      coreId,
      displayName,
      affiliation,
      session,
      realCwid,
      impersonatedCwid,
      requestId,
    });
  }

  if (
    !Array.isArray(cwids) ||
    cwids.length === 0 ||
    cwids.length > MAX_CWIDS ||
    !cwids.every((c) => typeof c === "string")
  ) {
    return editError(400, "invalid_cwids", "cwids");
  }

  // --- the core must exist (core_client is FK-less, same ADR-005 posture as core_claim) ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser/comms_steward ---
  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return editError(403, authz.reason);
  }

  // Re-parse server-side (never trust the client): normalize, de-dupe, and
  // split into well-formed CWIDs vs. everything else. A malformed token is
  // reported back, never written and never a reason to reject the batch.
  const { cwids: parsedCwids, invalid } = parseCwidBlock(cwids.join("\n"));
  // MAX_CWIDS above caps the ARRAY length; this caps what that array parsed OUT
  // to. One element can carry a whole pasted block, so 500 strings of 100 CWIDs
  // each would otherwise reach 50,000 rows written — and fan the directory half
  // of the name resolution below out across every one of them.
  if (parsedCwids.length > MAX_CWIDS) {
    return editError(400, "invalid_cwids", "cwids");
  }

  const activeRows =
    parsedCwids.length > 0
      ? await db.write.coreClient.findMany({
          where: { coreId, cwid: { in: parsedCwids }, removedAt: null },
          select: { cwid: true },
        })
      : [];
  // `cwid: { in: parsedCwids }` cannot match a NULL row, so every row here has a
  // cwid; the flatMap is what tells the type system that.
  const activeSet = new Set(activeRows.flatMap((r) => (r.cwid ? [r.cwid.toLowerCase()] : [])));
  const toWrite = parsedCwids.filter((c) => !activeSet.has(c));
  const alreadyPresent = parsedCwids.filter((c) => activeSet.has(c));

  let writeback: unknown;
  // Row id per written cwid, taken from the upsert itself (see below).
  const idByCwid = new Map<string, string>();
  if (toWrite.length > 0) {
    const now = new Date();
    let mirrorCwids: Array<string | null>;
    try {
      mirrorCwids = await db.write.$transaction(async (tx) => {
        for (const cwid of toWrite) {
          // `select: { id }` so the row id comes STRAIGHT OFF THE WRITE. It used
          // to be re-read afterwards through `db.read`, which is a separate
          // client bound to the Aurora READER (`DATABASE_URL_RO`): that is the
          // exact read-your-writes race this module's header warns about, and
          // prod runs a real replica (staging has none, so staging could never
          // surface it). On a lagged read the id came back null, the panel fell
          // back to keying the row on its cwid, and Remove — which always sends
          // `id` — then 404'd forever on a freshly added client.
          const row = await tx.coreClient.upsert({
            where: { coreId_cwid: { coreId, cwid } },
            create: { coreId, cwid, addedBy: session.cwid, addedAt: now },
            update: { addedBy: session.cwid, addedAt: now, removedBy: null, removedAt: null },
            select: { id: true },
          });
          idByCwid.set(cwid, row.id);
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "core",
            targetEntityId: `${coreId}:${cwid}`,
            action: "core_client_add",
            fieldsChanged: ["client"],
            beforeValues: { active: false },
            afterValues: { active: true },
            ts: now,
            requestId,
          });
        }
        // Re-read the full active list from the SAME transaction — see the
        // module comment on why this must not be a separate db.read call.
        const activeAfter = await tx.coreClient.findMany({
          where: { coreId, removedAt: null },
          select: { cwid: true },
        });
        return activeAfter.map((r) => r.cwid);
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    // best-effort engine writeback: mirror the FULL active list read inside
    // the transaction above. Only when something actually changed (mirrors
    // the bulk-claim "nothing written → no transaction, no writeback" posture).
    writeback = await mirrorActiveClients(coreId, mirrorCwids);
  }

  // --- resolve names for the newly-added cwids only: Scholars first, then the
  //     enterprise directory for whoever Scholars does not hold — a core's
  //     clients include staff accounts that have no Scholar row at all. A CWID
  //     neither store knows is still written, and only that case comes back with
  //     `source: null`, which is what makes the panel's "recorded anyway" label
  //     true when it prints it. When the directory never answered, an unresolved
  //     CWID is `"unavailable"` instead: nothing was learned about that person,
  //     so nothing may be asserted about them. ---
  const { people, directoryUnavailable } = await resolvePeople(toWrite);
  const added = toWrite.map((cwid) => {
    const person = people.get(cwid);
    return {
      id: idByCwid.get(cwid) ?? null,
      cwid,
      name: person?.name ?? null,
      slug: person?.slug ?? null,
      affiliation: person?.dept ?? null,
      source: person?.source ?? (directoryUnavailable ? ("unavailable" as const) : null),
    };
  });

  return editOk({ added, alreadyPresent, invalid, writeback });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  // Removes by CWID (the original contract) OR by row `id`. A NAME-ONLY client
  // has no cwid to key on, so `id` is the only handle that reaches it; callers
  // holding a cwid keep working unchanged.
  const { coreId, cwid, id } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  const byId = typeof id === "string" && id.length > 0 && id.length <= 64;
  if (!byId && (typeof cwid !== "string" || cwid.length === 0)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  let normalizedCwid: string | null = null;
  if (!byId) {
    // Reuse the same normalize+validate path POST uses, single-token.
    const { cwids: parsedCwids, invalid: parsedInvalid } = parseCwidBlock(cwid as string);
    if (parsedCwids.length !== 1 || parsedInvalid.length !== 0) {
      return editError(400, "invalid_cwid", "cwid");
    }
    normalizedCwid = parsedCwids[0];
  }
  /** What the DENIAL log points at — only what the caller sent is known this
   *  early. The AUDIT row uses the RESOLVED value below instead. */
  const targetSuffix = byId ? (id as string) : (normalizedCwid as string);

  // --- the core must exist ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser/comms_steward ---
  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityId: `${coreId}:${targetSuffix}`,
    });
    return editError(403, authz.reason);
  }

  // `findFirst` (not `findUnique`) so ONE probe serves both handles. The `id`
  // form still scopes on `coreId` — an id alone would let a caller soft-remove a
  // row belonging to a core they have no role on, since authorization above only
  // ever checked the coreId they sent.
  const existing = await db.write.coreClient.findFirst({
    where: byId ? { id: id as string, coreId } : { coreId, cwid: normalizedCwid as string },
    select: { id: true, cwid: true, removedAt: true },
  });
  if (!existing || existing.removedAt !== null) {
    return editError(404, "client_not_found", byId ? "id" : "cwid");
  }
  // Audit continuity: `core_client_add` writes `{coreId}:{cwid}`, so the matching
  // remove MUST too, or the two rows stop pairing in the audit log — and the
  // panel now always removes BY ID, so keying the audit on the id would have
  // broken that pairing for every CWID client. Only a name-only row (no cwid)
  // falls back to the row id, which is what its own add row carries.
  const auditSuffix = existing.cwid ?? existing.id;

  const now = new Date();
  let mirrorCwids: Array<string | null>;
  try {
    mirrorCwids = await db.write.$transaction(async (tx) => {
      await tx.coreClient.update({
        where: { id: existing.id },
        data: { removedBy: session.cwid, removedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: `${coreId}:${auditSuffix}`,
        action: "core_client_remove",
        fieldsChanged: ["client"],
        beforeValues: { active: true },
        afterValues: { active: false },
        ts: now,
        requestId,
      });
      // Re-read the full active list from the SAME transaction — see the
      // module comment on why this must not be a separate db.read call.
      const activeAfter = await tx.coreClient.findMany({
        where: { coreId, removedAt: null },
        select: { cwid: true },
      });
      return activeAfter.map((r) => r.cwid);
    });
  } catch (err) {
    logEditFailure(`${PATH}#remove`, err);
    return editError(500, "write_failed");
  }

  const writeback = await mirrorActiveClients(coreId, mirrorCwids);

  return editOk({ removed: true, writeback });
}


/** Case-folded, whitespace-collapsed comparison key for a typed name or
 *  affiliation. `null`/blank both fold to "" so an absent affiliation compares
 *  equal to an empty one. Pure. */
function normalizeNameKey(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** One resolved person. A CWID neither store knows is simply absent from the
 *  map below, so `source` is never "nowhere" — that is what absence means. */
interface ResolvedPerson {
  name: string;
  dept: string | null;
  /** Profile slug — always `null` for a directory hit, which has no profile. */
  slug: string | null;
  source: "scholars" | "directory";
}

/** What a resolve knew, and whether it got to ask everyone. `directoryUnavailable`
 *  is the difference between "the directory says there is no such person" and
 *  "the directory did not answer" — absence from `people` means the first ONLY
 *  when this is false. */
interface ResolveOutcome {
  people: Map<string, ResolvedPerson>;
  directoryUnavailable: boolean;
}

/**
 * Resolve names for a block of CWIDs, keyed by the (lowercase) cwid passed in:
 * Scholars first, then the enterprise directory for whatever Scholars does not
 * hold — the same order `loadCoreReviewQueue` uses to name core staff.
 *
 * An ED failure — a throw, or simply outrunning `DIRECTORY_BUDGET_MS` — is
 * caught and logged, never thrown: a directory outage must degrade the naming to
 * "Scholars only", never fail an add whose rows are already committed. It is
 * reported as `directoryUnavailable` rather than swallowed, because the caller
 * cannot otherwise tell a degraded resolve from a genuine miss and the panel
 * prints one of them as a statement about the person. A CWID that resolves
 * nowhere is still added — a legitimate non-faculty core user may precede their
 * Scholar row, which is why the add path never rejects a well-formed CWID for
 * being unknown.
 *
 * The Scholar read stays on `db.read`: `scholar` is ETL-owned and was not
 * written by this request, so there is nothing to race.
 */
async function resolvePeople(cwids: string[]): Promise<ResolveOutcome> {
  const resolved = new Map<string, ResolvedPerson>();
  if (cwids.length === 0) return { people: resolved, directoryUnavailable: false };
  const scholars = await db.read.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true, slug: true, primaryDepartment: true },
  });
  for (const scholar of scholars) {
    resolved.set(scholar.cwid.toLowerCase(), {
      name: scholar.preferredName,
      dept: scholar.primaryDepartment,
      slug: scholar.slug,
      source: "scholars",
    });
  }

  const unresolved = cwids.filter((c) => !resolved.has(c));
  if (unresolved.length === 0) return { people: resolved, directoryUnavailable: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race the directory against the budget. The loser keeps running to its own
    // unbind (`Promise.race` stays subscribed, so a late rejection is handled),
    // it just stops being anything this response waits for.
    const people = await Promise.race([
      fetchDirectoryPeopleByCwid(unresolved),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`directory budget exceeded (${DIRECTORY_BUDGET_MS}ms)`)),
          DIRECTORY_BUDGET_MS,
        );
      }),
    ]);
    for (const person of people) {
      resolved.set(person.cwid.toLowerCase(), {
        name: person.name,
        dept: person.dept,
        slug: null,
        source: "directory",
      });
    }
  } catch (err) {
    // Degrade to Scholars-only rather than failing a write that has committed —
    // and SAY it degraded, so the receipt does not call these people "not found".
    logEditFailure(`${PATH}#directory`, err);
    return { people: resolved, directoryUnavailable: true };
  } finally {
    clearTimeout(timer);
  }
  return { people: resolved, directoryUnavailable: false };
}

/**
 * `mode: "name"` — record a NAME-ONLY client. Roster-only by construction: no
 * cwid, so nothing to match a byline against and nothing to mirror to the
 * engine (`mirrorActiveClients` drops it).
 *
 * Reuses `core_client_add` rather than minting an audit action: the audit-log
 * `action` ENUM lives in a separate database and file (scripts/sql/audit-log.sql),
 * and a TS-union-only widening passes typecheck and every test and then fails as
 * a MySQL 1265 that rolls back the write. The row id goes in `targetEntityId`
 * where a CWID row puts its cwid, so the two are still distinguishable.
 */
async function addNameOnlyClient(args: {
  coreId: string;
  displayName: unknown;
  affiliation: unknown;
  session: EditSession;
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string;
}): Promise<NextResponse> {
  const { coreId, session, realCwid, impersonatedCwid, requestId } = args;
  const name =
    typeof args.displayName === "string" ? args.displayName.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0 || name.length > MAX_NAME_LEN) {
    return editError(400, "invalid_display_name", "displayName");
  }
  const affiliationRaw =
    typeof args.affiliation === "string" ? args.affiliation.trim() : "";
  if (affiliationRaw.length > MAX_NAME_LEN) {
    return editError(400, "invalid_affiliation", "affiliation");
  }
  const affiliation = affiliationRaw.length > 0 ? affiliationRaw : null;

  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return editError(403, authz.reason);
  }

  // The (coreId, cwid) unique index cannot dedupe these — MySQL permits any
  // number of NULLs in a unique index — so the duplicate check is here, and it
  // is case-insensitive because "Fei Wang" and "fei wang" are one person.
  const existing = await db.write.coreClient.findMany({
    where: { coreId, cwid: null, removedAt: null },
    select: { id: true, displayName: true, affiliation: true },
  });
  // Compare on the NORMALIZED name PLUS the affiliation. Two reasons, both from
  // what this field is for:
  //   - `trim()` alone leaves internal whitespace, so a name pasted out of a
  //     document as "Ada  Lovelace" slipped past a stored "Ada Lovelace" and
  //     created a second active row that RENDERS IDENTICALLY (HTML collapses the
  //     run), leaving the owner two indistinguishable rows to guess between. The
  //     unique index cannot catch it — (coreId, NULL) never collides.
  //   - the affiliation is documented as the disambiguator, so two genuinely
  //     different people who share a name must both be addable. Only the exact
  //     same pair is a duplicate.
  const clash = existing.find(
    (r) =>
      normalizeNameKey(r.displayName) === normalizeNameKey(name) &&
      normalizeNameKey(r.affiliation) === normalizeNameKey(affiliation),
  );
  if (clash) return editOk({ added: [], alreadyPresent: [name], invalid: [] });

  const now = new Date();
  let created: { id: string };
  try {
    created = await db.write.$transaction(async (tx) => {
      const row = await tx.coreClient.create({
        data: {
          coreId,
          cwid: null,
          displayName: name,
          affiliation,
          addedBy: session.cwid,
          addedAt: now,
        },
        select: { id: true },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: `${coreId}:${row.id}`,
        action: "core_client_add",
        fieldsChanged: ["client"],
        beforeValues: { active: false },
        afterValues: { active: true },
        ts: now,
        requestId,
      });
      return row;
    });
  } catch (err) {
    logEditFailure(`${PATH}#name-only`, err);
    return editError(500, "write_failed");
  }

  // No writeback: a name-only client has no CWID for the engine to match, so
  // the mirrored CLIENTS item is unchanged by this write.
  return editOk({
    added: [
      { id: created.id, cwid: null, name, affiliation, slug: null, addedAt: now.toISOString() },
    ],
    alreadyPresent: [],
    invalid: [],
  });
}
