"use client";

/**
 * Matcha targeted messages — the "Email individually" review queue. Top: "the pitch" (what the
 * partner is looking for) and the subject, drafted on open by `/api/edit/matcha/pitch` and
 * editable. Then one card per selected researcher, in rank order. Each card's "Why I thought of
 * you" bullets and "One idea to discuss" line are drafted per person, in the second person, from
 * their saved brief (same route, with `cwid`). The message shows as a formatted preview with
 * "Edit"; "Open in mail app" (a plain-text `mailto:`), "Copy" (HTML with real bullets and bold
 * labels, plus plain text) and a "Done" tick the officer works down. Editing the pitch or subject
 * rewrites every card the officer has not edited by hand. Nothing is sent from Scholars; addresses
 * live only in this dialog's state.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  MAILTO_SOFT_LIMIT,
  buildMailto,
  buildTargetedEmail,
  emailBodyToHtml,
  parseEmailBody,
} from "@/lib/edit/matcha-email";

/** One selected researcher. */
export type TargetedPerson = {
  cwid: string;
  name: string;
  hasBrief: boolean;
  /** The brief's `updatedAt`: part of the lines cache key, so a redraft or an edit drafts the
   *  personal lines afresh. "" with no brief. */
  briefVersion: string;
};

/** What `/api/edit/matcha/contacts` returns. */
export type TargetedContacts = {
  contacts: { cwid: string; name: string; email: string }[];
  missing: { cwid: string; name: string }[];
  officer: { name: string; email: string | null; dept?: string | null };
};

type Lines = { bullets: string[]; idea: string };
type Drafted = { pitch: string; subject: string };

type Card = {
  /** The officer's hand edit; absent ⇒ the message follows the pitch. */
  override?: string;
  editing?: boolean;
  done: boolean;
  copied?: "ok" | "failed";
};

/** Above this many words the pitch box warns: the whole email should stay near 120 words. */
export const PITCH_WARN_WORDS = 70;
/** Per-person drafts in flight at once. */
const LINES_CONCURRENCY = 3;

/** localStorage key for the officer's pitch and subject on one search. */
export function pitchStorageKey(submissionId: string): string {
  return `matcha-pitch:${submissionId}`;
}
/** localStorage key for one researcher's drafted lines on one search and brief version. */
export function linesStorageKey(submissionId: string, cwid: string, briefVersion: string): string {
  return `matcha-lines:${submissionId}:${cwid}:${briefVersion}`;
}

/** Lines with nothing in them: the post-check dropped every part (or the model wrote none). */
function isEmptyLines(l: Lines): boolean {
  return l.bullets.length === 0 && !l.idea;
}

// ponytail: the drafts are cached in THIS browser only (localStorage); persist them on the
// submission server-side if officers need them across devices.
function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the draft still lives in the dialog.
  }
}

/** A cached pitch: the JSON `{pitch, subject}`, or a bare string from before subjects existed
 *  (`readCache` then fails to parse it and the dialog drafts afresh). */
function readCachedPitch(submissionId: string): Drafted | null {
  const c = readCache<Drafted>(pitchStorageKey(submissionId));
  return c && typeof c.pitch === "string" ? { pitch: c.pitch, subject: c.subject ?? "" } : null;
}

function wordCount(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

/** Copy as HTML (real bullets, bold labels) with a plain-text twin; plain text alone where the
 *  browser has no `ClipboardItem`. */
async function copyMessage(body: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([emailBodyToHtml(body)], { type: "text/html" }),
        "text/plain": new Blob([body], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(body);
}

/** The message as the recipient will see it in a rich mail client. */
function MessagePreview({ body }: { body: string }) {
  return (
    <div
      data-slot="matcha-targeted-preview"
      className="border-input bg-background flex flex-col gap-3 rounded-md border px-3 py-2 text-sm"
    >
      {parseEmailBody(body).map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="-mt-2 list-disc pl-5">
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {l.label ? <strong>{l.label}</strong> : null}
                {l.text}
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

export function TargetedEmailDialog({
  submissionId,
  people,
  focus,
  requester,
  loadContacts,
  draftPitch,
  draftLines,
  onClose,
}: {
  submissionId: string;
  /** The selected researchers, in rank order. */
  people: readonly TargetedPerson[];
  focus: string;
  requester: string | null;
  loadContacts: () => Promise<TargetedContacts>;
  draftPitch: () => Promise<Drafted>;
  draftLines: (cwid: string) => Promise<Lines>;
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | ({ kind: "ready" } & TargetedContacts)
  >({ kind: "loading" });
  const [drafted, setDraftedState] = useState<Drafted>({ pitch: "", subject: "" });
  const [pitchStatus, setPitchStatus] = useState<"idle" | "drafting" | "error">("idle");
  const [lines, setLines] = useState<Record<string, Lines | "drafting" | "failed">>({});
  const [cards, setCards] = useState<Record<string, Card>>({});

  function setDrafted(next: Drafted) {
    setDraftedState(next);
    writeCache(pitchStorageKey(submissionId), next);
  }

  // False once the dialog closes: a draft landing after that is dropped.
  const liveRef = useRef(false);

  /** Draft one person's lines; cache them unless empty (an empty result is retried next open). */
  async function fetchLines(p: TargetedPerson) {
    try {
      const l = await draftLines(p.cwid);
      if (!isEmptyLines(l)) writeCache(linesStorageKey(submissionId, p.cwid, p.briefVersion), l);
      if (liveRef.current) setLines((prev) => ({ ...prev, [p.cwid]: l }));
    } catch {
      if (liveRef.current) setLines((prev) => ({ ...prev, [p.cwid]: "failed" }));
    }
  }

  function regenerate() {
    setPitchStatus("drafting");
    draftPitch()
      .then((d) => {
        setDrafted(d);
        setPitchStatus("idle");
      })
      .catch(() => setPitchStatus("error"));
  }

  // On open: addresses; the pitch (cached edit, else a fresh draft); each briefed person's lines
  // (cached, else drafted, `LINES_CONCURRENCY` at a time).
  useEffect(() => {
    let live = true;
    loadContacts()
      .then((r) => live && setContacts({ kind: "ready", ...r }))
      .catch(
        (err: unknown) =>
          live &&
          setContacts({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
      );
    const cached = readCachedPitch(submissionId);
    if (cached) setDraftedState(cached);
    else regenerate();

    const queue: TargetedPerson[] = [];
    const initial: Record<string, Lines | "drafting"> = {};
    for (const p of people) {
      if (!p.hasBrief) continue;
      const c = readCache<Lines>(linesStorageKey(submissionId, p.cwid, p.briefVersion));
      if (c && Array.isArray(c.bullets) && !isEmptyLines(c)) initial[p.cwid] = c;
      else {
        initial[p.cwid] = "drafting";
        queue.push(p);
      }
    }
    setLines(initial);
    const worker = async () => {
      for (let p = queue.shift(); p && liveRef.current; p = queue.shift()) await fetchLines(p);
    };
    liveRef.current = true;
    for (let i = 0; i < LINES_CONCURRENCY; i++) void worker();
    return () => {
      live = false;
      liveRef.current = false;
    };
    // Once per open: the dialog is remounted for a new selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const officerName = contacts.kind === "ready" ? contacts.officer.name : "";
  const officerDept = contacts.kind === "ready" ? (contacts.officer.dept ?? null) : null;
  // The directory's preferred name (as the greeting uses) and address, by cwid.
  const contactBy = new Map(
    contacts.kind === "ready" ? contacts.contacts.map((c) => [c.cwid, c]) : [],
  );
  const reachable = people.filter((p) => contactBy.has(p.cwid));
  const missing = contacts.kind === "ready" ? contacts.missing : [];
  const doneCount = reachable.filter((p) => cards[p.cwid]?.done).length;
  const pitchWords = wordCount(drafted.pitch);

  function patchCard(cwid: string, patch: Partial<Card>) {
    setCards((prev) => ({ ...prev, [cwid]: { ...(prev[cwid] ?? { done: false }), ...patch } }));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="matcha-targeted-dialog"
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {people.length === 1 ? "Email researcher" : "Email researchers individually"}
          </DialogTitle>
          <DialogDescription>
            {contacts.kind === "ready"
              ? `${doneCount} of ${reachable.length} done. Review each message, then open it in your mail app or copy it. Nothing is sent by Scholars.`
              : "Addresses are looked up when you ask and are not saved."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          <label htmlFor="matcha-pitch" className="text-sm font-medium">
            The pitch
          </label>
          <p className="text-muted-foreground text-xs">
            What the partner is looking for, in every message. Check it says nothing confidential.
          </p>
          <Textarea
            id="matcha-pitch"
            rows={4}
            value={drafted.pitch}
            disabled={pitchStatus === "drafting"}
            placeholder={pitchStatus === "drafting" ? "Drafting the pitch…" : ""}
            onChange={(e) => setDrafted({ ...drafted, pitch: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pitchStatus === "drafting"}
              onClick={regenerate}
            >
              {pitchStatus === "drafting" ? "Drafting…" : "Regenerate"}
            </Button>
            <span
              data-slot="matcha-pitch-words"
              className={
                pitchWords > PITCH_WARN_WORDS
                  ? "text-destructive text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {pitchWords} words
              {pitchWords > PITCH_WARN_WORDS
                ? ` · over ${PITCH_WARN_WORDS}; shorter reads better`
                : ""}
            </span>
            {pitchStatus === "error" ? (
              <span className="text-destructive text-xs" role="alert">
                Couldn&apos;t draft the pitch. Write one, or try again.
              </span>
            ) : null}
          </div>
          <label htmlFor="matcha-subject" className="mt-2 text-sm font-medium">
            Subject
          </label>
          <Input
            id="matcha-subject"
            value={drafted.subject}
            disabled={pitchStatus === "drafting"}
            placeholder={buildTargetedEmail({ focus, requester, name: "" }).subject}
            onChange={(e) => setDrafted({ ...drafted, subject: e.target.value })}
          />
        </div>

        {contacts.kind === "loading" ? (
          <p className="text-sm" role="status">
            Looking up addresses…
          </p>
        ) : contacts.kind === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {contacts.message}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {reachable.map((p) => {
              const card = cards[p.cwid] ?? { done: false };
              const { name, email } = contactBy.get(p.cwid)!;
              const l = lines[p.cwid];
              const built = buildTargetedEmail({
                focus,
                requester,
                officerName,
                officerDept,
                name,
                pitch: drafted.pitch,
                subject: drafted.subject,
                bullets: typeof l === "object" ? l.bullets : null,
                idea: typeof l === "object" ? l.idea : null,
              });
              const body = card.override ?? built.body;
              const mailto = buildMailto({ to: email, subject: built.subject, body });
              return (
                <section
                  key={p.cwid}
                  data-slot="matcha-targeted-card"
                  aria-label={name}
                  className="border-border flex flex-col gap-2 rounded border p-3"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">{name}</div>
                      <div className="text-muted-foreground text-xs">{email}</div>
                    </div>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={card.done}
                        onChange={(e) => patchCard(p.cwid, { done: e.target.checked })}
                      />
                      Done
                    </label>
                  </div>
                  {!p.hasBrief ? (
                    <p
                      className="text-muted-foreground text-xs"
                      data-slot="matcha-targeted-no-brief"
                    >
                      No brief — draft one for a personal line
                    </p>
                  ) : l === "drafting" && card.override == null ? (
                    <p className="text-muted-foreground text-xs" role="status">
                      Drafting the personal lines…
                    </p>
                  ) : (l === "failed" || (typeof l === "object" && isEmptyLines(l))) &&
                    card.override == null ? (
                    <div className="flex items-center gap-2 text-xs" role="alert">
                      <span
                        className={l === "failed" ? "text-destructive" : "text-muted-foreground"}
                      >
                        {l === "failed"
                          ? "Couldn't draft the personal lines; the message goes without them."
                          : "No personal lines came out of this brief; the message goes without them."}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          setLines((prev) => ({ ...prev, [p.cwid]: "drafting" }));
                          void fetchLines(p);
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {card.editing ? (
                    <Textarea
                      aria-label={`Message to ${name}`}
                      rows={body.split("\n").length + 1}
                      value={body}
                      onChange={(e) => patchCard(p.cwid, { override: e.target.value })}
                    />
                  ) : (
                    <MessagePreview body={body} />
                  )}
                  {mailto.length > MAILTO_SOFT_LIMIT ? (
                    <p className="text-xs" data-slot="matcha-targeted-too-long">
                      Too long for some mail apps — use Copy.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="apollo" size="sm">
                      <a href={mailto} onClick={() => patchCard(p.cwid, { done: true })}>
                        Open in mail app
                      </a>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        copyMessage(body)
                          .then(() => patchCard(p.cwid, { copied: "ok" }))
                          .catch(() => patchCard(p.cwid, { copied: "failed" }));
                      }}
                    >
                      Copy
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => patchCard(p.cwid, { editing: !card.editing })}
                    >
                      {card.editing ? "Preview" : "Edit"}
                    </Button>
                    {card.copied === "ok" ? (
                      <span className="text-xs" role="status">
                        Copied. Paste into Outlook keeps the bullets and bold.
                      </span>
                    ) : card.copied === "failed" ? (
                      <span className="text-destructive text-xs" role="alert">
                        Couldn&apos;t copy; click Edit, select the message and copy it.
                      </span>
                    ) : null}
                  </div>
                </section>
              );
            })}
            {missing.length > 0 ? (
              <div data-slot="matcha-targeted-missing" className="text-sm">
                <div className="font-medium">No email on file</div>
                <ul className="text-muted-foreground list-disc pl-5">
                  {missing.map((m) => (
                    <li key={m.cwid}>{m.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
